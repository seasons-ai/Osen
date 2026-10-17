import { describe, it, expect } from "vitest";
import {
  StanceSchema, ParticipantSchema, LimitsSchema, SessionSchema, TurnResponseSchema, UsageSchema,
  FailureKindSchema, FinalStatusSchema, SessionEventSchema, MaterialMetaSchema, TOKEN_CAP_REASON, INSUFFICIENT_ACTIVE_REASON_CODE,
} from "./schema.ts";

const ts = "2026-01-01T00:00:00.000Z";
const p = (n: number) => ({ id: `p${n}`, name: `M${n}`, providerId: "scripted", model: "m", role: null });
const limits = { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 };
const session = { id: "s1", createdAt: ts, origin: "cli", topic: "тема", templateId: null, framing: "", participants: [p(1), p(2)], limits };
const resp = (o: object = {}) => ({ stance: "amend", reasoning: "r", solution: "s", answers: [], questions: [], ...o });
const ev = (o: object) => ({ seq: 1, ts, ...o });
const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => expect(s.safeParse(v).success).toBe(true);
const bad = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => expect(s.safeParse(v).success).toBe(false);

describe("simple schemas", () => {
  it("Stance", () => { ok(StanceSchema, "agree"); bad(StanceSchema, "maybe"); });
  it("Participant", () => { ok(ParticipantSchema, p(1)); bad(ParticipantSchema, { ...p(1), id: "p0" }); bad(ParticipantSchema, { ...p(1), name: "" }); });
  it("Limits", () => { ok(LimitsSchema, limits); bad(LimitsSchema, { ...limits, maxRounds: 0 }); });
  it("FailureKind", () => { ok(FailureKindSchema, "timeout"); bad(FailureKindSchema, "other"); });
  it("FinalStatus", () => { ok(FinalStatusSchema, "stopped"); bad(FinalStatusSchema, "interrupted"); });
  it("Usage", () => {
    const r = UsageSchema.parse({ inputTokens: 10 });
    expect("costUsd" in r).toBe(false);
    bad(UsageSchema, { inputTokens: -1 });
  });
});

describe("Session", () => {
  it("valid", () => ok(SessionSchema, session));
  it("one participant", () => bad(SessionSchema, { ...session, participants: [p(1)] }));
  it("topic of spaces", () => bad(SessionSchema, { ...session, topic: "   " }));
  it("identifiers p1, p3", () => bad(SessionSchema, { ...session, participants: [p(1), p(3)] }));
});

describe("TurnResponse", () => {
  it("amend is valid", () => ok(TurnResponseSchema, resp()));
  it("amend with null", () => bad(TurnResponseSchema, resp({ solution: null })));
  it("amend with spaces", () => bad(TurnResponseSchema, resp({ solution: "  " })));
  it("agree with text", () => bad(TurnResponseSchema, resp({ stance: "agree", solution: "x" })));
  it("object with text", () => bad(TurnResponseSchema, resp({ stance: "object", solution: "x" })));
  it("agree with an empty string gives null", () => {
    const r = TurnResponseSchema.safeParse(resp({ stance: "agree", solution: "" }));
    expect(r.success && r.data.solution).toBe(null);
  });
  it("unknown stance", () => bad(TurnResponseSchema, resp({ stance: "maybe" })));
  it("empty reasoning", () => { bad(TurnResponseSchema, resp({ reasoning: "" })); bad(TurnResponseSchema, resp({ reasoning: "  " })); });
  it("no answers", () => { const { answers: _a, ...rest } = resp(); bad(TurnResponseSchema, rest); });
  it("extra key is dropped", () => {
    const r = TurnResponseSchema.parse(resp({ extra: 1 }));
    expect("extra" in r).toBe(false);
  });
  it("Russian message with a field", () => {
    const r = TurnResponseSchema.safeParse(resp({ solution: null }));
    expect(!r.success && r.error.issues[0]?.message).toContain("solution");
  });
});

const completed = {
  type: "turn_completed", turn: 1, round: 1, participantId: "p1", stance: "amend", normalized: false,
  reasoning: "r", solution: "s", version: 1, questions: [{ id: "q1", to: "p2", text: "?" }], answers: [],
  attempts: 1, usage: {}, durationMs: 5,
};

