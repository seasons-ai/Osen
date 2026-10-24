import { describe, it, expect } from "vitest";
import {
  initialState, currentVersion, activeParticipantIds, openQuestionsFor, openOwnerQuestions, OWNER_ID, isConsensus, objectors,
  resumePoint, sessionTotals, tokenUsage, draftPhase, draftIdOf, draftCallsLeft, turnOrder, maxCallsBound,
  slotHolder, slotRoster, applyReplacements,
} from "./state.ts";
import type { SessionState, QuestionState, TurnRecord, DraftSlot } from "./state.ts";
import { foldEvents } from "./fold.ts";
import type { SessionEvent, Usage } from "./schema.ts";

const q = (id: string, to: string, status: QuestionState["status"]): QuestionState => ({
  id, from: "p1", to, text: "?", turn: 1, status, answer: null,
});
const turn = (n: number, participantId: string, reasoning: string): TurnRecord => ({
  turn: n, round: 1, participantId, stance: "object", normalized: false, reasoning,
  version: 1, newVersion: false, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 0,
});
const base = (): SessionState => ({
  ...initialState(),
  versions: [{ number: 1, text: "t", authorId: "p1", turn: 1 }],
  participants: [
    { id: "p1", status: "active", dropReason: null },
    { id: "p2", status: "active", dropReason: null },
    { id: "p3", status: "active", dropReason: null },
  ],
  agreed: ["p1", "p2", "p3"],
});

describe("state", () => {
  it("initialState is empty", () => {
    const s = initialState();
    expect(s).toMatchObject({ session: null, pid: null, status: "running", currentTurn: null, round: 0, finish: null, lastSeq: 0 });
    expect(currentVersion(s)).toBeNull();
  });

  it("currentVersion returns the last one", () => {
    const s = base();
    s.versions.push({ number: 2, text: "u", authorId: "p2", turn: 2 });
    expect(currentVersion(s)?.number).toBe(2);
  });

  it("activeParticipantIds skips dropped-out participants", () => {
    const s = base();
    s.participants[1]!.status = "dropped";
    expect(activeParticipantIds(s)).toEqual(["p1", "p3"]);
  });

  it("openQuestionsFor filters by addressee and status", () => {
    const s = base();
    s.questions = [q("q1", "p2", "open"), q("q2", "p2", "answered"), q("q3", "p3", "open")];
    expect(openQuestionsFor(s, "p2").map((x) => x.id)).toEqual(["q1"]);
  });

  it("consensus on full agreement", () => {
    expect(isConsensus(base())).toBe(true);
  });

  it("agreement with an open question does not count", () => {
    const s = base();
    s.questions = [q("q1", "p3", "open")];
    expect(isConsensus(s)).toBe(false);
  });

  it("a dropped-out participant is not required for agreement", () => {
    const s = base();
    s.participants[2]!.status = "dropped";
    s.agreed = ["p1", "p2"];
    expect(isConsensus(s)).toBe(true);
  });

  it("with one active participant there is no agreement", () => {
    const s = base();
    s.participants[1]!.status = "dropped";
    s.participants[2]!.status = "dropped";
    s.agreed = ["p1"];
    expect(isConsensus(s)).toBe(false);
  });

  it("without a version there is no agreement", () => {
    const s = { ...base(), versions: [] };
    expect(isConsensus(s)).toBe(false);
  });

  it("objectors takes the participant's last turn", () => {
    const s = base();
    s.agreed = ["p1"];
    s.turns = [turn(1, "p2", "старый"), turn(2, "p2", "новый")];
    expect(objectors(s)).toEqual([
      { participantId: "p2", reasoning: "новый" },
      { participantId: "p3", reasoning: null },
    ]);
  });
});

describe("ownerMessages", () => {
  it("empty in the initial state", () => { expect(initialState().ownerMessages).toEqual([]); });
});

