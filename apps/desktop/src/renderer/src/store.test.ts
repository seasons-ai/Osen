import { describe, expect, it } from "vitest";
import type { Session, SessionEvent } from "@model-council/core/protocol";
import type { BridgeEvent, HistoryItem } from "../../shared/bridge.ts";
import type { RerunView } from "../../shared/setup.ts";
import { initialUi, pendingFor, reduce } from "./store.ts";
import type { UiAction, UiState } from "./store.ts";

const ts = new Date(Date.UTC(2026, 0, 1)).toISOString();
const session: Session = {
  id: "s1", createdAt: ts, origin: "cli", topic: "Тема", templateId: null, framing: "",
  participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: "scripted", model: "m", role: null })),
  limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
};
const events: SessionEvent[] = [
  { seq: 1, ts, type: "session_created", session, pid: 1 },
  { seq: 2, ts, type: "turn_started", turn: 1, round: 1, participantId: "p1" },
  {
    seq: 3, ts, type: "turn_completed", turn: 1, round: 1, participantId: "p1", stance: "amend", normalized: false,
    reasoning: "ok", solution: "решение", version: 1, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 1,
  },
];
const item = (id: string): HistoryItem => ({
  id, topic: "Т", createdAt: ts, origin: "cli", status: "running", templateName: null, participants: [], round: 1, maxRounds: 3, turns: 0, pinned: false, tokenCapStop: false, tokensIncomplete: false, partial: null,
});
const run = (s: UiState, ...actions: UiAction[]) => actions.reduce(reduce, s);
const ev = (id: string, event: SessionEvent): UiAction => ({ type: "bridge", event: { type: "session-event", id, event } });

describe("expired owner waits", () => {
  const started: SessionEvent = { seq: 4, ts, type: "owner_wait_started", waitId: "w1", reasons: ["round_boundary"], questionIds: [], afterTurn: 2, deadline: "2026-01-01T00:05:00Z" };
  const finished = (reason: "expired" | "continued" | "answered" | "stopped", waitId = "w1"): SessionEvent => ({ seq: 5, ts: started.deadline, type: "owner_wait_finished", waitId, reason });
  const opened = () => run(initialUi(), { type: "open", id: "s1" }, ...events.map((e) => ev("s1", e)));
  const expired = () => run(opened(), ev("s1", started), ev("s1", finished("expired")));
  it("keeps afterTurn of the active wait until the fold and the completion time", () => {
    const s = expired();
    expect(s.expiredWaits).toEqual([{ waitId: "w1", afterTurn: 2, at: "2026-01-01T00:05:00Z" }]);
    expect(s.session.waiting).toBeNull();
  });
  it.each(["continued", "answered", "stopped"] as const)("reason %s adds no mark", (reason) => {
    expect(run(opened(), ev("s1", started), ev("s1", finished(reason))).expiredWaits).toEqual([]);
  });
  it("without a matching wait takes the last started turn, without turns — zero", () => {
    expect(run(opened(), ev("s1", finished("expired"))).expiredWaits[0]?.afterTurn).toBe(1);
    expect(run(opened(), ev("s1", started), ev("s1", finished("expired", "другое"))).expiredWaits[0]?.afterTurn).toBe(1);
    expect(run(initialUi(), { type: "open", id: "s1" }, ev("s1", events[0]!), ev("s1", finished("expired"))).expiredWaits[0]?.afterTurn).toBe(0);
  });
  it("a repeated event and an event of another session add no marks", () => {
    const s = expired();
    expect(run(s, ev("s1", finished("expired")), ev("s2", { ...finished("expired"), seq: 6 })).expiredWaits).toEqual(s.expiredWaits);
  });
  it("reopening restores the marks by replaying the journal", () => {
    expect(run(expired(), { type: "open", id: "s1" }, ...events.map((e) => ev("s1", e)), ev("s1", started), ev("s1", finished("expired"))).expiredWaits).toEqual(expired().expiredWaits);
  });
  it("several expiries are kept in event order", () => {
    const s = run(expired(), ev("s1", { ...started, seq: 6, waitId: "w2", afterTurn: 3 }), ev("s1", { ...finished("expired", "w2"), seq: 7, ts: "2026-01-01T00:10:00Z" }));
    expect(s.expiredWaits).toEqual([{ waitId: "w1", afterTurn: 2, at: "2026-01-01T00:05:00Z" }, { waitId: "w2", afterTurn: 3, at: "2026-01-01T00:10:00Z" }]);
  });
  it("initial state, open, navigate, started and a foreign open-result clear the list", () => {
    expect(initialUi().expiredWaits).toEqual([]);
    const s = expired();
    const actions: UiAction[] = [{ type: "open", id: "s2" }, { type: "navigate", section: "history" }, { type: "started", id: "s2" }, { type: "bridge", event: { type: "open-result", id: "s2" } }];
    for (const action of actions) expect(reduce(s, action).expiredWaits).toEqual([]);
    expect(run(s, { type: "bridge", event: { type: "open-result", id: "s1" } }).expiredWaits).toEqual(s.expiredWaits);
  });
});

