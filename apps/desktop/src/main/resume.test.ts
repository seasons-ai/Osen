import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResumeRejectedError, planResume, appendEvent, createScriptedDriver, createSession, createSessionJournal, eventsPath, initialRegistry, materialPath, readEvents, readSession, runStoredSession } from "@model-council/core";
import type { CollectedMaterial, Limits, Logger, ParticipantDriver, Session, SessionEvent } from "@model-council/core";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setProcessLanguage } from "@model-council/core/i18n";
import { createLauncher, LaunchError } from "./launcher.ts";
import { ReplacementInputError, nameReplacements, resumeScenarioPath, resumeView } from "./resume.ts";
import { rosterNames } from "../shared/setup.ts";
import type { ProviderOption, RegistryView } from "../shared/setup.ts";

type Step = NonNullable<Parameters<typeof createScriptedDriver>[0]>["steps"][number];
const resp = (stance: string, solution: string | null): Step => ({ response: { stance, reasoning: "r", solution, answers: [], questions: [] } });
const amend = (t: string) => resp("amend", t);
const agree = (delayMs?: number): Step => ({ ...resp("agree", null), ...(delayMs ? { delayMs } : {}) });
const object = () => resp("object", null);
const fatal: Step = { error: "fatal", retryable: false };
const env = { COUNCIL_DEV: "1" };
const logs: string[] = [];
const logger: Logger = { info: (m) => { logs.push(m); }, error: () => {} };
const never = (): Promise<never> => new Promise(() => {});

let dir: string;
let runs: Promise<unknown>[];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "council-resume-")); runs = []; logs.length = 0; });
afterEach(async () => { await Promise.allSettled(runs); rmSync(dir, { recursive: true, force: true }); });

const scen = (name: string, steps: Step[]) => {
  const p = join(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify({ steps }));
  return p;
};
const drv = (...steps: Step[]) => createScriptedDriver({ steps }, env);

interface Mk { maxRounds?: number; origin?: Session["origin"]; models?: string[]; providers?: string[]; materials?: CollectedMaterial[]; n?: number; slow?: boolean; cap?: number }
const mk = (id: string, o: Mk = {}): Session =>
  createSession({
    topic: "Тема", framing: "", origin: o.origin ?? "mcp",
    limits: { maxRounds: o.maxRounds ?? 1, turnTimeoutSec: 30, contextChars: 20000, ...(o.cap !== undefined ? { maxTotalTokens: o.cap } : {}), ...(o.materials ? { materialsChars: 10000 } : {}) } as Limits,
    participants: Array.from({ length: o.n ?? 2 }, (_, i) => ({ name: `N${i + 1}`, providerId: o.providers?.[i] ?? "scripted", model: o.models?.[i] ?? `p${i + 1}`, role: null })),
    ...(o.materials ? { materials: o.materials } : {}),
  }, { maxParticipants: 8, id });
const prior = (session: Session, ds: ParticipantDriver[], extra: Partial<Parameters<typeof runStoredSession>[0]> = {}) =>
  runStoredSession({ session, drivers: Object.fromEntries(ds.map((d, i) => [`p${i + 1}`, d])), dataDir: dir, ...extra });

// round 1 without agreement; on resume both agree. Scenario files are in dir.
async function noConsensus(id: string, o: Mk = {}) {
  const f1 = scen(`${id}-p1`, [amend("v1"), agree(o.slow ? 400 : 0)]);
  const f2 = scen(`${id}-p2`, [object(), agree()]);
  await prior(mk(id, { models: [f1, f2], ...o }), [drv(amend("v1")), drv(object())], o.materials ? { materials: o.materials } : {});
  return [f1, f2] as const;
}

const provider = (o: Partial<ProviderOption> & { id: string }): ProviderOption =>
  ({ kind: "cli", label: o.id, available: true, reason: null, models: [], defaultModel: null, billing: "subscription", ...o });
const registry = (providers: ProviderOption[] = [], maxRounds = 4): RegistryView =>
  ({ providers, defaults: { maxRounds, maxParticipants: 8, materialsChars: 1000, maxTotalTokens: null, participants: [] }, ownerWait: { minSec: 1, maxSec: 86400, defaultSec: 300 } });
