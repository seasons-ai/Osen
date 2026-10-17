import { describe, expect, it } from "vitest";
import { applyEvent, currentVersion, foldEvents, objectors } from "@model-council/core/protocol";
import type { StoredStatus } from "@model-council/core";
import { initialUi, reduce } from "../renderer/src/store.ts";
import type { SessionEvent, SessionState } from "@model-council/core/protocol";
import { afterEach } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import { failureLabel, isObjecting, objectingParticipants, timeline } from "./timeline.ts";
import type { WaitExpiry } from "./timeline.ts";

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;
const fold = (bodies: Body[]) => foldEvents(bodies.map((b, i) => ({ ...b, seq: i + 1, ts: "2026-01-01T00:00:00Z" }) as SessionEvent));

const created: Body = {
  type: "session_created", pid: 1,
  session: {
    id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "Т", templateId: null, framing: "",
    participants: [1, 2, 3].map((i) => ({ id: `p${i}`, name: `Имя${i}`, providerId: "scripted", model: "m", role: null })),
    limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
  },
};
const started = (turn: number, participantId: string): Body => ({ type: "turn_started", turn, round: 1, participantId });
const done = (turn: number, participantId: string, stance: "amend" | "agree" = "agree", version = 1): Body => ({
  type: "turn_completed", turn, round: 1, participantId, stance, normalized: false, reasoning: "r",
  solution: stance === "amend" ? "текст" : null, version, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 1,
});
const fail = (turn: number, participantId: string, attempt: number): Body => ({
  type: "turn_failed", turn, round: 1, participantId, attempt, kind: "timeout", message: "долго",
});
const kinds = (b: Body[]) => timeline(fold(b)).map((i) => i.kind + (i.kind === "failure" ? `:${i.retried}` : ""));

describe("timeline", () => {
  it("only finished turns", () => {
    expect(kinds([created, started(1, "p1"), done(1, "p1", "amend"), started(2, "p2"), done(2, "p2")])).toEqual(["turn", "turn"]);
  });
  it("failure and a successful retry", () => {
    expect(kinds([created, started(1, "p1"), fail(1, "p1", 1), done(1, "p1", "amend")])).toEqual(["failure:true", "turn"]);
  });
  it("two failures and a dropout", () => {
    const s = fold([created, started(1, "p1"), done(1, "p1", "amend"), started(2, "p2"), fail(2, "p2", 1), fail(2, "p2", 2),
      { type: "participant_dropped", participantId: "p2", reason: "таймаут" }]);
    const t = timeline(s);
    expect(t.map((i) => i.kind)).toEqual(["turn", "failure", "failure", "dropped"]);
    expect([t[1], t[2]].map((i) => i?.kind === "failure" && i.retried)).toEqual([true, false]);
    expect(t[3]).toEqual({ kind: "dropped", participantId: "p2", reason: "таймаут" });
  });
  it("failure of a running turn without a dropout", () => {
    expect(kinds([created, started(1, "p1"), fail(1, "p1", 1)])).toEqual(["failure:false"]);
  });
  it("order by turn number", () => {
    const s = fold([created, started(1, "p1"), done(1, "p1", "amend"), started(2, "p2"), fail(2, "p2", 1), done(2, "p2"), started(3, "p3"), done(3, "p3")]);
    expect(timeline(s).map((i) => (i.kind === "turn" ? i.turn.turn : i.kind === "failure" ? i.failure.turn : 0))).toEqual([1, 2, 2, 3]);
  });
  it("labels", () => {
    expect((["call_error", "timeout", "invalid_response"] as const).map((k) => failureLabel(k))).toEqual(["ошибка вызова", "таймаут", "некорректный ответ"]);
  });
});

describe("timeline: participant replacement", () => {
  const pre: Body[] = [created, started(1, "p1"), done(1, "p1", "amend"), { type: "participant_dropped", participantId: "p2", reason: "таймаут" }, { type: "session_finished", status: "failed", version: 1, agreed: [], objectors: [] } as Body];
  const marks = (b: Body[]) => timeline(fold(b)).flatMap((i) => (i.kind === "resumed" ? [i.mark] : []));
  it("the resume mark with a replacement carries replacements", () => {
    const m = marks([...pre, { type: "session_resumed", pid: 2, maxRounds: 5, replacements: [{ oldParticipantId: "p2", participant: { id: "p4", name: "Новый", providerId: "scripted", model: "m", role: null } }] } as Body]);
    expect(m).toHaveLength(1);
    expect(m[0]!.replacements).toEqual([{ oldParticipantId: "p2", newParticipantId: "p4" }]);
  });
  it("without a replacement there is no replacements key", () => {
    const m = marks([...pre, { type: "session_resumed", pid: 2, maxRounds: 5 } as Body]);
    expect(m).toHaveLength(1);
    expect("replacements" in m[0]!).toBe(false);
  });
});