describe("SessionEvent", () => {
  it("session_created", () => {
    ok(SessionEventSchema, ev({ type: "session_created", session, pid: 1 }));
    bad(SessionEventSchema, ev({ type: "session_created", session, pid: 1.5 }));
  });
  it("turn_started", () => {
    ok(SessionEventSchema, ev({ type: "turn_started", turn: 1, round: 1, participantId: "p1" }));
    bad(SessionEventSchema, ev({ type: "turn_started", turn: 0, round: 1, participantId: "p1" }));
  });
  it("turn_completed", () => {
    ok(SessionEventSchema, ev(completed));
    bad(SessionEventSchema, ev({ ...completed, solution: null }));
    bad(SessionEventSchema, ev({ ...completed, stance: "agree" }));
    ok(SessionEventSchema, ev({ ...completed, stance: "agree", solution: null }));
    bad(SessionEventSchema, ev({ ...completed, questions: [{ id: "x", to: "p2", text: "?" }] }));
  });
  it("turn_failed", () => {
    const f = { type: "turn_failed", turn: 1, round: 1, participantId: "p1", attempt: 1, kind: "timeout", message: "m" };
    ok(SessionEventSchema, ev(f));
    ok(SessionEventSchema, ev({ ...f, raw: "abc" }));
    bad(SessionEventSchema, ev({ ...f, kind: "weird" }));
    ok(SessionEventSchema, ev({ ...f, usage: { inputTokens: 5 } }));
    bad(SessionEventSchema, ev({ ...f, usage: { inputTokens: -1 } }));
  });
  it("participant_dropped", () => {
    ok(SessionEventSchema, ev({ type: "participant_dropped", participantId: "p2", reason: "r" }));
    bad(SessionEventSchema, ev({ type: "participant_dropped", participantId: "p2" }));
  });
  it("question_closed", () => {
    ok(SessionEventSchema, ev({ type: "question_closed", questionId: "q1", reason: "answered" }));
    bad(SessionEventSchema, ev({ type: "question_closed", questionId: "q1", reason: "x" }));
  });
  it("session_finished", () => {
    const f = { type: "session_finished", status: "consensus", version: 1, agreed: ["p1"], objectors: [{ participantId: "p2", reasoning: null }] };
    ok(SessionEventSchema, ev(f));
    ok(SessionEventSchema, ev({ ...f, status: "failed", version: null, reason: "r" }));
    bad(SessionEventSchema, ev({ ...f, version: 0 }));
  });
  it("unknown type", () => bad(SessionEventSchema, ev({ type: "nope" })));
  it("without seq", () => bad(SessionEventSchema, { ts, type: "turn_started", turn: 1, round: 1, participantId: "p1" }));
});

describe("materials in the session", () => {
  const sha = "a".repeat(64);
  const m = (n: number, over: object = {}) => ({ id: `m${n}`, name: `f${n}.md`, chars: 5, sha256: sha, ...over });
  const withMat = { ...session, materials: [m(1), m(2)], limits: { ...limits, materialsChars: 500 } };

  it("valid, fields are kept", () => {
    const r = SessionSchema.parse(withMat);
    expect(r.materials).toEqual([m(1), m(2)]);
    expect(r.limits.materialsChars).toBe(500);
  });
  it("MaterialMeta", () => { ok(MaterialMetaSchema, m(1)); ok(MaterialMetaSchema, m(1, { chars: 0 })); });
  it("identifiers m2, m1", () => bad(SessionSchema, { ...session, materials: [m(2), m(1)] }));
  it("Russian message", () => {
    const r = SessionSchema.safeParse({ ...session, materials: [m(2)] });
    expect(!r.success && r.error.issues[0]?.message).toContain("m1");
  });
  it("bad checksum", () => bad(SessionSchema, { ...session, materials: [m(1, { sha256: "xyz" })] }));
  it("uppercase letters in the checksum", () => bad(SessionSchema, { ...session, materials: [m(1, { sha256: "A".repeat(64) })] }));
  it("negative number of characters", () => bad(SessionSchema, { ...session, materials: [m(1, { chars: -1 })] }));
  it("empty name", () => bad(SessionSchema, { ...session, materials: [m(1, { name: "  " })] }));
  it("old session without new fields", () => {
    const r = SessionSchema.parse(session);
    expect("materials" in r).toBe(false);
    expect("materialsChars" in r.limits).toBe(false);
  });
  it("session_created with materials without text", () => {
    const r = SessionEventSchema.parse(ev({ type: "session_created", session: { ...withMat, materials: [{ ...m(1), text: "секрет" }] }, pid: 1 }));
    expect(JSON.stringify(r)).not.toContain("секрет");
    expect(r.type === "session_created" && r.session.materials).toEqual([m(1)]);
  });
  it("session_created of an old journal", () => {
    const r = SessionEventSchema.parse(ev({ type: "session_created", session, pid: 1 }));
    expect(r.type === "session_created" && "materials" in r.session).toBe(false);
  });
});