describe("openOwnerQuestions", () => {
  it("only open questions to the owner, in order of appearance", () => {
    const s = base();
    s.questions = [q("q1", OWNER_ID, "open"), q("q2", "p2", "open"), q("q3", OWNER_ID, "answered"), q("q4", OWNER_ID, "open"), q("q5", OWNER_ID, "unanswered")];
    expect(openOwnerQuestions(s).map((x) => x.id)).toEqual(["q1", "q4"]);
  });
});

describe("resumePoint", () => {
  const sess = (): SessionState => ({
    ...base(),
    session: {
      id: "s", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "t", templateId: null, framing: "",
      participants: ["p1", "p2", "p3"].map((id) => ({ id, name: id, providerId: "scripted", model: "m", role: null })),
      limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
    },
  });
  const t = (n: number, id: string, round: number): TurnRecord => ({ ...turn(n, id, "r"), round });
  const ls = (turn: number, round: number, participantId: string) => ({ turn, round, participantId });

  it("no turns", () => {
    expect(resumePoint(sess())).toEqual({ turn: 1, round: 1, index: 0, redo: false, completedRounds: 0 });
  });
  it("stop in the middle of a turn: repeat", () => {
    const s = sess();
    s.turns = [t(1, "p1", 1), t(2, "p2", 1), t(3, "p3", 1), t(4, "p1", 2)];
    s.lastStarted = ls(5, 2, "p2");
    expect(resumePoint(s)).toEqual({ turn: 5, round: 2, index: 1, redo: true, completedRounds: 1 });
  });
  it("failure between turns: next participant", () => {
    const s = sess();
    s.turns = [t(1, "p1", 1), t(2, "p2", 1)];
    s.lastStarted = ls(2, 1, "p2");
    expect(resumePoint(s)).toEqual({ turn: 3, round: 1, index: 2, redo: false, completedRounds: 0 });
  });
  it("round completed: new round", () => {
    const s = sess();
    s.turns = [t(4, "p1", 2), t(5, "p2", 2), t(6, "p3", 2)];
    s.lastStarted = ls(6, 2, "p3");
    expect(resumePoint(s)).toEqual({ turn: 7, round: 3, index: 0, redo: false, completedRounds: 2 });
  });
  it("participant dropped out in a started turn: not repeated", () => {
    const s = sess();
    s.turns = [t(1, "p1", 1)];
    s.lastStarted = ls(2, 1, "p2");
    s.participants[1]!.status = "dropped";
    expect(resumePoint(s)).toEqual({ turn: 3, round: 1, index: 2, redo: false, completedRounds: 0 });
  });
  it("next in order dropped out: skipped", () => {
    const s = sess();
    s.turns = [t(1, "p1", 1)];
    s.lastStarted = ls(1, 1, "p1");
    s.participants[1]!.status = "dropped";
    expect(resumePoint(s)).toEqual({ turn: 2, round: 1, index: 2, redo: false, completedRounds: 0 });
  });
  it("last active one dropped out on its turn: new round", () => {
    const s = sess();
    s.turns = [t(1, "p1", 1), t(2, "p2", 1)];
    s.lastStarted = ls(3, 1, "p3");
    s.participants[2]!.status = "dropped";
    expect(resumePoint(s)).toEqual({ turn: 4, round: 2, index: 0, redo: false, completedRounds: 1 });
  });
  it("without a session: error", () => {
    expect(() => resumePoint(initialState())).toThrow(/session_created/);
  });
});

// Sums are computed from the journal (sessionUsage), so the state is built by folding events.
type UBody = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;
const foldU = (bodies: UBody[]): SessionState =>
  foldEvents(bodies.map((x, i) => ({ ...x, seq: i + 1, ts: "2026-01-01T00:00:00Z" }) as SessionEvent));