// Removes reasonCode from session_finished: such a failure cannot be resumed.
const unrecoverable = (id: string) => {
  const evs = readEvents(dir, id)!.events.map((e) => (e.type === "session_finished" ? (({ reasonCode: _r, ...rest }) => rest)(e as typeof e & { reasonCode?: string }) : e));
  writeFileSync(eventsPath(dir, id), evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
};
const view = (id: string, r = registry(), sp: (m: string) => string | null = resumeScenarioPath(() => null), replacements?: Parameters<typeof resumeView>[4]) => resumeView(dir, id, r, sp, replacements);

describe("resumeView", () => {
  it("remainder exists: stopped, the round is not finished", async () => {
    const ac = new AbortController();
    const stopper: ParticipantDriver = { call: () => (ac.abort(), never()) };
    const [f1, f2] = [scen("a", [agree()]), scen("b", [agree()])];
    await prior(mk("s", { maxRounds: 3, models: [f1, f2] }), [drv(amend("v1"), amend("v2")), stopper], { signal: ac.signal });
    const v = view("s");
    expect(v).toMatchObject({ allowed: true, reason: null, rounds: { min: 1, max: 20, remaining: 3, initial: 3 } });
    expect(v.participants.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(v.participants.every((p) => p.available && p.billing === "free")).toBe(true);
  });

  it("no remainder: remaining null, initial from the registry, participants listed", async () => {
    await noConsensus("s");
    const v = view("s", registry([], 5));
    expect(v).toMatchObject({ allowed: true, reason: null, rounds: { remaining: null, initial: 5 } });
    expect(v.participants).toHaveLength(2);
    expect(view("s", registry([], 99)).rounds.initial).toBe(20);
  });

  it("draftCalls: an ordinary session — 0; interrupted in the drafts phase — remainder 0 + 2 + 3", async () => {
    await noConsensus("n");
    expect(view("n").draftCalls).toBe(0);
    // a real run with a phase; the journal is cut right after p2's attempt starts: p1 accepted, p2 has an attempt without an outcome, p3 has not started
    const flag = { over: false };
    const drivers = Object.fromEntries(["p1", "p2", "p3"].map((id) => [id, {
      call: async () => ({ text: JSON.stringify({ stance: "amend", reasoning: "r", solution: flag.over ? `ХОД-${id}` : `ЧЕРНОВИК-${id}`, answers: [], questions: [] }), usage: { inputTokens: 1, outputTokens: 0, costUsd: 0 } }),
    } as ParticipantDriver]));
    const session = createSession({
      topic: "Тема", framing: "", origin: "cli", drafts: { synthesizerId: "p2" },
      limits: { maxRounds: 1, turnTimeoutSec: 30, contextChars: 20000 } as Limits,
      participants: [1, 2, 3].map((i) => ({ name: `N${i}`, providerId: "scripted", model: `p${i}`, role: null })),
    }, { maxParticipants: 8, id: "d" });
    await runStoredSession({ session, drivers, dataDir: dir, onEvent: (e) => { if (e.type === "drafts_finished") flag.over = true; } });
    const evs = readEvents(dir, "d")!.events;
    const idx = evs.findIndex((e) => e.type === "draft_attempt_started" && e.participantId === "p2");
    const cut = evs.slice(0, idx + 1).map((e) => (e.type === "session_created" ? { ...e, pid: 2 ** 22 + 1 } : e)); // the executor is dead
    writeFileSync(eventsPath(dir, "d"), cut.map((e) => JSON.stringify(e)).join("\n") + "\n");
    for (const f of ["d2", "d3"]) rmSync(join(dir, "sessions", "d", "drafts", `${f}.txt`), { force: true });
    expect(view("d")).toMatchObject({ allowed: true, draftCalls: 5 });
  });

  it("consensus, failed, unknown, running: allowed=false with a reason", async () => {
    await prior(mk("c"), [drv(amend("v1")), drv(agree())]);
    await prior(mk("f"), [drv(amend("v1")), drv(fatal)]);
    unrecoverable("f"); // the "fewer than two active" failure is now fixed by a replacement; here an unrecoverable one is needed
    for (const id of ["c", "f", "nope"]) {
      const v = view(id);
      expect(v).toMatchObject({ allowed: false, participants: [], rounds: { remaining: null }, draftCalls: 0 });
      expect(v.reason).toContain(id);
    }
    expect(readSession(dir, "c")?.status).toBe("consensus");
    expect(readSession(dir, "f")?.status).toBe("failed");
    const ac = new AbortController();
    runs.push(prior(mk("r"), [{ call: never }, { call: never }], { signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 100));
    expect(view("r")).toMatchObject({ allowed: false });
    expect(view("r").reason).toContain("идёт");
    ac.abort();
  });

  it("a dropped participant does not get into the list", async () => {
    const fs = [scen("a", [agree()]), scen("b", [agree()]), scen("c", [agree()])];
    await prior(mk("s", { maxRounds: 1, n: 3, models: fs }), [drv(amend("v1")), drv(fatal), drv(object())]);
    const v = view("s", registry([], 2));
    expect(v.participants.map((p) => p.id)).toEqual(["p1", "p3"]);
  });

  it("provider: unavailable, missing, spend flags", async () => {
    const fs = ["m", "x:free", "m"];
    await prior(mk("s", { n: 3, maxRounds: 1, providers: ["sub", "web", "gone"], models: fs }), [drv(amend("v1")), drv(object()), drv(object())]);
    const r = registry([
      provider({ id: "sub", billing: "subscription", available: false, reason: "не найден" }),
      provider({ id: "web", kind: "openai-http", billing: "paid" }),
    ]);
    expect(view("s", r).participants).toEqual([
      { id: "p1", name: "N1", billing: "subscription", available: false, reason: "не найден" },
      { id: "p2", name: "N2", billing: "free", available: true, reason: null },
      { id: "p3", name: "N3", billing: "free", available: false, reason: "провайдер «gone» отсутствует в реестре" },
    ]);
    const paid = registry([provider({ id: "sub" }), provider({ id: "web", kind: "openai-http", billing: "paid" }), provider({ id: "gone", billing: "free" })]);
    expect(view("s", paid).participants.map((p) => p.billing)).toEqual(["subscription", "free", "free"]);
    const nofree = mk("t", { n: 2, providers: ["web", "web"], models: ["gpt", "gpt"] });
    await prior(nofree, [drv(amend("v1")), drv(object())]);
    expect(view("t", paid).participants.map((p) => p.billing)).toEqual(["paid", "paid"]);
  });

  it("scenario: by name, by absolute path, by relative path (unavailable)", async () => {
    const f2 = scen("abs", [agree()]);
    await prior(mk("s", { models: ["byname", f2] }), [drv(amend("v1")), drv(object())]);
    await prior(mk("t", { models: ["byname", "rel/p.json"] }), [drv(amend("v1")), drv(object())]);
    const sp = resumeScenarioPath((m) => (m === "byname" ? "/x/byname.json" : null));
    expect(view("s", registry(), sp).participants.map((p) => p.available)).toEqual([true, true]);
    const t = view("t", registry(), sp).participants;
    expect(t.map((p) => p.available)).toEqual([true, false]);
    expect(t[1]!.reason).toContain("rel/p.json");
    expect(resumeScenarioPath(() => null)("/нет/такого.json")).toBeNull();
  });
});

describe("launcher.resume", () => {
  const make = (extra: Partial<Parameters<typeof createLauncher>[0]> = {}) => createLauncher({
    dataDir: dir, env, logger, registry: () => initialRegistry(["claude"]), catalog: () => ({ templates: [], errors: [], neutralFraming: "" }) as never,
    scenarioPath: () => null, ...extra,
  });
  const settle = async () => { await new Promise((r) => setTimeout(r, 700)); };

  it("a session from another source: resolution after session_resumed, running(), onChunk, onEnded", async () => {
    await noConsensus("s", { origin: "mcp", slow: true });
    const chunks: string[] = [];
    const ended: string[] = [];
    const l = make({ onChunk: (id) => chunks.push(id), onEnded: (id) => ended.push(id) });
    const r = await l.resume("s", 2);
    expect(r).toEqual({ droppedOwnerRequests: [] });
    expect(readEvents(dir, "s")!.events.some((e) => e.type === "session_resumed")).toBe(true);
    expect(l.running()).toEqual(["s"]);
    await settle();
    expect(l.running()).toEqual([]);
    expect(ended).toEqual(["s"]);
    expect(readSession(dir, "s")?.status).toBe("consensus");
    expect(logs.some((m) => m.includes("Resume request for session s: rounds 2"))).toBe(true);
    expect(logs.some((m) => m.includes("unapplied messages removed 0"))).toBe(true);
  });

  it("double call: the same promise and one session_resumed; after resolution — an engine refusal", async () => {
    await noConsensus("s", { origin: "cli" });
    const l = make();
    const a = l.resume("s", 2);
    const b = l.resume("s", 2);
    expect(b).toBe(a);
    await a;
    expect(readEvents(dir, "s")!.events.filter((e) => e.type === "session_resumed")).toHaveLength(1);
    await settle();
  });

  it("a repeat right after resolution while the segment runs: \"session is running\"", async () => {
    await noConsensus("s", { slow: true });
    const l = make();
    await l.resume("s", 2);
    await expect(l.resume("s", 1)).rejects.toThrow(/идёт/);
    expect(readEvents(dir, "s")!.events.filter((e) => e.type === "session_resumed")).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 600));
  });

  it("engine refusal: consensus", async () => {
    await prior(mk("c"), [drv(amend("v1")), drv(agree())]);
    const before = readEvents(dir, "c")!.events.length;
    const l = make();
    await expect(l.resume("c", 1)).rejects.toThrow(/согласие уже достигнуто/);
    expect(readEvents(dir, "c")!.events).toHaveLength(before);
    expect(l.running()).toEqual([]);
    expect(logs.some((m) => m.includes("rejected: consensus"))).toBe(true);
  });

  it("engine refusal: the material snapshot is deleted", async () => {
    const text = "материал";
    const m: CollectedMaterial = { id: "m1", name: "a.txt", chars: text.length, sha256: createHash("sha256").update(text, "utf8").digest("hex"), text };
    await noConsensus("s", { materials: [m] });
    rmSync(materialPath(dir, "s", "m1"));
    const before = readEvents(dir, "s")!.events.length;
    const l = make();
    await expect(l.resume("s", 1)).rejects.toThrow(/Материал «a.txt»/);
    expect(readEvents(dir, "s")!.events).toHaveLength(before);
    expect(l.running()).toEqual([]);
  });

  it("unavailable scenario: refusal without a journal entry", async () => {
    await prior(mk("s", { models: ["rel/p1.json", "rel/p2.json"] }), [drv(amend("v1")), drv(object())]);
    await expect(make().resume("s", 1)).rejects.toThrow(/сценарий «rel\/p1.json» недоступен/);
  });

  it("rounds out of bounds is rejected", async () => {
    await noConsensus("s");
    for (const n of [0, 21, 1.5]) await expect(make().resume("s", n)).rejects.toThrow(/от 1 до 20/);
  });

  it("returns the texts of deleted unapplied messages", async () => {
    await noConsensus("s");
    const open = join(dir, "sessions", "s", "owner-messages");
    mkdirSync(open, { recursive: true });
    writeFileSync(join(open, "001-x.json"), JSON.stringify({ text: "забытая реплика", createdAt: "2026-01-01T00:00:00Z" }));
    const r = await make().resume("s", 2);
    expect(r.droppedOwnerRequests).toEqual(["забытая реплика"]);
    await settle();
  });
});

describe("resumeView: token ceiling", () => {
  const tok = (st: Step): Step => ({ ...st, inputTokens: 300, outputTokens: 200 });
  // each turn 500 tokens; three turns without agreement
  const run3 = (id: string, o: Mk) => prior(mk(id, { n: 3, ...o }), [drv(tok(amend("v1"))), drv(tok(object())), drv(tok(object()))]);

  it("stopped by the ceiling: the view is built, exhausted", async () => {
    await run3("s", { maxRounds: 5, cap: 1200, models: [scen("a", [agree()]), scen("b", [agree()]), scen("c", [agree()])] });
    expect(readSession(dir, "s")?.state.finish?.reason).toBe("token_cap");
    const v = view("s");
    expect(v).toMatchObject({ allowed: true, tokenCap: { cap: 1200, spent: 1500, exhausted: true } });
    expect(v.participants).toHaveLength(3);
    expect(v.rounds.remaining).not.toBeNull();
  });

  it("ceiling not exhausted: the spend is visible", async () => {
    await run3("s", { cap: 5000, models: [scen("a", [agree()]), scen("b", [agree()]), scen("c", [agree()])] });
    expect(readSession(dir, "s")?.status).toBe("no_consensus");
    expect(view("s", registry([], 5))).toMatchObject({ allowed: true, tokenCap: { cap: 5000, spent: 1500, exhausted: false } });
  });

  it("without a ceiling: cap null", async () => {
    await run3("s", { models: [scen("a", [agree()]), scen("b", [agree()]), scen("c", [agree()])] });
    expect(view("s").tokenCap).toEqual({ cap: null, spent: 1500, exhausted: false });
  });

  it("ceiling and rounds exhausted: the view is built, no remainder", async () => {
    await run3("s", { maxRounds: 1, cap: 1200, models: [scen("a", [agree()]), scen("b", [agree()]), scen("c", [agree()])] });
    const v = view("s");
    expect(v).toMatchObject({ allowed: true, rounds: { remaining: null }, tokenCap: { cap: 1200, spent: 1500, exhausted: true } });
  });

  it("interrupted with an exhausted ceiling", () => {
    const session = mk("i", { maxRounds: 5, cap: 1200 });
    createSessionJournal(dir, "i");
    const turns = (n: number, seq: number): SessionEvent[] => [
      { seq, ts: session.createdAt, type: "turn_started", turn: n, round: 1, participantId: `p${(n % 2) + 1}` },
      { seq: seq + 1, ts: session.createdAt, type: "turn_completed", turn: n, round: 1, participantId: `p${(n % 2) + 1}`, stance: "amend", normalized: false, reasoning: "r", solution: "v", version: n, questions: [], answers: [], attempts: 1, usage: { inputTokens: 300, outputTokens: 200 }, durationMs: 1 },
    ];
    appendEvent(dir, "i", { seq: 1, ts: session.createdAt, type: "session_created", session, pid: 4_000_000 });
    [...turns(1, 2), ...turns(2, 4), ...turns(3, 6)].forEach((e) => appendEvent(dir, "i", e));
    expect(readSession(dir, "i")?.status).toBe("interrupted");
    expect(view("i").tokenCap).toEqual({ cap: 1200, spent: 1500, exhausted: true });
  });

  it("consensus: allowed=false, the ceiling is zero", async () => {
    await prior(mk("c", { maxRounds: 3 }), [drv(amend("v1"), agree()), drv(agree(), agree())]);
    expect(readSession(dir, "c")?.status).toBe("consensus");
    const v = view("c");
    expect(v.allowed).toBe(false);
    expect(v.tokenCap).toEqual({ cap: null, spent: 0, exhausted: false });
  });
});

describe("resumeView: participant replacements", () => {
  const scriptedProvider = provider({ id: "scripted", kind: "scripted", label: "Сценарный", defaultModel: null, billing: "free" });
  const reg = () => registry([scriptedProvider]);
  const catalogSession = () => {
    const cat = scen("cat", [agree(), agree()]);
    return { cat, sp: resumeScenarioPath((m) => (m === "cat" ? cat : null)) };
  };
  // p1 takes turns, p2 drops out with a fatal error: the "fewer than two active" failure, fixed by a replacement
  const failedSession = async (id: string) => {
    const f1 = scen(`${id}-p1`, [agree(), agree()]);
    const f2 = scen(`${id}-p2`, [agree()]);
    await prior(mk(id, { models: [f1, f2] }), [drv(amend("v1")), drv(fatal)]);
    return [f1, f2] as const;
  };
  const swap = (participantId: string, model = "cat", providerId = "scripted") => [{ participantId, providerId, model }];

  it("fixable failure without replacements: allowed, blocked names the dropped one, the replacement list", async () => {
    await failedSession("f");
    expect(readSession(dir, "f")?.status).toBe("failed");
    const { sp } = catalogSession();
    const v = view("f", reg(), sp);
    expect(v.allowed).toBe(true);
    expect(v.blocked).toContain("p2");
    expect(v.replaceable).toEqual([expect.objectContaining({ id: "p2", why: "dropped", required: false })]);
    expect(v.participants.map((p) => p.id)).toEqual(["p1"]);
    expect(v.providers.length).toBeGreaterThan(0);
    expect(v.replacements).toEqual([]);
    expect(v.agreementReset).toBe(false);
    expect(v.draftCalls).toBe(0);
  });

  it("fixable failure with a replacement: the new participant p3 named by the setup rules", async () => {
    const [f1] = await failedSession("f");
    const { cat, sp } = catalogSession();
    const r = reg();
    const v = view("f", r, sp, swap("p2"));
    expect(v.blocked).toBeNull();
    expect(v.participants.map((p) => p.id)).toEqual(["p1", "p3"]);
    expect(v.participants[1]).toMatchObject({ available: true, replaces: "p2" });
    const names = rosterNames([{ providerId: "scripted", model: f1 }, { providerId: "scripted", model: readSession(dir, "f")!.state.session!.participants[1]!.model }, { providerId: "scripted", model: "cat" }], r.providers);
    expect(v.replacements).toEqual([{ participantId: "p2", newId: "p3", name: names[2], providerId: "scripted", model: "cat" }]);
    expect(v.replacements[0]!.name).not.toBe("Участник 3");
    expect(v.agreementReset).toBe(true);
    expect(v.rounds.max).toBe(20);
    expect(v.draftCalls).toBe(0);
    expect(cat).toBeTruthy();
  });

  it("unavailable active one: required in the list, with a replacement it drops out of participants", async () => {
    const [, f2] = await noConsensus("u");
    rmSync(f2);
    const { sp } = catalogSession();
    const a = view("u", reg(), sp);
    expect(a.allowed).toBe(true);
    expect(a.participants.find((p) => p.id === "p2")).toMatchObject({ available: false });
    expect(a.replaceable).toEqual([expect.objectContaining({ id: "p2", why: "unavailable", required: true })]);
    const b = view("u", reg(), sp, swap("p2"));
    expect(b.participants.map((p) => p.id)).toEqual(["p1", "p3"]);
    expect(b.replaceable.map((x) => x.id)).toEqual(["p2"]);
    expect(b.participants.find((p) => p.id === "p3")).toMatchObject({ replaces: "p2", available: true });
  });

  it("replacement entry: a path instead of a catalog, an unknown provider, not pN — a window refusal", async () => {
    await failedSession("f");
    const { cat, sp } = catalogSession();
    expect(() => view("f", reg(), sp, swap("p2", cat))).toThrow(ReplacementInputError);
    expect(() => view("f", reg(), sp, swap("p2", "cat", "nope"))).toThrow(/провайдера «nope»/);
    expect(() => view("f", reg(), sp, swap("2"))).toThrow(/participantId/);
    expect(() => view("f", reg(), sp, swap("p2", "нет-такого"))).toThrow(/нет в каталоге/);
  });

  it("a repeated replacement of an already replaced one: the engine refusal is passed through", async () => {
    await failedSession("f");
    const { sp } = catalogSession();
    expect(() => view("f", reg(), sp, [...swap("p2"), ...swap("p2")])).toThrow(ResumeRejectedError);
  });

  it("the new participant's provider is unavailable: available false with a reason", async () => {
    await failedSession("f");
    const { sp } = catalogSession();
    const down = provider({ id: "web", kind: "openai-http", label: "Веб", available: false, reason: "нет ключа", billing: "paid" });
    const v = view("f", registry([scriptedProvider, down]), sp, swap("p2", "m", "web"));
    expect(v.participants.find((p) => p.id === "p3")).toMatchObject({ available: false, reason: "нет ключа", replaces: "p2" });
  });

  it("few active, an active one is unavailable and already being replaced: it is not in participants, the rest as without a map", async () => {
    const f1 = scen("g-p1", [agree()]);
    await prior(mk("g", { models: [f1, scen("g-p2", [agree()])] }), [drv(amend("v1")), drv(fatal)]);
    rmSync(f1); // p1 is now unavailable
    const { sp } = catalogSession();
    const none = view("g", reg(), sp);
    expect(none.participants.map((p) => p.id)).toEqual(["p1"]);
    const v = view("g", reg(), sp, swap("p1"));
    expect(v.blocked).toContain("p2");
    expect(v.participants).toEqual([]);
    expect(v.replacements).toEqual([]);
    expect(v.agreementReset).toBe(false);
    expect(v.replaceable.map((x) => x.id)).toEqual(["p1", "p2"]);
  });

  it("unfixable failure and consensus: allowed false, no replacements", async () => {
    await failedSession("f");
    unrecoverable("f");
    await prior(mk("c"), [drv(amend("v1")), drv(agree())]);
    for (const id of ["f", "c"]) {
      expect(view(id, reg())).toMatchObject({ allowed: false, blocked: null, replaceable: [], replacements: [], providers: [], agreementReset: false });
    }
  });

  it("an ordinary session without replacements: no new obstacles", async () => {
    await noConsensus("n");
    expect(view("n", reg())).toMatchObject({ allowed: true, reason: null, blocked: null, replaceable: [], replacements: [], agreementReset: false, rounds: { remaining: null }, draftCalls: 0 });
  });
});

describe("launcher.resume: participant replacements", () => {
  const catDir = () => join(dir, "catalog");
  const make = () => createLauncher({
    dataDir: dir, env, logger, registry: () => initialRegistry(["claude"]), catalog: () => ({ templates: [], errors: [], neutralFraming: "" }) as never,
    scenarioPath: (m) => (existsSync(join(catDir(), m)) ? join(catDir(), m) : null),
  });
  const setupFiles = () => {
    mkdirSync(catDir(), { recursive: true });
    writeFileSync(join(catDir(), "cat.json"), JSON.stringify({ steps: [agree(), agree()] }));
  };
  const journal = (id: string) => readFileSync(eventsPath(dir, id));
  const settle = async () => { await new Promise((r) => setTimeout(r, 700)); };
  const failed = async (id: string) => {
    const f1 = scen(`${id}-p1`, [agree(), agree()]);
    await prior(mk(id, { models: [f1, scen(`${id}-p2`, [agree()])] }), [drv(amend("v1")), drv(fatal)]);
  };
  const swap = [{ participantId: "p2", providerId: "scripted", model: "cat.json" }];

  it("replacing a dropped one: one session_resumed with replacements, the name as in the view", async () => {
    await failed("f");
    setupFiles();
    const sp = resumeScenarioPath((m) => (existsSync(join(catDir(), m)) ? join(catDir(), m) : null));
    const r = registry([provider({ id: "scripted", kind: "scripted", label: "Сценарный", defaultModel: null, billing: "free" }), provider({ id: "claude", label: "Claude", defaultModel: "default" })]);
    const v = resumeView(dir, "f", r, sp, swap);
    await make().resume("f", 2, undefined, swap);
    const resumed = readEvents(dir, "f")!.events.filter((e) => e.type === "session_resumed") as unknown as { replacements: { participant: { name: string; id: string } }[] }[];
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.replacements).toHaveLength(1);
    expect(resumed[0]!.replacements[0]!.participant.name).toBe(v.replacements[0]!.name);
    expect(logs.some((m) => m.includes("rounds 2, replacements 1"))).toBe(true);
    await settle();
    expect(readSession(dir, "f")?.status).not.toBe("running");
  });

  it("double call: the same promise and one session_resumed", async () => {
    await failed("f");
    setupFiles();
    const l = make();
    const a = l.resume("f", 2, undefined, swap);
    const b = l.resume("f", 2, undefined, swap);
    expect(b).toBe(a);
    await a;
    expect(readEvents(dir, "f")!.events.filter((e) => e.type === "session_resumed")).toHaveLength(1);
    await settle();
  });

  it("a repeat with the same replacement set in another order — the same promise; with other parameters — LaunchError, the journal has the first map", async () => {
    await failed("f");
    setupFiles();
    const two = [...swap, { participantId: "p1", providerId: "scripted", model: "cat.json" }];
    const l = make();
    const a = l.resume("f", 2, undefined, two);
    expect(l.resume("f", 2, undefined, [...two].reverse())).toBe(a);
    await expect(l.resume("f", 2, undefined, swap)).rejects.toBeInstanceOf(LaunchError);
    await expect(l.resume("f", 3, undefined, two)).rejects.toBeInstanceOf(LaunchError);
    await expect(l.resume("f", 2, null, two)).rejects.toBeInstanceOf(LaunchError);
    await a.catch(() => {}); // p1 is available — the engine refuses; what matters is only that the repeats did not pass
  });

  it("another map while a request is running: refusal, the journal has one session_resumed with the map of the first call", async () => {
    await failed("f");
    setupFiles();
    writeFileSync(join(catDir(), "other.json"), JSON.stringify({ steps: [agree(), agree()] }));
    const l = make();
    const a = l.resume("f", 2, undefined, swap);
    await expect(l.resume("f", 2, undefined, [{ ...swap[0]!, model: "other.json" }])).rejects.toBeInstanceOf(LaunchError);
    await a;
    const resumed = readEvents(dir, "f")!.events.filter((e) => e.type === "session_resumed") as unknown as { replacements: { participant: { model: string } }[] }[];
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.replacements[0]!.participant.model).toBe("cat.json");
    await settle();
  });

  it("replacing an available active one: engine refusal, the journal unchanged", async () => {
    await noConsensus("s");
    setupFiles();
    const before = journal("s");
    await expect(make().resume("s", 2, undefined, swap)).rejects.toBeInstanceOf(ResumeRejectedError);
    expect(journal("s").equals(before)).toBe(true);
  });

  it("a bad map: LaunchError, the journal unchanged", async () => {
    await failed("f");
    setupFiles();
    const before = journal("f");
    for (const bad of [{}, [{ participantId: "x", providerId: "scripted", model: "cat.json" }], [{ participantId: "p2", providerId: "scripted", model: join(catDir(), "cat.json") }], [{ participantId: "p2", providerId: "ghost", model: "m" }]]) {
      await expect(make().resume("f", 2, undefined, bad as never)).rejects.toBeInstanceOf(LaunchError);
    }
    expect(journal("f").equals(before)).toBe(true);
  });

  it("scenario disappeared after the view: refusal, the journal unchanged", async () => {
    await failed("f");
    setupFiles();
    rmSync(join(catDir(), "cat.json"));
    const before = journal("f");
    await expect(make().resume("f", 2, undefined, swap)).rejects.toThrow();
    expect(journal("f").equals(before)).toBe(true);
  });
});