describe("owner_message", () => {
  const om = (o: object = {}) => ev({ type: "owner_message", id: "o1", text: "уточнение", afterTurn: 2, requestId: "req-1", ...o });
  it("a valid event is parsed and keeps seq and ts", () => {
    const r = SessionEventSchema.parse(om({ seq: 7 }));
    expect(r).toMatchObject({ type: "owner_message", id: "o1", text: "уточнение", afterTurn: 2, requestId: "req-1", seq: 7, ts });
    ok(SessionEventSchema, om({ afterTurn: 0 }));
  });
  it("rejects bad fields", () => {
    bad(SessionEventSchema, om({ id: "o0" }));
    bad(SessionEventSchema, om({ id: "q1" }));
    bad(SessionEventSchema, om({ text: "" }));
    bad(SessionEventSchema, om({ text: " \n " }));
    bad(SessionEventSchema, om({ afterTurn: -1 }));
  });
  it("answers: optional, but non-empty and meaningful", () => {
    ok(SessionEventSchema, om());
    ok(SessionEventSchema, om({ answers: [{ questionId: "q1", text: "да" }] }));
    bad(SessionEventSchema, om({ answers: [] }));
    bad(SessionEventSchema, om({ answers: [{ questionId: "", text: "да" }] }));
    bad(SessionEventSchema, om({ answers: [{ questionId: "q1", text: " " }] }));
    bad(SessionEventSchema, om({ requestId: undefined }));
  });
});

describe("session_resumed", () => {
  const sr = (o: object = {}) => ev({ type: "session_resumed", pid: 5, maxRounds: 4, ...o });
  it("a valid event is parsed", () => {
    expect(SessionEventSchema.parse(sr({ seq: 9 }))).toMatchObject({ type: "session_resumed", pid: 5, maxRounds: 4, seq: 9, ts });
  });
  it("rejects bad fields", () => {
    bad(SessionEventSchema, sr({ maxRounds: 0 }));
    bad(SessionEventSchema, sr({ pid: 1.5 }));
    bad(SessionEventSchema, sr({ pid: undefined }));
  });
});

describe("owner_selected_version", () => {
  const os = (o: object = {}) => ev({ type: "owner_selected_version", version: 2, statusAtSelection: "no_consensus", note: "мой выбор", ...o });
  it("with and without a note passes", () => {
    expect(SessionEventSchema.parse(os())).toMatchObject({ type: "owner_selected_version", version: 2, note: "мой выбор" });
    ok(SessionEventSchema, os({ note: undefined }));
  });
  it("rejects bad fields", () => {
    bad(SessionEventSchema, os({ version: undefined }));
    bad(SessionEventSchema, os({ version: 0 }));
    bad(SessionEventSchema, os({ statusAtSelection: "running" }));
    bad(SessionEventSchema, os({ note: "  " }));
  });
});

describe("token cap", () => {
  it("limits: 5000 passes, bad values are rejected with the field name", () => {
    ok(LimitsSchema, { ...limits, maxTotalTokens: 5000 });
    for (const v of [0, -1, 1.5, "5"]) {
      const r = LimitsSchema.safeParse({ ...limits, maxTotalTokens: v });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error!.issues.map((i) => i.path))).toContain("maxTotalTokens");
    }
  });
  it("session_resumed: number, null and without the field; 0 is rejected", () => {
    const sr = (o: object = {}) => ev({ type: "session_resumed", pid: 5, maxRounds: 4, ...o });
    ok(SessionEventSchema, sr({ maxTotalTokens: 8000 }));
    ok(SessionEventSchema, sr({ maxTotalTokens: null }));
    ok(SessionEventSchema, sr());
    bad(SessionEventSchema, sr({ maxTotalTokens: 0 }));
  });
  it("old turn_failed without usage passes", () => {
    ok(SessionEventSchema, ev({ type: "turn_failed", turn: 1, round: 1, participantId: "p1", attempt: 1, kind: "timeout", message: "m" }));
  });
  it("stop reason", () => { expect(TOKEN_CAP_REASON).toBe("token_cap"); });
});

