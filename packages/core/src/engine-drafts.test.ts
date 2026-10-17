import { describe, it, expect } from "vitest";
import { createSession, runSession, SessionInputError } from "./engine.ts";
import type { DraftStore, OwnerMessageSource, RunSessionOptions } from "./engine.ts";
import { createScriptedDriver } from "./participants/scripted.ts";
import type { Scenario } from "./participants/scripted.ts";
import type { ParticipantDriver, TurnRequest, TurnResult } from "./participants/driver.ts";
import { sha256Of } from "./materials.ts";
import { DRAFT_CONTEXT_LIMIT_REASON, INSUFFICIENT_ACTIVE_REASON_CODE, SYNTHESIZER_UNAVAILABLE_REASON, TOKEN_CAP_REASON } from "./protocol/schema.ts";
import { foldEvents } from "./protocol/fold.ts";
import type { Limits, SessionEvent } from "./protocol/schema.ts";
import { maxCallsBound, tokenUsage } from "./protocol/state.ts";
import type { SessionState } from "./protocol/state.ts";

type Step = Scenario["steps"][number];
type Extra = Record<string, unknown>;

const resp = (stance: string, solution: string | null, extra: Extra = {}): Step => ({
  response: { stance, reasoning: "r", solution, answers: [], questions: [], ...extra },
});
const amend = (text: string, extra?: Extra) => resp("amend", text, extra);
const agree = (extra?: Extra) => resp("agree", null, extra);
const object = (extra?: Extra) => resp("object", null, extra);

const scripted = (...steps: Step[]) => createScriptedDriver({ steps }, { COUNCIL_DEV: "1" });
const limits = (over: Partial<Limits> = {}): Limits => ({ maxRounds: 5, turnTimeoutSec: 30, contextChars: 20000, ...over });

const WS = [{ name: "proj/a.txt", text: "содержимое файла" }];
const FILES = ["proj/a.txt"];

interface Opts { synth?: string; over?: Partial<Limits>; ws?: boolean }
function mk(n: number, o: Opts = {}) {
  return createSession(
    {
      topic: "Тема", framing: "", origin: "cli", limits: limits(o.over),
      drafts: o.synth ? { synthesizerId: o.synth } : {},
      ...(o.ws ? { workspace: WS } : {}),
      participants: Array.from({ length: n }, (_, i) => ({ name: `N${i + 1}`, providerId: "scripted", model: "m", role: null })),
    },
    { maxParticipants: 8, id: "s1", now: () => new Date("2026-01-01T00:00:00Z") },
  );
}

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1) + (tick += 10));

const types = (events: SessionEvent[]) => events.map((e) => e.type);
const of = <T extends SessionEvent["type"]>(events: SessionEvent[], type: T) =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);
const finishOf = (events: SessionEvent[]) => of(events, "session_finished")[0]!;
const driverOf = (fn: (req: TurnRequest) => Promise<TurnResult>): ParticipantDriver => ({ call: fn });

interface Call { id: string; prompt: string; phase: boolean }
/** Records each request and whether the drafts phase was running at that moment. */
function play(drivers: ParticipantDriver[], o: Opts = {}, extra: Partial<RunSessionOptions> = {}) {
  const calls: Call[] = [];
  let over = false;
  const wrapped = Object.fromEntries(drivers.map((d, i) => [`p${i + 1}`, driverOf((req) => {
    calls.push({ id: `p${i + 1}`, prompt: req.prompt, phase: !over });
    return d.call(req);
  })]));
  const session = mk(drivers.length, o);
  const run = runSession({
    session, now: clock, drivers: wrapped, ...(o.ws ? { workspace: WS } : {}), ...extra,
    onEvent: (e, s) => { if (e.type === "drafts_finished") over = true; extra.onEvent?.(e, s); },
  });
  return { run, calls, session };
}
const phaseOf = (calls: Call[], id: string) => calls.filter((c) => c.phase && c.id === id);
const lbl = (id: string) => `МЕТКА-${id.toUpperCase()}-Ж`;
const draftOf = (id: string) => amend(lbl(id), { reasoning: `ОБОСН-${lbl(id)}` });
const BAD: Step = { raw: "это не JSON" };

describe("createSession: drafts phase", () => {
  const base = (drafts?: { synthesizerId?: string }) => ({
    topic: "Т", framing: "", origin: "cli" as const, limits: limits(),
    ...(drafts ? { drafts } : {}),
    participants: [1, 2, 3].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })),
  });
  const opt = { maxParticipants: 8, id: "s1" };
  it("1. default synthesizer p1, explicit p2, unknown rejected, no phase field without one", () => {
    expect(createSession(base({}), opt).drafts).toEqual({ enabled: true, synthesizerId: "p1" });
    expect(createSession(base({ synthesizerId: "p2" }), opt).drafts).toEqual({ enabled: true, synthesizerId: "p2" });
    expect(() => createSession(base({ synthesizerId: "p9" }), opt)).toThrow(SessionInputError);
    expect(() => createSession(base({ synthesizerId: "p9" }), opt)).toThrow("Синтезатор p9 не входит в состав: допустимы p1–p3.");
    expect(createSession(base(), opt)).not.toHaveProperty("drafts");
  });
});