const doneU = (n: number, usage: Usage, durationMs = 10, participantId = "p1"): UBody[] => [
  { type: "turn_started", turn: n, round: 1, participantId },
  { type: "turn_completed", turn: n, round: 1, participantId, stance: "object", normalized: false, reasoning: "r", solution: null, version: 1, questions: [], answers: [], attempts: 1, usage, durationMs },
];
const failU = (n: number, usage?: Usage, participantId = "p2"): UBody[] => [
  { type: "turn_started", turn: n, round: 1, participantId },
  { type: "turn_failed", turn: n, round: 1, participantId, attempt: 1, kind: "timeout", message: "m", ...(usage ? { usage } : {}) },
  { type: "participant_dropped", participantId, reason: "x" },
];

describe("sessionTotals", () => {
  const st = (...turns: UBody[][]): SessionState => foldU(turns.flat());

  it("all reported", () => {
    expect(sessionTotals(st(doneU(1, { inputTokens: 5, outputTokens: 2, costUsd: 0.5 }), doneU(2, { inputTokens: 3, outputTokens: 1, costUsd: 0.25 }))))
      .toEqual({ turns: 2, drafts: 0, durationMs: 20, inputTokens: 8, outputTokens: 3, costUsd: 0.75, incomplete: false, tokensFrom: ["p1"], costFrom: ["p1"], costIncomplete: false });
  });
  it("nobody reported tokens", () => {
    expect(sessionTotals(st(doneU(1, {}), doneU(2, {}))))
      .toEqual({ turns: 2, drafts: 0, durationMs: 20, inputTokens: null, outputTokens: null, costUsd: null, incomplete: false, tokensFrom: [], costFrom: [], costIncomplete: false });
  });
  it("some reported", () => {
    expect(sessionTotals(st(doneU(1, { inputTokens: 5 }), doneU(2, {}))))
      .toMatchObject({ inputTokens: 5, outputTokens: null, costUsd: null, incomplete: true });
  });
  it("zero turns", () => {
    expect(sessionTotals(st())).toEqual({ turns: 0, drafts: 0, durationMs: 0, inputTokens: null, outputTokens: null, costUsd: null, incomplete: false, tokensFrom: [], costFrom: [], costIncomplete: false });
  });
});

describe("sessionTotals: usage of failures of an unfinished turn", () => {
  it("known usage is included, and incompleteness is kept", () => {
    const s = foldU([...doneU(1, {}), ...doneU(2, {}, 10, "p2"), ...failU(3, { inputTokens: 100, outputTokens: 5, costUsd: 0.2 }, "p3")]);
    expect(sessionTotals(s)).toMatchObject({ inputTokens: 100, outputTokens: 5, costUsd: 0.2, incomplete: true });
  });
});

describe("sessionTotals: usage participants", () => {
  const failP2 = (attempt: number): UBody => ({ type: "turn_failed", turn: 2, round: 1, participantId: "p2", attempt, kind: "invalid_response", message: "m", usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.1 } });
  const journal = (lastUsage: Usage): SessionState => foldU([
    ...doneU(1, { inputTokens: 5, outputTokens: 5, costUsd: 0.5 }),
    { type: "turn_started", turn: 2, round: 1, participantId: "p2" }, failP2(1), failP2(2),
    { type: "participant_dropped", participantId: "p2", reason: "x" },
    ...doneU(3, lastUsage, 10, "p3"),
  ]);
  it("p2 with failed attempts goes into tokensFrom and costFrom", () => {
    expect(sessionTotals(journal({ inputTokens: 1, outputTokens: 1, costUsd: 0.5 })))
      .toMatchObject({ tokensFrom: ["p1", "p2", "p3"], costFrom: ["p1", "p2", "p3"], costIncomplete: false });
  });
  it("a turn without cost makes the cost incomplete", () => {
    expect(sessionTotals(journal({ inputTokens: 1, outputTokens: 1 }))).toMatchObject({ costFrom: ["p1", "p2"], costIncomplete: true });
  });
});

