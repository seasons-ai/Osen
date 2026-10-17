import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import { foldEvents } from "@model-council/core/protocol";
import type { SessionEvent, SessionState } from "@model-council/core/protocol";
import { ParticipantsPanel, RoundCounter, agreementReset, tokenMeter } from "./Participants.tsx";
import { feed } from "../../shared/messages/session-feed.ts";
import { result } from "../../shared/messages/result.ts";

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;
const mk = (bodies: Body[]): SessionEvent[] => bodies.map((b, i) => ({ ...b, seq: i + 1, ts: "2026-01-01T00:00:00Z" }) as SessionEvent);

const created = (n = 3): Body => ({
  type: "session_created", pid: 1,
  session: {
    id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "Цена", templateId: null, framing: "",
    participants: Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Имя${i + 1}`, providerId: "scripted", model: `мод${i + 1}`, role: i === 0 ? "Критик" : null })),
    limits: { maxRounds: 4, turnTimeoutSec: 60, contextChars: 1000 },
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
const drop = (id: string): Body => ({ type: "participant_dropped", participantId: id, reason: "таймаут" });
const panel = (s: SessionState, running = true) => renderToStaticMarkup(<ParticipantsPanel state={s} running={running} />);
const card = (h: string, n: number) => h.split('class="participant session-p').slice(1).filter((c) => c.includes(`data-p="${n}"`))[0]!;

describe("ParticipantsPanel", () => {
  const live = fold([
    created(3), started(1, "p1"), done(1, "p1", "amend", 1, { questions: [{ id: "q1", to: "p3", text: "?" }] }),
    started(2, "p2"), done(2, "p2", "agree", 1), started(3, "p3"),
  ]);
  it("turn of p2 started: p2 is thinking, the others keep their states", () => {
    const s = fold([created(3), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2")]);
    const h = panel(s);
    expect(card(h, 2)).toContain("participant--active");
    expect(card(h, 2)).toContain("думает");
    expect(card(h, 1)).toContain("согласен");
    expect(card(h, 3)).toContain("ждёт хода");
  });
  it("departed with a reason", () => {
    const h = panel(fold([created(3), drop("p3")]));
    expect(card(h, 3)).toContain("participant--off");
    expect(card(h, 3)).toContain("выбыл");
    expect(card(h, 3)).toContain("таймаут");
  });
  it("all five labels", () => {
    const s = fold([created(5), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "object", 1), drop("p3"), started(4, "p4")]);
    const h = panel(s);
    for (const [n, w] of [[1, "согласен"], [2, "возражает"], [3, "выбыл"], [4, "думает"], [5, "ждёт хода"]] as const) expect(card(h, n)).toContain(w);
  });
  it("indicator: 2 of 3 agree, one open question", () => {
    const h = panel(live);
    expect(h).toContain('<span class="meter__label"><span>согласны</span><span class="mono session-meter__count">2 из 3</span></span>');
    expect(h).toContain('открытых вопросов: <span class="mono">1</span>');
    expect(h).toContain('class="meter" data-tone="accent"');
    expect(h).toContain("--value:67%");
  });
  it("agreement: info and 100%", () => {
    const h = panel(fold([created(2), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "agree", 1)]), false);
    expect(h).toContain('class="meter" data-tone="info"');
    expect(h).toContain("--value:100%");
    expect(h).toContain('открытых вопросов: <span class="mono">0</span>');
  });
  it("avatar: thinking — accent, agreeing — info, objecting — danger, others without a tone", () => {
    const s = fold([created(5), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "object", 1), drop("p3"), started(4, "p4")]);
    const h = panel(s);
    const tone = (n: number) => card(h, n).match(/<span class="avatar[^"]*"[^>]*?(?: data-tone="(\w+)")?>/)![1];
    expect([1, 2, 3, 4, 5].map(tone)).toEqual(["info", "danger", undefined, "accent", undefined]);
  });
  it("two thinking participants with different numbers are colored the same", () => {
    const avatar = (h: string, n: number) => card(h, n).match(/<span class="avatar[^>]*>/)![0].replace(/ data-p="\d"/, "");
    const a = panel(fold([created(3), started(1, "p1")]));
    const b = panel(fold([created(3), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2")]));
    expect(avatar(a, 1)).toBe(avatar(b, 2));
    expect(avatar(a, 1)).toContain('data-tone="accent"');
  });
  it("role, «no role» and model", () => {
    const h = panel(live);
    expect(card(h, 1)).toContain('participant__name">Имя1 <span class="tag">мод1</span></div><div class="participant__meta">Критик</div>');
    expect(card(h, 2)).toContain('participant__name">Имя2 <span class="tag">мод2</span></div><div class="participant__meta">без роли</div>');
  });
  it("without a session empty", () => {
    expect(panel(fold([]))).toBe("");
  });
});

describe("RoundCounter", () => {
  it("round 2 of 4", () => {
    const s = fold([created(2), { type: "turn_started", turn: 1, round: 2, participantId: "p1" }]);
    expect(renderToStaticMarkup(<RoundCounter state={s} />)).toContain("круг 2 из 4");
  });
  it("before the first turn", () => {
    expect(renderToStaticMarkup(<RoundCounter state={fold([created(2)])} />)).toContain("круг 1 из 4");
  });
});

describe("RoundCounter: solution panel view per osen mockup", () => {
  const turns = (n: number, usage: { inputTokens?: number; outputTokens?: number }, complete = false): Body[] =>
    Array.from({ length: n }, (_, i) => [{ type: "turn_started", turn: i + 1, round: 3, participantId: "p1" } as Body, tok(i + 1, "p1", i === 0 || !complete ? (i === 0 ? usage : {}) : usage)]).flat();
  const text = (h: string): string => h.replace(/<[^>]*>/g, "");
  const en = <T,>(f: () => T): T => { setProcessLanguage("en"); try { return f(); } finally { setProcessLanguage("ru"); } };
  it("ru: round · turns · tokens, mono, without icon", () => {
    const h = renderToStaticMarkup(<RoundCounter state={fold([created(2), ...turns(9, { inputTokens: 3466, outputTokens: 1 }, true)])} />);
    expect(text(h)).toBe("круг 3 из 4 · 9 ходов · 31.2k tok");
    expect(h).toContain("session-counter mono");
    expect(h).not.toContain("<svg");
  });
  it("en: round · turns · tok", () => {
    const s = fold([created(2), ...turns(9, { inputTokens: 3466, outputTokens: 1 }, true)]);
    expect(text(en(() => renderToStaticMarkup(<RoundCounter state={s} />)))).toBe("round 3 of 4 · 9 turns · 31.2k tok");
  });
  it("forms of the turn count", () => {
    const one = text(renderToStaticMarkup(<RoundCounter state={fold([created(2), ...turns(1, {})])} />));
    expect(one).toBe("круг 3 из 4 · 1 ход");
    expect(text(renderToStaticMarkup(<RoundCounter state={fold([created(2), ...turns(3, {})])} />))).toContain("3 хода");
  });
  it("no tokens — no «tok»", () => {
    expect(renderToStaticMarkup(<RoundCounter state={fold([created(2)])} />)).not.toContain("tok");
  });
  it("incomplete accounting — «≥»", () => {
    expect(text(renderToStaticMarkup(<RoundCounter state={fold([created(2), ...turns(2, { inputTokens: 1000, outputTokens: 500 })])} />))).toContain("· ≥1.5k tok");
  });
  it("drafts: «drafts · 0 turns»", () => {
    const c = created(2) as Extract<Body, { type: "session_created" }>;
    const head: Body = { ...c, session: { ...c.session, drafts: { enabled: true, synthesizerId: "p2" } } };
    const dok: Body = { type: "draft_completed", draftId: "d1", participantId: "p1", attempts: 1, durationMs: 1, usage: {}, chars: 3, sha256: "a".repeat(64), reasoning: "r" };
    const head2 = [head, dok];
    const t = text(renderToStaticMarkup(<RoundCounter state={fold(head2)} />));
    expect(t.startsWith("черновики · 0 ходов")).toBe(true);
  });
});

describe("ParticipantsPanel: materials", () => {
  const base = created(3) as Extract<Body, { type: "session_created" }>;
  const withMats = fold([{ ...base, session: { ...base.session, materials: [1, 2, 3].map((i) => ({ id: `m${i}`, name: `f${i}.txt`, chars: 10 * i, sha256: "a".repeat(64) })) } }, started(1, "p1")]);
  it("three materials: a row inside the indicator block", () => {
    const h = panel(withMats);
    const meter = h.slice(h.indexOf("session-meter"));
    expect(meter).toContain('<summary>материалы: <span class="mono">3</span></summary>');
    expect(meter).not.toContain("#i-doc");
    expect(meter.indexOf("открытых вопросов")).toBeLessThan(meter.indexOf("материалы: "));
  });
  it("without materials there is no row", () => {
    expect(panel(fold([created(3), started(1, "p1")]))).not.toContain("session-materials");
  });
});

describe("agreement reset by an owner reply", () => {
  const LINE = "согласие сброшено репликой владельца";
  const owner = (afterTurn: number): Body => ({ type: "owner_message", id: "o1", text: "Реплика", afterTurn, requestId: "r1" } as unknown as Body);
  const base = [created(3), started(1, "p1"), done(1, "p1", "amend", 1)];
  const fresh = fold([...base, started(2, "p2"), owner(2)]);
  it("after a reply the in-progress one has the row", () => {
    expect(agreementReset(fresh, true)).toBe(true);
    expect(panel(fresh)).toContain(LINE);
  });
  it("a reply between turns (before the next one starts) — also present", () => expect(agreementReset(fold([...base, owner(1)]), true)).toBe(true));
  it("after the next completed turn it disappears", () => {
    const s = fold([...base, owner(1), started(2, "p2"), done(2, "p2", "agree", 1)]);
    expect(agreementReset(s, true)).toBe(false);
    expect(panel(s)).not.toContain(LINE);
  });
  it("a completed session has none", () => {
    expect(agreementReset(fresh, false)).toBe(false);
    expect(panel(fresh, false)).not.toContain(LINE);
  });
  it("without replies there is none", () => {
    expect(agreementReset(fold(base), true)).toBe(false);
    expect(panel(fold(base))).not.toContain(LINE);
  });
});

const tcreated = (cap?: number): Body => {
  const c = created() as Extract<Body, { type: "session_created" }>;
  return cap === undefined ? c : { ...c, session: { ...c.session, limits: { ...c.session.limits, maxTotalTokens: cap } } };
};
const tok = (turn: number, id: string, usage: { inputTokens?: number; outputTokens?: number }): Body =>
  ({ ...done(turn, id, "amend", turn), usage }) as Body;
const tp = (bodies: Body[]) => panel(fold(bodies));

describe("ParticipantsPanel: token spending", () => {
  it("ceiling 1200, spent 500: accent bar at 42%", () => {
    const h = tp([tcreated(1200), started(1, "p1"), tok(1, "p1", { inputTokens: 300, outputTokens: 200 })]);
    expect(h).toContain('<span class="mono">500 из 1200</span> токенов');
    expect(h).toContain('data-tone="accent"');
    expect(h).toContain("#i-coins");
    expect(h).toContain("--value:42%");
  });
  it("1000 of 1200: warning at 83%", () => {
    const h = tp([tcreated(1200), started(1, "p1"), tok(1, "p1", { inputTokens: 300, outputTokens: 200 }), started(2, "p2"), tok(2, "p2", { inputTokens: 300, outputTokens: 200 })]);
    expect(h).toContain('<span class="mono">1000 из 1200</span> токенов');
    expect(h).toContain('class="meter session-tokens" data-tone="warn"');
    expect(h).toContain("#i-alert");
    expect(h).toContain("--value:83%");
  });
  it("80% threshold: 960 of 1200 warns, 959 does not", () => {
    const warn = (n: number) => tokenMeter(fold([tcreated(1200), started(1, "p1"), tok(1, "p1", { inputTokens: n })]))!.warn;
    expect(warn(960)).toBe(true);
    expect(warn(959)).toBe(false);
  });
  it("overrun: bar not above 100%", () => {
    const h = tp([tcreated(1200), started(1, "p1"), tok(1, "p1", { inputTokens: 1500 })]);
    expect(h).toContain('<span class="mono">1500 из 1200</span> токенов');
    expect(h).toContain("--value:100%");
  });
  it("without a ceiling: spending row, no bar", () => {
    const h = tp([tcreated(), started(1, "p1"), tok(1, "p1", { inputTokens: 700 })]);
    expect(h).toContain("израсходовано 700 токенов");
    expect(h).not.toContain("session-tokens");
    expect(h).not.toContain("учёт неполный");
  });
  it("without a ceiling and without tokens: neither bar nor row", () => {
    const h = tp([tcreated(), started(1, "p1"), done(1, "p1", "amend", 1)]);
    expect(h).not.toContain("session-tokens");
    expect(h).not.toContain("израсходовано");
    expect(h).not.toContain("#i-coins");
  });
  it("some turns without tokens: accounting incomplete, with and without a ceiling", () => {
    const two = [started(1, "p1"), tok(1, "p1", { inputTokens: 100 }), started(2, "p2"), done(2, "p2", "amend", 2)];
    expect(tp([tcreated(1200), ...two])).toContain('<span class="mono">100 из 1200</span> токенов · учёт неполный');
    expect(tp([tcreated(), ...two])).toContain("израсходовано 100 токенов · учёт неполный");
  });
  it("a turn without usage at ceiling 100: 0 of 100, accounting incomplete", () => {
    const h = tp([tcreated(100), started(1, "p1"), done(1, "p1", "amend", 1)]);
    expect(h).toContain('<span class="mono">0 из 100</span> токенов · учёт неполный');
  });
  it("the bar stands after «open questions» and before materials", () => {
    const b = tcreated(1200) as Extract<Body, { type: "session_created" }>;
    const h = panel(fold([{ ...b, session: { ...b.session, materials: [{ id: "m1", name: "f.txt", chars: 10, sha256: "a".repeat(64) }] } }, started(1, "p1"), tok(1, "p1", { inputTokens: 5 })]));
    expect(h.indexOf("открытых вопросов")).toBeLessThan(h.indexOf("session-tokens"));
    expect(h.indexOf("session-tokens")).toBeLessThan(h.indexOf("session-materials"));
  });
});

describe("ParticipantsPanel: independent drafts", () => {
  const c = created(3) as Extract<Body, { type: "session_created" }>;
  const head: Body = { ...c, session: { ...c.session, drafts: { enabled: true, synthesizerId: "p2" } } };
  const dok = (d: string, p: string): Body => ({ type: "draft_completed", draftId: d, participantId: p, attempts: 1, durationMs: 1, usage: {}, chars: 3, sha256: "a".repeat(64), reasoning: "r" });
  const s = fold([head, dok("d1", "p1"), dok("d2", "p2")]);
  it("indicator «drafts: accepted 2 of 3» instead of «agree»", () => {
    const h = panel(s);
    expect(h).toContain('<span>принято черновиков</span><span class="mono session-meter__count">2 из 3</span>');
    expect(h).not.toContain("согласны");
  });
  it("counter in the header — «drafts»; after the phase — round", () => {
    expect(renderToStaticMarkup(<RoundCounter state={s} />)).toContain("черновики");
    expect(renderToStaticMarkup(<RoundCounter state={s} />)).not.toContain("круг");
    expect(renderToStaticMarkup(<RoundCounter state={fold([head, dok("d1", "p1"), { type: "drafts_finished" }])} />)).toContain("круг 1 из 4");
  });
});

const newbie = { id: "p5", name: "Новый", providerId: "scripted", model: "m", role: null };
const finishedFail: Body = { type: "session_finished", status: "failed", version: 1, agreed: [], objectors: [] } as Body;
const resumeWith = (old?: string): Body =>
  ({ type: "session_resumed", pid: 2, maxRounds: 5, ...(old ? { replacements: [{ oldParticipantId: old, participant: newbie }] } : {}) }) as Body;

describe("ParticipantsPanel: participant replacement", () => {
  const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
  const base: Body[] = [created(4), started(1, "p1"), done(1, "p1", "amend", 1), drop("p2"), drop("p4"), finishedFail];
  const replaced = () => fold([...base, resumeWith("p2")]);
  it("the new participant stands in the place of the previous one, the previous one is not in the list, numbers are identifiers", () => {
    const h = panel(replaced(), false);
    const order = ["Имя1", "Новый", "Имя3", "Имя4"].map((n) => h.indexOf(`participant__name">${n} <span class="tag">`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(h).not.toMatch(/participant__name">Имя2[ <]/);
    expect(h.match(/class="participant session-p/g)).toHaveLength(4);
    expect(h).toContain('<span class="avatar" data-p="5">5</span>');
    expect(text(h)).toContain("заменил p2 «Имя2»");
  });
  it("a departed one without replacement is shown as before, without a replacement mark", () => {
    const h = panel(replaced(), false);
    expect(card(h, 4)).toContain("participant--off");
    expect(card(h, 4)).toContain("таймаут");
    expect(card(h, 4)).not.toContain("заменил");
  });
  it("without replacements the markup has no session-p__replaces", () => {
    const h = panel(fold([created(3), drop("p3")]));
    expect(h).not.toContain("session-p__replaces");
  });
  it("agreementReset: right after continuation with a replacement — yes, after a completed turn — no", () => {
    const s = replaced();
    expect(agreementReset(s, true)).toBe(true);
    expect(agreementReset(s, false)).toBe(false);
    expect(text(panel(s))).toContain("согласия сброшены заменой участника");
    const next = fold([...base, resumeWith("p2"), started(2, "p5"), done(2, "p5", "agree", 1)]);
    expect(agreementReset(next, true)).toBe(false);
    expect(text(panel(next))).not.toContain("согласия сброшены");
    expect(agreementReset(fold([...base, resumeWith()]), true)).toBe(false);
  });
});