describe("reduce", () => {
  it("initial state: history, list not received", () => {
    const s = initialUi();
    expect(s.section).toBe("history");
    expect(s.sessions).toBeNull();
    expect(s.openId).toBeNull();
  });

  it("navigate changes the section and closes the session", () => {
    const s = run(initialUi(), { type: "open", id: "s1" }, { type: "navigate", section: "settings" });
    expect(s.section).toBe("settings");
    expect(s.openId).toBeNull();
  });

  it("open resets the fold, close closes it", () => {
    let s = run(initialUi(), { type: "open", id: "s1" }, ev("s1", events[0]!));
    expect(s.session.lastSeq).toBe(1);
    s = run(s, { type: "open", id: "s2" });
    expect(s.session.lastSeq).toBe(0);
    expect(run(s, { type: "navigate", section: "history" }).openId).toBeNull();
  });

  it("started opens the session in history and resets the fold", () => {
    const s = run(initialUi(), { type: "open", id: "s1" }, ev("s1", events[0]!), { type: "navigate", section: "new" }, { type: "started", id: "s2" });
    expect(s.section).toBe("history");
    expect(s.openId).toBe("s2");
    expect(s.session.lastSeq).toBe(0);
  });

  it("sessions and bridge sessions replace the list entirely", () => {
    let s = run(initialUi(), { type: "sessions", sessions: [item("a")] });
    expect(s.sessions?.map((i) => i.id)).toEqual(["a"]);
    s = run(s, { type: "bridge", event: { type: "sessions", sessions: [item("b"), item("c")] } });
    expect(s.sessions?.map((i) => i.id)).toEqual(["b", "c"]);
  });

  it("events of the open session are folded", () => {
    const s = run(initialUi(), { type: "open", id: "s1" }, ...events.map((e) => ev("s1", e)));
    expect(s.session.turns).toHaveLength(1);
    expect(s.session.lastSeq).toBe(3);
  });

  it("an event of a foreign session and a repeat by seq are ignored", () => {
    const s = run(initialUi(), { type: "open", id: "s1" }, ev("s1", events[0]!));
    expect(reduce(s, ev("other", events[1]!))).toBe(s);
    expect(reduce(s, ev("s1", events[0]!))).toBe(s);
    expect(reduce(initialUi(), ev("s1", events[0]!)).session.lastSeq).toBe(0);
  });

  it("a repeated error is not duplicated, another one is added", () => {
    const err = (message: string): BridgeEvent => ({ type: "error", message });
    let s = run(initialUi(), { type: "error", message: "а" }, { type: "bridge", event: err("а") });
    expect(s.errors).toHaveLength(1);
    s = run(s, { type: "bridge", event: err("б") });
    expect(s.errors.map((e) => e.message)).toEqual(["а", "б"]);
  });

  it("dismiss removes the message by id", () => {
    let s = run(initialUi(), { type: "error", message: "а" }, { type: "error", message: "б" });
    s = run(s, { type: "dismiss", id: s.errors[0]!.id });
    expect(s.errors.map((e) => e.message)).toEqual(["б"]);
  });

  describe("turn-text", () => {
    const tt = (id: string, turn: number, attempt: number, offset: number, text: string): UiAction => ({ type: "bridge", event: { type: "turn-text", id, turn, attempt, offset, text } });
    const opened = () => run(initialUi(), { type: "open", id: "s1" });

    it("offset 0 replaces, the next chunk is appended", () => {
      let s = run(opened(), tt("s1", 1, 1, 0, "аб"));
      expect(s.live).toEqual({ turn: 1, attempt: 1, text: "аб" });
      s = run(s, tt("s1", 1, 1, 2, "вг"));
      expect(s.live?.text).toBe("абвг");
      s = run(s, tt("s1", 1, 2, 0, "н"));
      expect(s.live).toEqual({ turn: 1, attempt: 2, text: "н" });
    });

    it("a foreign id, a wrong offset, another attempt and an empty live do not change the state", () => {
      const s0 = opened();
      expect(run(s0, tt("s2", 1, 1, 0, "x"))).toBe(s0);
      expect(run(s0, tt("s1", 1, 1, 3, "x"))).toBe(s0);
      const s = run(s0, tt("s1", 1, 1, 0, "аб"));
      expect(run(s, tt("s1", 1, 1, 5, "x"))).toBe(s);
      expect(run(s, tt("s1", 1, 2, 2, "x"))).toBe(s);
      expect(run(s, tt("s1", 2, 1, 2, "x"))).toBe(s);
    });

    it("open, navigate and started reset live", () => {
      const s = run(opened(), tt("s1", 1, 1, 0, "аб"));
      expect(run(s, { type: "open", id: "s2" }).live).toBeNull();
      expect(run(s, { type: "navigate", section: "new" }).live).toBeNull();
      expect(run(s, { type: "started", id: "s3" }).live).toBeNull();
    });
  });

  describe("open-result", () => {
    const openResult = (id: string): UiAction => ({ type: "bridge", event: { type: "open-result", id } });

    it("another session from settings: opens history and resets the fold", () => {
      const s0 = run(initialUi(), { type: "navigate", section: "settings" });
      const s = run(s0, openResult("s9"));
      expect(s.section).toBe("history");
      expect(s.openId).toBe("s9");
      expect(s.session.lastSeq).toBe(0);
      expect(s.live).toBeNull();
      expect(s.resultRequest).toBe(s0.resultRequest + 1);
    });

    it("an already open session: the fold is kept, the counter grows with each event", () => {
      const s0 = run(initialUi(), { type: "open", id: "s1" }, ...events.map((e) => ev("s1", e)));
      const s1 = run(s0, openResult("s1"));
      expect(s1.openId).toBe("s1");
      expect(s1.session).toBe(s0.session);
      expect(s1.resultRequest).toBe(s0.resultRequest + 1);
      expect(run(s1, openResult("s1")).resultRequest).toBe(s0.resultRequest + 2);
    });

    it("navigate, open and started do not change the counter; it starts at 0", () => {
      expect(initialUi().resultRequest).toBe(0);
      const s = run(initialUi(), openResult("s1"));
      expect(run(s, { type: "navigate", section: "new" }).resultRequest).toBe(1);
      expect(run(s, { type: "open", id: "s2" }).resultRequest).toBe(1);
      expect(run(s, { type: "started", id: "s3" }).resultRequest).toBe(1);
    });
  });

  describe("open-session", () => {
    const openSession = (id: string): UiAction => ({ type: "bridge", event: { type: "open-session", id } });

    it("another session from settings: opens history and resets the fold, «Summary» is not requested", () => {
      const s0 = run(initialUi(), { type: "navigate", section: "settings" });
      const s = run(s0, openSession("s9"));
      expect(s.section).toBe("history");
      expect(s.openId).toBe("s9");
      expect(s.session.lastSeq).toBe(0);
      expect(s.resultRequest).toBe(s0.resultRequest);
    });

    it("an already open session: state is the same, the screen is not recreated", () => {
      const s0 = run(initialUi(), { type: "open", id: "s1" }, ...events.map((e) => ev("s1", e)));
      const s1 = run(s0, openSession("s1"));
      expect(s1.session).toBe(s0.session);
      expect(s1.resultRequest).toBe(s0.resultRequest);
      expect(s1.openId).toBe("s1");
    });
  });
});