describe("resumeView and the replacement map: process language at call time", () => {
  afterEach(() => { setProcessLanguage("ru"); });
  const scriptedProvider = provider({ id: "scripted", kind: "scripted", label: "Сценарный", defaultModel: null, billing: "free" });
  const sp = resumeScenarioPath(() => null);
  const msg = (raw: unknown): string => {
    try { nameReplacements(raw, [{ providerId: "scripted", model: "a" }], [scriptedProvider], sp); } catch (e) { return (e as Error).message; }
    return "";
  };
  const swap = (o: Record<string, unknown>) => [{ participantId: "p1", providerId: "scripted", model: "x", ...o }];

  it("unavailable scenario and a provider outside the registry: the reason in the call language, the provider reason unchanged", async () => {
    await prior(mk("s", { n: 3, maxRounds: 1, providers: ["scripted", "gone", "sub"], models: ["rel/p.json", "m", "m"] }), [drv(amend("v1")), drv(object()), drv(object())]);
    const r = registry([provider({ id: "sub", available: false, reason: "не найден: Reason from provider" })]);
    setProcessLanguage("en");
    const en = view("s", r).participants.map((p) => p.reason);
    setProcessLanguage("ru");
    const ru = view("s", r).participants.map((p) => p.reason);
    expect(en).toEqual(["scenario “rel/p.json” is unavailable", "provider “gone” is missing from the registry", "не найден: Reason from provider"]);
    expect(ru).toEqual(["сценарий «rel/p.json» недоступен", "провайдер «gone» отсутствует в реестре", "не найден: Reason from provider"]);
  });

  it("dropped one: the reason from the journal as recorded in both languages", async () => {
    await prior(mk("f", { models: [scen("f-p1", [agree()]), scen("f-p2", [agree()])] }), [drv(amend("v1")), drv(fatal)]);
    const reg = registry([scriptedProvider]);
    const recorded = readSession(dir, "f")!.state.participants.find((p) => p.id === "p2")!.dropReason!;
    expect(recorded).toBeTruthy();
    for (const l of ["en", "ru"] as const) {
      setProcessLanguage(l);
      expect(view("f", reg).replaceable[0]!.reason).toBe(recorded);
    }
    // ponytail: the "reason not specified" branch is unreachable through the journal: the participant_dropped schema requires reason (z.string()).
  });

  it("replacement map refusals: English at en, the previous ones at ru", () => {
    const cases: [unknown, string, string][] = [
      ["x", "Replacements must be an array.", "Замены должны быть массивом."],
      [[{ participantId: "px" }], "Replacement 1: participantId must look like p1, p2…", "Замена 1: participantId должен быть вида p1, p2…"],
      [swap({ model: "" }), "Replacement 1 (p1): non-empty providerId and model are required.", "Замена 1 (p1): нужны непустые providerId и model."],
      [swap({}), "Replacement 1 (p1): scenario “x” is not in the catalog.", "Замена 1 (p1): сценария «x» нет в каталоге."],
      [swap({ providerId: "zz" }), "Replacement 1 (p1): provider “zz” is not in the registry.", "Замена 1 (p1): провайдера «zz» нет в реестре."],
      [swap({ model: "no/such.json" }), "Replacement 1 (p1): scenario “no/such.json” is not in the catalog.", "Замена 1 (p1): сценария «no/such.json» нет в каталоге."],
      [swap({ model: "/Users/owner/Desktop/Мозговой штурм/packages/core/scenarios/dropout/p3.json" }),
        "Replacement 1 (p1): scenario “p3.json” is given as a path, not as a name from the catalog.",
        "Замена 1 (p1): сценарий «p3.json» задан путём, а не именем из каталога."],
    ];
    for (const [raw, en, ru] of cases) {
      setProcessLanguage("en");
      expect(msg(raw)).toBe(en);
      setProcessLanguage("ru");
      expect(msg(raw)).toBe(ru);
    }
  });

  it("the core refusal text goes as is in both languages", async () => {
    await prior(mk("c"), [drv(amend("v1")), drv(agree())]);
    const core = (): string => { try { planResume(dir, "c", {}); } catch (e) { return (e as Error).message; } return ""; };
    for (const l of ["en", "ru"] as const) {
      setProcessLanguage(l);
      const v = view("c", registry());
      expect(v.allowed).toBe(false);
      expect(v.reason).toBeTruthy();
      expect(v.reason).toBe(core());
    }
  });
});