describe("runSession: independent drafts phase", () => {
  it("2. other synthesizer: drafts in order, turns shifted", async () => {
    const { run } = play([
      scripted(draftOf("p1"), object(), object()),
      scripted(draftOf("p2"), amend("v1"), object()),
      scripted(draftOf("p3"), object(), object()),
    ], { synth: "p2", over: { maxRounds: 2 } });
    const { events, state } = await run;
    expect(types(events).slice(0, 8)).toEqual([
      "session_created",
      "draft_attempt_started", "draft_completed", "draft_attempt_started", "draft_completed",
      "draft_attempt_started", "draft_completed", "drafts_finished",
    ]);
    expect(of(events, "draft_completed").map((e) => e.participantId)).toEqual(["p1", "p2", "p3"]);
    expect(of(events, "turn_started").map((e) => e.participantId)).toEqual(["p2", "p3", "p1", "p2", "p3", "p1"]);
    expect(of(events, "turn_started")[0]).toMatchObject({ turn: 1, round: 1 });
    expect(state.versions[0]).toMatchObject({ number: 1, authorId: "p2", turn: 1 });
    expect(finishOf(events).status).toBe("no_consensus");
  });

  it("3. drafts create no versions, agreements, turns or questions", async () => {
    let seen: SessionState | null = null;
    const { run } = play([scripted(draftOf("p1"), amend("v1")), scripted(draftOf("p2"), agree())], {}, {
      onEvent: (e, s) => { if (e.type === "drafts_finished") seen = s; },
    });
    await run;
    expect(seen).not.toBeNull();
    const s = seen as unknown as SessionState;
    expect([s.versions, s.agreed, s.turns, s.questions]).toEqual([[], [], [], []]);
  });

  it("4. phase requests contain no foreign labels or names", async () => {
    const p2: Step[] = [{ ...amend("x", { files: FILES }) }, BAD, draftOf("p2")];
    const { run, calls } = play([
      scripted(draftOf("p1"), amend("v1")), scripted(...p2, object()), scripted(draftOf("p3"), object()),
    ], { ws: true, over: { maxRounds: 1 } });
    await run;
    expect(phaseOf(calls, "p2")).toHaveLength(3);
    for (const id of ["p1", "p2", "p3"]) {
      for (const c of phaseOf(calls, id)) {
        for (const other of ["p1", "p2", "p3"].filter((x) => x !== id)) {
          expect(c.prompt).not.toContain(lbl(other));
          expect(c.prompt).not.toContain(`ОБОСН-${lbl(other)}`);
          expect(c.prompt).not.toContain(`N${other.slice(1)}`);
        }
      }
    }
    expect(phaseOf(calls, "p2")[1]!.prompt).toContain("# Запрошенные файлы");
    expect(phaseOf(calls, "p2")[2]!.prompt).toContain("# Исправь предыдущий ответ");
  });

  it("5. owner question in a draft: correction, no questions, attempts 2", async () => {
    const q = amend("s", { questions: [{ to: "owner", text: "Что именно?" }] });
    const { run, calls } = play([scripted(q, draftOf("p1"), amend("v1")), scripted(draftOf("p2"), agree())]);
    const { events, state } = await run;
    const f = of(events, "draft_attempt_failed")[0]!;
    expect(f).toMatchObject({ draftId: "d1", attempt: 1, kind: "invalid_response" });
    const second = phaseOf(calls, "p1")[1]!.prompt;
    expect(second).toContain("# Исправь предыдущий ответ");
    expect(second).toContain(f.message);
    expect(second).toContain("нельзя задавать вопросы");
    expect(of(events, "draft_completed")[0]).toMatchObject({ participantId: "p1", attempts: 2 });
    expect(state.questions).toEqual([]);
  });

  it("6. agree and object in a draft produce a correction request", async () => {
    const { run, calls } = play([
      scripted(agree(), draftOf("p1"), amend("v1")), scripted(object(), draftOf("p2"), object()),
    ]);
    const { events } = await run;
    expect(of(events, "draft_attempt_failed").map((e) => e.participantId)).toEqual(["p1", "p2"]);
    for (const id of ["p1", "p2"]) expect(phaseOf(calls, id)[1]!.prompt).toContain("# Исправь предыдущий ответ");
    expect(of(events, "draft_completed")).toHaveLength(2);
  });

  it("7. draft with file reading: two calls, filesRead filled", async () => {
    const { run, calls } = play([
      scripted(amend("x", { files: FILES }), draftOf("p1"), amend("v1")), scripted(draftOf("p2"), object()),
    ], { ws: true });
    const { events } = await run;
    const c = of(events, "draft_completed")[0]!;
    expect(c.attempts).toBe(2);
    expect(c.filesRead).toEqual([{ name: "proj/a.txt", chars: WS[0]!.text.length, shown: WS[0]!.text.length }]);
    expect(phaseOf(calls, "p1")).toHaveLength(2);
    expect(of(events, "draft_attempt_failed")).toHaveLength(0);
    expect(c).not.toHaveProperty("usageIncomplete");
  });

  it("8. three slot calls: read, two invalid; no fourth", async () => {
    const files = amend("x", { files: FILES });
    const mkP2 = () => scripted(files, BAD, BAD, draftOf("p2"));
    const t = play([scripted(draftOf("p1"), amend("v1")), mkP2(), scripted(draftOf("p3"), object())], { ws: true });
    const r = await t.run;
    expect(phaseOf(t.calls, "p2")).toHaveLength(3);
    const inPhase = r.events.slice(0, types(r.events).indexOf("drafts_finished"));
    expect(of(inPhase, "participant_dropped").map((e) => e.participantId)).toEqual(["p2"]);
    expect(of(r.events, "draft_completed").map((e) => e.participantId)).toEqual(["p1", "p3"]);
    expect(types(r.events)).toContain("drafts_finished");
    const two = play([scripted(draftOf("p1"), amend("v1")), mkP2()], { ws: true });
    const r2 = await two.run;
    expect(phaseOf(two.calls, "p2")).toHaveLength(3);
    expect(finishOf(r2.events)).toMatchObject({ status: "failed", reason: "Активных участников осталось меньше двух." });
  });

  it("9. synthesizer dropped out: failed synthesizer_unavailable, others not called", async () => {
    const t = play([
      scripted(draftOf("p1"), amend("v1")), scripted({ error: "fatal", retryable: false }), scripted(draftOf("p3")),
    ], { synth: "p2" });
    const { events, state } = await t.run;
    expect(finishOf(events)).toMatchObject({ status: "failed", reason: SYNTHESIZER_UNAVAILABLE_REASON });
    expect(t.calls.filter((c) => c.id === "p3")).toHaveLength(0);
    expect(types(events)).not.toContain("turn_started");
    expect(state.drafts.find((d) => d.draftId === "d1")?.done).not.toBeNull();
  });

  it("10. drafts too long: failed draft_context_limit at once", async () => {
    const long = (id: string) => amend("Я".repeat(60), { reasoning: id });
    const t = play([scripted(long("a")), scripted(long("b")), scripted(long("c"))], { over: { contextChars: 100 } });
    const { events } = await t.run;
    expect(finishOf(events)).toMatchObject({ status: "failed", reason: DRAFT_CONTEXT_LIMIT_REASON });
    expect(of(events, "draft_completed")).toHaveLength(2);
    expect(t.calls.filter((c) => c.id === "p3")).toHaveLength(0);
    expect(types(events)).not.toContain("turn_started");
  });

  it("11. token cap in the phase: stopped token_cap", async () => {
    const t = play([
      scripted({ ...draftOf("p1"), inputTokens: 1000, outputTokens: 500 }), scripted(draftOf("p2")),
    ], { over: { maxTotalTokens: 1200 } });
    const { events, state } = await t.run;
    expect(finishOf(events)).toMatchObject({ status: "stopped", reason: TOKEN_CAP_REASON, version: null });
    expect(t.calls.filter((c) => c.id === "p2")).toHaveLength(0);
    expect(state.drafts[0]!.done).not.toBeNull();
  });

  it("12. owner message in the phase is applied after the slot, does not reach draft requests", async () => {
    let given = false;
    const source: OwnerMessageSource = {
      take: () => (given ? [] : (given = true, [{ requestId: "r1", text: "РЕПЛИКА-ВЛАДЕЛЬЦА" }])),
      done: () => {}, reopen: () => {},
    };
    const t = play([
      scripted(draftOf("p1"), amend("v1"), object()), scripted(draftOf("p2"), object(), object()), scripted(draftOf("p3"), object(), object()),
    ], { over: { maxRounds: 2 } }, { ownerMessages: source });
    const { events } = await t.run;
    const ty = types(events);
    const iMsg = ty.indexOf("owner_message");
    expect(iMsg).toBe(ty.indexOf("draft_completed") + 1);
    expect(iMsg).toBeLessThan(ty.indexOf("drafts_finished"));
    expect(of(events, "owner_message")[0]!.afterTurn).toBe(0);
    expect(of(events, "draft_completed").map((e) => e.participantId)).toEqual(["p1", "p2", "p3"]);
    for (const c of t.calls.filter((x) => x.phase)) expect(c.prompt).not.toContain("РЕПЛИКА-ВЛАДЕЛЬЦА");
    expect(t.calls.find((c) => !c.phase)!.prompt).toContain("РЕПЛИКА-ВЛАДЕЛЬЦА");
  });

  it("12b. message after the last slot is applied before the first turn_started", async () => {
    let takes = 0;
    const source: OwnerMessageSource = {
      take: () => (++takes === 3 ? [{ requestId: "r1", text: "ПОЗДНЯЯ" }] : []),
      done: () => {}, reopen: () => {},
    };
    const t = play([
      scripted(draftOf("p1"), amend("v1")), scripted(draftOf("p2"), object()), scripted(draftOf("p3"), object()),
    ], { over: { maxRounds: 1 } }, { ownerMessages: source });
    const { events } = await t.run;
    const ty = types(events);
    expect(ty.indexOf("owner_message")).toBeGreaterThan(ty.lastIndexOf("draft_completed"));
    expect(ty.indexOf("owner_message")).toBeLessThan(ty.indexOf("turn_started"));
    for (const c of t.calls.filter((x) => x.phase)) expect(c.prompt).not.toContain("ПОЗДНЯЯ");
  });

  it("20a. synthesizer dropped out on the first turn: failed synthesizer_unavailable, no other is chosen", async () => {
    const t = play([
      scripted(draftOf("p1"), object()), scripted(draftOf("p2"), BAD, BAD), scripted(draftOf("p3"), amend("v1")),
    ], { synth: "p2", over: { maxRounds: 3 } });
    const { events, state } = await t.run;
    expect(finishOf(events)).toMatchObject({ status: "failed", reason: SYNTHESIZER_UNAVAILABLE_REASON, version: null });
    expect(t.calls.filter((c) => !c.phase && c.id !== "p2")).toHaveLength(0);
    expect(state.versions).toEqual([]);
    expect(state.drafts.map((d) => d.done !== null)).toEqual([true, true, true]);
  });

  it("20b. synthesizer dropped out on its second turn: session goes on without it", async () => {
    const t = play([
      scripted(draftOf("p1"), object(), object()), scripted(draftOf("p2"), amend("v1"), BAD, BAD), scripted(draftOf("p3"), object(), object()),
    ], { synth: "p2", over: { maxRounds: 2 } });
    const { events } = await t.run;
    expect(of(events, "participant_dropped").map((e) => e.participantId)).toEqual(["p2"]);
    expect(finishOf(events).reason).not.toBe(SYNTHESIZER_UNAVAILABLE_REASON);
    expect(finishOf(events).status).toBe("no_consensus");
  });

  it("21. reason priority: synthesizer outranks 'fewer than two' and the token cap", async () => {
    const heavy: Step = { raw: "не JSON", inputTokens: 1000, outputTokens: 500 };
    const t = play([scripted(draftOf("p1")), scripted(heavy, heavy)], { synth: "p2", over: { maxTotalTokens: 1200 } });
    const { events } = await t.run;
    expect(finishOf(events)).toMatchObject({ status: "failed", reason: SYNTHESIZER_UNAVAILABLE_REASON });
  });

  it("13. every regular request carries all drafts, including after file reads", async () => {
    const t = play([
      scripted(draftOf("p1"), object({ files: FILES }), amend("v1"), object()),
      scripted(draftOf("p2"), object(), object()), scripted(draftOf("p3"), object(), object()),
    ], { ws: true, over: { maxRounds: 2 } });
    await t.run;
    const regular = t.calls.filter((c) => !c.phase);
    expect(regular.length).toBeGreaterThanOrEqual(7);
    expect(regular.some((c) => c.prompt.includes("# Запрошенные файлы"))).toBe(true);
    for (const c of regular) {
      expect(c.prompt).toContain("# Независимые черновики");
      for (const id of ["p1", "p2", "p3"]) {
        expect(c.prompt).toContain(lbl(id));
        expect(c.prompt).toContain(`ОБОСН-${lbl(id)}`);
      }
    }
  });

  it("14. the synthesizer's first regular turn: agree is rejected", async () => {
    const t = play([scripted(draftOf("p1"), object()), scripted(draftOf("p2"), agree(), amend("v1"))], { synth: "p2", over: { maxRounds: 1 } });
    const { events } = await t.run;
    expect(of(events, "turn_failed")[0]).toMatchObject({ participantId: "p2", kind: "invalid_response" });
    expect(t.calls.filter((c) => !c.phase && c.id === "p2")[1]!.prompt).toContain("# Исправь предыдущий ответ");
  });

  it("18. signal stop during a draft call", async () => {
    const ctl = new AbortController();
    const waiting = driverOf((req) => new Promise<TurnResult>((_, reject) => {
      req.signal.addEventListener("abort", () => reject(new Error("aborted")));
      setTimeout(() => ctl.abort(), 0);
    }));
    const { run } = play([scripted(draftOf("p1")), waiting], {}, { signal: ctl.signal });
    const { events } = await run;
    expect(finishOf(events).status).toBe("stopped");
    expect(of(events, "draft_completed").map((e) => e.draftId)).toEqual(["d1"]);
    expect(of(events, "draft_attempt_started")).toHaveLength(2);
    expect(of(events, "draft_attempt_failed")).toHaveLength(0);
  });

  it("19. onChunk is silent in the phase and works in regular turns", async () => {
    const chunks: boolean[] = [];
    let over = false;
    const { run } = play([scripted(draftOf("p1"), amend("v1")), scripted(draftOf("p2"), object())], { over: { maxRounds: 1 } }, {
      onChunk: () => { chunks.push(over); },
      onEvent: (e) => { if (e.type === "drafts_finished") over = true; },
    });
    await run;
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((x) => x)).toBe(true);
  });
});