describe("tokenUsage", () => {
  const st = (...turns: UBody[][]): SessionState => foldU(turns.flat());

  it("Sum over two turns", () => {
    expect(tokenUsage(st(doneU(1, { inputTokens: 300, outputTokens: 200 }), doneU(2, { inputTokens: 100, outputTokens: 50 }))))
      .toEqual({ inputTokens: 400, outputTokens: 250, total: 650, incomplete: false });
  });
  it("Turn without usage data", () => {
    const r = tokenUsage(st(doneU(1, { inputTokens: 300, outputTokens: 200 }), doneU(2, {}), doneU(3, { inputTokens: 100, outputTokens: 50 })));
    expect(r).toEqual({ inputTokens: 400, outputTokens: 250, total: 650, incomplete: true });
  });
  it("a turn with only costUsd did not report tokens, a turn with only inputTokens did", () => {
    expect(tokenUsage(st(doneU(1, { costUsd: 0.5 })))).toMatchObject({ total: 0, incomplete: true });
    expect(tokenUsage(st(doneU(1, { inputTokens: 7 })))).toEqual({ inputTokens: 7, outputTokens: 0, total: 7, incomplete: false });
  });
  it("Attempts of a dropped-out participant", () => {
    const r = tokenUsage(st(doneU(1, { inputTokens: 10, outputTokens: 10 }), failU(2, { inputTokens: 30, outputTokens: 5 })));
    expect(r).toEqual({ inputTokens: 40, outputTokens: 15, total: 55, incomplete: false });
  });
  it("attempt of a turn completed later in the same segment is not counted a second time", () => {
    const r = tokenUsage(st([doneU(1, {})[0]!, failU(1, { inputTokens: 99, outputTokens: 99 }, "p1")[1]!, doneU(1, { inputTokens: 10, outputTokens: 10 })[1]!]));
    expect(r.total).toBe(20);
  });
  it("failure without usage: a counted entry without tokens, the sum is incomplete", () => {
    expect(tokenUsage(st(doneU(1, { inputTokens: 1, outputTokens: 1 }), failU(2))).incomplete).toBe(true);
  });
  it("empty state", () => {
    expect(tokenUsage(initialState())).toEqual({ inputTokens: 0, outputTokens: 0, total: 0, incomplete: false });
  });
});

describe("Spend relative to the cap: turn running", () => {
  const SHA = "b".repeat(64);
  const U: Usage = { inputTokens: 150, outputTokens: 100 };
  const head = (drafts = false): UBody => ({
    type: "session_created", pid: 1,
    session: {
      id: "s", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "t", templateId: null, framing: "",
      participants: ["p1", "p2", "p3"].map((id) => ({ id, name: id, providerId: "scripted", model: "m", role: null })),
      limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000, maxTotalTokens: 1200 },
      ...(drafts ? { drafts: { enabled: true as const, synthesizerId: "p1" } } : {}),
    },
  });
  const running = (...extra: UBody[]) => [head(), ...doneU(1, U), ...doneU(2, U, 10, "p2"), { type: "turn_started", turn: 3, round: 1, participantId: "p3" } as UBody, ...extra];
  const dst = (draftId: string, participantId: string, attempt = 1): UBody => ({ type: "draft_attempt_started", draftId, participantId, attempt });
  const dok = (draftId: string, participantId: string, usage: Usage): UBody =>
    ({ type: "draft_completed", draftId, participantId, attempts: 1, durationMs: 7, usage, chars: 3, sha256: SHA, reasoning: "r" });

  it("a running turn is not incomplete with live, the sum is unchanged", () => {
    const s = foldU(running());
    expect(tokenUsage(s, { live: true })).toMatchObject({ total: 500, incomplete: false });
    expect(tokenUsage(s)).toMatchObject({ total: 500, incomplete: true });
  });
  it("a turn completed without tokens stays incomplete with live", () => {
    expect(tokenUsage(foldU([head(), ...doneU(1, {}), { type: "turn_started", turn: 2, round: 1, participantId: "p2" }]), { live: true }).incomplete).toBe(true);
  });
  it("a gap in file-request attempt numbers of the running turn stays incomplete with live", () => {
    const failAt = (attempt: number): UBody => ({ type: "turn_failed", turn: 3, round: 1, participantId: "p3", attempt, kind: "invalid_response", message: "m", usage: U });
    const s = foldU(running(failAt(1), failAt(3)));
    expect(tokenUsage(s, { live: true }).incomplete).toBe(true);
  });
  it("a running draft attempt in the drafting phase is not incomplete with live", () => {
    const s = foldU([head(true), dst("d1", "p1"), dok("d1", "p1", U), dst("d2", "p2")]);
    expect(tokenUsage(s, { live: true })).toMatchObject({ total: 250, incomplete: false });
    expect(tokenUsage(s).incomplete).toBe(true);
  });
  it("a lost draft attempt of an earlier slot stays incomplete with live while the next slot runs", () => {
    const s = foldU([head(true), dst("d1", "p1"), dst("d2", "p2")]);
    expect(tokenUsage(s, { live: true }).incomplete).toBe(true);
  });
  it("after drafts_finished a draft attempt without outcome stays incomplete with live", () => {
    const s = foldU([head(true), dst("d1", "p1"), dok("d1", "p1", U), dst("d2", "p2"), { type: "drafts_finished" }]);
    expect(tokenUsage(s, { live: true }).incomplete).toBe(true);
  });
});

