import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { foldEvents } from "@model-council/core/protocol";
import type { SessionEvent } from "@model-council/core/protocol";
import { afterEach } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import { Avatar, MaterialsRow, PHASE, PhaseBadge, STANCE, Who, bareNameOf, chars, failReason, linkify, modelOf, nameOf, num, participantPhase, phaseWord, progress, splitName, stanceWord } from "./session-ui.tsx";
import { BADGES, StatusBadge, statusText } from "./StatusBadge.tsx";
import type { ParticipantPhase } from "./session-ui.tsx";
import type { StoredStatus } from "@model-council/core";

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;
const mk = (bodies: Body[]): SessionEvent[] => bodies.map((b, i) => ({ ...b, seq: i + 1, ts: "2026-01-01T00:00:00Z" }) as SessionEvent);

const created = (n = 3): Body => ({
  type: "session_created", pid: 1,
  session: {
    id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "Цена", templateId: null, framing: "",
    participants: Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Имя${i + 1}`, providerId: "scripted", model: "m", role: null })),
    limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
  },
});
const started = (turn: number, participantId: string): Body => ({ type: "turn_started", turn, round: 1, participantId });
const done = (
  turn: number, participantId: string, stance: "amend" | "agree" | "object", version: number,
  extra: { reasoning?: string; questions?: { id: string; to: string; text: string }[]; answers?: { questionId: string; text: string }[] } = {},
): Body => ({
  type: "turn_completed", turn, round: 1, participantId, stance, normalized: false, reasoning: extra.reasoning ?? `аргумент ${turn}`,
  solution: stance === "amend" ? `текст v${version}` : null, version,
  questions: extra.questions ?? [], answers: extra.answers ?? [], attempts: 1, usage: {}, durationMs: 5,
});

const fold = (bodies: Body[]) => foldEvents(mk(bodies));
describe("linkify", () => {
  const out = (t: string) => renderToStaticMarkup(<>{linkify(t)}</>);
  it("https becomes a link, the dot is not included", () => {
    expect(out("см. https://example.com/a.")).toBe('см. <a href="https://example.com/a" target="_blank" rel="noreferrer">https://example.com/a</a>.');
  });
  it("dangerous schemes stay as text", () => {
    expect(out("javascript:alert(1) file:///etc/passwd")).not.toContain("<a");
  });
});

describe("participantPhase", () => {
  const base = [created(3), started(1, "p1"), done(1, "p1", "amend", 1)];
  it("waiting, thinking, agreeing", () => {
    const s = fold([...base, started(2, "p2")]);
    expect(participantPhase(s, "p3", true)).toBe("waiting");
    expect(participantPhase(s, "p2", true)).toBe("thinking");
    expect(participantPhase(s, "p1", true)).toBe("agreed");
  });
  it("without running nobody is thinking", () => {
    expect(participantPhase(fold([...base, started(2, "p2")]), "p2", false)).toBe("waiting");
  });
  it("objecting while the version is the same; after a new version waiting again", () => {
    const o = fold([...base, started(2, "p2"), done(2, "p2", "object", 1)]);
    expect(participantPhase(o, "p2", true)).toBe("objecting");
    const n = fold([...base, started(2, "p2"), done(2, "p2", "object", 1), started(3, "p3"), done(3, "p3", "amend", 2)]);
    expect(participantPhase(n, "p2", true)).toBe("waiting");
  });
  it("departed", () => {
    const s = fold([created(3), { type: "participant_dropped", participantId: "p3", reason: "таймаут" } as unknown as Body]);
    expect(participantPhase(s, "p3", true)).toBe("dropped");
  });
});

describe("progress", () => {
  it("two of three and one open question", () => {
    const s = fold([created(3), started(1, "p1"), done(1, "p1", "amend", 1, { questions: [{ id: "q1", to: "p3", text: "?" }] }), started(2, "p2"), done(2, "p2", "agree", 1)]);
    expect(progress(s)).toEqual({ round: 1, maxRounds: 3, agreed: 2, active: 3, openQuestions: 1, consensus: false, drafting: null });
  });
  it("all agree without questions", () => {
    const s = fold([created(2), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "agree", 1)]);
    expect(progress(s).consensus).toBe(true);
  });
  it("a departed one is not in active", () => {
    const s = fold([created(3), { type: "participant_dropped", participantId: "p3", reason: "x" } as unknown as Body]);
    expect(progress(s).active).toBe(2);
  });
});

describe("num / nameOf", () => {
  const s = fold([created(2)]);
  it("known and unknown id", () => {
    expect(num(s.session, "p2")).toBe(2);
    expect(nameOf(s.session, "p2")).toBe("Имя2");
    expect(num(s.session, "zz")).toBe(0);
    expect(nameOf(s.session, "zz")).toBe("zz");
    expect(num(null, "p1")).toBe(0);
  });
});

describe("participant model separately from the name", () => {
  it("splitName removes the suffix of the recorded model and keeps the repeat number", () => {
    expect(splitName("Claude Code (sonnet)", "sonnet")).toEqual({ name: "Claude Code", model: "sonnet" });
    expect(splitName("Claude Code (sonnet) #2", "sonnet")).toEqual({ name: "Claude Code #2", model: "sonnet" });
  });
  it("a name without the recorded model suffix — whole", () => {
    expect(splitName("Codex", "default")).toEqual({ name: "Codex", model: "default" });
    expect(splitName("Аналитик (старший)", "sonnet")).toEqual({ name: "Аналитик (старший)", model: "sonnet" });
    expect(splitName("Claude Code (sonnet)", "opus")).toEqual({ name: "Claude Code (sonnet)", model: "opus" });
    // The model suffix is not at the end (no « #N» follows it) — it is part of the name, not a core suffix.
    expect(splitName("Gemini (beta) (sonnet)", "beta")).toEqual({ name: "Gemini (beta) (sonnet)", model: "beta" });
    expect(splitName("Аналитик (sonnet) резерв", "sonnet")).toEqual({ name: "Аналитик (sonnet) резерв", model: "sonnet" });
  });
  it("bareNameOf and modelOf by session; owner without a model", () => {
    const s = fold([{ type: "session_created", pid: 1, session: {
      id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "Цена", templateId: null, framing: "",
      participants: [
        { id: "p1", name: "Claude Code (sonnet)", providerId: "claude", model: "sonnet", role: null },
        { id: "p2", name: "Claude Code (sonnet) #2", providerId: "claude", model: "sonnet", role: null },
        { id: "p3", name: "Участник 3", providerId: "scripted", model: "a.json", role: null },
      ],
      limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
    } }]);
    expect([bareNameOf(s.session, "p1"), modelOf(s.session, "p1")]).toEqual(["Claude Code", "sonnet"]);
    expect([bareNameOf(s.session, "p2"), modelOf(s.session, "p2")]).toEqual(["Claude Code #2", "sonnet"]);
    expect([bareNameOf(s.session, "p3"), modelOf(s.session, "p3")]).toEqual(["Участник 3", "a.json"]);
    expect([bareNameOf(s.session, "owner", "ru"), modelOf(s.session, "owner")]).toEqual(["Владелец", null]);
    expect([bareNameOf(s.session, "zz"), modelOf(s.session, "zz")]).toEqual(["zz", null]);
    expect(nameOf(s.session, "p1")).toBe("Claude Code (sonnet)");
  });
});

describe("MaterialsRow", () => {
  const withMats = (materials?: { id: string; name: string; chars: number; sha256: string }[]) => {
    const st = foldEvents(mk([created(2)]));
    return materials === undefined ? st.session : { ...st.session!, materials };
  };
  const m = (name: string, c: number, i: number) => ({ id: `m${i}`, name, chars: c, sha256: "f".repeat(64) });
  const html = (s: ReturnType<typeof withMats>) => renderToStaticMarkup(<MaterialsRow session={s} />);

  it("three materials: count, names, sizes, classes, icon", () => {
    const h = html(withMats([m("topic.txt", 420, 1), m("a.md", 2, 2), m("c.csv", 5, 3)]));
    expect(h).toContain('class="disclosure session-materials"');
    expect(h).toContain('class="disclosure__list"');
    expect(h).toContain('<summary>материалы: <span class="mono">3</span></summary>');
    expect(h).not.toContain("#i-doc");
    expect(h).toContain('<span class="mono">topic.txt</span><span class="muted">420 знаков</span>');
    expect(h).toContain("2 знака");
    expect(h).toContain("5 знаков");
  });
  it("no field, empty array, null — nothing", () => {
    expect(html(withMats())).toBe("");
    expect(html(withMats([]))).toBe("");
    expect(html(null)).toBe("");
  });
  it.each([[1, "знак"], [2, "знака"], [5, "знаков"], [11, "знаков"], [21, "знак"], [22, "знака"], [25, "знаков"]])("inflection %i", (n, w) => {
    expect(html(withMats([m("x", n, 1)]))).toContain(`>${n} ${w}</span>`);
  });
  it("without sha256 and id, the name is escaped", () => {
    const h = html(withMats([m("<b>x</b>", 3, 1)]));
    expect(h).not.toContain("ffff");
    expect(h).not.toContain("m1");
    expect(h).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(h).not.toContain("<b>");
  });
});

describe("owner in Who / nameOf", () => {
  const s = fold([created()]).session;
  it("nameOf", () => {
    expect(nameOf(s, "owner")).toBe("Владелец");
    expect(nameOf(s, "p1")).toBe("Имя1");
  });
  it("Who of the owner with a key icon", () => {
    const h = renderToStaticMarkup(<Who session={s} id="owner" />);
    expect(h).toContain('class="session-who session-owner__who"');
    expect(h).toContain("avatar avatar--sm session-owner__avatar");
    expect(h).toContain("Владелец");
  });
  it("Who of a participant — 22 px avatar without participant color, name without model", () => {
    expect(renderToStaticMarkup(<Who session={s} id="p2" />)).toBe('<span class="session-who"><span class="avatar avatar--sm">2</span> Имя2</span>');
    const c = created() as Extract<Body, { type: "session_created" }>;
    const named = fold([{ ...c, session: { ...c.session, participants: [{ id: "p1", name: "Codex (gpt) #2", providerId: "codex", model: "gpt", role: null }] } }]).session;
    expect(renderToStaticMarkup(<Who session={named} id="p1" />)).toBe('<span class="session-who"><span class="avatar avatar--sm">1</span> Codex #2</span>');
    expect(renderToStaticMarkup(<Who session={s} id="owner" />)).toContain('class="avatar avatar--sm session-owner__avatar"');
  });
});

describe("progress and participantPhase: independent drafts", () => {
  const c = created(3) as Extract<Body, { type: "session_created" }>;
  const head: Body = { ...c, session: { ...c.session, drafts: { enabled: true, synthesizerId: "p2" } } };
  const dst = (d: string, p: string): Body => ({ type: "draft_attempt_started", draftId: d, participantId: p, attempt: 1 });
  const dok = (d: string, p: string): Body => ({ type: "draft_completed", draftId: d, participantId: p, attempts: 1, durationMs: 1, usage: {}, chars: 3, sha256: "a".repeat(64), reasoning: "r" });
  const phase = [head, dst("d1", "p1"), dok("d1", "p1"), dst("d2", "p2"), dok("d2", "p2"), dst("d3", "p3")];
  it("in the phase — 2 of 3 accepted, after — null, without a phase — null", () => {
    expect(progress(fold(phase)).drafting).toEqual({ accepted: 2, total: 3 });
    expect(progress(fold([...phase, dok("d3", "p3"), { type: "drafts_finished" }])).drafting).toBeNull();
    expect(progress(fold([created(3)])).drafting).toBeNull();
  });
  it("a slot in work — «thinking» during an in-progress session", () => {
    const s = fold(phase);
    expect(participantPhase(s, "p3", true)).toBe("thinking");
    expect(participantPhase(s, "p3", false)).toBe("waiting");
    expect(participantPhase(s, "p1", true)).toBe("waiting");
  });
});

describe("Avatar: color cycling through eight", () => {
  it("number 9 is shown as is, color — the first one", () => {
    const h = renderToStaticMarkup(<Avatar n={9} />);
    expect(h).toContain('data-p="1"');
    expect(h).toContain(">9</span>");
  });
  it("number 8 does not change", () => {
    const h = renderToStaticMarkup(<Avatar n={8} />);
    expect(h).toContain('data-p="8"');
    expect(h).toContain(">8</span>");
  });
});

describe("Osen tones: warm — in progress, cold — settled", () => {
  it("agreement and «agree» — info, edit — muted, in progress — accent", () => {
    expect(STANCE.agree.tone).toBe("info");
    expect(STANCE.amend.tone).toBe("muted");
    expect(STANCE.object.tone).toBe("danger");
    expect(PHASE.agreed.tone).toBe("info");
    expect(PHASE.thinking.tone).toBe("accent");
    expect(BADGES.consensus.tone).toBe("info");
    expect(BADGES.running.tone).toBe("accent");
  });
  it("the avatar is colored by the state tone, the number does not affect the tone", () => {
    expect(renderToStaticMarkup(<Avatar n={1} tone="accent" />)).toContain('data-tone="accent"');
    expect(renderToStaticMarkup(<Avatar n={2} />)).not.toContain("data-tone");
  });
});

describe("progress: drafts and replacement", () => {
  const c = created(3) as Extract<Body, { type: "session_created" }>;
  const head: Body = { ...c, session: { ...c.session, drafts: { enabled: true, synthesizerId: "p1" } } };
  const dok = (d: string, p: string): Body => ({ type: "draft_completed", draftId: d, participantId: p, attempts: 1, durationMs: 1, usage: {}, chars: 3, sha256: "a".repeat(64), reasoning: "r" });
  it("a replaced owner of an accepted draft is counted once: of 3, not of 4", () => {
    const s = fold([head, dok("d1", "p1"), dok("d2", "p2"),
      { type: "session_finished", status: "stopped", version: null, agreed: [], objectors: [] } as Body,
      { type: "session_resumed", pid: 2, maxRounds: 4, replacements: [{ oldParticipantId: "p2", participant: { id: "p4", name: "Новый", providerId: "scripted", model: "m", role: null } }] } as Body]);
    expect(progress(s).drafting).toEqual({ accepted: 2, total: 3 });
  });
});

describe("common session elements: en", () => {
  afterEach(() => setProcessLanguage("ru"));
  const sess = () => fold([created(2)]).session;

  it("labels of positions and states", () => {
    setProcessLanguage("en");
    expect((["amend", "agree", "object"] as const).map((k) => stanceWord(k))).toEqual(["amends", "agrees", "objects"]);
    expect((["waiting", "thinking", "agreed", "objecting", "dropped"] as ParticipantPhase[]).map((k) => phaseWord(k)))
      .toEqual(["waiting for turn", "thinking", "agrees", "objects", "dropped"]);
    expect(renderToStaticMarkup(<PhaseBadge phase="dropped" />)).toContain("dropped");
  });
  it("the language passed explicitly does not depend on the process language", () => {
    expect(stanceWord("agree", "en")).toBe("agrees");
    expect(stanceWord("agree", "ru")).toBe("согласен");
    expect(phaseWord("waiting", "ru")).toBe("ждёт хода");
  });
  it("owner and materials", () => {
    setProcessLanguage("en");
    expect(nameOf(sess(), "owner")).toBe("Owner");
    expect(renderToStaticMarkup(<Who session={sess()} id="owner" />)).toContain("Owner");
    const s = { ...sess()!, materials: [{ id: "m1", name: "a.md", chars: 1, sha256: "x" }] };
    const h = renderToStaticMarkup(<MaterialsRow session={s} />);
    expect(h).toContain('<summary>materials: <span class="mono">1</span></summary>');
    expect(h).toContain("1 character");
  });
  it("chars number forms", () => {
    expect([1, 2, 5, 11, 21].map((n) => chars(n, "ru"))).toEqual(["1 знак", "2 знака", "5 знаков", "11 знаков", "21 знак"]);
    expect([1, 2, 5, 11, 21].map((n) => chars(n, "en"))).toEqual(["1 character", "2 characters", "5 characters", "11 characters", "21 characters"]);
  });
  it("status badge: all statuses and the ceiling in en", () => {
    setProcessLanguage("en");
    const want: Record<StoredStatus, string> = { running: "running", consensus: "consensus reached", no_consensus: "no consensus", stopped: "stopped", interrupted: "interrupted", failed: "failed" };
    for (const [k, v] of Object.entries(want)) {
      expect(statusText(k as StoredStatus)).toBe(v);
      expect(renderToStaticMarkup(<StatusBadge status={k as StoredStatus} />)).toContain(v);
    }
    expect(statusText("stopped", true)).toBe("stopped · token cap");
    expect(renderToStaticMarkup(<StatusBadge status="stopped" tokenCap />)).toContain("stopped · token cap");
  });
  it("switching language changes only the badge text", () => {
    const strip = (h: string) => h.replace(/>[^<]+</g, "><");
    const out = (st: StoredStatus, cap = false): [string, string] => { setProcessLanguage("ru"); const ru = renderToStaticMarkup(<StatusBadge status={st} tokenCap={cap} />); setProcessLanguage("en"); const en = renderToStaticMarkup(<StatusBadge status={st} tokenCap={cap} />); return [ru, en]; };
    for (const [st, cap] of [["running", false], ["consensus", false], ["failed", false], ["stopped", true]] as const) {
      const [ru, en] = out(st, cap);
      expect(ru).not.toBe(en);
      expect(strip(ru)).toBe(strip(en));
    }
    expect(BADGES.stopped.tone).toBe("muted");
    expect(STANCE.agree.tone).toBe("info");
    expect(PHASE.waiting.tone).toBe("muted");
  });
  it("failReason: codes, free text, empty", () => {
    const drafts = { ...created(2), session: { ...(created(2) as { session: object }).session, drafts: { synthesizerId: "p2" } } } as unknown as Body;
    const base = fold([drafts]);
    const f = (reason: string | null, code?: string) => ({ ...base, finish: { status: "failed" as const, version: null, agreed: [], objectors: [], reason, reasonCode: code ?? null } });
    const st = (code: string) => ({ ...base, finish: { ...f(code).finish, reason: code } });
    expect(failReason(st("synthesizer_unavailable"), "en")).toBe("Synthesizer “Имя2” dropped out before creating version 1. Start a new session with a different synthesizer.");
    expect(failReason(st("synthesizer_unavailable"), "ru")).toBe("Синтезатор «Имя2» выбыл, не создав версию 1. Запустите новую сессию с другим синтезатором.");
    expect(failReason(st("draft_context_limit"), "en")).toBe("The combined text of the independent drafts exceeded the context limit: the discussion did not start. Accepted drafts remain in the feed.");
    expect(failReason(st("draft_context_limit"), "ru")).toContain("Суммарный текст");
    expect(failReason(f("Что-то сломалось"), "en")).toBe("Что-то сломалось");
    expect(failReason(f(null), "en")).toBe("The session ended with a failure.");
    expect(failReason(f(""), "ru")).toBe("Сессия завершилась сбоем.");
  });
  it("failReason: a reason with a code is shown by code in the active language, an unknown code — as recorded", () => {
    const f = (reason: string, reasonCode: string) => ({ ...fold([created(2)]), finish: { status: "failed" as const, version: null, agreed: [], objectors: [], reason, reasonCode } });
    const RU = "Активных участников осталось меньше двух.", EN = "Fewer than two active participants remain.";
    for (const recorded of [RU, EN]) {
      expect(failReason(f(recorded, "insufficient_active_participants"), "en")).toBe(EN);
      expect(failReason(f(recorded, "insufficient_active_participants"), "ru")).toBe(RU);
    }
    expect(failReason(f("Записано как есть", "code_from_the_future"), "en")).toBe("Записано как есть");
  });
});