describe("runSession: continuation of the drafts phase", () => {
  function memStore() {
    const m = new Map<string, string>();
    const store: DraftStore = {
      save: (id, t) => (m.set(id, t), { chars: t.length, sha256: sha256Of(t) }),
      load: ({ draftId }) => { const t = m.get(draftId); if (t === undefined) throw new Error("missing"); return t; },
    };
    return store;
  }
  /** First segment: p1 accepted, on the first call p2 gets a stop. Journal as from a killed process. */
  async function interrupted(p2first?: Step) {
    const ctl = new AbortController();
    const store = memStore();
    let n = 0;
    const p2 = driverOf((req) => {
      if (p2first && n++ === 0) return scripted(p2first).call(req);
      return new Promise<TurnResult>((_, reject) => {
        req.signal.addEventListener("abort", () => reject(new Error("aborted")));
        setTimeout(() => ctl.abort(), 0);
      });
    });
    const { run } = play([scripted(draftOf("p1")), p2, scripted()], {}, { signal: ctl.signal, draftStore: store });
    const { events } = await run;
    return { store, events: events.filter((e) => e.type !== "session_finished") };
  }
  const resumeRun = (drivers: ParticipantDriver[], events: SessionEvent[], store: DraftStore, maxRounds = 1) => {
    const t = play(drivers, {}, { resume: { events, maxRounds }, draftStore: store });
    return { ...t };
  };

  it("15. interruption: p1 is not called, p2's attempts continue from number 2, no more than two", async () => {
    const { store, events } = await interrupted();
    expect(of(events, "draft_attempt_started").map((e) => [e.draftId, e.attempt])).toEqual([["d1", 1], ["d2", 1]]);
    const t = resumeRun([
      scripted(amend("v1"), object()),
      scripted({ error: "e1" }, { error: "e2" }, draftOf("p2")),
      scripted(draftOf("p3"), object()),
    ], events, store);
    const r = await t.run;
    expect(phaseOf(t.calls, "p1")).toHaveLength(0);
    expect(phaseOf(t.calls, "p2")).toHaveLength(2);
    expect(of(r.events, "draft_attempt_started").filter((e) => e.draftId === "d2").map((e) => e.attempt)).toEqual([2, 3]);
    expect(of(r.events, "participant_dropped").map((e) => e.participantId)).toEqual(["p2"]);
  });

  it("15c. slot with an attempt without an outcome: usageIncomplete on draft_completed and incomplete spend", async () => {
    const { store, events } = await interrupted();
    const t = resumeRun([scripted(amend("v1"), object()), scripted(draftOf("p2"), object()), scripted(draftOf("p3"), object())], events, store);
    const r = await t.run;
    const done = of(r.events, "draft_completed");
    expect(done.find((e) => e.draftId === "d2")!.usageIncomplete).toBe(true);
    expect(done.find((e) => e.draftId === "d3")).not.toHaveProperty("usageIncomplete");
    expect(tokenUsage(r.state).incomplete).toBe(true);
  });

  it("15b. three started attempts without an outcome: dropout without a call", async () => {
    const { store, events } = await interrupted();
    const head = events.slice(0, 3);
    const extra = [1, 2, 3].map((attempt, i) => ({
      seq: 4 + i, ts: "2026-01-01T00:00:00.000Z", type: "draft_attempt_started" as const, draftId: "d2", participantId: "p2", attempt,
    }));
    const t = resumeRun([scripted(amend("v1"), object()), scripted(draftOf("p2")), scripted(draftOf("p3"), object())], [...head, ...extra], store);
    const r = await t.run;
    expect(phaseOf(t.calls, "p2")).toHaveLength(0);
    expect(of(r.events, "participant_dropped")[0]).toMatchObject({ participantId: "p2", reason: "Исчерпаны три вызова черновика." });
  });

  it("16. slot spend is summed across segments and counted once", async () => {
    const ctl = new AbortController();
    const store = memStore();
    let n = 0;
    const p1 = driverOf(async () => ({ text: JSON.stringify(draftOf("p1") && (draftOf("p1") as { response: unknown }).response), usage: { inputTokens: 10 } }));
    const p2 = driverOf((req) => {
      if (n++ === 0) return Promise.resolve({ text: "мусор", usage: { inputTokens: 100 } });
      return new Promise<TurnResult>((_, reject) => {
        req.signal.addEventListener("abort", () => reject(new Error("aborted")));
        setTimeout(() => ctl.abort(), 0);
      });
    });
    const first = await play([p1, p2, scripted()], {}, { signal: ctl.signal, draftStore: store }).run;
    const events = first.events.filter((e) => e.type !== "session_finished");
    expect(of(events, "draft_attempt_failed")[0]!.usage).toEqual({ inputTokens: 100 });
    let m = 0;
    const p2b = driverOf(async () => ({
      text: JSON.stringify((draftOf("p2") as { response: unknown }).response), usage: m++ === 0 ? { inputTokens: 150 } : {},
    }));
    const p3 = driverOf(async () => ({ text: JSON.stringify((draftOf("p3") as { response: unknown }).response), usage: {} }));
    const t = play([scripted(amend("v1")), p2b, p3], {}, { resume: { events, maxRounds: 1 }, draftStore: store });
    const r = await t.run;
    const done = of(r.events, "draft_completed").find((e) => e.draftId === "d2")!;
    expect(done.usage).toEqual({ inputTokens: 250 });
    expect(done.attempts).toBe(3);
    // in the previous segment, after a recorded failure, a second attempt without an outcome started
    expect(done.usageIncomplete).toBe(true);
    expect(tokenUsage(r.state).total).toBe(260);
  });

  it("17. corrupted storage: refusal without events and calls", async () => {
    const { events } = await interrupted();
    const store: DraftStore = { save: () => ({ chars: 0, sha256: "" }), load: () => { throw new Error("corrupted"); } };
    let seen = 0;
    const t = play([scripted(), scripted(), scripted()], {}, {
      resume: { events, maxRounds: 1 }, draftStore: store, onEvent: () => { seen++; },
    });
    await expect(t.run).rejects.toThrow("corrupted");
    expect(seen).toBe(0);
    expect(t.calls).toHaveLength(0);
  });

  it("Spend of an attempt with a file request: draft accepted after the continuation, total 1300", async () => {
    const ctl = new AbortController();
    const store = memStore();
    let n = 0;
    const p2 = driverOf((req) => {
      if (n++ === 0) return scripted({ ...amend("x", { files: FILES }), inputTokens: 600, outputTokens: 400 }).call(req);
      return new Promise<TurnResult>((_, reject) => {
        req.signal.addEventListener("abort", () => reject(new Error("aborted")));
        setTimeout(() => ctl.abort(), 0);
      });
    });
    const first = await play([scripted(draftOf("p1")), p2, scripted()], { ws: true }, { signal: ctl.signal, draftStore: store }).run;
    const events = first.events.filter((e) => e.type !== "session_finished");
    expect(of(events, "draft_files_served")).toHaveLength(1);
    let m = 0;
    const p2b = driverOf(async () => ({
      text: JSON.stringify((draftOf("p2") as { response: unknown }).response), usage: m++ === 0 ? { inputTokens: 300 } : {},
    }));
    const t = play([scripted(amend("v1"), object()), p2b, scripted(draftOf("p3"), object())], {}, {
      resume: { events, maxRounds: 1 }, draftStore: store,
    });
    const r = await t.run;
    const done = of(r.events, "draft_completed").find((e) => e.draftId === "d2")!;
    expect(done.usage).toMatchObject({ inputTokens: 900, outputTokens: 400 });
    expect(done.usageIncomplete).toBe(true);
    expect(tokenUsage(foldEvents(r.events)).total).toBe(1300);
  });
});