describe("independent drafts: order and counters", () => {
  const sess = (drafts?: { enabled: true; synthesizerId: string }): SessionState => ({
    ...base(),
    session: {
      id: "s", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "t", templateId: null, framing: "",
      participants: ["p1", "p2", "p3"].map((id) => ({ id, name: id, providerId: "scripted", model: "m", role: null })),
      limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
      ...(drafts ? { drafts } : {}),
    },
  });
  const syn = () => sess({ enabled: true, synthesizerId: "p2" });
  const slot = (draftId: string, participantId: string, started: number, done = false): DraftSlot => ({
    draftId, participantId, started, failures: [],
    done: done ? { participantId, attempts: started, durationMs: 1, usage: {}, chars: 1, sha256: "0".repeat(64), reasoning: "r" } : null,
  });
  const ids = (s: SessionState) => turnOrder(s.session!).map((p) => p.id);
  const t = (n: number, id: string): TurnRecord => ({ ...turn(n, id, "r"), round: 1 });

  it("turnOrder: without drafts the original list, with a synthesizer a shift", () => {
    expect(ids(sess())).toEqual(["p1", "p2", "p3"]);
    expect(ids(syn())).toEqual(["p2", "p3", "p1"]);
  });
  it("resumePoint with synthesizer p2", () => {
    const s = syn();
    expect(resumePoint(s)).toMatchObject({ turn: 1, index: 0 });
    s.turns = [t(1, "p2")];
    s.lastStarted = { turn: 1, round: 1, participantId: "p2" };
    expect(resumePoint(s)).toMatchObject({ turn: 2, round: 1, index: 1, redo: false });
    s.turns = [t(1, "p2"), t(2, "p3"), t(3, "p1")];
    s.lastStarted = { turn: 3, round: 1, participantId: "p1" };
    expect(resumePoint(s)).toMatchObject({ turn: 4, round: 2, index: 0, completedRounds: 1 });
  });
  it("maxCallsBound", () => {
    expect(maxCallsBound(3, 2, true)).toBe(27);
    expect(maxCallsBound(3, 2, false)).toBe(18);
  });
  it("draftPhase and draftIdOf", () => {
    const s = syn();
    expect(draftPhase(sess())).toBe("off");
    expect(draftPhase(s)).toBe("drafting");
    expect(draftPhase({ ...s, draftsFinished: true })).toBe("finished");
    expect(draftIdOf(s.session!, "p3")).toBe("d3");
  });
  it("draftCallsLeft", () => {
    expect(draftCallsLeft(sess())).toBe(0);
    const s = syn();
    s.drafts = [slot("d1", "p1", 1, true), slot("d2", "p2", 1)];
    expect(draftCallsLeft(s)).toBe(2 + 3);
    s.participants[2]!.status = "dropped";
    expect(draftCallsLeft(s)).toBe(2);
    expect(draftCallsLeft({ ...s, draftsFinished: true })).toBe(0);
  });
});