describe("isObjecting", () => {
  const turn = (n: number, id: string, stance: "amend" | "agree" | "object", version: number): Body => ({
    type: "turn_completed", turn: n, round: 1, participantId: id, stance, normalized: false, reasoning: "r",
    solution: stance === "amend" ? "т" : null, version, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 1,
  });
  const base: Body[] = [created, started(1, "p1"), turn(1, "p1", "amend", 1), started(2, "p2"), turn(2, "p2", "object", 1)];
  it("objected to the current version", () => expect(isObjecting(fold(base), "p2")).toBe(true));
  it("a new version appeared after the objection", () => {
    expect(isObjecting(fold([...base, started(3, "p1"), turn(3, "p1", "amend", 2)]), "p2")).toBe(false);
  });
  it("did not take a turn", () => expect(isObjecting(fold(base), "p3")).toBe(false));
  it("agreed", () => expect(isObjecting(fold([created, started(1, "p1"), turn(1, "p1", "amend", 1), started(2, "p2"), turn(2, "p2", "agree", 1)]), "p2")).toBe(false));
});

describe("timeline: owner messages", () => {
  const say = (id: string, afterTurn: number): Body => ({ type: "owner_message", id, text: `т${id}`, afterTurn, requestId: `r${id}` });
  const three: Body[] = [created, started(1, "p1"), done(1, "p1", "amend"), started(2, "p2"), done(2, "p2"), started(3, "p3"), done(3, "p3")];
  const order = (b: Body[]) => timeline(fold(b)).map((i) => (i.kind === "owner" ? i.message.id : i.kind));
  it("after turn 2 stands between 2 and 3", () => {
    expect(order([...three.slice(0, 5), say("o1", 2), ...three.slice(5)])).toEqual(["turn", "turn", "o1", "turn"]);
  });
  it("afterTurn = 0 — first", () => {
    expect(order([created, say("o1", 0), ...three.slice(1)])).toEqual(["o1", "turn", "turn", "turn"]);
  });
  it("same afterTurn — in application order", () => {
    expect(order([...three.slice(0, 3), say("o1", 1), say("o2", 1), ...three.slice(3)])).toEqual(["turn", "o1", "o2", "turn", "turn"]);
  });
  it("after a turn with failures and a dropout — after them", () => {
    const b: Body[] = [created, started(1, "p1"), done(1, "p1", "amend"), started(2, "p2"), fail(2, "p2", 1), fail(2, "p2", 2),
      { type: "participant_dropped", participantId: "p2", reason: "таймаут" }, say("o1", 2), started(3, "p3"), done(3, "p3")];
    expect(order(b)).toEqual(["turn", "failure", "failure", "dropped", "o1", "turn"]);
  });
  it("afterTurn greater than the last turn — at the end", () => {
    expect(order([...three, started(4, "p1"), say("o1", 4)])).toEqual(["turn", "turn", "turn", "o1"]);
  });
  it("without messages the result is unchanged", () => {
    expect(order(three)).toEqual(["turn", "turn", "turn"]);
  });
});