describe("runSession: budget and spend of drafts with a file request", () => {
  it("Budget and spend of drafts: file request and dropout in the phase stop by token_cap", async () => {
    const askFiles = amend("x", { files: FILES });
    const t = play([
      scripted(draftOf("p1")),
      scripted({ ...askFiles, inputTokens: 600, outputTokens: 400 }, { error: "e1" }, { error: "e2" }),
      scripted(draftOf("p3")),
    ], { ws: true, over: { maxTotalTokens: 900 } });
    const { events, state } = await t.run;
    expect(of(events, "draft_files_served")).toEqual([
      expect.objectContaining({ draftId: "d2", participantId: "p2", attempt: 1, usage: expect.objectContaining({ inputTokens: 600, outputTokens: 400 }) }),
    ]);
    expect(of(events, "participant_dropped").map((e) => e.participantId)).toEqual(["p2"]);
    expect(finishOf(events)).toMatchObject({ status: "stopped", reason: TOKEN_CAP_REASON, version: null });
    expect(tokenUsage(state).total).toBe(1000);
    expect(phaseOf(t.calls, "p3")).toHaveLength(0);
    expect(types(events)).not.toContain("turn_started");
  });
});

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function randomRun(seed: number) {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const n = 2 + int(3);
  const rounds = 1 + int(2);
  const synth = `p${1 + int(n)}`;
  const kinds = ["valid", "files", "notjson", "agree", "ownerq", "retry", "fatal", "timeout"] as const;
  const scripts = Array.from({ length: n }, (_, i) => {
    const id = `p${i + 1}`;
    const pick = (k: (typeof kinds)[number]): Step => {
      switch (k) {
        case "valid": return draftOf(id);
        case "files": return amend("x", { files: FILES });
        case "notjson": return BAD;
        case "agree": return agree();
        case "ownerq": return amend("s", { questions: [{ to: "owner", text: "Вопрос?" }] });
        case "retry": return { error: "сбой", retryable: true };
        case "fatal": return { error: "фатально", retryable: false };
        default: return { timeout: true };
      }
    };
    const len = int(5);
    const steps = Array.from({ length: len }, () => pick(kinds[int(kinds.length)]!));
    return scripted(...steps, ...Array.from({ length: 12 }, () => draftOf(id)));
  });
  const t = play(scripts, { synth, ws: true, over: { maxRounds: rounds } });
  const run = await t.run;
  return { n, rounds, synth, ...t, ...run };
}