describe("participant replacement: slots", () => {
  const person = (id: string) => ({ id, name: id, providerId: "scripted", model: "m", role: null });
  const sess = (n: number, drafts?: { enabled: true; synthesizerId: string }): SessionState => ({
    ...initialState(),
    session: {
      id: "s", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "t", templateId: null, framing: "",
      participants: Array.from({ length: n }, (_, i) => person(`p${i + 1}`)),
      limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
      ...(drafts ? { drafts } : {}),
    },
    participants: Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, status: "active" as const, dropReason: null })),
    versions: [{ number: 1, text: "t", authorId: "p1", turn: 1 }],
    agreed: ["p1", "p3"],
  });
  const rep = (s: SessionState, ...pairs: [string, string][]) =>
    applyReplacements(s, pairs.map(([old, id]) => ({ oldParticipantId: old, participant: person(id) })));
  const order = (s: SessionState) => turnOrder(s.session!).map((p) => p.id);
  const t = (n: number, id: string, round = 1): TurnRecord => ({ ...turn(n, id, "r"), round });
  const ls = (turn: number, round: number, participantId: string) => ({ turn, round, participantId });

  it("applyReplacements without replacements or without a session returns the same state", () => {
    const s = sess(3);
    expect(applyReplacements(s, [])).toBe(s);
    const empty = initialState();
    expect(applyReplacements(empty, [{ oldParticipantId: "p1", participant: person("p4") }])).toBe(empty);
  });

  it("applyReplacements: participants, agreement and questions", () => {
    const s = sess(3);
    s.questions = [q("q1", "p2", "open"), q("q2", "p2", "unanswered"), q("q3", "p3", "open"), { ...q("q4", "p1", "open"), from: "p2" }];
    const r = rep(s, ["p2", "p4"]);
    expect(r.session!.participants.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(r.session!.participants[3]!.replaces).toBe("p2");
    expect(r.participants[1]).toEqual({ id: "p2", status: "dropped", dropReason: null, replacedBy: "p4" });
    expect(r.participants[3]).toEqual({ id: "p4", status: "active", dropReason: null, replaces: "p2" });
    expect(r.agreed).toEqual([]);
    expect(r.questions.map((x) => x.status)).toEqual(["replaced", "unanswered", "open", "open"]);
    expect(r.versions).toBe(s.versions);
    expect(s.participants).toHaveLength(3);
  });

  it("applyReplacements: a dropped-out one keeps the dropout reason", () => {
    const s = sess(3);
    s.participants[1] = { id: "p2", status: "dropped", dropReason: "сбой" };
    expect(rep(s, ["p2", "p4"]).participants[1]).toEqual({ id: "p2", status: "dropped", dropReason: "сбой", replacedBy: "p4" });
  });

  it("slotHolder and slotRoster: one replacement and the chain p2 → p4 → p5", () => {
    const one = rep(sess(3), ["p2", "p4"]);
    expect(slotHolder(one.session!, "p2")).toBe("p4");
    expect(slotHolder(one.session!, "p1")).toBe("p1");
    expect(slotRoster(one.session!).map((p) => p.id)).toEqual(["p1", "p4", "p3"]);
    const chain = rep(one, ["p4", "p5"]);
    expect(slotHolder(chain.session!, "p2")).toBe("p5");
    expect(slotHolder(chain.session!, "p4")).toBe("p5");
    expect(slotRoster(chain.session!).map((p) => p.id)).toEqual(["p1", "p5", "p3"]);
    expect(order(rep(sess(4), ["p1", "p5"], ["p3", "p6"]))).toEqual(["p5", "p2", "p6", "p4"]);
  });

  it("draftIdOf: replacement inherits the slot's draft identifier", () => {
    const chain = rep(rep(sess(3), ["p2", "p4"]), ["p4", "p5"]);
    expect(["p1", "p2", "p3", "p4", "p5"].map((id) => draftIdOf(chain.session!, id))).toEqual(["d1", "d2", "d3", "d2", "d2"]);
  });

  it("turnOrder with drafts: the synthesizer slot is first, even if it was replaced", () => {
    const s = rep(sess(3, { enabled: true, synthesizerId: "p2" }), ["p2", "p4"]);
    expect(order(s)).toEqual(["p4", "p3", "p1"]);
    expect(order(rep(s, ["p4", "p5"]))).toEqual(["p5", "p3", "p1"]);
    expect(order(rep(sess(3, { enabled: true, synthesizerId: "p2" }), ["p1", "p4"]))).toEqual(["p2", "p3", "p4"]);
  });

  it("resumePoint: interrupted turn of a replaced active one: the new one takes the slot, turn+1, same round", () => {
    const s = sess(3);
    s.turns = [t(1, "p1")];
    s.lastStarted = ls(2, 1, "p2");
    expect(resumePoint(rep(s, ["p2", "p4"]))).toEqual({ turn: 3, round: 1, index: 1, redo: false, completedRounds: 0 });
  });

  it("resumePoint: participant dropped out on its turn and was replaced: slot passed", () => {
    const s = sess(3);
    s.turns = [t(1, "p1")];
    s.lastStarted = ls(2, 1, "p2");
    s.participants[1] = { id: "p2", status: "dropped", dropReason: "сбой" };
    expect(resumePoint(rep(s, ["p2", "p4"]))).toEqual({ turn: 3, round: 1, index: 2, redo: false, completedRounds: 0 });
    const last = sess(3);
    last.turns = [t(1, "p1"), t(2, "p2")];
    last.lastStarted = ls(3, 1, "p3");
    last.participants[2] = { id: "p3", status: "dropped", dropReason: "сбой" };
    expect(resumePoint(rep(last, ["p3", "p4"]))).toEqual({ turn: 4, round: 2, index: 0, redo: false, completedRounds: 1 });
  });

  it("resumePoint: one dropped out in the previous round and the replacement speaks in the current round", () => {
    const s = sess(3);
    s.turns = [t(1, "p1"), t(2, "p3"), t(3, "p1", 2)];
    s.lastStarted = ls(3, 2, "p1");
    s.participants[1] = { id: "p2", status: "dropped", dropReason: "сбой" };
    expect(resumePoint(rep(s, ["p2", "p4"]))).toEqual({ turn: 4, round: 2, index: 1, redo: false, completedRounds: 1 });
  });

  it("draftCallsLeft: the replacing one gets the rest of the inherited slot", () => {
    const mk = (started: number, done = false) => {
      const s = rep(sess(3, { enabled: true, synthesizerId: "p1" }), ["p2", "p4"]);
      s.participants = s.participants.map((p) => (p.id === "p1" || p.id === "p3" ? { ...p, status: "dropped" as const } : p));
      s.drafts = [{ draftId: "d2", participantId: "p2", started, failures: [], done: done ? { participantId: "p2", attempts: started, durationMs: 1, usage: {}, chars: 1, sha256: "0".repeat(64), reasoning: "r" } : null }];
      return s;
    };
    expect(draftCallsLeft(mk(1))).toBe(2);
    expect(draftCallsLeft(mk(3))).toBe(0);
    expect(draftCallsLeft(mk(1, true))).toBe(0);
  });
});