describe("timeline: resume divider", () => {
  const mark = (beforeTurn: number, addedRounds = 2) => ({ ts: "2026-01-02T10:42:00Z", maxRounds: 5, addedRounds, beforeTurn });
  const withMarks = (b: Body[], ...marks: ReturnType<typeof mark>[]) => ({ ...fold(b), resumes: marks });
  const order = (s: ReturnType<typeof fold>) => timeline(s).map((i) => (i.kind === "turn" ? `t${i.turn.turn}` : i.kind === "owner" ? `o${i.message.id}` : i.kind === "failure" ? `f${i.failure.turn}` : i.kind === "resumed" ? `r${i.mark.beforeTurn}` : i.kind));
  it("one mark between the previous and the new turns", () => {
    const s = withMarks([created, started(1, "p1"), done(1, "p1", "amend"), started(2, "p2"), done(2, "p2"), started(3, "p3"), done(3, "p3")], mark(3));
    expect(order(s)).toEqual(["t1", "t2", "r3", "t3"]);
  });
  it("mark before a repeated turn with previous failures", () => {
    const s = withMarks([created, started(1, "p1"), done(1, "p1", "amend"), started(2, "p2"), fail(2, "p2", 1), fail(2, "p2", 2), started(2, "p2"), done(2, "p2")], mark(2));
    expect(order(s)).toEqual(["t1", "r2", "f2", "f2", "t2"]);
  });
  it("two marks in event order", () => {
    const s = withMarks([created, started(1, "p1"), done(1, "p1", "amend"), started(2, "p2"), done(2, "p2"), started(3, "p3"), done(3, "p3")], mark(2, 1), mark(3, 2));
    expect(order(s)).toEqual(["t1", "r2", "t2", "r3", "t3"]);
    expect(timeline(s).flatMap((i) => (i.kind === "resumed" ? [i.mark.addedRounds] : []))).toEqual([1, 2]);
  });
  it("no new turns yet — the mark at the end", () => {
    const s = withMarks([created, started(1, "p1"), done(1, "p1", "amend"), started(2, "p2"), done(2, "p2")], mark(3));
    expect(order(s)).toEqual(["t1", "t2", "r3"]);
  });
  it("an owner message that came before the resume stands before the mark", () => {
    const owner = { id: "o1", requestId: "r", text: "уточнение", afterTurn: 2, answers: [] } as unknown as SessionState["ownerMessages"][number];
    const base = fold([created, started(1, "p1"), done(1, "p1", "amend"), started(2, "p2"), done(2, "p2"), started(3, "p3"), done(3, "p3")]);
    expect(order({ ...base, ownerMessages: [owner], resumes: [mark(3)] })).toEqual(["t1", "t2", "oo1", "r3", "t3"]);
    expect(order({ ...fold([created, started(1, "p1"), done(1, "p1", "amend")]), ownerMessages: [{ ...owner, afterTurn: 1 }], resumes: [mark(2)] })).toEqual(["t1", "oo1", "r2"]);
  });
  it("without resumes nothing changes", () => {
    expect(order(fold([created, started(1, "p1"), done(1, "p1", "amend")]))).toEqual(["t1"]);
  });
});

describe("timeline: owner wait expiry", () => {
  const mark: WaitExpiry = { waitId: "w1", afterTurn: 2, at: "2026-01-02T10:42:00Z" };
  const base = fold([created, started(1, "p1"), done(1, "p1", "amend"), started(2, "p2"), fail(2, "p2", 1), done(2, "p2"), started(3, "p3"), done(3, "p3")]);
  it("after all elements of turn 2 and before turn 3", () => {
    const t = timeline(base, [mark]);
    expect(t.map((i) => i.kind)).toEqual(["turn", "failure", "turn", "wait-expired", "turn"]);
    expect(t[3]).toEqual({ kind: "wait-expired", mark });
  });
  it("after failures and a participant dropout", () => {
    const s = fold([created, started(2, "p2"), fail(2, "p2", 1), { type: "participant_dropped", participantId: "p2", reason: "таймаут" }, started(3, "p3"), done(3, "p3")]);
    expect(timeline(s, [mark]).map((i) => i.kind)).toEqual(["failure", "dropped", "wait-expired", "turn"]);
  });
  it("at one point: owner message, resume, expiry", () => {
    const s = {
      ...base,
      ownerMessages: [{ id: "o1", requestId: "r1", text: "уточнение", afterTurn: 2, answers: [], ts: mark.at }],
      resumes: [{ ts: mark.at, maxRounds: 5, addedRounds: 2, beforeTurn: 3 }],
    };
    expect(timeline(s, [mark]).map((i) => i.kind)).toEqual(["turn", "failure", "turn", "owner", "resumed", "wait-expired", "turn"]);
  });
  it("at one point marks go by time: the deadline expired before the resume — expiry first", () => {
    const s = { ...base, resumes: [{ ts: new Date(Date.parse(mark.at) + 60000).toISOString(), maxRounds: 5, addedRounds: 2, beforeTurn: 3 }] };
    expect(timeline(s, [mark]).map((i) => i.kind)).toEqual(["turn", "failure", "turn", "wait-expired", "resumed", "turn"]);
  });
  it("after the last turn — at the end, after the message and the resume", () => {
    const s = fold([created, started(2, "p2"), done(2, "p2"), { type: "owner_message", id: "o1", requestId: "r1", text: "уточнение", afterTurn: 2 }, { type: "session_resumed", pid: 2, maxRounds: 5 }]);
    expect(timeline(s, [mark]).map((i) => i.kind)).toEqual(["turn", "owner", "resumed", "wait-expired"]);
  });
  it("zero turn — before the first; several expiries — in event order", () => {
    const first = { ...mark, waitId: "w0", afterTurn: 0 };
    const second = { ...mark, waitId: "w2" };
    const t = timeline(base, [first, mark, second]);
    expect(t.map((i) => i.kind)).toEqual(["wait-expired", "turn", "failure", "turn", "wait-expired", "wait-expired", "turn"]);
    expect(t.flatMap((i) => i.kind === "wait-expired" ? [i.mark.waitId] : [])).toEqual(["w0", "w1", "w2"]);
  });
  it("without the second argument the result is unchanged", () => {
    expect(timeline(base).map((i) => i.kind)).toEqual(["turn", "failure", "turn", "turn"]);
    expect(timeline(base)).toEqual(timeline(base, []));
  });
});