describe("Requirement: independence of draft requests (property)", () => {
  it("Requirement: independence of draft requests: 200 random sessions", async () => {
    const seen = { threeDrop: 0, synthDrop: 0, filesFix: 0 };
    for (let seed = 1; seed <= 200; seed++) {
      const r = await randomRun(seed);
      const ids = Array.from({ length: r.n }, (_, i) => `p${i + 1}`);
      for (const c of r.calls.filter((x) => x.phase)) {
        for (const o of ids.filter((x) => x !== c.id)) {
          expect(c.prompt, `seed ${seed}`).not.toContain(lbl(o));
          expect(c.prompt, `seed ${seed}`).not.toContain(`«N${o.slice(1)}»`);
        }
      }
      for (const id of ids) expect(phaseOf(r.calls, id).length, `seed ${seed}`).toBeLessThanOrEqual(3);
      const t = types(r.events);
      const iFin = t.indexOf("drafts_finished");
      const iTurn = t.indexOf("turn_started");
      if (iTurn >= 0) expect(iFin, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      if (iTurn >= 0) expect(iFin, `seed ${seed}`).toBeLessThan(iTurn);
      if (iTurn >= 0) expect(of(r.events, "turn_started")[0]!.participantId, `seed ${seed}`).toBe(r.synth);
      if (iTurn >= 0 && finishOf(r.events).status !== "failed") expect(r.state.versions[0]?.authorId, `seed ${seed}`).toBe(r.synth);
      if (ids.some((id) => phaseOf(r.calls, id).length === 3 && of(r.events, "participant_dropped").some((d) => d.participantId === id))) seen.threeDrop++;
      if (finishOf(r.events).reason === SYNTHESIZER_UNAVAILABLE_REASON) seen.synthDrop++;
      if (of(r.events, "draft_completed").some((e) => e.attempts >= 3 && e.filesRead)) seen.filesFix++;
    }
    expect(seen.threeDrop).toBeGreaterThan(0);
    expect(seen.synthDrop).toBeGreaterThan(0);
    expect(seen.filesFix).toBeGreaterThan(0);
  });
});

describe("Requirement: budget and spend of drafts (property)", () => {
  it("Requirement: budget and spend of drafts: calls not above the limit", async () => {
    for (let seed = 1001; seed <= 1200; seed++) {
      const r = await randomRun(seed);
      expect(r.calls.length, `seed ${seed}`).toBeLessThanOrEqual(maxCallsBound(r.n, r.rounds, true));
    }
  });
});

describe("runSession: continuation of the drafts phase with a participant replacement", () => {
  function memStore() {
    const m = new Map<string, string>();
    const store: DraftStore = {
      save: (id, t) => (m.set(id, t), { chars: t.length, sha256: sha256Of(t) }),
      load: ({ draftId }) => { const t = m.get(draftId); if (t === undefined) throw new Error("missing"); return t; },
    };
    return store;
  }
  const rep = (oldId: string, id: string) => ({
    oldParticipantId: oldId, participant: { id, name: `N${id}`, providerId: "scripted", model: "m", role: null },
  });
  const hang = (ctl: AbortController) => driverOf((req) => new Promise<TurnResult>((_, reject) => {
    req.signal.addEventListener("abort", () => reject(new Error("aborted")));
    setTimeout(() => ctl.abort(), 0);
  }));
  /** First segment: p1 accepted, p2 per the script, p3 gets a stop. */
  async function head(p2: ParticipantDriver, o: Opts = {}) {
    const ctl = new AbortController();
    const store = memStore();
    const { run } = play([scripted(draftOf("p1")), p2, hang(ctl)], o, { signal: ctl.signal, draftStore: store });
    const { events } = await run;
    return { store, events: events.filter((e) => e.type !== "session_finished") };
  }
  /** Continuation with p2 replaced by p4; records each one's calls. */
  function again(events: SessionEvent[], store: DraftStore, ds: Record<string, ParticipantDriver>, o: Opts = {}, extra: Partial<RunSessionOptions> = {}) {
    const calls: Call[] = [];
    let over = false;
    const drivers = Object.fromEntries(Object.entries(ds).map(([id, d]) => [id, driverOf((req) => {
      calls.push({ id, prompt: req.prompt, phase: !over });
      return d.call(req);
    })]));
    const run = runSession({
      session: mk(3, o), now: clock, drivers, draftStore: store, ...extra,
      resume: { events, maxRounds: 1, replacements: [rep("p2", "p4")] },
      onEvent: (e) => { if (e.type === "drafts_finished") over = true; },
    });
    return { run, calls };
  }

  it("g1. slot with one started attempt: p4 continues the same slot, attempts 2 and 3, no more than three in total", async () => {
    const ctl = new AbortController();
    const store = memStore();
    const first = await play([scripted(draftOf("p1")), hang(ctl), scripted()], {}, { signal: ctl.signal, draftStore: store }).run;
    const events = first.events.filter((e) => e.type !== "session_finished");
    const t = again(events, store, {
      p1: scripted(amend("v1"), object()), p2: scripted(), p3: scripted(draftOf("p3"), object()),
      p4: scripted({ error: "e1" }, { error: "e2" }, draftOf("p4")),
    });
    const r = await t.run;
    expect(of(r.events, "session_resumed")).toHaveLength(1);
    expect(t.calls.filter((c) => c.id === "p2")).toHaveLength(0);
    expect(phaseOf(t.calls, "p4")).toHaveLength(2);
    const started = of(r.events, "draft_attempt_started").filter((e) => e.participantId === "p4");
    expect(started.map((e) => [e.draftId, e.attempt])).toEqual([["d2", 2], ["d2", 3]]);
    expect(of(r.events, "participant_dropped").map((e) => e.participantId)).toEqual(["p4"]);
  });

  it("g2. slot accepted by the previous participant: p4 writes no draft, the accepted text stays in the turn context", async () => {
    const { store, events } = await head(scripted(draftOf("p2")));
    const t = again(events, store, {
      p1: scripted(amend("v1"), agree()), p2: scripted(), p3: scripted(draftOf("p3"), agree()), p4: scripted(agree()),
    });
    const r = await t.run;
    expect(t.calls.filter((c) => c.id === "p2")).toHaveLength(0);
    expect(phaseOf(t.calls, "p4")).toHaveLength(0);
    expect(of(r.events, "draft_attempt_started").filter((e) => e.draftId === "d2")).toEqual([]);
    const turn = t.calls.find((c) => !c.phase && c.id === "p1")!;
    expect(turn.prompt).toContain(lbl("p2"));
    expect(of(r.events, "participant_dropped")).toEqual([]);
  });

  it("g3. slot exhausted by the previous participant: p4 is not called for a draft, does not drop out, plays regular turns", async () => {
    const { store, events } = await head(scripted(draftOf("p2")), {});
    // instead of p2's accepted draft — three started attempts without an outcome and a dropout
    const cutAt = events.findIndex((e) => e.type === "draft_completed" && e.draftId === "d2");
    const base = events.slice(0, cutAt - 1); // without p2's draft_attempt_started and draft_completed
    const last = base[base.length - 1]!.seq;
    const mkEv = (i: number, e: object) => ({ seq: last + i, ts: "2026-01-01T00:00:00.000Z", ...e }) as SessionEvent;
    const journal = [
      ...base,
      ...[1, 2, 3].map((attempt, i) => mkEv(i + 1, { type: "draft_attempt_started", draftId: "d2", participantId: "p2", attempt })),
      mkEv(4, { type: "participant_dropped", participantId: "p2", reason: "Исчерпаны три вызова черновика." }),
    ];
    const t = again(journal, store, {
      p1: scripted(amend("v1"), agree()), p2: scripted(), p3: scripted(draftOf("p3"), agree()), p4: scripted(agree()),
    });
    const r = await t.run;
    expect(phaseOf(t.calls, "p4")).toHaveLength(0);
    expect(t.calls.filter((c) => c.id === "p2")).toHaveLength(0);
    expect(of(r.events, "participant_dropped")).toEqual([]);
    expect(of(r.events, "drafts_finished")).toHaveLength(1);
    expect(of(r.events, "turn_started").map((e) => e.participantId)).toContain("p4");
    expect(finishOf(r.events).status).toBe("consensus");
  });

  it("g4. synthesizer replaced without version 1: failed synthesizer_unavailable, no reasonCode, p4 not called", async () => {
    const { store, events } = await head(scripted(draftOf("p2")), { synth: "p2" });
    const t = again(events, store, {
      p1: scripted(), p2: scripted(), p3: scripted(draftOf("p3")), p4: scripted(draftOf("p4")),
    }, { synth: "p2" });
    const r = await t.run;
    expect(finishOf(r.events)).toMatchObject({ status: "failed", reason: SYNTHESIZER_UNAVAILABLE_REASON });
    expect(finishOf(r.events)).not.toHaveProperty("reasonCode");
    expect(t.calls).toHaveLength(0);
  });

  it("a. reasonCode only for 'fewer than two active' in the drafts phase; the other phase outcomes have none", async () => {
    const few = await play([scripted(draftOf("p1"), amend("v1")), scripted({ error: "fatal", retryable: false })]).run;
    expect(finishOf(few.events)).toMatchObject({ status: "failed", reason: "Активных участников осталось меньше двух.", reasonCode: INSUFFICIENT_ACTIVE_REASON_CODE });
    const synth = await play([scripted(draftOf("p1")), scripted({ error: "fatal", retryable: false }), scripted()], { synth: "p2" }).run;
    expect(finishOf(synth.events).reason).toBe(SYNTHESIZER_UNAVAILABLE_REASON);
    expect(finishOf(synth.events)).not.toHaveProperty("reasonCode");
    const long = (id: string) => amend("Я".repeat(60), { reasoning: id });
    const ctx = await play([scripted(long("a")), scripted(long("b")), scripted(long("c"))], { over: { contextChars: 100 } }).run;
    expect(finishOf(ctx.events).reason).toBe(DRAFT_CONTEXT_LIMIT_REASON);
    expect(finishOf(ctx.events)).not.toHaveProperty("reasonCode");
    const cap = await play([scripted({ ...draftOf("p1"), inputTokens: 1000, outputTokens: 500 }), scripted(draftOf("p2"))], { over: { maxTotalTokens: 1200 } }).run;
    expect(finishOf(cap.events).reason).toBe(TOKEN_CAP_REASON);
    expect(finishOf(cap.events)).not.toHaveProperty("reasonCode");
  });
});