describe("historyFilter", () => {
  const f = { query: "импорт", status: "consensus" } as const;
  it("initially empty and «all»", () => expect(initialUi().historyFilter).toEqual({ query: "", status: "all" }));
  it("history-filter changes the selection", () => expect(run(initialUi(), { type: "history-filter", filter: f }).historyFilter).toEqual(f));
  it("going into a session and back does not reset the selection", () => {
    const s = run(initialUi(), { type: "history-filter", filter: f }, { type: "open", id: "s1" }, { type: "navigate", section: "history" });
    expect(s.openId).toBeNull();
    expect(s.historyFilter).toEqual(f);
  });
  it("a sessions event does not reset the selection", () => {
    const s = run(initialUi(), { type: "history-filter", filter: f }, { type: "bridge", event: { type: "sessions", sessions: [item("a")] } });
    expect(s.historyFilter).toEqual(f);
    expect(s.sessions).toHaveLength(1);
  });
});

describe("pending owner replies", () => {
  const sent = (id: string, requestId: string, text = requestId): UiAction => ({ type: "owner-sent", id, requestId, text, answerTo: null });
  const ownerMsg = (seq: number, requestId: string): SessionEvent => ({ seq, ts, type: "owner_message", id: `o${seq}`, text: "т", afterTurn: 0, requestId });
  const finished = (seq: number): SessionEvent => ({ seq, ts, type: "session_finished", status: "consensus", version: 1, agreed: [], objectors: [] });
  const ids = (s: UiState, id: string) => pendingFor(s, id).map((p) => p.requestId);
  const opened = () => run(initialUi(), { type: "open", id: "s1" }, ev("s1", events[0]!));

  it("owner-sent adds in order, per session, without repeats", () => {
    const s = run(initialUi(), sent("s1", "r1"), sent("s1", "r2"), sent("s2", "r3"), sent("s1", "r1"));
    expect(ids(s, "s1")).toEqual(["r1", "r2"]);
    expect(ids(s, "s2")).toEqual(["r3"]);
  });

  it("owner_message removes only its own reply; the last one removes the key", () => {
    let s = run(opened(), sent("s1", "r1"), sent("s1", "r2"), ev("s1", ownerMsg(2, "r2")));
    expect(ids(s, "s1")).toEqual(["r1"]);
    s = run(s, ev("s1", ownerMsg(3, "r1")));
    expect("s1" in s.pendingOwner).toBe(false);
  });

  it("owner_message with an unknown requestId does not change the lists, but is applied", () => {
    const s = run(opened(), sent("s1", "r1"), ev("s1", ownerMsg(2, "term")));
    expect(ids(s, "s1")).toEqual(["r1"]);
    expect(s.session.ownerMessages).toHaveLength(1);
  });

  it("session_finished removes the list of its own session", () => {
    const s = run(opened(), sent("s1", "r1"), sent("s1", "r2"), sent("s2", "r3"), ev("s1", finished(2)));
    expect("s1" in s.pendingOwner).toBe(false);
    expect(ids(s, "s2")).toEqual(["r3"]);
  });

  it("an event of a not-open session and an old seq do not change the lists", () => {
    const s = run(opened(), sent("s1", "r1"));
    expect(reduce(s, ev("other", ownerMsg(2, "r1"))).pendingOwner).toBe(s.pendingOwner);
    expect(reduce(s, ev("s1", ownerMsg(1, "r1"))).pendingOwner).toBe(s.pendingOwner);
  });

  it("navigate, open of another session and open-result do not reset; a repeated open removes by the journal", () => {
    let s = run(opened(), sent("s1", "r1"), { type: "navigate", section: "settings" }, { type: "open", id: "s2" });
    s = run(s, { type: "bridge", event: { type: "open-result", id: "s3" } });
    expect(ids(s, "s1")).toEqual(["r1"]);
    s = run(s, { type: "open", id: "s1" }, ev("s1", events[0]!), ev("s1", ownerMsg(2, "r1")));
    expect(ids(s, "s1")).toEqual([]);
  });

  it("pendingFor: the list of the open session; null and unknown give one empty array", () => {
    const s = run(opened(), sent("s1", "r1"));
    expect(pendingFor(s, s.openId)).toHaveLength(1);
    expect(pendingFor(s, null)).toBe(pendingFor(s, "нет"));
  });
});

