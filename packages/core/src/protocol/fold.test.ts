import { describe, it, expect } from "vitest";
import { applyEvent, foldEvents } from "./fold.ts";
import { initialState, isConsensus, openOwnerQuestions, tokenUsage, draftPhase, draftCallsLeft, sessionTotals } from "./state.ts";
import type { SessionEvent } from "./schema.ts";

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;

const mk = (bodies: Body[]): SessionEvent[] =>
  bodies.map((b, i) => ({ ...b, seq: i + 1, ts: "2026-01-01T00:00:00Z" }) as SessionEvent);

const deepFreeze = <T,>(o: T): T => {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
};

const session = (n: number) => ({
  id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli" as const, topic: "t", templateId: null, framing: "",
  participants: Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`, name: `n${i + 1}`, providerId: "scripted", model: "m", role: null,
  })),
  limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
});

const created = (n = 3): Body => ({ type: "session_created", session: session(n), pid: 42 });
const started = (turn: number, participantId: string, round = 1): Body => ({ type: "turn_started", turn, round, participantId });
const done = (
  turn: number, participantId: string, stance: "amend" | "agree" | "object", version: number,
  extra: { questions?: { id: string; to: string; text: string }[]; answers?: { questionId: string; text: string }[] } = {},
): Body => ({
  type: "turn_completed", turn, round: 1, participantId, stance, normalized: false, reasoning: "r",
  solution: stance === "amend" ? `текст v${version}` : null, version,
  questions: extra.questions ?? [], answers: extra.answers ?? [], attempts: 1, usage: {}, durationMs: 5,
});

const v2 = (): Body[] => [
  created(), done(1, "p1", "amend", 1), done(2, "p2", "amend", 2),
];

describe("fold", () => {
  it("deterministic and does not mutate events", () => {
    const events = deepFreeze(mk([...v2(), done(3, "p3", "agree", 2)]));
    expect(foldEvents(events)).toEqual(foldEvents(events));
  });

  it("applyEvent does not mutate state", () => {
    const events = mk(v2());
    const s = deepFreeze(foldEvents(events.slice(0, 2)));
    const next = applyEvent(s, events[2]!);
    expect(next).not.toBe(s);
    expect(s.versions).toHaveLength(1);
  });

  it("some events give running and the state at that moment", () => {
    const events = mk([...v2(), started(3, "p3"), done(3, "p3", "agree", 2), { type: "session_finished", status: "consensus", version: 2, agreed: [], objectors: [] }]);
    const s = foldEvents(events.slice(0, 3));
    expect(s.status).toBe("running");
    expect(s.finish).toBeNull();
    expect(s.versions).toHaveLength(2);
    expect(s.lastSeq).toBe(3);
  });

  describe("event effects", () => {
    it("session_created", () => {
      const s = foldEvents(mk([created(2)]));
      expect(s.pid).toBe(42);
      expect(s.session?.id).toBe("s1");
      expect(s.participants).toEqual([
        { id: "p1", status: "active", dropReason: null },
        { id: "p2", status: "active", dropReason: null },
      ]);
      expect(s.lastSeq).toBe(1);
    });

    it("session_created without materials: no keys", () => {
      const s = foldEvents(mk([created(2)]));
      expect(s.session).toEqual(session(2));
      expect(s.session && "materials" in s.session).toBe(false);
    });

    it("session_created with materials", () => {
      const materials = [{ id: "m1", name: "a.md", chars: 3, sha256: "b".repeat(64) }];
      const body: Body = { type: "session_created", session: { ...session(2), materials }, pid: 1 };
      expect(foldEvents(mk([body])).session?.materials).toEqual(materials);
    });

    it("turn_started", () => {
      const s = foldEvents(mk([created(), started(1, "p1", 2)]));
      expect(s.currentTurn).toEqual({ turn: 1, round: 2, participantId: "p1" });
      expect(s.round).toBe(2);
    });

    it("turn_completed", () => {
      const s = foldEvents(mk([created(), started(1, "p1"), done(1, "p1", "amend", 1)]));
      expect(s.currentTurn).toBeNull();
      expect(s.turns).toHaveLength(1);
      expect(s.turns[0]).toMatchObject({ turn: 1, participantId: "p1", stance: "amend", version: 1, newVersion: true, attempts: 1, durationMs: 5 });
      expect(s.turns[0]).not.toHaveProperty("solution");
      expect(s.versions).toEqual([{ number: 1, text: "текст v1", authorId: "p1", turn: 1 }]);
      expect(s.agreed).toEqual(["p1"]);
    });

    it("turn_failed", () => {
      const s = foldEvents(mk([
        created(),
        { type: "turn_failed", turn: 1, round: 1, participantId: "p1", attempt: 1, kind: "timeout", message: "m" },
        { type: "turn_failed", turn: 1, round: 1, participantId: "p1", attempt: 2, kind: "invalid_response", message: "m2", raw: "xx" },
      ]));
      expect(s.failures).toEqual([
        { turn: 1, round: 1, participantId: "p1", attempt: 1, kind: "timeout", message: "m", raw: null },
        { turn: 1, round: 1, participantId: "p1", attempt: 2, kind: "invalid_response", message: "m2", raw: "xx" },
      ]);
    });

    it("participant_dropped", () => {
      const s = foldEvents(mk([created(), started(1, "p2"), { type: "participant_dropped", participantId: "p2", reason: "сбой" }]));
      expect(s.participants[1]).toEqual({ id: "p2", status: "dropped", dropReason: "сбой" });
      expect(s.currentTurn).toBeNull();
    });

    it("question_closed", () => {
      const s = foldEvents(mk([
        created(), done(1, "p1", "amend", 1, { questions: [{ id: "q1", to: "p2", text: "?" }] }),
        { type: "question_closed", questionId: "q1", reason: "unanswered" },
      ]));
      expect(s.questions[0]!.status).toBe("unanswered");
    });

    it("session_finished", () => {
      const s = foldEvents(mk([
        created(), started(1, "p1"),
        { type: "session_finished", status: "no_consensus", version: null, agreed: [], objectors: [{ participantId: "p1", reasoning: null }], reason: "лимит" },
      ]));
      expect(s.status).toBe("no_consensus");
      expect(s.finish).toEqual({ status: "no_consensus", version: null, agreed: [], objectors: [{ participantId: "p1", reasoning: null }], reason: "лимит", reasonCode: null });
      expect(s.currentTurn).toBeNull();
    });
  });

  it("amend after two agree: three versions, agreed only the author", () => {
    const s = foldEvents(mk([...v2(), done(3, "p1", "agree", 2), done(4, "p3", "amend", 3)]));
    expect(s.versions.map((v) => v.number)).toEqual([1, 2, 3]);
    expect(s.versions[2]!.authorId).toBe("p3");
    expect(s.agreed).toEqual(["p3"]);
  });

  it("agree, then object: version unchanged, participant left agreed", () => {
    const s = foldEvents(mk([...v2(), done(3, "p1", "agree", 2), done(4, "p2", "object", 2)]));
    expect(s.versions).toHaveLength(2);
    expect(s.agreed).toEqual(["p1"]);
    expect(s.turns[3]!.newVersion).toBe(false);
  });

  it("agree without repeats and in participant order", () => {
    const s = foldEvents(mk([
      created(), done(1, "p1", "amend", 1), done(2, "p3", "agree", 1), done(3, "p2", "agree", 1), done(4, "p2", "agree", 1),
    ]));
    expect(s.agreed).toEqual(["p1", "p2", "p3"]);
  });

  it("question lifecycle", () => {
    const e = mk([
      created(), done(1, "p1", "amend", 1, { questions: [{ id: "q1", to: "p2", text: "почему?" }] }),
      done(2, "p2", "agree", 1, { answers: [{ questionId: "q1", text: "потому" }] }),
      { type: "question_closed", questionId: "q1", reason: "answered" },
    ]);
    expect(foldEvents(e.slice(0, 2)).questions).toEqual([
      { id: "q1", from: "p1", to: "p2", text: "почему?", turn: 1, status: "open", answer: null },
    ]);
    expect(foldEvents(e.slice(0, 3)).questions[0]).toMatchObject({ status: "open", answer: "потому" });
    expect(foldEvents(e).questions[0]).toMatchObject({ status: "answered", answer: "потому" });
  });

  it("dropout of an agreeing participant", () => {
    const s = foldEvents(mk([
      ...v2(), done(3, "p1", "agree", 2), started(4, "p1"),
      { type: "participant_dropped", participantId: "p1", reason: "ошибки" },
    ]));
    expect(s.agreed).toEqual(["p2"]);
    expect(s.participants[0]).toMatchObject({ status: "dropped", dropReason: "ошибки" });
    expect(s.currentTurn).toBeNull();
  });

  it("full session of two participants", () => {
    const s = foldEvents(mk([
      created(2), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "agree", 1),
      { type: "session_finished", status: "consensus", version: 1, agreed: ["p1", "p2"], objectors: [] },
    ]));
    expect(s.status).toBe("consensus");
    expect(s.finish).toEqual({ status: "consensus", version: 1, agreed: ["p1", "p2"], objectors: [], reason: null, reasonCode: null });
    expect(s.versions).toHaveLength(1);
    expect(s.agreed).toEqual(["p1", "p2"]);
    expect(s.lastSeq).toBe(6);
  });

  it("empty list gives initialState", () => {
    expect(foldEvents([])).toEqual(initialState());
  });

  it("unknown participant and question do not throw", () => {
    const s = foldEvents(mk([
      created(), started(1, "p9"),
      { type: "participant_dropped", participantId: "p9", reason: "x" },
      { type: "question_closed", questionId: "q9", reason: "answered" },
      done(2, "p1", "agree", 1, { answers: [{ questionId: "q9", text: "t" }] }),
    ]));
    expect(s.participants.every((p) => p.status === "active")).toBe(true);
    expect(s.questions).toEqual([]);
    expect(s.currentTurn).toBeNull();
  });
});

describe("owner_message", () => {
  const om = (id: string, afterTurn: number, text = `реплика ${id}`): Body => ({ type: "owner_message", id, text, afterTurn, requestId: `req-${id}` });
  const withQ = (): Body[] => [
    ...v2(), done(3, "p3", "object", 2, { questions: [{ id: "q1", to: "p3", text: "?" }] }),
    done(4, "p1", "agree", 2), done(5, "p2", "agree", 2),
  ];

  it("resets the agreeing ones and leaves the rest alone", () => {
    const before = foldEvents(mk(withQ()));
    expect(before.agreed).toEqual(["p1", "p2"]);
    const after = foldEvents(mk([...withQ(), om("o1", 5)]));
    expect(after.agreed).toEqual([]);
    expect(after.versions).toEqual(before.versions);
    expect(after.questions).toEqual(before.questions);
    expect(after.questions.some((x) => x.id === "q1" && x.status === "open")).toBe(true);
    expect(after.participants).toEqual(before.participants);
    expect(after.round).toBe(before.round);
    expect(after.turns).toEqual(before.turns);
    expect(after.ownerMessages).toEqual([{ id: "o1", text: "реплика o1", afterTurn: 5, requestId: "req-o1", answers: [] }]);
  });

  it("a repeated remark resets the agreeing ones again", () => {
    const s = foldEvents(mk([...v2(), om("o1", 2), done(3, "p1", "agree", 2), om("o2", 3)]));
    expect(s.agreed).toEqual([]);
    expect(s.ownerMessages.map((m) => m.id)).toEqual(["o1", "o2"]);
  });

  it("consensus only after everyone agrees again, version unchanged", () => {
    const evs: Body[] = [...v2(), done(3, "p3", "agree", 2), om("o1", 3), done(4, "p1", "agree", 2), done(5, "p2", "agree", 2)];
    const partial = foldEvents(mk(evs));
    expect(isConsensus(partial)).toBe(false);
    const full = foldEvents(mk([...evs, done(6, "p3", "agree", 2)]));
    expect(isConsensus(full)).toBe(true);
    expect(full.versions.length).toBe(2);
    expect(full.versions.at(-1)!.number).toBe(2);
  });

  it("old journal without the event gives ownerMessages: []", () => {
    const s = foldEvents(mk(v2()));
    expect(s.ownerMessages).toEqual([]);
    expect(s.agreed).toEqual(["p2"]);
  });

  it("repeated fold gives an equal state", () => {
    const evs = mk([...withQ(), om("o1", 5)]);
    expect(foldEvents(evs)).toEqual(foldEvents(evs));
  });
});

describe("questions to the owner", () => {
  const ownerQ = (): Body[] => [
    ...v2(), done(3, "p3", "object", 2, { questions: [{ id: "q1", to: "owner", text: "что важнее?" }] }),
    done(4, "p1", "agree", 2), done(5, "p2", "agree", 2),
  ];
  const om = (answers?: { questionId: string; text: string }[]): Body => ({
    type: "owner_message", id: "o1", text: "ответ", afterTurn: 5, requestId: "req-1", ...(answers ? { answers } : {}),
  });
  const close = (reason: "answered" | "unanswered"): Body => ({ type: "question_closed", questionId: "q1", reason });

  it("open question to the owner is visible and blocks consent", () => {
    const s = foldEvents(mk(ownerQ()));
    expect(openOwnerQuestions(s)).toEqual([{ id: "q1", from: "p3", to: "owner", text: "что важнее?", turn: 3, status: "open", answer: null }]);
    expect(s.agreed).toEqual(["p1", "p2"]);
    expect(isConsensus({ ...s, agreed: ["p1", "p2", "p3"] })).toBe(false);
  });
  it("owner's answer writes answer, status stays open until question_closed", () => {
    const a = [{ questionId: "q1", text: "скорость" }];
    const s = foldEvents(mk([...ownerQ(), om(a)]));
    expect(s.questions[0]).toMatchObject({ status: "open", answer: "скорость" });
    expect(s.ownerMessages[0]!.answers).toEqual(a);
    expect(s.agreed).toEqual([]);
    const c = foldEvents(mk([...ownerQ(), om(a), close("answered")]));
    expect(c.questions[0]).toMatchObject({ status: "answered", answer: "скорость" });
    expect(openOwnerQuestions(c)).toEqual([]);
  });
  it("closing a question to the owner resets the agreeing ones", () => {
    const s = foldEvents(mk([...ownerQ(), close("unanswered")]));
    expect(s.questions[0]!.status).toBe("unanswered");
    expect(s.agreed).toEqual([]);
  });
  it("closing a question to a participant does not touch the agreeing ones", () => {
    const evs: Body[] = [
      ...v2(), done(3, "p3", "object", 2, { questions: [{ id: "q1", to: "p1", text: "?" }] }),
      done(4, "p2", "agree", 2), close("unanswered"),
    ];
    expect(foldEvents(mk(evs)).agreed).toEqual(["p2"]);
  });
  it("old journal: answers empty, no questions to the owner", () => {
    const s = foldEvents(mk([...v2(), om()]));
    expect(s.ownerMessages[0]!.answers).toEqual([]);
    expect(openOwnerQuestions(s)).toEqual([]);
  });
  it("answer to a question addressed to a participant does not change its answer", () => {
    const evs: Body[] = [...v2(), done(3, "p3", "object", 2, { questions: [{ id: "q1", to: "p1", text: "?" }] }), om([{ questionId: "q1", text: "x" }])];
    const s = foldEvents(mk(evs));
    expect(s.questions[0]!.answer).toBeNull();
  });
});

describe("session_resumed", () => {
  const fin = (status: "no_consensus" | "consensus"): Body => ({ type: "session_finished", status, version: 2, agreed: [], objectors: [], reason: "лимит" });
  const resumed = (pid: number, maxRounds: number): Body => ({ type: "session_resumed", pid, maxRounds });

  it("after no_consensus: running, no result, new pid and limit, the rest preserved", () => {
    const before = foldEvents(mk([
      ...v2(), started(3, "p3"), done(3, "p3", "object", 2, { questions: [{ id: "q1", to: "p1", text: "?" }] }),
      { type: "participant_dropped", participantId: "p2", reason: "сбой" }, fin("no_consensus"),
    ]));
    const s = foldEvents(mk([
      ...v2(), started(3, "p3"), done(3, "p3", "object", 2, { questions: [{ id: "q1", to: "p1", text: "?" }] }),
      { type: "participant_dropped", participantId: "p2", reason: "сбой" }, fin("no_consensus"), resumed(77, 6),
    ]));
    expect(s).toMatchObject({ status: "running", finish: null, pid: 77, currentTurn: null });
    expect(s.session!.limits.maxRounds).toBe(6);
    expect(s.session!.id).toBe("s1");
    for (const k of ["versions", "agreed", "questions", "participants", "turns", "failures", "ownerMessages", "round", "lastStarted"] as const) {
      expect(s[k]).toEqual(before[k]);
    }
  });

  it("second continuation and consensus result", () => {
    const s = foldEvents(mk([
      ...v2(), fin("no_consensus"), resumed(1, 4), fin("no_consensus"), resumed(2, 5),
      started(3, "p3"), done(3, "p3", "agree", 2), fin("consensus"),
    ]));
    expect(s.status).toBe("consensus");
    expect(s.finish?.status).toBe("consensus");
    expect(s.pid).toBe(2);
    expect(s.session!.limits.maxRounds).toBe(5);
  });

  it("lastStarted survives session_finished", () => {
    const s = foldEvents(mk([created(), started(1, "p1"), fin("no_consensus")]));
    expect(s.lastStarted).toEqual({ turn: 1, round: 1, participantId: "p1" });
  });

  it("without session_created the state changes only pid", () => {
    const s = foldEvents(mk([resumed(9, 4)]));
    expect(s.session).toBeNull();
    expect(s.pid).toBe(9);
  });
});

describe("owner_selected_version", () => {
  const fin = (status: "no_consensus" | "consensus" = "no_consensus"): Body => ({ type: "session_finished", status, version: 3, agreed: [], objectors: [], reason: "лимит" });
  const v3 = (): Body[] => [created(), done(1, "p1", "amend", 1), done(2, "p2", "amend", 2), done(3, "p3", "amend", 3), fin()];
  const sel = (version: number, note?: string): Body => ({ type: "owner_selected_version", version, statusAtSelection: "no_consensus", ...(note ? { note } : {}) });

  it("records the choice and changes nothing else", () => {
    const before = foldEvents(mk(v3()));
    const s = foldEvents(mk([...v3(), sel(1, "заметка")]));
    expect(s.ownerSelection).toEqual({ version: 1, statusAtSelection: "no_consensus", note: "заметка", ts: "2026-01-01T00:00:00Z" });
    expect(s.versions).toHaveLength(3);
    for (const k of ["status", "finish", "versions", "agreed"] as const) expect(s[k]).toEqual(before[k]);
  });

  it("old journal without the event gives ownerSelection: null", () => {
    expect(foldEvents(mk(v3())).ownerSelection).toBeNull();
  });

  it("the last choice wins", () => {
    const s = foldEvents(mk([...v3(), sel(1, "a"), sel(2)]));
    expect(s.ownerSelection).toMatchObject({ version: 2, note: null });
  });

  it("continuation and new turns do not reset the choice", () => {
    const s = foldEvents(mk([
      ...v3(), sel(1, "a"), { type: "session_resumed", pid: 7, maxRounds: 5 },
      started(4, "p1", 2), done(4, "p1", "agree", 3), fin("consensus"),
    ]));
    expect(s.ownerSelection).toEqual({ version: 1, statusAtSelection: "no_consensus", note: "a", ts: "2026-01-01T00:00:00Z" });
    expect(s.status).toBe("consensus");
  });
});

describe("token cap", () => {
  const fin: Body = { type: "session_finished", status: "no_consensus", version: 2, agreed: [], objectors: [] };
  const withCap = (): Body => { const c = created() as Extract<Body, { type: "session_created" }>; return { ...c, session: { ...c.session, limits: { ...c.session.limits, maxTotalTokens: 5000 } } }; };
  const resumed = (extra: object = {}): Body => ({ type: "session_resumed", pid: 9, maxRounds: 4, ...extra }) as Body;
  const fail = { type: "turn_failed", turn: 1, round: 1, participantId: "p1", attempt: 1, kind: "timeout", message: "m" } as const;

  it("turn_failed with usage carries the usage, without it there is no field", () => {
    const s = foldEvents(mk([created(), { ...fail, usage: { inputTokens: 3 } }, { ...fail, attempt: 2 }]));
    expect(s.failures[0]!.usage).toEqual({ inputTokens: 3 });
    expect("usage" in s.failures[1]!).toBe(false);
  });
  it("New cap", () => {
    expect(foldEvents(mk([withCap(), fin, resumed({ maxTotalTokens: 9000 })])).session!.limits.maxTotalTokens).toBe(9000);
  });
  it("Cap removed", () => {
    expect("maxTotalTokens" in foldEvents(mk([withCap(), fin, resumed({ maxTotalTokens: null })])).session!.limits).toBe(false);
  });
  it("Field is missing", () => {
    const s = foldEvents(mk([withCap(), fin, resumed()]));
    expect(s.session!.limits).toMatchObject({ maxTotalTokens: 5000, maxRounds: 4 });
  });
  it("Old journal", () => {
    const s = foldEvents(mk([created(), fin, resumed()]));
    expect("maxTotalTokens" in s.session!.limits).toBe(false);
  });
  it("turns before and after session_resumed are summed", () => {
    const u = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });
    const a = done(1, "p1", "amend", 1), b = done(2, "p2", "agree", 1);
    const s = foldEvents(mk([created(), { ...a, usage: u(5, 5) } as Body, fin, resumed(), { ...b, usage: u(7, 3) } as Body]));
    expect(tokenUsage(s).total).toBe(20);
  });
});

describe("resumes", () => {
  const fin: Body = { type: "session_finished", status: "no_consensus", version: 2, agreed: [], objectors: [], reason: "лимит" };
  const resumed = (maxRounds: number): Body => ({ type: "session_resumed", pid: 7, maxRounds });
  const round2 = (turn: number, id: string): Body => ({ ...started(turn, id, 2) });

  it("after no_consensus over two rounds: one mark", () => {
    const s = foldEvents(mk([
      created(2), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "object", 1),
      round2(3, "p1"), done(3, "p1", "object", 1), round2(4, "p2"), done(4, "p2", "object", 1), fin, resumed(3),
    ]));
    expect(s.resumes).toEqual([{ ts: "2026-01-01T00:00:00Z", maxRounds: 3, addedRounds: 1, beforeTurn: 5 }]);
  });

  it("stop in the middle of a turn: beforeTurn is the unfinished turn", () => {
    const s = foldEvents(mk([
      created(2), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "object", 1),
      round2(3, "p1"), { ...fin, status: "stopped" as never }, resumed(4),
    ]));
    expect(s.resumes).toEqual([{ ts: "2026-01-01T00:00:00Z", maxRounds: 4, addedRounds: 3, beforeTurn: 3 }]);
  });

  it("two continuations: two marks in order", () => {
    const s = foldEvents(mk([
      created(2), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "object", 1),
      fin, resumed(3), round2(3, "p1"), done(3, "p1", "object", 1), round2(4, "p2"), done(4, "p2", "object", 1), fin, resumed(5),
    ]));
    expect(s.resumes.map((r) => [r.maxRounds, r.addedRounds, r.beforeTurn])).toEqual([[3, 2, 3], [5, 3, 5]]);
  });

  it("without session_created there are no marks; old journal: empty", () => {
    expect(foldEvents(mk([resumed(3)])).resumes).toEqual([]);
    expect(foldEvents(mk([created(2), started(1, "p1")])).resumes).toEqual([]);
    expect(initialState().resumes).toEqual([]);
  });
});

describe("filesRead", () => {
  it("copied into the turn entry; without the field there is no key", () => {
    const withFiles = { ...done(1, "p1", "amend", 1), filesRead: [{ name: "d/a", chars: 5, shown: 5 }] } as Body;
    const s = foldEvents(mk([created(), withFiles, done(2, "p2", "agree", 1)]));
    expect(s.turns[0]!.filesRead).toEqual([{ name: "d/a", chars: 5, shown: 5 }]);
    expect("filesRead" in s.turns[1]!).toBe(false);
  });
});

describe("owner wait", () => {
  const ws = (waitId = "w1", extra: Partial<{ reasons: ("round_boundary" | "owner_question")[]; questionIds: string[] }> = {}): Body => ({
    type: "owner_wait_started", waitId, reasons: extra.reasons ?? ["round_boundary", "owner_question"], questionIds: extra.questionIds ?? ["q1"],
    afterTurn: 2, deadline: "2026-01-01T00:05:00Z",
  });
  const wf = (waitId = "w1", requestId?: string): Body => ({ type: "owner_wait_finished", waitId, reason: "continued", ...(requestId ? { requestId } : {}) });
  const base = (): Body[] => [...v2(), started(3, "p3")];

  it("journal without wait: default fields", () => {
    expect(foldEvents(mk(v2()))).toMatchObject({ waiting: null, waitCount: 0, appliedReleases: [], status: "running" });
  });
  it("started: wait filled, status unchanged", () => {
    const before = foldEvents(mk(base()));
    const s = foldEvents(mk([...base(), ws()]));
    expect(s.waiting).toEqual({
      waitId: "w1", reasons: ["round_boundary", "owner_question"], questionIds: ["q1"], afterTurn: 2,
      deadline: "2026-01-01T00:05:00Z", startedAt: "2026-01-01T00:00:00Z",
    });
    expect(s).toMatchObject({ status: "running", waitCount: 1 });
    expect(s.agreed).toEqual(before.agreed);
    expect(s.currentTurn).toEqual(before.currentTurn);
  });
  it("updated: reasons and questions replaced, deadline unchanged; foreign waitId has no effect", () => {
    const upd = (waitId: string): Body => ({ type: "owner_wait_updated", waitId, reasons: ["owner_question"], questionIds: ["q1", "q2"] });
    const s = foldEvents(mk([...base(), ws(), upd("w1")]));
    expect(s.waiting).toMatchObject({ reasons: ["owner_question"], questionIds: ["q1", "q2"], deadline: "2026-01-01T00:05:00Z", afterTurn: 2 });
    expect(foldEvents(mk([...base(), ws(), upd("w2")]))).toEqual({ ...foldEvents(mk([...base(), ws()])), lastSeq: base().length + 2 });
  });
  it("finished: wait cleared, requestId remembered; without requestId the list does not change", () => {
    const s = foldEvents(mk([...base(), ws(), wf("w1", "r1")]));
    expect(s).toMatchObject({ waiting: null, appliedReleases: ["r1"], status: "running" });
    expect(foldEvents(mk([...base(), ws(), wf("w1")])).appliedReleases).toEqual([]);
    const other = foldEvents(mk([...base(), ws(), wf("w9", "r2")]));
    expect(other.waiting?.waitId).toBe("w1");
    expect(other.appliedReleases).toEqual(["r2"]);
  });
  it("second wait: waitCount 2", () => {
    expect(foldEvents(mk([...base(), ws(), wf(), ws("w2")])).waitCount).toBe(2);
  });
  it("session_finished clears the wait", () => {
    const s = foldEvents(mk([...base(), ws(), { type: "session_finished", status: "stopped", version: 2, agreed: [], objectors: [] }]));
    expect(s.waiting).toBeNull();
    expect(s.waitCount).toBe(1);
  });
  it("session_resumed keeps the wait and the session ownerWait", () => {
    const withWait = mk([
      { type: "session_created", session: { ...session(3), ownerWait: { pauseAfterRound: true, timeoutSec: 60 } }, pid: 42 },
      ws(), wf("w1", "r1"), ws("w2"), { type: "session_resumed", pid: 7, maxRounds: 5 },
    ]);
    const s = foldEvents(withWait);
    expect(s.waiting).toMatchObject({ waitId: "w2", deadline: "2026-01-01T00:05:00Z" });
    expect(s).toMatchObject({ status: "running", waitCount: 2, appliedReleases: ["r1"] });
    expect(s.session!.ownerWait).toEqual({ pauseAfterRound: true, timeoutSec: 60 });
  });
});

describe("independent drafts", () => {
  const SHA = "b".repeat(64);
  const dst = (draftId: string, participantId: string, attempt = 1): Body => ({ type: "draft_attempt_started", draftId, participantId, attempt });
  const dfail = (draftId: string, participantId: string, attempt: number, usage?: { inputTokens?: number; outputTokens?: number }): Body =>
    ({ type: "draft_attempt_failed", draftId, participantId, attempt, kind: "timeout", message: "m", ...(usage ? { usage } : {}) });
  const dok = (draftId: string, participantId: string, usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } = {}, attempts = 1): Body =>
    ({ type: "draft_completed", draftId, participantId, attempts, durationMs: 7, usage, chars: 3, sha256: SHA, reasoning: "r" });
  const withDrafts = (n = 3, synthesizerId = "p1"): Body => {
    const c = created(n) as Extract<Body, { type: "session_created" }>;
    return { ...c, session: { ...c.session, drafts: { enabled: true, synthesizerId } } };
  };
  const fin: Body = { type: "drafts_finished" };

  it("Requirement: Events of the independent phase: the phase creates no turns, versions or consents", () => {
    const s = foldEvents(mk([withDrafts(), dst("d1", "p1"), dok("d1", "p1"), dst("d2", "p2"), dok("d2", "p2"), dst("d3", "p3"), dok("d3", "p3"), fin]));
    expect(s.turns).toEqual([]);
    expect(s.versions).toEqual([]);
    expect(s.agreed).toEqual([]);
    expect(s.currentTurn).toBeNull();
    expect(s.lastStarted).toBeNull();
    expect(draftPhase(s)).toBe("finished");
    expect(s.drafts.map((d) => d.draftId)).toEqual(["d1", "d2", "d3"]);
  });
  it("Draft after a failure: usage of the failed attempt is not added to the aggregate", () => {
    const s = foldEvents(mk([withDrafts(), dst("d1", "p1"), dfail("d1", "p1", 1, { inputTokens: 60, outputTokens: 40 }), dst("d1", "p1", 2), dok("d1", "p1", { inputTokens: 150, outputTokens: 100 }, 2)]));
    expect(tokenUsage(s).total).toBe(250);
    expect(s.drafts[0]!.failures).toHaveLength(1);
    expect(sessionTotals(s)).toMatchObject({ drafts: 1, inputTokens: 150, outputTokens: 100 });
  });
  it("Attempt with an unknown outcome", () => {
    const s = foldEvents(mk([withDrafts(), dst("d1", "p1")]));
    expect(s.drafts[0]!.started).toBe(1);
    expect(tokenUsage(s).incomplete).toBe(true);
    expect(sessionTotals(s).incomplete).toBe(true);
    expect(draftCallsLeft(s)).toBe(2 + 3 + 3);
  });
  it("Slot executor change", () => {
    const s = foldEvents(mk([withDrafts(4), dst("d2", "p2"), dst("d2", "p4", 2), dok("d2", "p4", { inputTokens: 5, outputTokens: 5 }, 2)]));
    expect(s.drafts).toHaveLength(1);
    expect(s.drafts[0]).toMatchObject({ started: 2, participantId: "p4" });
    expect(s.drafts[0]!.done!.participantId).toBe("p4");
    expect(tokenUsage(s).total).toBe(10);
  });
  it("interrupted attempt, slot accepted after continuation", () => {
    const resumed: Body = { type: "session_resumed", pid: 9, maxRounds: 4 };
    const log = (flag: boolean) => foldEvents(mk([
      withDrafts(), dst("d2", "p2"), resumed, dst("d2", "p2", 2),
      { ...dok("d2", "p2", { inputTokens: 100, outputTokens: 50 }, 2), ...(flag ? { usageIncomplete: true as const } : {}) } as Body,
    ]));
    const a = log(true);
    expect(tokenUsage(a)).toMatchObject({ total: 150, incomplete: true });
    expect(sessionTotals(a).incomplete).toBe(true);
    const b = log(false);
    expect(b.drafts[0]!.started).toBe(2);
    expect(tokenUsage(b).incomplete).toBe(false);
    expect(sessionTotals(b).incomplete).toBe(false);
  });
  it("old journal folds as before, phase off", () => {
    const sel: Body = { type: "owner_selected_version", version: 2, statusAtSelection: "no_consensus" };
    const wait: Body = { type: "owner_wait_started", waitId: "w1", reasons: ["round_boundary"], questionIds: [], afterTurn: 2, deadline: "2026-01-01T00:05:00Z" };
    const s = foldEvents(mk([...v2(), sel, wait, { type: "owner_wait_finished", waitId: "w1", reason: "continued" }]));
    expect(draftPhase(s)).toBe("off");
    expect(s).toMatchObject({ drafts: [], draftsFinished: false, waiting: null, ownerSelection: { version: 2 } });
    expect(s.turns).toHaveLength(2);
  });
  it("Additional phase: sessionTotals includes turns and drafts", () => {
    const u = { inputTokens: 10, outputTokens: 5, costUsd: 0.5 };
    const s = foldEvents(mk([
      withDrafts(),
      dst("d1", "p1"), dok("d1", "p1", u), dst("d2", "p2"), dok("d2", "p2", u), dst("d3", "p3"), dok("d3", "p3", u), fin,
      { ...done(1, "p1", "amend", 1), usage: u } as Body, { ...done(2, "p2", "agree", 1), usage: u } as Body,
    ]));
    expect(sessionTotals(s)).toEqual({ turns: 2, drafts: 3, durationMs: 3 * 7 + 2 * 5, inputTokens: 50, outputTokens: 25, costUsd: 2.5, incomplete: false, tokensFrom: ["p1", "p2", "p3"], costFrom: ["p1", "p2", "p3"], costIncomplete: false });
  });
  it("sessionTotals: known usage of failures of unfinished turns and slots is included", () => {
    const s = foldEvents(mk([
      created(),
      { type: "turn_failed", turn: 1, round: 1, participantId: "p1", attempt: 1, kind: "timeout", message: "m", usage: { inputTokens: 4 } },
    ]));
    expect(sessionTotals(s).inputTokens).toBe(4);
  });

  describe("Requirement: Events of the independent phase (property)", () => {
    function mulberry32(seed: number) {
      return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    interface Expect { started: number; failTok: number; doneTok: number | null; done: boolean; dropped: boolean; fails?: number; noTok?: boolean; failNoTok?: boolean }

    it("Requirement: Events of the independent phase: 400 random journals", () => {
      const rnd = mulberry32(40);
      const int = (n: number) => Math.floor(rnd() * n);
      let seenThree = false, seenNone = false, seenCut = false;
      for (let iter = 0; iter < 400; iter++) {
        const n = 2 + int(4);
        const bodies: Body[] = [withDrafts(n, `p${1 + int(n)}`)];
        const slots: Expect[] = [];
        for (let k = 1; k <= n; k++) {
          const id = `p${k}`, d = `d${k}`;
          const e: Expect = { started: 0, failTok: 0, doneTok: null, done: false, dropped: false };
          slots.push(e);
          const attempts = int(4);
          for (let a = 1; a <= attempts; a++) {
            bodies.push(dst(d, id, a));
            const r = rnd();
            if (r < 0.45) {
              const tok = rnd() < 0.5 ? int(100) : undefined;
              bodies.push(dfail(d, id, a, tok === undefined ? undefined : { inputTokens: tok, outputTokens: 1 }));
            } else if (r < 0.7) {
              break;
            } else {
              bodies.push(dok(d, id, rnd() < 0.2 ? {} : { inputTokens: 10 + int(50), outputTokens: 1 + int(9) }, a));
              break;
            }
          }
          if (rnd() < 0.15) bodies.push({ type: "participant_dropped", participantId: id, reason: "x" });
        }
        // the reference is computed from the truncated journal, independently of state.ts
        const cut = rnd() < 0.5 ? bodies.length : int(bodies.length + 1);
        const used = bodies.slice(0, Math.max(1, cut));
        if (rnd() < 0.3 && cut === bodies.length) used.push(fin);
        const events = mk(used);
        const s1 = foldEvents(events), s2 = foldEvents(events);
        expect(s1).toEqual(s2);

        const ref = new Map<string, Expect>();
        const dropped = new Set<string>();
        let finished = false;
        for (const b of used) {
          if (b.type === "draft_attempt_started") { const e = ref.get(b.draftId) ?? { started: 0, failTok: 0, doneTok: null, done: false, dropped: false }; e.started++; ref.set(b.draftId, e); }
          else if (b.type === "draft_attempt_failed") { const e = ref.get(b.draftId)!; e.fails = (e.fails ?? 0) + 1; e.failTok += (b.usage?.inputTokens ?? 0) + (b.usage?.outputTokens ?? 0); if (b.usage?.inputTokens === undefined && b.usage?.outputTokens === undefined) e.failNoTok = true; }
          else if (b.type === "draft_completed") { const e = ref.get(b.draftId)!; e.done = true; e.noTok = b.usage.inputTokens === undefined && b.usage.outputTokens === undefined; e.doneTok = (b.usage.inputTokens ?? 0) + (b.usage.outputTokens ?? 0); }
          else if (b.type === "participant_dropped") dropped.add(b.participantId);
          else if (b.type === "drafts_finished") finished = true;
        }
        let total = 0, left = 0, incomplete = false;
        for (const [d, e] of ref) {
          total += e.done ? e.doneTok! : e.failTok;
          // incompleteness: a call without outcome or a counted entry without tokens (a failure without usage too)
          if (e.done ? e.noTok : e.started > (e.fails ?? 0) || e.failNoTok) incomplete = true;
          if (e.started === 3) seenThree = true;
          if (e.started > 3) throw new Error("больше трёх попыток");
          const slot = s1.drafts.find((x) => x.draftId === d)!;
          expect(slot.started).toBe(e.started);
          expect(3 - slot.started).toBeGreaterThanOrEqual(0);
          expect(3 - slot.started).toBeLessThanOrEqual(3);
        }
        for (let k = 1; k <= n; k++) {
          const e = ref.get(`d${k}`);
          if (!e) seenNone = true;
          if (!dropped.has(`p${k}`) && !e?.done) left += 3 - (e?.started ?? 0);
        }
        if (used[used.length - 1]!.type === "draft_attempt_started") seenCut = true;
        expect(draftCallsLeft(s1)).toBe(finished ? 0 : left);
        expect(tokenUsage(s1).total).toBe(total);
        expect(tokenUsage(s1).incomplete).toBe(incomplete);
        expect(s1.turns).toEqual([]);
        expect(s1.versions).toEqual([]);
        expect(s1.agreed).toEqual([]);
      }
      expect(seenThree && seenNone && seenCut).toBe(true);
    });
  });
});

describe("participant replacement on continuation", () => {
  const person = (n: number) => ({ id: `p${n}`, name: `n${n}`, providerId: "scripted", model: "m", role: null });
  const fin: Body = { type: "session_finished", status: "no_consensus", version: 2, agreed: [], objectors: [], reason: "лимит" };
  const resumedWith = (replacements?: { oldParticipantId: string; participant: ReturnType<typeof person> }[]): Body =>
    ({ type: "session_resumed", pid: 7, maxRounds: 5, ...(replacements ? { replacements } : {}) });
  const prefix = (): Body[] => [
    ...v2(), started(3, "p3"),
    done(3, "p3", "agree", 2, { questions: [{ id: "q1", to: "p2", text: "вопрос старому" }, { id: "q2", to: "p1", text: "ранний" }] }),
    { type: "question_closed", questionId: "q2", reason: "unanswered" },
    { type: "owner_wait_started", waitId: "w1", reasons: ["owner_question"], questionIds: [], afterTurn: 3, deadline: "2026-01-02T00:00:00Z" },
    fin,
  ];

  it("replacement: history and usage untouched, participants and questions updated", () => {
    const before = foldEvents(mk(prefix()));
    const s = foldEvents(mk([...prefix(), resumedWith([{ oldParticipantId: "p2", participant: person(4) }])]));
    expect(s.versions).toEqual(before.versions);
    expect(s.turns).toEqual(before.turns);
    expect(s.turns.map((t) => t.participantId)).toEqual(["p1", "p2", "p3"]);
    expect(s.agreed).toEqual([]);
    expect(before.agreed).not.toEqual([]);
    expect(s.questions.find((x) => x.id === "q1")).toMatchObject({ status: "replaced", text: "вопрос старому", to: "p2" });
    expect(s.questions.find((x) => x.id === "q2")).toEqual(before.questions.find((x) => x.id === "q2"));
    expect(s.participants.find((x) => x.id === "p2")).toEqual({ id: "p2", status: "dropped", dropReason: null, replacedBy: "p4" });
    expect(s.participants.find((x) => x.id === "p4")).toEqual({ id: "p4", status: "active", dropReason: null, replaces: "p2" });
    expect(tokenUsage(s)).toEqual(tokenUsage(before));
    expect(s.waiting).toEqual(before.waiting);
    expect(s.drafts).toEqual(before.drafts);
    expect(s).toMatchObject({ status: "running", finish: null, pid: 7 });
  });

  it("continuation label counts the first turn by the state after replacement", () => {
    const s = foldEvents(mk([...v2(), started(3, "p2"), fin, resumedWith([{ oldParticipantId: "p2", participant: person(4) }])]));
    expect(s.resumes[0]!.beforeTurn).toBe(4);
    const same = foldEvents(mk([...v2(), started(3, "p2"), fin, resumedWith()]));
    expect(same.resumes[0]!.beforeTurn).toBe(3);
  });

  it("without replacements the state is the same as the previous rule gave", () => {
    const s = foldEvents(mk([...prefix(), resumedWith()]));
    const before = foldEvents(mk(prefix()));
    for (const k of ["agreed", "questions", "participants"] as const) expect(s[k]).toEqual(before[k]);
    expect(s.session!.participants).toEqual(before.session!.participants);
    expect(s.participants.every((x) => x.replacedBy === undefined && x.replaces === undefined)).toBe(true);
  });

  it("continuation label: replacements only on a continuation with a replacement", () => {
    const withR = foldEvents(mk([...prefix(), resumedWith([{ oldParticipantId: "p2", participant: person(4) }])]));
    expect(withR.resumes[0]!.replacements).toEqual([{ oldParticipantId: "p2", newParticipantId: "p4" }]);
    const without = foldEvents(mk([...prefix(), resumedWith()]));
    expect("replacements" in without.resumes[0]!).toBe(false);
  });

  it("session_finished: reasonCode is present or null", () => {
    const base: Body = { type: "session_finished", status: "failed", version: null, agreed: [], objectors: [] };
    expect(foldEvents(mk([created(), base])).finish?.reasonCode).toBeNull();
    expect(foldEvents(mk([created(), { ...base, reasonCode: "insufficient_active_participants" } as Body])).finish?.reasonCode).toBe("insufficient_active_participants");
  });
});

describe("Requirement: Usage of an attempt with a file request: fold", () => {
  it("*_files_served go into usageEvents and do not change turns, failures and slots", () => {
    const evs = mk([
      created(), started(1, "p1"),
      { type: "turn_files_served", turn: 1, round: 1, participantId: "p1", attempt: 1, usage: { inputTokens: 5 } },
      { type: "draft_attempt_started", draftId: "d2", participantId: "p2", attempt: 1 },
      { type: "draft_files_served", draftId: "d2", participantId: "p2", attempt: 1, usage: {} },
    ]);
    const s = foldEvents(evs);
    expect(s.turns).toEqual([]);
    expect(s.failures).toEqual([]);
    expect(s.drafts).toEqual([{ draftId: "d2", participantId: "p2", started: 1, failures: [], done: null }]);
    expect(s.usageEvents.map((e) => e.type)).toEqual(["session_created", "turn_started", "turn_files_served", "draft_attempt_started", "draft_files_served"]);
    expect(s.lastSeq).toBe(5);
  });
});