describe("folder on request", () => {
  it("TurnResponse without files gives []", () => {
    expect(TurnResponseSchema.parse(resp()).files).toEqual([]);
    expect(TurnResponseSchema.parse(resp({ files: ["a"] })).files).toEqual(["a"]);
  });
  it("Session with and without workspace", () => {
    ok(SessionSchema, session);
    ok(SessionSchema, { ...session, workspace: { files: 2, chars: 0 } });
    bad(SessionSchema, { ...session, workspace: { files: 0, chars: 0 } });
  });
  it("turn_completed with and without filesRead", () => {
    ok(SessionEventSchema, ev(completed));
    ok(SessionEventSchema, ev({ ...completed, filesRead: [{ name: "d/a", chars: 5, shown: 5 }] }));
    bad(SessionEventSchema, ev({ ...completed, filesRead: [{ name: "d/a", chars: -1, shown: 0 }] }));
  });
});

describe("owner wait", () => {
  const ws = (o: object = {}) => ev({ type: "owner_wait_started", waitId: "w1", reasons: ["round_boundary", "owner_question"], questionIds: ["q1"], afterTurn: 2, deadline: ts, ...o });
  const wu = (o: object = {}) => ev({ type: "owner_wait_updated", waitId: "w1", reasons: ["owner_question"], questionIds: [], ...o });
  const wf = (o: object = {}) => ev({ type: "owner_wait_finished", waitId: "w1", reason: "continued", ...o });
  it("valid events pass", () => {
    ok(SessionEventSchema, ws());
    ok(SessionEventSchema, ws({ questionIds: [], afterTurn: 0 }));
    ok(SessionEventSchema, wu());
    ok(SessionEventSchema, wf());
    for (const reason of ["continued", "answered", "expired", "stopped"]) ok(SessionEventSchema, wf({ reason, requestId: "r1" }));
  });
  it("rejects bad fields", () => {
    for (const mkEv of [ws, wu, wf]) { bad(SessionEventSchema, mkEv({ waitId: "x1" })); bad(SessionEventSchema, mkEv({ waitId: "w0" })); }
    for (const mkEv of [ws, wu]) { bad(SessionEventSchema, mkEv({ reasons: [] })); bad(SessionEventSchema, mkEv({ reasons: ["other"] })); }
    bad(SessionEventSchema, ws({ deadline: "завтра" }));
    bad(SessionEventSchema, wf({ reason: "timeout" }));
    bad(SessionEventSchema, wf({ requestId: "" }));
  });
  it("ownerWait in the session", () => {
    ok(SessionSchema, session);
    ok(SessionSchema, { ...session, ownerWait: {} });
    ok(SessionSchema, { ...session, ownerWait: { pauseAfterRound: true, waitForOwner: true, timeoutSec: 86400 } });
    ok(SessionSchema, { ...session, ownerWait: { timeoutSec: 1 } });
    for (const timeoutSec of [0, 1.5, 86401]) bad(SessionSchema, { ...session, ownerWait: { timeoutSec } });
  });
});

describe("independent drafts", () => {
  const sha = "a".repeat(64);
  it("drafts in the session", () => {
    const three = { ...session, participants: [p(1), p(2), p(3)] };
    ok(SessionSchema, { ...three, drafts: { enabled: true, synthesizerId: "p2" } });
    bad(SessionSchema, { ...three, drafts: { enabled: true, synthesizerId: "p9" } });
    bad(SessionSchema, { ...three, drafts: { enabled: false, synthesizerId: "p2" } });
    ok(SessionSchema, three);
  });
  it("phase events", () => {
    const s = { draftId: "d1", participantId: "p1" };
    const c = { ...s, type: "draft_completed", attempts: 1, durationMs: 5, usage: {}, chars: 3, sha256: sha, reasoning: "r" };
    ok(SessionEventSchema, ev({ type: "draft_attempt_started", ...s, attempt: 1 }));
    ok(SessionEventSchema, ev({ type: "draft_attempt_failed", ...s, attempt: 3, kind: "timeout", message: "m", raw: "x", usage: { inputTokens: 1 } }));
    ok(SessionEventSchema, ev(c));
    ok(SessionEventSchema, ev({ ...c, filesRead: [{ name: "a", chars: 1, shown: 1 }] }));
    ok(SessionEventSchema, ev({ type: "drafts_finished" }));
    bad(SessionEventSchema, ev({ type: "draft_attempt_started", ...s, attempt: 4 }));
    bad(SessionEventSchema, ev({ type: "draft_attempt_failed", ...s, attempt: 0, kind: "timeout", message: "m" }));
    bad(SessionEventSchema, ev({ type: "draft_attempt_started", draftId: "x1", participantId: "p1", attempt: 1 }));
    bad(SessionEventSchema, ev({ ...c, sha256: "abc" }));
    bad(SessionEventSchema, ev({ ...c, reasoning: " " }));
  });
});