describe("rerun", () => {
  const view: RerunView = {
    sessionId: "s1", date: "2026-10-07", topic: "Тема", templateId: null, framingFromSession: false,
    participants: [], maxRounds: 3, ownerWait: null,
    materials: { items: [], skipped: [], left: [], folder: null, ignored: [], error: null, chars: 0, limit: 100, over: 0, stamp: "s" },
  };
  const withRerun = () => run({ ...initialUi(), section: "history", openId: "s1", live: { turn: 1, attempt: 1, text: "x" } }, { type: "rerun", view });
  it("opens «New» with the rerun view and resets the open session", () => {
    const s = withRerun();
    expect(s).toMatchObject({ section: "new", openId: null, live: null });
    expect(s.rerun).toBe(view);
  });
  it("navigate, open, started, open-result reset the rerun", () => {
    expect(run(withRerun(), { type: "navigate", section: "history" }).rerun).toBeNull();
    expect(run(withRerun(), { type: "open", id: "s2" }).rerun).toBeNull();
    expect(run(withRerun(), { type: "started", id: "s2" }).rerun).toBeNull();
    expect(run(withRerun(), { type: "bridge", event: { type: "open-result", id: "s2" } }).rerun).toBeNull();
  });
  it("navigate to «Settings» and «New» keep the rerun and setupKept", () => {
    const a = withRerun();
    const b = run(a, { type: "navigate", section: "settings" });
    expect(b.rerun).toBe(view);
    expect(b.setupKept).toBe(true);
    const c = run(b, { type: "navigate", section: "new" });
    expect(c.rerun).toBe(view);
    expect(c.setupKept).toBe(true);
  });
  it("setupKept: false at the start; true after navigate(new) and rerun; navigate(history), open, started, open-result, open-session reset it", () => {
    expect(initialUi().setupKept).toBe(false);
    expect(run(initialUi(), { type: "navigate", section: "new" }).setupKept).toBe(true);
    expect(withRerun().setupKept).toBe(true);
    expect(run(initialUi(), { type: "navigate", section: "new" }, { type: "navigate", section: "settings" }).setupKept).toBe(true);
    const kept = run(initialUi(), { type: "navigate", section: "new" });
    for (const a of [
      { type: "navigate", section: "history" }, { type: "open", id: "s2" }, { type: "started", id: "s2" },
      { type: "bridge", event: { type: "open-result", id: "s2" } }, { type: "bridge", event: { type: "open-session", id: "s2" } },
    ] as UiAction[]) expect(run(kept, a).setupKept).toBe(false);
    const sameId = { ...kept, openId: "s2" };
    expect(run(sameId, { type: "bridge", event: { type: "open-result", id: "s2" } }).setupKept).toBe(false);
    expect(run(sameId, { type: "bridge", event: { type: "open-session", id: "s2" } }).setupKept).toBe(false);
  });
  it("pending replies are not affected", () => {
    const s = run(initialUi(), { type: "owner-sent", id: "s1", requestId: "r1", text: "т", answerTo: null }, { type: "rerun", view });
    expect(pendingFor(s, "s1")).toHaveLength(1);
  });
});

describe("usagePeriod", () => {
  const p = { mode: "range", from: "2026-10-01", to: "2026-10-09" } as const;
  it("initially «Today» without dates", () => expect(initialUi().usagePeriod).toEqual({ mode: "today", from: "", to: "" }));
  it("usage-period changes the period", () => expect(run(initialUi(), { type: "usage-period", period: p }).usagePeriod).toEqual(p));
  it("auto-refresh, transitions and the selection keep the same period object", () => {
    const s0 = run(initialUi(), { type: "usage-period", period: p });
    const s = run(
      s0,
      { type: "sessions", sessions: [item("a")] },
      { type: "bridge", event: { type: "sessions", sessions: [item("b")] } },
      { type: "history-filter", filter: { query: "x", status: "all" } },
      { type: "open", id: "a" },
      { type: "navigate", section: "history" },
      { type: "started", id: "c" },
    );
    expect(s.usagePeriod).toBe(s0.usagePeriod);
  });
});

describe("cli-transition event", () => {
  it("does not change the screen state", () => {
    const s = initialUi();
    expect(reduce(s, { type: "bridge", event: { type: "cli-transition" } })).toBe(s);
  });
});
