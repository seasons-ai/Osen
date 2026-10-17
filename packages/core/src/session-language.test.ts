import { afterEach, describe, expect, it } from "vitest";
import { createSession, runSession } from "./engine.ts";
import { getProcessLanguage, setProcessLanguage } from "./i18n/process-language.ts";
import type { Language } from "./i18n/language.ts";
import type { ParticipantDriver, TurnRequest } from "./participants/driver.ts";
import { foldEvents } from "./protocol/fold.ts";
import { SessionEventSchema, SessionSchema, sessionLanguage } from "./protocol/schema.ts";
import type { Session, SessionEvent } from "./protocol/schema.ts";
import { buildMaterialsPreview, buildTurnPrompt } from "./protocol/context.ts";

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const people = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `N${i + 1}`, providerId: "scripted", model: "m", role: null }));
const opt = { maxParticipants: 8, id: "s1", now: () => new Date("2026-01-01T00:00:00Z") };
const RULES_HEAD: Record<Language, string> = { en: "# Protocol rules\n", ru: "# Правила протокола\n" };

interface Call { participantId: string; language: Language; prompt: string }

// Deterministic participant: answers depend only on the seed and the call number, not on the request text.
function randomDriver(seed: number, calls: Call[], folder: boolean): ParticipantDriver {
  const rnd = mulberry32(seed);
  return {
    async call(req: TurnRequest) {
      calls.push({ participantId: req.participant.id, language: req.language, prompt: req.prompt });
      const k = Math.floor(rnd() * 10);
      const body = (stance: string, solution: string | null, extra: Record<string, unknown> = {}) =>
        JSON.stringify({ stance, reasoning: `r${k}`, solution, answers: [], questions: [], files: [], ...extra });
      const text =
        k === 0 ? "не JSON"
        : k === 1 && folder ? JSON.stringify({ files: ["d/a.txt", "d/нет.txt"] })
        : k === 2 ? body("agree", "лишний текст")
        : k <= 5 ? body("amend", `версия ${k}`)
        : k <= 7 ? body("agree", null)
        : body("object", null);
      return { text, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

interface Gen { n: number; maxRounds: number; contextChars: number; folder: boolean; drafts: boolean; seeds: number[]; resumes: { lang: Language; replace: boolean }[] }

function generate(seed: number): Gen {
  const rnd = mulberry32(seed);
  const int = (k: number) => Math.floor(rnd() * k);
  const n = 2 + int(3);
  return {
    n, maxRounds: 1 + int(2), contextChars: [40, 300, 100000][int(3)]!, folder: rnd() < 0.5, drafts: rnd() < 0.4,
    seeds: Array.from({ length: n + 2 }, () => int(1e9)),
    resumes: Array.from({ length: 1 + int(2) }, () => ({ lang: (rnd() < 0.5 ? "en" : "ru") as Language, replace: rnd() < 0.4 })),
  };
}

const sessionOf = (g: Gen, language: Language | undefined): Session => {
  const s = createSession({
    topic: "T", framing: "", origin: "cli", participants: people(g.n),
    limits: { maxRounds: g.maxRounds, turnTimeoutSec: 30, contextChars: g.contextChars },
    ...(g.folder ? { workspace: [{ name: "d/a.txt", text: "abc" }, { name: "d/b.txt", text: "x".repeat(50) }] } : {}),
    ...(g.drafts ? { drafts: {} } : {}),
    ...(language ? { language } : {}),
  }, opt);
  return s;
};

async function play(g: Gen, session: Session, calls: Call[], processLang: (i: number) => Language) {
  const workspace = g.folder ? [{ name: "d/a.txt", text: "abc" }, { name: "d/b.txt", text: "x".repeat(50) }] : undefined;
  const drivers = () => Object.fromEntries(g.seeds.map((s, i) => [`p${i + 1}`, randomDriver(s, calls, g.folder)]));
  const texts = new Map<string, string>(); // draft texts between segments, like snapshots on disk
  const draftStore = { save: (id: string, t: string) => (texts.set(id, t), { chars: t.length, sha256: "" }), load: ({ draftId }: { draftId: string }) => texts.get(draftId)! };
  setProcessLanguage(processLang(0));
  let events: SessionEvent[] = (await runSession({ session, drivers: drivers(), draftStore, ...(workspace ? { workspace } : {}) })).events;
  for (const [i, r] of g.resumes.entries()) {
    setProcessLanguage(processLang(i + 1));
    const state = foldEvents(events);
    const replacements = r.replace
      ? [{ oldParticipantId: "p1", participant: { id: `p${state.session!.participants.length + 1}`, name: "Z", providerId: "scripted", model: "m", role: null } }]
      : undefined;
    const run = await runSession({
      session: state.session!, drivers: drivers(), draftStore, ...(workspace ? { workspace } : {}),
      resume: { events, maxRounds: state.round + 1, ...(replacements && !state.session!.participants.some((p) => p.replaces === "p1") ? { replacements } : {}) },
    });
    events = [...events, ...run.events];
  }
  return events;
}

describe("Session language", () => {
  const before = getProcessLanguage();
  afterEach(() => setProcessLanguage(before));

  it("Language is recorded on creation: from the active language, explicit outranks", () => {
    setProcessLanguage("en");
    expect(createSession({ topic: "T", framing: "", origin: "cli", participants: people(2), limits: { maxRounds: 1, turnTimeoutSec: 1, contextChars: 1 } }, opt).language).toBe("en");
    setProcessLanguage("ru");
    expect(createSession({ topic: "T", framing: "", origin: "mcp", participants: people(2), limits: { maxRounds: 1, turnTimeoutSec: 1, contextChars: 1 } }, opt).language).toBe("ru");
    expect(createSession({ topic: "T", framing: "", origin: "desktop", participants: people(2), limits: { maxRounds: 1, turnTimeoutSec: 1, contextChars: 1 }, language: "en" }, opt).language).toBe("en");
  });

  it("the session_created event carries the language, the fold returns it in the state", async () => {
    setProcessLanguage("en");
    const calls: Call[] = [];
    const { events } = await runSession({ session: sessionOf(generate(1), undefined), drivers: Object.fromEntries([1, 2, 3, 4].map((i) => [`p${i}`, randomDriver(i, calls, false)])) });
    expect(events[0]).toMatchObject({ type: "session_created", session: { language: "en" } });
    expect(sessionLanguage(foldEvents(events).session!)).toBe("en");
  });

  it("Journal without language: read as ru", () => {
    const line = { seq: 1, ts: "2026-01-01T00:00:00Z", type: "session_created", pid: 1, session: {
      id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "T", templateId: null, framing: "",
      participants: people(2).map((p, i) => ({ ...p, id: `p${i + 1}` })), limits: { maxRounds: 1, turnTimeoutSec: 1, contextChars: 1 },
    } };
    const ev = SessionEventSchema.parse(line) as Extract<SessionEvent, { type: "session_created" }>;
    expect("language" in ev.session).toBe(false);
    expect(sessionLanguage(foldEvents([ev]).session!)).toBe("ru");
  });

  it("unknown language in the journal is rejected by the schema", () => {
    expect(SessionSchema.safeParse({ ...sessionOf(generate(2), "en"), language: "de" }).success).toBe(false);
  });

  it("Language changed between preview and launch: session in the language at creation, same set", async () => {
    const workspace = [{ name: "d/a.txt", text: "abc" }];
    setProcessLanguage("en");
    const preview = buildMaterialsPreview({ language: getProcessLanguage(), materials: [], workspace, skipped: [], left: [] });
    expect(preview.manifest).toContain("# Owner's folder\n");
    setProcessLanguage("ru");
    const session = createSession({ topic: "T", framing: "", origin: "desktop", participants: people(2), limits: { maxRounds: 1, turnTimeoutSec: 30, contextChars: 1000 }, workspace }, opt);
    expect(session.language).toBe("ru");
    const calls: Call[] = [];
    setProcessLanguage("en");
    await runSession({ session, workspace, drivers: { p1: randomDriver(1, calls, false), p2: randomDriver(2, calls, false) } });
    expect(calls[0]!.prompt).toContain(preview.manifest!.replace("# Owner's folder", "# Папка владельца").split("\n").at(-1)!);
    expect(calls.every((c) => c.prompt.includes("# Папка владельца\n") && !c.prompt.includes("# Owner's folder"))).toBe(true);
  });

  it("Session language is unchanged: continuations and replacements under any active language (property, 60 journals)", async () => {
    const reached = { correction: 0, served: 0, omitted: 0, replaced: 0, draft: 0, draftServed: 0, draftCorrection: 0 };
    for (let seed = 1; seed <= 60; seed++) {
      const g = generate(seed);
      const created: Language = seed % 2 === 0 ? "en" : "ru";
      const calls: Call[] = [];
      setProcessLanguage(created);
      const session = sessionOf(g, undefined);
      const events = await play(g, session, calls, (i) => (i === 0 ? created : g.resumes[i - 1]!.lang));
      const ctx = `seed ${seed}`;
      expect(events.filter((e) => e.type !== "session_created" && "language" in e), ctx).toEqual([]);
      expect(events.filter((e) => e.type === "session_created"), ctx).toHaveLength(1);
      expect((events[0] as Extract<SessionEvent, { type: "session_created" }>).session, ctx).toEqual(session);
      expect(sessionLanguage(foldEvents(events).session!), ctx).toBe(created);
      expect(calls.length, ctx).toBeGreaterThan(0);
      reached.replaced += events.filter((e) => e.type === "session_resumed" && e.replacements).length;
      for (const c of calls) {
        if (/# (Fix your previous answer|Исправь предыдущий ответ)/.test(c.prompt)) reached.correction++;
        if (/# (Requested files|Запрошенные файлы)/.test(c.prompt)) reached.served++;
        if (/\[(Early turns omitted|Ранние ходы опущены)/.test(c.prompt)) reached.omitted++;
        if (/# (Independent draft rules|Правила независимого черновика)/.test(c.prompt)) {
          reached.draft++;
          if (/# (Requested files|Запрошенные файлы)/.test(c.prompt)) reached.draftServed++;
          if (/# (Fix your previous answer|Исправь предыдущий ответ)/.test(c.prompt)) reached.draftCorrection++;
        }
        expect(c.language, ctx).toBe(created);
        expect(c.prompt, ctx).toContain(RULES_HEAD[created] === RULES_HEAD.en ? "Reply with one JSON object" : "Ответь одним JSON-объектом");
        expect(c.prompt, ctx).not.toContain(created === "en" ? "Ответь одним JSON-объектом" : "Reply with one JSON object");
      }
    }
    // The generator reaches boundary states: correction, requested files, journal truncation, replacement, drafts with files and correction.
    expect(Object.values(reached).every((n) => n > 0), JSON.stringify(reached)).toBe(true);
  });

  it("Requests of a Russian session are unchanged: recorded ru and a session without the field give byte-equal requests (property, 60 sessions)", async () => {
    for (let seed = 101; seed <= 160; seed++) {
      const g = generate(seed);
      const withRu: Call[] = [];
      const without: Call[] = [];
      const lang = () => (seed % 2 === 0 ? "en" : "ru") as Language; // the active language must not affect it
      await play(g, sessionOf(g, "ru"), withRu, lang);
      const { language: _l, ...old } = sessionOf(g, "ru");
      await play(g, old as Session, without, () => "en");
      expect(without.map((c) => c.prompt), `seed ${seed}`).toEqual(withRu.map((c) => c.prompt));
      expect(without.every((c) => c.language === "ru"), `seed ${seed}`).toBe(true);
    }
  });

  it("request assembly does not look at the process language", () => {
    const s = foldEvents([{ seq: 1, ts: "2026-01-01T00:00:00Z", type: "session_created", pid: 1, session: sessionOf(generate(5), "ru") }]);
    setProcessLanguage("en");
    const a = buildTurnPrompt(s, "p1");
    setProcessLanguage("ru");
    expect(buildTurnPrompt(s, "p1")).toBe(a);
    expect(a).toContain(RULES_HEAD.ru);
  });
});