const st = (d: string, p: string, attempt = 1): Body => ({ type: "draft_attempt_started", draftId: d, participantId: p, attempt });
const df = (d: string, p: string, attempt: number): Body => ({ type: "draft_attempt_failed", draftId: d, participantId: p, attempt, kind: "timeout", message: "долго" });
const ok = (d: string, p: string, attempts = 1): Body => ({ type: "draft_completed", draftId: d, participantId: p, attempts, durationMs: 1, usage: {}, chars: 3, sha256: "a".repeat(64), reasoning: "r" });

describe("timeline: independent drafts", () => {
  const withDrafts = (n = 3, synth = "p2"): Body => {
    const c = created as Extract<Body, { type: "session_created" }>;
    return { ...c, session: { ...c.session, participants: c.session.participants.slice(0, n), drafts: { enabled: true, synthesizerId: synth } } };
  };
  const fin: Body = { type: "drafts_finished" };

  it("the phase is running: the section and two drafts in participant order, no turns", () => {
    const t = timeline(fold([withDrafts(), st("d2", "p2"), ok("d2", "p2"), st("d1", "p1"), ok("d1", "p1"), st("d3", "p3")]));
    expect(t.map((i) => i.kind)).toEqual(["draft-phase", "draft", "draft"]);
    expect(t.flatMap((i) => (i.kind === "draft" ? [i.draftId] : []))).toEqual(["d1", "d2"]);
  });
  it("the phase is finished: a start mark before the turn, the draft has no version or position", () => {
    const t = timeline(fold([withDrafts(), st("d1", "p1"), ok("d1", "p1"), st("d2", "p2"), ok("d2", "p2"), fin, started(1, "p2"), done(1, "p2", "amend", 1)]));
    expect(t.map((i) => i.kind)).toEqual(["draft-phase", "draft", "draft", "discussion-start", "turn"]);
    expect(t[3]).toEqual({ kind: "discussion-start", synthesizerId: "p2" });
    for (const i of t) if (i.kind === "draft") expect(Object.keys(i.done)).not.toEqual(expect.arrayContaining(["version", "stance"]));
  });
  it("slot failures before the accepted draft; the dropped one without a draft", () => {
    const t = timeline(fold([withDrafts(), st("d1", "p1"), df("d1", "p1", 1), st("d1", "p1", 2), df("d1", "p1", 2), st("d1", "p1", 3), ok("d1", "p1", 3),
      st("d2", "p2"), df("d2", "p2", 1), { type: "participant_dropped", participantId: "p2", reason: "таймаут" }]));
    expect(t.map((i) => i.kind + (i.kind === "draft-failure" ? `:${i.retried}` : ""))).toEqual(["draft-phase", "draft-failure:true", "draft-failure:true", "draft", "draft-failure:false", "draft-dropped"]);
    expect(t.at(-1)).toEqual({ kind: "draft-dropped", participantId: "p2", reason: "таймаут" });
  });
});