describe("participant replacement and reasonCode", () => {
  const sr = (o: object = {}) => ev({ type: "session_resumed", pid: 5, maxRounds: 4, ...o });
  const rep = (old: string, id: string) => ({ oldParticipantId: old, participant: p(Number(id.slice(1))) });
  const fin = { type: "session_finished", status: "failed", version: null, agreed: [], objectors: [] };

  it("old session_resumed and session_finished without new fields parse as before", () => {
    expect(SessionEventSchema.parse(sr())).not.toHaveProperty("replacements");
    expect(SessionEventSchema.parse(ev(fin))).not.toHaveProperty("reasonCode");
  });
  it("replacements are accepted", () => {
    ok(SessionEventSchema, sr({ replacements: [rep("p1", "p3"), rep("p2", "p4")] }));
    const e = SessionEventSchema.parse(sr({ replacements: [rep("p1", "p3")] }));
    expect(e).toMatchObject({ replacements: [{ oldParticipantId: "p1", participant: { id: "p3" } }] });
  });
  it("replacements: empty list, repeated replaced id and repeated new id are rejected", () => {
    bad(SessionEventSchema, sr({ replacements: [] }));
    bad(SessionEventSchema, sr({ replacements: [rep("p1", "p3"), rep("p1", "p4")] }));
    bad(SessionEventSchema, sr({ replacements: [rep("p1", "p3"), rep("p2", "p3")] }));
    bad(SessionEventSchema, sr({ replacements: [{ oldParticipantId: "x", participant: p(3) }] }));
  });
  it("session_created with replaces is rejected, Participant with replaces is allowed", () => {
    bad(SessionEventSchema, ev({ type: "session_created", pid: 1, session: { ...session, participants: [p(1), { ...p(2), replaces: "p1" }] } }));
    ok(ParticipantSchema, { ...p(3), replaces: "p1" });
    bad(ParticipantSchema, { ...p(3), replaces: "q1" });
  });
  it("session_finished: reasonCode is accepted, empty one is rejected", () => {
    const e = SessionEventSchema.parse(ev({ ...fin, reasonCode: INSUFFICIENT_ACTIVE_REASON_CODE }));
    expect(e).toMatchObject({ reasonCode: "insufficient_active_participants" });
    bad(SessionEventSchema, ev({ ...fin, reasonCode: "" }));
  });
});

describe("Requirement: Usage of an attempt with a file request: *_files_served events", () => {
  const turn = { type: "turn_files_served", turn: 2, round: 1, participantId: "p2", attempt: 1 };
  const draft = { type: "draft_files_served", draftId: "d2", participantId: "p2", attempt: 1 };
  it("event with usage and with empty usage passes", () => {
    ok(SessionEventSchema, ev({ ...turn, usage: { inputTokens: 600, outputTokens: 400 } }));
    ok(SessionEventSchema, ev({ ...turn, usage: {} }));
    ok(SessionEventSchema, ev({ ...draft, usage: { inputTokens: 1 } }));
    ok(SessionEventSchema, ev({ ...draft, usage: {} }));
  });
  it("without usage and with a wrong attempt: no", () => {
    bad(SessionEventSchema, ev(turn));
    bad(SessionEventSchema, ev(draft));
    bad(SessionEventSchema, ev({ ...turn, attempt: 0, usage: {} }));
    bad(SessionEventSchema, ev({ ...draft, attempt: 4, usage: {} }));
    bad(SessionEventSchema, ev({ ...draft, draftId: "x", usage: {} }));
  });
});