describe("ParticipantsPanel: en", () => {
  afterEach(() => setProcessLanguage("ru"));
  const en = <T,>(f: () => T): T => { setProcessLanguage("en"); return f(); };
  const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
  const tags = (h: string) => [...h.matchAll(/<([a-z0-9]+)/g)].map((m) => m[1]).join(",");

  it("heading, roles, agreement, questions", () => {
    const s = fold([created(3), started(1, "p1"), done(1, "p1", "amend", 1, { questions: [{ id: "q1", to: "p3", text: "?" }] }), started(2, "p2"), done(2, "p2", "agree", 1), started(3, "p3")]);
    const h = en(() => panel(s));
    expect(h).toContain('aria-label="Participants"');
    expect(h).toContain('eyebrow">Participants<');
    expect(card(h, 1)).toContain('participant__name">Имя1 <span class="tag">мод1</span></div><div class="participant__meta">Критик</div>');
    expect(card(h, 2)).toContain('participant__meta">no role</div>');
    expect(h).toContain('<span>agreed</span><span class="mono session-meter__count">2 of 3</span>');
    expect(h).toContain('session-meter__line">open questions: <span class="mono">1</span></div>');
    expect(h).not.toMatch(/согласны|открытых|без роли|Участники/);
  });
  it("departed: reason as recorded", () => {
    const h = en(() => panel(fold([created(3), drop("p3")])));
    expect(card(h, 3)).toContain("таймаут");
    expect(card(h, 3)).toContain("dropped");
  });
  it("reason not given", () => {
    const h = en(() => panel(fold([created(3), { type: "participant_dropped", participantId: "p3" } as unknown as Body])));
    expect(card(h, 3)).toContain("no reason given");
  });
  it("replacement and both agreement resets", () => {
    const base: Body[] = [created(4), started(1, "p1"), done(1, "p1", "amend", 1), drop("p2"), finishedFail];
    const h = en(() => panel(fold([...base, resumeWith("p2")])));
    expect(text(h)).toContain("replaced p2 “Имя2”");
    expect(text(h)).toContain("agreements reset by participant replacement");
    const owner = { type: "owner_message", id: "o1", text: "Р", afterTurn: 2, requestId: "r1" } as unknown as Body;
    expect(text(en(() => panel(fold([created(3), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), owner]))))).toContain("agreement reset by the owner&#x27;s message");
  });
  it("spending: with a ceiling, without, incomplete", () => {
    const tp = (bodies: Body[]) => en(() => panel(fold(bodies)));
    expect(tp([tcreated(1200), started(1, "p1"), tok(1, "p1", { inputTokens: 500 })])).toContain('<span class="mono">500 of 1200</span> tokens');
    expect(tp([tcreated(), started(1, "p1"), tok(1, "p1", { inputTokens: 700 })])).toContain("700 tokens spent");
    expect(tp([tcreated(), started(1, "p1"), tok(1, "p1", { inputTokens: 1 })])).toContain("1 token spent");
    const two = [started(1, "p1"), tok(1, "p1", { inputTokens: 100 }), started(2, "p2"), done(2, "p2", "amend", 2)];
    expect(tp([tcreated(1200), ...two])).toContain('<span class="mono">100 of 1200</span> tokens · incomplete count');
    expect(tp([tcreated(), ...two])).toContain("100 tokens spent · incomplete count");
  });
  it("drafts and the round counter", () => {
    const c = created(3) as Extract<Body, { type: "session_created" }>;
    const head: Body = { ...c, session: { ...c.session, drafts: { enabled: true, synthesizerId: "p2" } } };
    const dok = (d: string, p: string): Body => ({ type: "draft_completed", draftId: d, participantId: p, attempts: 1, durationMs: 1, usage: {}, chars: 3, sha256: "a".repeat(64), reasoning: "r" });
    const s = fold([head, dok("d1", "p1"), dok("d2", "p2")]);
    expect(en(() => panel(s))).toContain('<span>drafts accepted</span><span class="mono session-meter__count">2 of 3</span>');
    expect(en(() => renderToStaticMarkup(<RoundCounter state={s} />))).toContain("drafts ·");
    expect(en(() => renderToStaticMarkup(<RoundCounter state={fold([created(2), { type: "turn_started", turn: 1, round: 2, participantId: "p1" }])} />))).toContain("round 2 of 4");
  });
  it("the lineup does not depend on the language", () => {
    const states = [
      fold([created(3), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2")]),
      fold([tcreated(1200), started(1, "p1"), tok(1, "p1", { inputTokens: 5 })]),
      fold([created(4), started(1, "p1"), done(1, "p1", "amend", 1), drop("p2"), finishedFail, resumeWith("p2")]),
    ];
    for (const s of states) {
      const e = en(() => panel(s));
      setProcessLanguage("ru");
      expect(tags(e)).toBe(tags(panel(s)));
    }
  });
});

describe("ParticipantsPanel: osen look (89)", () => {
  const live = fold([
    created(3), started(1, "p1"), done(1, "p1", "amend", 1, { questions: [{ id: "q1", to: "p3", text: "?" }] }),
    started(2, "p2"), done(2, "p2", "agree", 1), started(3, "p3"),
  ]);
  it("name and model .tag in one row, role on a separate row, without «Name (model)»", () => {
    const c = created(3) as Extract<Body, { type: "session_created" }>;
    const s = fold([{ ...c, session: { ...c.session, participants: [{ id: "p1", name: "Codex (gpt-5.6-luna)", providerId: "codex", model: "gpt-5.6-luna", role: "Сторонник низкого входа" }, { id: "p2", name: "Локальный", providerId: "ollama", model: "default", role: null }] } }, started(1, "p1")]);
    const h = panel(s);
    expect(card(h, 1)).toContain('<div class="participant__name">Codex <span class="tag">gpt-5.6-luna</span></div><div class="participant__meta">Сторонник низкого входа</div>');
    expect(card(h, 1)).not.toContain("Codex (gpt-5.6-luna)");
    expect(card(h, 1)).not.toContain("·");
    // the default model is not shown
    expect(card(h, 2)).toContain('<div class="participant__name">Локальный</div><div class="participant__meta">без роли</div>');
    expect(card(h, 2)).not.toContain("tag");
  });
  it("«agree» label and mono count separately; fill accent (leaf) at 2 of 3, info (rain) on agreement", () => {
    const h = panel(live);
    expect(h).toContain('<div class="meter" data-tone="accent" style="--value:67%"><span class="meter__label"><span>согласны</span><span class="mono session-meter__count">2 из 3</span></span>');
    expect(h).not.toContain("согласны 2 из 3");
    const all = panel(fold([created(2), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "agree", 1)]), false);
    expect(all).toContain('<div class="meter" data-tone="info" style="--value:100%"><span class="meter__label"><span>согласны</span><span class="mono session-meter__count">2 из 2</span></span>');
  });
  it("rows of questions and materials — mono number, without icons", () => {
    const c = created(3) as Extract<Body, { type: "session_created" }>;
    const s = fold([{ ...c, session: { ...c.session, materials: [{ id: "m1", name: "a.txt", chars: 10, sha256: "a".repeat(64) }] } }, started(1, "p1"), done(1, "p1", "amend", 1, { questions: [{ id: "q1", to: "p3", text: "?" }] })]);
    const meter = panel(s).slice(panel(s).indexOf("session-meter"));
    expect(meter).toContain('<div class="session-meter__line">открытых вопросов: <span class="mono">1</span></div>');
    expect(meter).toContain('<summary>материалы: <span class="mono">1</span></summary>');
    expect(meter).not.toContain("#i-question");
    expect(meter).not.toContain("#i-doc");
  });
  it("drafts: «drafts accepted» and count separately", () => {
    const c = created(3) as Extract<Body, { type: "session_created" }>;
    const s = fold([{ ...c, session: { ...c.session, drafts: { enabled: true, synthesizerId: "p2" } } }, { type: "draft_attempt_started", draftId: "d1", participantId: "p1", attempt: 1 }]);
    expect(panel(s)).toContain('<span>принято черновиков</span><span class="mono session-meter__count">0 из 3</span>');
  });
  it("departed: reason under the «departed» chip", () => {
    const c = card(panel(fold([created(3), drop("p3")])), 3);
    expect(c.indexOf("выбыл")).toBeLessThan(c.indexOf("session-p__reason"));
    expect(c).toContain('session-p__reason">таймаут<');
  });
  it("spending relative to the ceiling: number mono, the bar icon stays", () => {
    const h = panel(fold([tcreated(1200), started(1, "p1"), tok(1, "p1", { inputTokens: 1000 })]));
    expect(h).toMatch(/session-tokens" data-tone="warn"[^>]*><span class="meter__label"><svg[^>]*><use href="#i-alert"><\/use><\/svg> <span class="mono">1000 из 1200<\/span> токенов<\/span>/);
  });
});

describe("Numbers, dates and inflection in the Summary and export: token inflection for any N and CAP", () => {
  // Independent oracle of endings: by remainders, without Intl.PluralRules and plural.
  const ends1 = (n: number): boolean => n % 10 === 1 && n % 100 !== 11;
  const nom3 = (n: number): string => (ends1(n) ? "токен" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "токена" : "токенов");
  const gen2 = (n: number): string => (ends1(n) ? "токена" : "токенов");
  const caps = [1, 2, 5, 11, 21, 101, 111, 1000, 1001];
  it("ru: feed and Summary lines per the oracle", () => {
    const f = feed("ru");
    const r = result("ru");
    for (let n = 0; n <= 1200; n++) {
      expect(f.tokensSpent(n)).toBe(`израсходовано ${n} ${nom3(n)}`);
      expect(f.capText(n, null)).toBe(`Израсходовано ${n} ${nom3(n)}.`);
      expect(r.capExhausted(null, n)).toBe(`израсходовано ${n} ${nom3(n)}: чтобы продолжить, задайте новый потолок или снимите его`);
      for (const cap of caps) {
        expect(f.capText(n, cap)).toBe(`Израсходовано ${n} из ${cap} ${gen2(cap)}.`);
        expect(r.capExhausted(cap, n)).toBe(`Потолок ${cap}, израсходовано ${n} ${nom3(n)}: чтобы продолжить, задайте новый потолок или снимите его`);
        expect(r.spentLine(n, cap)).toBe(`Израсходовано ${n} ${nom3(n)}, потолок ${cap}`);
      }
      expect(f.tokensOfCap(n)).toBe(gen2(n));
    }
  });
  it("en: lines as before, bar — tokens", () => {
    const f = feed("en");
    expect([f.tokensSpent(1), f.tokensSpent(21), f.capText(21, 21), f.capText(1, null), f.tokensOfCap(1), f.tokensOfCap(21)]).toEqual(["1 token spent", "21 tokens spent", "21 of 21 tokens spent.", "1 token spent.", "tokens", "tokens"]);
    expect(result("en").capExhausted(1, 1)).toBe("Cap 1, 1 token spent: to continue, set a new cap or remove it");
  });
  it("ru: panel markup — «spent 21 tokens» and «1 of 21» tokens", () => {
    expect(tp([tcreated(), started(1, "p1"), tok(1, "p1", { inputTokens: 21 })])).toContain("израсходовано 21 токен<");
    expect(tp([tcreated(21), started(1, "p1"), tok(1, "p1", { inputTokens: 1 })])).toContain('<span class="mono">1 из 21</span> токена');
    expect(tp([tcreated(1000), started(1, "p1"), tok(1, "p1", { inputTokens: 11 })])).toContain('<span class="mono">11 из 1000</span> токенов');
  });
});