// Deterministic generator of phase journals (mulberry32).
function mulberry32(a: number) {
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe("timeline: properties", () => {
  it("Independent drafts in the feed: for any journal each accepted draft once", () => {
    const SHA = "c".repeat(64);
    let dupes = 0, redelivered = 0;
    const BYPASS_REDUCE = false; // true — events bypass the store.reduce cutoff (checks that the test distinguishes it)
    let sawThree = false, sawDroppedNoDraft = false, sawCut = false, sawEmpty = false;
    for (let seed = 1; seed <= 400; seed++) {
      const rnd = mulberry32(seed);
      const pick = (n: number) => Math.floor(rnd() * n);
      const n = 2 + pick(4);
      const c = created as Extract<Body, { type: "session_created" }>;
      const ids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
      const bodies: Body[] = [{ ...c, session: { ...c.session, participants: ids.map((id, i) => ({ ...c.session.participants[0]!, id, name: `Имя${i + 1}` })), drafts: { enabled: true, synthesizerId: ids[pick(n)]! } } }];
      const dropped = new Set<string>();
      const empty = seed % 25 === 0;
      if (!empty) ids.forEach((id, i) => {
        const d = `d${i + 1}`;
        const mode = pick(5); // 0 accepted at once, 1 accepted after failures, 2 three attempts and accepted, 3 dropped without a draft, 4 no slot
        if (mode === 4) return;
        const fails = mode === 0 ? 0 : mode === 1 ? 1 + pick(2) : mode === 2 ? 2 : 1 + pick(2);
        for (let a = 1; a <= fails; a++) { bodies.push(st(d, id, a), df(d, id, a)); }
        if (mode === 3) { bodies.push({ type: "participant_dropped", participantId: id, reason: "сбой" }); dropped.add(id); return; }
        if (mode === 2) sawThree = true;
        bodies.push(st(d, id, fails + 1), { type: "draft_completed", draftId: d, participantId: id, attempts: fails + 1, durationMs: 1, usage: {}, chars: 3, sha256: SHA, reasoning: "r" });
      });
      if (empty) sawEmpty = true;
      if (dropped.size > 0) sawDroppedNoDraft = true;
      const cut = rnd() < 0.3;
      if (cut) { sawCut = true; bodies.push(st(`d${n}`, ids[n - 1]!, 1)); } // cut off in the middle of a slot
      let turns = 0;
      if (!cut && rnd() < 0.7) {
        bodies.push({ type: "drafts_finished" });
        const first = bodies[0] as Extract<Body, { type: "session_created" }>;
        const active = ids.filter((id) => !dropped.has(id));
        for (let k = 0; k < pick(4) && active.length > 0; k++, turns++) bodies.push(started(k + 1, active[k % active.length]!), done(k + 1, active[k % active.length]!, k === 0 ? "amend" : "agree", 1));
        void first;
      }
      const build = () => fold(bodies);
      const s = build();
      const t = timeline(s);
      const cards = t.filter((i) => i.kind === "draft");
      const accepted = s.drafts.filter((d) => d.done !== null);
      expect(cards.length).toBe(accepted.length);
      for (const d of accepted) expect(cards.filter((i) => i.kind === "draft" && i.draftId === d.draftId)).toHaveLength(1);
      if (turns === 0) { expect(s.agreed).toEqual([]); expect(currentVersion(s)).toBeNull(); }
      const lastPhase = Math.max(...t.map((i, idx) => (i.kind === "draft-phase" || i.kind === "draft" || i.kind === "draft-failure" || i.kind === "draft-dropped" || i.kind === "discussion-start" ? idx : -1)));
      const firstRegular = t.findIndex((i) => i.kind === "turn" || i.kind === "failure" || i.kind === "dropped" || i.kind === "owner" || i.kind === "resumed");
      expect(t[0]!.kind).toBe("draft-phase");
      if (firstRegular >= 0) expect(lastPhase).toBeLessThan(firstRegular);
      expect(timeline(build())).toEqual(t);
      // window path: duplicates and a repeated tail delivery go through reduce
      const evs = bodies.map((b, i) => ({ ...b, seq: i + 1, ts: "2026-01-01T00:00:00Z" }) as SessionEvent);
      let ui = reduce(initialUi(), { type: "open", id: "s1" });
      let raw = ui.session;
      const deliver = (event: SessionEvent) => {
        if (BYPASS_REDUCE) raw = applyEvent(raw, event);
        else ui = reduce(ui, { type: "bridge", event: { type: "session-event", id: "s1", event } });
      };
      evs.forEach((e, i) => {
        deliver(e);
        if (rnd() < 0.3) { deliver(e); dupes++; }
        if (rnd() < 0.15) { for (let j = Math.max(0, i - 3); j <= i; j++) deliver(evs[j]!); redelivered++; }
      });
      const windowState = BYPASS_REDUCE ? raw : ui.session;
      expect(timeline(windowState)).toEqual(t);
      expect(timeline(windowState).filter((i) => i.kind === "draft")).toHaveLength(accepted.length);
    }
    expect([sawThree, sawDroppedNoDraft, sawCut, sawEmpty]).toEqual([true, true, true, true]);
    expect(dupes).toBeGreaterThan(0);
    expect(redelivered).toBeGreaterThan(0);
  });
});

describe("timeline: a replaced one is not counted as dropped", () => {
  const stop: Body = { type: "session_finished", status: "stopped", version: 1, agreed: [], objectors: [] } as Body;
  const resume = (old: string): Body => ({ type: "session_resumed", pid: 2, maxRounds: 5, replacements: [{ oldParticipantId: old, participant: { id: "p4", name: "Новый", providerId: "scripted", model: "m", role: null } }] }) as Body;
  const head = [created, started(1, "p1"), done(1, "p1", "amend"), started(2, "p2"), fail(2, "p2", 1)];
  it("replaced by an active one with a failed attempt: no dropped element", () => {
    const k = timeline(fold([...head, stop, resume("p2")])).map((i) => i.kind);
    expect(k).toContain("failure");
    expect(k).not.toContain("dropped");
  });
  it("dropped, then replaced: the dropped element stays", () => {
    const t = timeline(fold([...head, fail(2, "p2", 2), { type: "participant_dropped", participantId: "p2", reason: "таймаут" }, stop, resume("p2")]));
    expect(t.find((i) => i.kind === "dropped")).toEqual({ kind: "dropped", participantId: "p2", reason: "таймаут" });
  });
});

describe("timeline: en", () => {
  afterEach(() => setProcessLanguage("ru"));
  it("failure kind labels", () => {
    expect((["call_error", "timeout", "invalid_response"] as const).map((k) => failureLabel(k, "en"))).toEqual(["call error", "timeout", "invalid response"]);
  });
  it("dropped without a reason", () => {
    const s = fold([created, started(1, "p1"), done(1, "p1", "amend"), started(2, "p2"), fail(2, "p2", 1), { type: "participant_dropped", participantId: "p2", reason: null } as unknown as Body]);
    setProcessLanguage("en");
    expect(timeline(s).find((i) => i.kind === "dropped")).toMatchObject({ reason: "no reason given" });
    setProcessLanguage("ru");
    expect(timeline(s).find((i) => i.kind === "dropped")).toMatchObject({ reason: "причина не указана" });
  });
});

describe("objectingParticipants (change 109)", () => {
  // reference: the expression from the former Result.tsx
  const ref = (state: SessionState, status: StoredStatus) =>
    (state.finish?.objectors ?? objectors(state)).filter((o) => status === "no_consensus" || isObjecting(state, o.participantId));
  const obj = (turn: number, p: string, version = 1): Body => ({
    type: "turn_completed", turn, round: 1, participantId: p, stance: "object", normalized: false, reasoning: `против ${p}`,
    solution: null, version, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 1,
  });
  const states: [string, Body[]][] = [
    ["без завершения: p1 правит, p2 возражает", [created, started(1, "p1"), done(1, "p1", "amend"), started(2, "p2"), obj(2, "p2")]],
    ["возражение против старой версии", [created, started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), obj(2, "p2", 1), started(3, "p3"), done(3, "p3", "amend", 2)]],
    ["согласие", [created, started(1, "p1"), done(1, "p1", "amend"), started(2, "p2"), done(2, "p2"), started(3, "p3"), done(3, "p3"),
      { type: "session_finished", status: "consensus", version: 1, agreed: ["p1", "p2", "p3"], objectors: [] }]],
    ["завершение с записанными возражающими", [created, started(1, "p1"), done(1, "p1", "amend"), started(2, "p2"), obj(2, "p2"),
      { type: "session_finished", status: "no_consensus", version: 1, agreed: ["p1"], objectors: [{ participantId: "p2", reasoning: "дорого" }, { participantId: "p3", reasoning: null }] }]],
    ["пустая сессия", [created]],
  ];
  for (const [name, bodies] of states) {
    for (const status of ["interrupted", "running", "stopped", "failed", "consensus", "no_consensus"] as StoredStatus[]) {
      it(`${name} · ${status}`, () => {
        const s = fold(bodies);
        expect(objectingParticipants(s, status)).toEqual(ref(s, status));
      });
    }
  }
  it("interrupted: p1 agrees — only p2; no_consensus without a finish — also the one who did not take a turn", () => {
    const s = fold(states[0]![1]);
    expect(objectingParticipants(s, "interrupted").map((o) => o.participantId)).toEqual(["p2"]);
    expect(objectingParticipants(s, "no_consensus").map((o) => o.participantId)).toEqual(["p2", "p3"]);
  });
});
