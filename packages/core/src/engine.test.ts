import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { checkSessionMaterials, createSession, runSession, SessionInputError } from "./engine.ts";
import type { CollectedMaterial } from "./materials.ts";
import type { OwnerMessageRequest, OwnerMessageSource, OwnerRequest, RunSessionOptions } from "./engine.ts";
import { createScriptedDriver, readScenario } from "./participants/scripted.ts";
import type { Scenario } from "./participants/scripted.ts";
import { ParticipantCallError } from "./participants/driver.ts";
import type { ParticipantDriver, TurnRequest, TurnResult } from "./participants/driver.ts";
import { FOLDER_LIMITS, folderStats } from "./protocol/folder.ts";
import { foldEvents } from "./protocol/fold.ts";
import { RAW_LIMIT, truncateRaw } from "./protocol/parse.ts";
import { INSUFFICIENT_ACTIVE_REASON_CODE, SessionEventSchema, TOKEN_CAP_REASON } from "./protocol/schema.ts";
import type { Limits, SessionEvent } from "./protocol/schema.ts";
import { objectors, tokenUsage } from "./protocol/state.ts";
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

function mkSession(n: number, over: Partial<Limits> = {}) {
  return createSession(
    {
      topic: "Тема", framing: "", origin: "cli", limits: limits(over),
      participants: Array.from({ length: n }, (_, i) => ({ name: `N${i + 1}`, providerId: "scripted", model: "m", role: null })),
    },
    { maxParticipants: 8, id: "s1", now: () => new Date("2026-01-01T00:00:00Z") },
  );
}

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1) + (tick += 10));

function go(drivers: ParticipantDriver[], over: Partial<Limits> = {}, extra: Partial<RunSessionOptions> = {}) {
  const session = mkSession(drivers.length, over);
  return runSession({
    session, now: clock, drivers: Object.fromEntries(drivers.map((d, i) => [`p${i + 1}`, d])), ...extra,
  });
}

const types = (events: SessionEvent[]) => events.map((e) => e.type);
const of = <T extends SessionEvent["type"]>(events: SessionEvent[], type: T) =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);
const finishOf = (events: SessionEvent[]) => of(events, "session_finished")[0]!;

const driverOf = (fn: (req: TurnRequest) => Promise<TurnResult>): ParticipantDriver => ({ call: fn });
const textOf = (step: Step) => JSON.stringify("response" in step ? step.response : null, null, 2);
const spy = (inner: ParticipantDriver, prompts: string[]): ParticipantDriver =>
  driverOf((req) => { prompts.push(req.prompt); return inner.call(req); });

describe("runSession: main loop", () => {
  it("1. agreement in two turns, journal is consistent", async () => {
    const { events, state } = await go([scripted(amend("v1")), scripted(agree())]);
    expect(types(events)).toEqual([
      "session_created", "turn_started", "turn_completed", "turn_started", "turn_completed", "session_finished",
    ]);
    expect(finishOf(events).status).toBe("consensus");
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    for (const e of events) SessionEventSchema.parse(e);
    expect(foldEvents(events)).toEqual(state);
  });

  it("2. round-robin queue, calls do not overlap", async () => {
    let running = 0;
    let maxRunning = 0;
    const wrap = (d: ParticipantDriver) =>
      driverOf(async (req) => {
        maxRunning = Math.max(maxRunning, ++running);
        try { return await d.call(req); } finally { running--; }
      });
    const { events } = await go([
      wrap(scripted(amend("v1"), agree())),
      wrap(scripted(agree(), agree())),
      wrap(scripted(object(), agree())),
    ]);
    expect(of(events, "turn_started").map((e) => e.participantId)).toEqual(["p1", "p2", "p3", "p1", "p2", "p3"]);
    expect(maxRunning).toBe(1);
  });

  it("3. the dropped participant is skipped", async () => {
    const { events } = await go([
      scripted(amend("v1"), agree()),
      scripted({ error: "x" }, { error: "y" }),
      scripted(object(), agree()),
    ]);
    expect(of(events, "turn_started").map((e) => e.participantId)).toEqual(["p1", "p2", "p3", "p1", "p3"]);
    expect(finishOf(events).status).toBe("consensus");
  });

  it("4. no_consensus", async () => {
    const { events } = await go(
      [scripted(amend("v1"), agree()), scripted(agree(), agree()), scripted(object(), object({ reasoning: "последний" }))],
      { maxRounds: 2 },
    );
    const f = finishOf(events);
    expect(f.status).toBe("no_consensus");
    expect(f.version).toBe(1);
    expect(f.agreed).toEqual(["p1", "p2"]);
    expect(f.objectors).toEqual([{ participantId: "p3", reasoning: "последний" }]);
  });

  it("5. stop in the middle of a turn", async () => {
    const ctl = new AbortController();
    let seen: AbortSignal | undefined;
    const waiting = driverOf((req) => new Promise<TurnResult>((_, reject) => {
      seen = req.signal;
      req.signal.addEventListener("abort", () => reject(new Error("aborted")));
      setTimeout(() => ctl.abort(), 0);
    }));
    const { events } = await go([scripted(amend("v1")), waiting], {}, { signal: ctl.signal });
    const f = finishOf(events);
    expect(f.status).toBe("stopped");
    expect(f.version).toBe(1);
    expect(of(events, "turn_completed").map((e) => e.participantId)).toEqual(["p1"]);
    expect(seen?.aborted).toBe(true);
    expect(of(events, "turn_failed")).toHaveLength(0);
  });

  it("6. stop before start", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { events } = await go([scripted(amend("v1")), scripted(agree())], {}, { signal: ctl.signal });
    expect(types(events)).toEqual(["session_created", "session_finished"]);
    expect(finishOf(events)).toMatchObject({ status: "stopped", version: null });
  });

  it("7. failed: only one participant left", async () => {
    const { events } = await go([scripted(amend("v1")), scripted({ error: "fatal", retryable: false })]);
    expect(finishOf(events)).toMatchObject({
      status: "failed", reason: "Активных участников осталось меньше двух.",
    });
  });
});

describe("runSession: call failures", () => {
  it("8. retry after timeout", async () => {
    const { events } = await go([scripted(amend("v1")), scripted({ timeout: true }, agree())]);
    const failed = of(events, "turn_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ kind: "timeout", attempt: 1 });
    expect(of(events, "turn_completed")[1]!.attempts).toBe(2);
  });

  it("9. engine timeout (fake timers)", async () => {
    vi.useFakeTimers();
    try {
      const hang = driverOf((req) => new Promise<TurnResult>((_, reject) => {
        req.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }));
      const p = go([scripted(amend("v1")), hang], { turnTimeoutSec: 1 });
      for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1000);
      const { events } = await p;
      const failed = of(events, "turn_failed");
      expect(failed.map((e) => e.kind)).toEqual(["timeout", "timeout"]);
      expect(failed[0]!.message).toBe("Таймаут хода: 1 с.");
      expect(of(events, "participant_dropped")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("10. non-retryable error", async () => {
    const { events } = await go([
      scripted(amend("v1")), scripted({ error: "фатально", retryable: false }), scripted(agree()),
    ]);
    expect(of(events, "turn_failed")).toHaveLength(1);
    const i = types(events).indexOf("turn_failed");
    expect(events[i + 1]!.type).toBe("participant_dropped");
    expect(of(events, "participant_dropped")[0]!.reason).toContain("фатально");
  });

  it("11. two errors in a row", async () => {
    const { events } = await go([scripted(amend("v1")), scripted({ error: "a" }, { error: "b" }), scripted(agree())]);
    expect(of(events, "turn_failed").map((e) => e.attempt)).toEqual([1, 2]);
    expect(of(events, "participant_dropped")[0]!.reason).toBe("Повторная попытка не удалась: b");
  });

  it("16. regular driver error — call_error and retry", async () => {
    const inner = scripted(agree());
    let n = 0;
    const flaky = driverOf((req) => {
      if (n++ === 0) throw new Error("boom");
      return inner.call(req);
    });
    const { events } = await go([scripted(amend("v1")), flaky]);
    expect(of(events, "turn_failed")[0]).toMatchObject({ kind: "call_error", message: "boom", attempt: 1 });
    expect(of(events, "turn_completed")[1]!.attempts).toBe(2);
  });
});

describe("runSession: invalid answers", () => {
  it("12. correction", async () => {
    const prompts: string[] = [];
    const { events } = await go([
      scripted(amend("v1")),
      spy(scripted({ response: { stance: "agree" } }, agree()), prompts),
    ]);
    const bad = of(events, "turn_failed")[0]!;
    expect(bad.kind).toBe("invalid_response");
    expect(bad.raw).toBeTruthy();
    expect(of(events, "turn_completed")[1]!.attempts).toBe(2);
    expect(prompts[0]).not.toContain("# Исправь предыдущий ответ");
    expect(prompts[1]).toContain("# Исправь предыдущий ответ");
  });

  it("13. two invalid — dropout, long raw truncated", async () => {
    const long = "x".repeat(RAW_LIMIT + 500);
    const { events } = await go([scripted(amend("v1")), scripted({ raw: long }, { raw: long }), scripted(agree())]);
    const failed = of(events, "turn_failed");
    expect(failed).toHaveLength(2);
    expect(failed[0]!.raw).toBe(truncateRaw(long, "ru"));
    expect(failed[0]!.raw!.length).toBeLessThan(long.length);
    expect(of(events, "participant_dropped")[0]!.reason).toContain("Невалидный ответ после запроса на исправление");
  });

  it("14. error, invalid, valid: three calls", async () => {
    const { events } = await go([scripted(amend("v1")), scripted({ error: "e" }, { raw: "мусор" }, agree())]);
    expect(of(events, "turn_completed")[1]!.attempts).toBe(3);
    expect(of(events, "participant_dropped")).toHaveLength(0);
  });

  it("15. first agree turn is invalid", async () => {
    const prompts: string[] = [];
    const { events } = await go([spy(scripted(agree(), amend("v1")), prompts), scripted(agree())]);
    expect(of(events, "turn_failed")[0]).toMatchObject({ kind: "invalid_response" });
    expect(prompts[1]).toContain("# Исправь предыдущий ответ");
    expect(finishOf(events).status).toBe("consensus");
  });

  it("18. addressee did not answer the open question", async () => {
    const { events } = await go([
      scripted(amend("v1", { questions: [{ to: "p2", text: "почему?" }] })),
      scripted(agree(), agree({ answers: [{ questionId: "q1", text: "потому" }] })),
    ]);
    expect(of(events, "turn_failed")[0]).toMatchObject({ kind: "invalid_response", participantId: "p2" });
    expect(finishOf(events).status).toBe("consensus");
  });
});

describe("runSession: questions and agreement", () => {
  it("17. agree with a question — object, question q1, answer closes it", async () => {
    let agreedAtP2: string[] | undefined;
    const onEvent = (e: SessionEvent, s: SessionState) => {
      if (e.type === "turn_completed" && e.participantId === "p2" && e.turn === 2) agreedAtP2 = s.agreed;
    };
    const { events } = await go(
      [
        scripted(amend("v1"), agree({ answers: [{ questionId: "q1", text: "ответ" }] })),
        scripted(agree({ questions: [{ to: "p1", text: "а если?" }] }), agree()),
      ],
      {},
      { onEvent },
    );
    const second = of(events, "turn_completed")[1]!;
    expect(second).toMatchObject({ stance: "object", normalized: true });
    expect(second.questions).toEqual([{ id: "q1", to: "p1", text: "а если?" }]);
    expect(agreedAtP2).toEqual(["p1"]);
    const i = events.findIndex((e) => e.type === "turn_completed" && e.turn === 3);
    expect(events[i + 1]).toMatchObject({ type: "question_closed", questionId: "q1", reason: "answered" });
    expect(finishOf(events).status).toBe("consensus");
  });

  it("19. dropout closes questions", async () => {
    const { events } = await go([
      scripted(amend("v1", { questions: [{ to: "p2", text: "?" }] })),
      scripted({ error: "x", retryable: false }),
      scripted(agree()),
    ]);
    const i = types(events).indexOf("participant_dropped");
    expect(events[i + 1]).toMatchObject({ type: "question_closed", questionId: "q1", reason: "unanswered" });
  });

  it("20. edit after agreement resets agreement", async () => {
    const snaps: { agreed: string[]; version: number | undefined; author: string | undefined }[] = [];
    const onEvent = (e: SessionEvent, s: SessionState) => {
      if (e.type === "turn_completed" && e.turn >= 5) {
        const v = s.versions[s.versions.length - 1];
        snaps.push({ agreed: s.agreed, version: v?.number, author: v?.authorId });
      }
    };
    await go(
      [scripted(amend("v1"), agree()), scripted(amend("v2"), agree()), scripted(object(), amend("v3"))],
      { maxRounds: 2 },
      { onEvent },
    );
    expect(snaps).toEqual([
      { agreed: ["p1", "p2"], version: 2, author: "p2" },
      { agreed: ["p3"], version: 3, author: "p3" },
    ]);
  });

  it("21. first dropped out in the first turn, second must make amend", async () => {
    const { events } = await go([
      scripted({ error: "x", retryable: false }), scripted(amend("v1")), scripted(agree()),
    ]);
    expect(of(events, "turn_completed")[0]).toMatchObject({ participantId: "p2", stance: "amend", version: 1 });
    expect(finishOf(events)).toMatchObject({ status: "consensus", agreed: ["p2", "p3"] });
  });
});

describe("runSession: streams, spend, clock", () => {
  it("22. chunks arrive before turn_completed, not in events", async () => {
    const log: string[] = [];
    const chunks: string[] = [];
    const { events } = await go([scripted(amend("v1")), scripted(agree())], {}, {
      onChunk: (c) => { log.push(`chunk:${c.participantId}:${c.turn}`); if (c.participantId === "p1") chunks.push(c.text); },
      onEvent: (e) => { if (e.type === "turn_completed") log.push(`done:${e.participantId}:${e.turn}`); },
    });
    expect(log.indexOf("chunk:p1:1")).toBeGreaterThanOrEqual(0);
    expect(log.lastIndexOf("chunk:p1:1")).toBeLessThan(log.indexOf("done:p1:1"));
    expect(log.lastIndexOf("chunk:p2:2")).toBeLessThan(log.indexOf("done:p2:2"));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(textOf(amend("v1")));
    expect(new Set(types(events)).size).toBeLessThanOrEqual(7);
  });

  it("23. spend is summed by keys", async () => {
    const valid = textOf(agree());
    const one = driverOf(async () => ({ text: valid, usage: { inputTokens: 10, outputTokens: 5 } }));
    const a = await go([scripted(amend("v1")), one]);
    expect(of(a.events, "turn_completed")[1]!.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(of(a.events, "turn_completed")[1]!.usage).not.toHaveProperty("costUsd");

    const results: TurnResult[] = [
      { text: "мусор", usage: { inputTokens: 3 } },
      { text: valid, usage: { inputTokens: 10, outputTokens: 5 } },
    ];
    const two = driverOf(async () => results.shift()!);
    const b = await go([scripted(amend("v1")), two]);
    expect(of(b.events, "turn_completed")[1]!.usage).toEqual({ inputTokens: 13, outputTokens: 5 });
  });

  it("24. durationMs by injected clock", async () => {
    let t = 1_000;
    const inner = scripted(amend("v1"));
    const slow = driverOf(async (req) => { t += 250; return inner.call(req); });
    const { events } = await go([slow, scripted(agree())], {}, { now: () => new Date(t) });
    expect(of(events, "turn_completed")[0]!.durationMs).toBe(250);
    expect(of(events, "turn_completed")[1]!.durationMs).toBe(0);
  });

  it("an exception from onEvent rejects runSession", async () => {
    await expect(go([scripted(amend("v1")), scripted(agree())], {}, {
      onEvent: () => { throw new Error("listener failure"); },
    })).rejects.toThrow("listener failure");
  });

  it("ParticipantCallError with kind timeout from the driver keeps kind", async () => {
    const d = driverOf(async () => { throw new ParticipantCallError("timeout", "мой таймаут", false); });
    const { events } = await go([scripted(amend("v1")), d]);
    expect(of(events, "turn_failed")[0]).toMatchObject({ kind: "timeout", message: "мой таймаут" });
    expect(of(events, "participant_dropped")[0]!.reason).toBe("Неповторяемая ошибка: мой таймаут");
  });
});

describe("createSession and input checks", () => {
  const base = { topic: "Т", framing: "", origin: "cli" as const, limits: limits() };
  const part = { name: "n", providerId: "scripted", model: "m", role: null };

  it("25. input errors and identifiers", () => {
    const one = () => createSession({ ...base, participants: [part] }, { maxParticipants: 8 });
    expect(one).toThrow(SessionInputError);
    expect(one).toThrow("2");
    const many = () => createSession({ ...base, participants: [part, part, part] }, { maxParticipants: 2 });
    expect(many).toThrow(SessionInputError);
    expect(many).toThrow("2");
    const blank = () => createSession({ ...base, topic: "   ", participants: [part, part] }, { maxParticipants: 8 });
    expect(blank).toThrow(SessionInputError);
    expect(blank).toThrow("Тема обязательна.");
    const s = createSession({ ...base, participants: [part, part, part] }, { maxParticipants: 8 });
    expect(s.participants.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    expect(s.templateId).toBeNull();
  });

  it("25a. turnTimeoutSec: 2147483 creates, 2147484 — SessionInputError with the field and the boundary (change 108)", () => {
    const mk = (n: number) => () => createSession({ ...base, limits: limits({ turnTimeoutSec: n }), participants: [part, part] }, { maxParticipants: 8 });
    expect(mk(2147483)().limits.turnTimeoutSec).toBe(2147483);
    expect(mk(2147484)).toThrow(SessionInputError);
    expect(mk(2147484)).toThrow("turnTimeoutSec");
    expect(mk(2147484)).toThrow("2147483");
  });

  it("25b. old journal with turnTimeoutSec 5000000: the fold reads it, turn timer not shorter than 1 ms and not above 2147483647", async () => {
    const old = { ...mkSession(2), limits: limits({ turnTimeoutSec: 5000000 }) };
    const delays: number[] = [];
    const orig = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) => {
      if (typeof ms === "number") delays.push(ms);
      return orig(fn, ms, ...a);
    }) as typeof setTimeout);
    try {
      const { events } = await runSession({ session: old, now: clock, drivers: { p1: scripted(amend("v1")), p2: scripted(agree()) } });
      expect(events.some((e) => e.type === "turn_failed")).toBe(false);
      expect(() => events.forEach((e) => SessionEventSchema.parse(e))).not.toThrow();
      expect(foldEvents(events).session?.limits.turnTimeoutSec).toBe(5000000);
    } finally {
      spy.mockRestore();
    }
    expect(delays).toContain(2147483647);
    expect(delays.every((d) => d <= 2147483647)).toBe(true);
  });

  it("26. no driver — rejected, no events", async () => {
    const onEvent = vi.fn();
    await expect(runSession({ session: mkSession(2), drivers: { p1: scripted(amend("v1")) }, onEvent }))
      .rejects.toThrow(SessionInputError);
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("owner wait: session setting", () => {
  const mk = (ownerWait: Parameters<typeof createSession>[0]["ownerWait"]) => createSession(
    {
      topic: "Тема", framing: "", origin: "cli", limits: limits(), ownerWait,
      participants: [0, 1].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })),
    },
    { maxParticipants: 8, id: "s1" },
  );
  it("enabled mode reaches the session, disabled ones are not written", () => {
    expect(mk({ pauseAfterRound: true, waitForOwner: false, timeoutSec: 60 }).ownerWait).toEqual({ pauseAfterRound: true, timeoutSec: 60 });
    expect(mk({ waitForOwner: true }).ownerWait).toEqual({ waitForOwner: true });
  });
  it("only timeoutSec without modes: no field", () => {
    expect("ownerWait" in mk({ timeoutSec: 60 })).toBe(false);
    expect("ownerWait" in mk({ pauseAfterRound: false })).toBe(false);
    expect("ownerWait" in mk(undefined)).toBe(false);
  });
  it("invalid timeoutSec with a mode enabled: SessionInputError", () => {
    for (const t of [0, 1.5, 86401, Infinity, -1, "5" as unknown as number]) {
      expect(() => mk({ pauseAfterRound: true, timeoutSec: t })).toThrow(SessionInputError);
    }
  });
});

describe("owner materials", () => {
  const MARK1 = "УНИКАЛЬНАЯ-МЕТКА-ОДИН";
  const MARK2 = "УНИКАЛЬНАЯ-МЕТКА-ДВА";
  const mat = (n: number, text: string): CollectedMaterial => ({
    id: `m${n}`, name: `f${n}.md`, chars: text.length, sha256: createHash("sha256").update(text, "utf8").digest("hex"), text,
  });
  const mats = () => [mat(1, `первый ${MARK1}`), mat(2, `второй ${MARK2}`)];
  const mkWith = (materials: readonly CollectedMaterial[] | undefined, over: Partial<Limits> = {}, n = 2) =>
    createSession(
      {
        topic: "Тема", framing: "", origin: "cli", limits: limits({ materialsChars: 1000, ...over }), materials,
        participants: Array.from({ length: n }, (_, i) => ({ name: `N${i + 1}`, providerId: "scripted", model: "m", role: null })),
      },
      { maxParticipants: 8, id: "s1", now: () => new Date("2026-01-01T00:00:00Z") },
    );
  const drv = (ds: ParticipantDriver[]) => Object.fromEntries(ds.map((d, i) => [`p${i + 1}`, d]));
  const hasBoth = (p: string) => {
    expect(p).toContain("# Материалы владельца");
    expect(p).toContain(`первый ${MARK1}`);
    expect(p).toContain(`второй ${MARK2}`);
    expect(p.indexOf("# Тема")).toBeLessThan(p.indexOf("# Материалы владельца"));
    expect(p.indexOf("# Материалы владельца")).toBeLessThan(p.indexOf("# Текущая версия решения"));
  };

  it("createSession stores only metadata", () => {
    const s = mkWith(mats());
    expect(s.materials).toEqual(mats().map(({ text: _t, ...meta }) => meta));
    expect(JSON.stringify(s)).not.toContain(MARK1);
    expect(JSON.stringify(s)).not.toContain(MARK2);
  });

  it("createSession rejects an inconsistent set", () => {
    const [a, b] = mats() as [CollectedMaterial, CollectedMaterial];
    expect(() => mkWith([{ ...a, text: a.text + "!" }, b])).toThrow(SessionInputError);
    expect(() => mkWith([{ ...a, chars: a.chars + 1 }, b])).toThrow(SessionInputError);
    expect(() => mkWith([{ ...a, sha256: "0".repeat(64) }, b])).toThrow(SessionInputError);
    expect(() => mkWith([a, b], { materialsChars: 5 })).toThrow(SessionInputError);
    expect(() => mkWith([a, b], { materialsChars: undefined })).toThrow(SessionInputError);
  });

  it("empty or missing set: no materials key", () => {
    expect("materials" in mkWith(undefined)).toBe(false);
    expect("materials" in mkWith([])).toBe(false);
  });

  it("every turn of every round gets full texts; events without text", async () => {
    const prompts: string[] = [];
    const session = mkWith(mats());
    const { events } = await runSession({
      session, now: clock, materials: mats(),
      drivers: drv([spy(scripted(amend("v1"), agree()), prompts), spy(scripted(object(), agree()), prompts)]),
    });
    expect(prompts.length).toBeGreaterThanOrEqual(4);
    prompts.forEach(hasBoth);
    expect(of(events, "turn_completed").some((e) => e.round >= 2)).toBe(true);
    for (const e of events) {
      expect(JSON.stringify(e)).not.toContain(MARK1);
      expect(JSON.stringify(e)).not.toContain(MARK2);
    }
    expect(of(events, "session_created")[0]!.session.materials).toHaveLength(2);
  });

  it("retry after an error and the correction contain materials", async () => {
    const prompts: string[] = [];
    const session = mkWith(mats());
    await runSession({
      session, now: clock, materials: mats(),
      drivers: drv([
        scripted(amend("v1"), agree()),
        spy(scripted({ timeout: true }, { response: { stance: "agree" } }, agree()), prompts),
      ]),
    });
    expect(prompts.length).toBeGreaterThanOrEqual(3);
    prompts.forEach(hasBoth);
    expect(prompts[0]).toBe(prompts[1]);
    expect(prompts[2]).toContain("# Исправь предыдущий ответ");
  });

  it("set does not match the session: error, no events or calls", async () => {
    const [a, b] = mats() as [CollectedMaterial, CollectedMaterial];
    const other = mat(2, "другой текст");
    const cases: [string, ReturnType<typeof mkWith>, readonly CollectedMaterial[] | undefined][] = [
      ["другой текст", mkWith(mats()), [a, other]],
      ["набора нет", mkWith(mats()), undefined],
      ["лишний набор", mkWith(undefined), [a, b]],
      ["короче", mkWith(mats()), [a]],
    ];
    for (const [label, session, set] of cases) {
      const calls = vi.fn();
      const onEvent = vi.fn();
      const d = driverOf(async (req) => { calls(); return scripted(agree()).call(req); });
      await expect(runSession({ session, materials: set, onEvent, drivers: drv([d, d]) }), label).rejects.toThrow(SessionInputError);
      await expect(runSession({ session, materials: set, onEvent, drivers: drv([d, d]) }), label).rejects.toThrow("Материалы не соответствуют сессии: ");
      expect(onEvent).not.toHaveBeenCalled();
      expect(calls).not.toHaveBeenCalled();
    }
  });

  it("checkSessionMaterials: empty on both sides is fine", () => {
    expect(() => checkSessionMaterials(mkWith(undefined), undefined)).not.toThrow();
    expect(() => checkSessionMaterials(mkWith(undefined), [])).not.toThrow();
  });

  it("without materials: no section", async () => {
    const prompts: string[] = [];
    await go([spy(scripted(amend("v1"), agree()), prompts), spy(scripted(agree()), prompts)]);
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) expect(p).not.toContain("Материалы владельца");
  });

  it("small contextChars: early turns omitted, materials intact", async () => {
    const prompts: string[] = [];
    const session = mkWith(mats(), { contextChars: 1 });
    await runSession({
      session, now: clock, materials: mats(),
      drivers: drv([spy(scripted(amend("v1"), agree()), prompts), spy(scripted(object(), agree()), prompts)]),
    });
    prompts.forEach(hasBoth);
    expect(prompts.some((p) => p.includes("[Ранние ходы опущены из-за лимита контекста:"))).toBe(true);
  });
});

describe("owner messages between turns", () => {
  const req = (n: number): OwnerMessageRequest => ({ requestId: `r${n}`, text: `Реплика ${n}` });
  // open[i] — answer of the i-th take(false); closing[i] — answer of the i-th take(true)
  function fake(open: OwnerRequest[][] = [], closing: OwnerRequest[][] = [], log: string[] = []) {
    let o = 0;
    let c = 0;
    const calls = { take: [] as boolean[], done: [] as string[], reopen: 0 };
    const source: OwnerMessageSource = {
      take: (cl) => { calls.take.push(cl); log.push(`take:${cl}`); return (cl ? closing[c++] : open[o++]) ?? []; },
      done: (id) => { calls.done.push(id); log.push(`done:${id}`); },
      reopen: () => { calls.reopen++; log.push("reopen"); },
    };
    return { source, calls };
  }
  const SECTION = "# Реплики владельца";

  it("message after a possible last turn: agreement reset, next turn sees it", async () => {
    const prompts: string[] = [];
    const { source } = fake([[], [req(1)]]);
    const { events } = await go(
      [spy(scripted(amend("v1"), agree()), prompts), spy(scripted(agree(), agree()), prompts)],
      {}, { ownerMessages: source },
    );
    const t = types(events);
    const i = events.findIndex((e) => e.type === "owner_message");
    expect(events[i - 1]).toMatchObject({ type: "turn_completed", turn: 2 });
    expect(events[i]).toMatchObject({ id: "o1", afterTurn: 2, text: "Реплика 1", requestId: "r1" });
    expect(events[i + 1]).toMatchObject({ type: "turn_started", turn: 3 });
    expect(t.indexOf("consensus" as never)).toBe(-1);
    expect(prompts.slice(0, 2).some((x) => x.includes(SECTION))).toBe(false);
    expect(prompts[2]).toContain(SECTION);
    expect(prompts[2]).toContain("Реплика 1");
    const f = finishOf(events);
    expect(f).toMatchObject({ status: "consensus", version: 1 });
    expect(of(events, "turn_completed")).toHaveLength(4);
  });

  it("two messages in one take: o1, o2 with one afterTurn", async () => {
    const { source } = fake([[req(1), req(2)]]);
    const { events } = await go([scripted(amend("v1"), agree()), scripted(agree(), agree())], {}, { ownerMessages: source });
    expect(of(events, "owner_message").map((e) => [e.id, e.afterTurn, e.text])).toEqual([["o1", 1, "Реплика 1"], ["o2", 1, "Реплика 2"]]);
  });

  it("retry and correction within a turn do not see the message, the next turn does", async () => {
    for (const bad of [{ timeout: true } as Step, { response: { stance: "agree" } } as Step]) {
      const prompts: string[] = [];
      const p2prompts: string[] = [];
      const { source } = fake([[], [req(1)]]);
      const { events } = await go(
        [spy(scripted(amend("v1"), agree()), prompts), spy(scripted(bad, agree(), agree()), p2prompts)],
        {}, { ownerMessages: source },
      );
      expect(of(events, "turn_completed")[1]!.attempts).toBe(2);
      expect(p2prompts.slice(0, 2).every((x) => !x.includes(SECTION))).toBe(true);
      expect(of(events, "owner_message")[0]!.afterTurn).toBe(2);
      expect(prompts[1]).toContain(SECTION);
      expect(finishOf(events).status).toBe("consensus");
    }
  });

  it("message at the end of the last round: no_consensus, no agreement, no third turn", async () => {
    const { source } = fake([[], [req(1)]]);
    const { events } = await go([scripted(amend("v1")), scripted(agree())], { maxRounds: 1 }, { ownerMessages: source });
    const t = types(events);
    expect(t.indexOf("owner_message")).toBeLessThan(t.indexOf("session_finished"));
    expect(finishOf(events)).toMatchObject({ status: "no_consensus", agreed: [] });
    expect(of(events, "turn_started")).toHaveLength(2);
  });

  it("message exactly at closing: consensus cancelled, intake open, discussion goes on", async () => {
    const { source, calls } = fake([], [[req(1)]]);
    const { events } = await go(
      [scripted(amend("v1"), agree()), scripted(agree(), agree())], {}, { ownerMessages: source },
    );
    const o = of(events, "owner_message");
    expect(o).toHaveLength(1);
    expect(o[0]!.afterTurn).toBe(2);
    expect(calls.reopen).toBe(1);
    expect(of(events, "turn_started")).toHaveLength(4);
    expect(finishOf(events).status).toBe("consensus");
  });

  it("message at closing, rounds exhausted: no_consensus, event before finish", async () => {
    const { source, calls } = fake([], [[req(1)]]);
    const { events } = await go([scripted(amend("v1")), scripted(agree())], { maxRounds: 1 }, { ownerMessages: source });
    const t = types(events);
    expect(t.indexOf("owner_message")).toBeLessThan(t.indexOf("session_finished"));
    expect(finishOf(events)).toMatchObject({ status: "no_consensus", agreed: [] });
    expect(calls.reopen).toBe(1);
    expect(of(events, "turn_started")).toHaveLength(2);
  });

  it("request given twice gives one event; done called both times", async () => {
    const { source, calls } = fake([[req(1)], [req(1)]]);
    const { events } = await go([scripted(amend("v1"), agree(), agree()), scripted(agree(), agree())], {}, { ownerMessages: source });
    expect(of(events, "owner_message")).toHaveLength(1);
    expect(calls.done.filter((d) => d === "r1").length).toBeGreaterThanOrEqual(2);
  });

  it("order: owner_message event before done", async () => {
    const log: string[] = [];
    const { source } = fake([[req(1)]], [], log);
    await go([scripted(amend("v1"), agree()), scripted(agree(), agree())], {}, {
      ownerMessages: source, onEvent: (e) => { if (e.type === "owner_message") log.push(`event:${e.requestId}`); },
    });
    expect(log.indexOf("event:r1")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("event:r1")).toBeLessThan(log.indexOf("done:r1"));
  });

  it("take(true) before each finish; the message from it is written before session_finished", async () => {
    const check = (events: SessionEvent[], calls: { take: boolean[]; reopen: number }, status: string, reopen: number) => {
      expect(calls.take.at(-1)).toBe(true);
      expect(finishOf(events).status).toBe(status);
      expect(calls.reopen).toBe(reopen);
    };
    // consensus
    let f = fake();
    check((await go([scripted(amend("v1")), scripted(agree())], {}, { ownerMessages: f.source })).events, f.calls, "consensus", 0);
    // no_consensus + owner message from take(true)
    f = fake([], [[req(1)]]);
    let r = await go([scripted(amend("v1")), scripted(object())], { maxRounds: 1 }, { ownerMessages: f.source });
    check(r.events, f.calls, "no_consensus", 0);
    expect(types(r.events).indexOf("owner_message")).toBeLessThan(types(r.events).indexOf("session_finished"));
    // stopped (abort before start)
    f = fake([], [[req(1)]]);
    const ctl = new AbortController();
    ctl.abort();
    r = await go([scripted(amend("v1")), scripted(agree())], {}, { ownerMessages: f.source, signal: ctl.signal });
    check(r.events, f.calls, "stopped", 0);
    expect(types(r.events)).toEqual(["session_created", "owner_message", "session_finished"]);
    // stopped in the middle of a turn
    f = fake([], [[req(1)]]);
    const ctl2 = new AbortController();
    const waiting = driverOf((q) => new Promise<TurnResult>((_, rej) => {
      q.signal.addEventListener("abort", () => rej(new Error("aborted")));
      setTimeout(() => ctl2.abort(), 0);
    }));
    r = await go([scripted(amend("v1")), waiting], {}, { ownerMessages: f.source, signal: ctl2.signal });
    check(r.events, f.calls, "stopped", 0);
    expect(types(r.events).at(-2)).toBe("owner_message");
    // failed
    f = fake([], [[req(1)]]);
    r = await go([scripted(amend("v1")), scripted({ error: "fatal", retryable: false })], {}, { ownerMessages: f.source });
    check(r.events, f.calls, "failed", 0);
    expect(types(r.events).at(-2)).toBe("owner_message");
  });

  it("without a source the behavior is unchanged", async () => {
    const { events } = await go([scripted(amend("v1")), scripted(agree())]);
    expect(of(events, "owner_message")).toHaveLength(0);
    expect(finishOf(events).status).toBe("consensus");
  });

  it("continue request outside a wait: no events, done called, message from the same pass applied", async () => {
    const { source, calls } = fake([[{ requestId: "rel1", releaseWaitId: "w1" }, req(1)]]);
    const { events } = await go([scripted(amend("v1"), agree()), scripted(agree(), agree())], {}, { ownerMessages: source });
    expect(events.some((e) => e.type.startsWith("owner_wait"))).toBe(false);
    expect(calls.done.slice(0, 2)).toEqual(["rel1", "r1"]);
    expect(of(events, "owner_message").map((e) => [e.id, e.requestId])).toEqual([["o1", "r1"]]);
  });
});

describe("questions to the owner", () => {
  const ask = { questions: [{ to: "owner", text: "Какой бюджет?" }] };
  const rq = (n: number, questionId?: string, text = `Ответ ${n}`): OwnerMessageRequest => ({
    requestId: `r${n}`, text, ...(questionId !== undefined ? { questionId } : {}),
  });
  function queue(open: OwnerMessageRequest[][]) {
    let o = 0;
    const source: OwnerMessageSource = { take: (cl) => (cl ? [] : open[o++] ?? []), done: () => {}, reopen: () => {} };
    return source;
  }
  const closedOf = (events: SessionEvent[], questionId: string) =>
    of(events, "question_closed").filter((e) => e.questionId === questionId);

  it("answer during a turn: event order, agreement only after the message", async () => {
    const { events, state } = await go(
      [scripted(amend("v1", ask), agree(), agree()), scripted(agree(), agree(), agree())],
      {}, { ownerMessages: queue([[], [rq(1, "q1")]]) },
    );
    const i = events.findIndex((e) => e.type === "owner_message");
    expect(events[i - 1]).toMatchObject({ type: "turn_completed", turn: 2 });
    expect(events[i]).toMatchObject({ answers: [{ questionId: "q1", text: "Ответ 1" }] });
    expect(events[i + 1]).toMatchObject({ type: "question_closed", questionId: "q1", reason: "answered" });
    expect(events[i + 2]).toMatchObject({ type: "turn_started", turn: 3 });
    expect(closedOf(events, "q1")).toHaveLength(1);
    expect(events.slice(0, i).some((e) => e.type === "session_finished")).toBe(false);
    const f = finishOf(events);
    expect(f.status).toBe("consensus");
    expect(of(events, "turn_completed")).toHaveLength(4);
    expect(state.questions[0]).toMatchObject({ status: "answered" });
  });

  it("owner silence: unanswered closed before the next turn of the asker, agreeing participants reset", async () => {
    const { events } = await go(
      [scripted(amend("v1", ask), agree(), agree()), scripted(agree(), agree(), agree())],
    );
    const j = events.findIndex((e) => e.type === "question_closed");
    expect(events[j]).toMatchObject({ questionId: "q1", reason: "unanswered" });
    expect(events[j - 1]).toMatchObject({ type: "turn_completed", turn: 2 });
    expect(events[j + 1]).toMatchObject({ type: "turn_started", turn: 3, participantId: "p1" });
    expect(of(events, "question_closed")).toHaveLength(1);
    expect(events.findIndex((e) => e.type === "session_finished")).toBeGreaterThan(j);
    expect(finishOf(events).status).toBe("consensus");
    // p2 agreed in turn 2, the closing reset the agreeing ones: consensus only after one more agree from p2
    expect(of(events, "turn_completed")).toHaveLength(4);
    expect(events.filter((e) => e.type === "turn_completed" && e.turn === 3)).toHaveLength(1);
  });

  it("agree with a question to the owner is recorded as object, the question is open", async () => {
    const { events } = await go(
      [scripted(amend("v1"), agree(ask)), scripted(object(), agree())], { maxRounds: 2 },
    );
    const t2 = of(events, "turn_completed")[2]!;
    expect(t2).toMatchObject({ stance: "object", normalized: true });
    expect(events.some((e) => e.type === "question_closed")).toBe(false);
  });

  it("the request comes after unanswered is closed: a regular message without answers", async () => {
    const { events, state } = await go(
      [scripted(amend("v1", ask), agree(), agree()), scripted(agree(), agree(), agree())],
      {}, { ownerMessages: queue([[], [], [rq(1, "q1")]]) },
    );
    const om = of(events, "owner_message");
    expect(om).toHaveLength(1);
    expect(om[0]!.answers).toBeUndefined();
    expect(closedOf(events, "q1")).toHaveLength(1);
    expect(state.questions[0]).toMatchObject({ status: "unanswered" });
  });

  it("question to a participant and unknown id: message without answers, questions not closed", async () => {
    const toP2 = { questions: [{ to: "p2", text: "Ты как?" }] };
    const { events } = await go(
      [scripted(amend("v1", toP2), agree(), agree()), scripted(agree(), agree(), agree())],
      { maxRounds: 1 }, { ownerMessages: queue([[rq(1, "q1"), rq(2, "q99")]]) },
    );
    const om = of(events, "owner_message");
    expect(om).toHaveLength(2);
    expect(om.every((e) => e.answers === undefined)).toBe(true);
    expect(closedOf(events, "q1").every((e) => e.reason !== "answered")).toBe(true);
    expect(closedOf(events, "q99")).toHaveLength(0);
  });

  it("a regular message without questionId does not close the question to the owner", async () => {
    const { events } = await go(
      [scripted(amend("v1", ask), agree()), scripted(agree(), agree())],
      { maxRounds: 1 }, { ownerMessages: queue([[rq(1)]]) },
    );
    const t = types(events);
    expect(of(events, "owner_message")[0]!.answers).toBeUndefined();
    expect(t.indexOf("question_closed")).toBe(-1);
  });

  it("the asker drops out on the next turn: unanswered, then turn_started, then participant_dropped", async () => {
    const { events } = await go([
      scripted(amend("v1", ask), { error: "сбой", retryable: false }),
      scripted(agree(), agree(), agree()),
      scripted(agree(), agree(), agree()),
    ]);
    const j = events.findIndex((e) => e.type === "question_closed");
    expect(events[j]).toMatchObject({ questionId: "q1", reason: "unanswered" });
    expect(events[j + 1]).toMatchObject({ type: "turn_started", participantId: "p1" });
    const dropped = events.findIndex((e) => e.type === "participant_dropped");
    expect(dropped).toBeGreaterThan(j + 1);
    expect(of(events, "question_closed")).toHaveLength(1);
    expect(of(events, "participant_dropped")).toHaveLength(1);
    expect(["consensus", "no_consensus"]).toContain(finishOf(events).status);
  });
});

describe("runSession: session continuation", () => {
  const dmap = (ds: ParticipantDriver[]) => Object.fromEntries(ds.map((d, i) => [`p${i + 1}`, d]));
  const first = async (ds: ParticipantDriver[], over: Partial<Limits> = {}, extra: Partial<RunSessionOptions> = {}) => {
    const session = mkSession(ds.length, over);
    const run = await runSession({ session, now: clock, drivers: dmap(ds), ...extra });
    return { session, prev: run.events };
  };
  const again = (
    session: ReturnType<typeof mkSession>, prev: SessionEvent[], maxRounds: number, ds: ParticipantDriver[],
    extra: Partial<RunSessionOptions> = {},
  ) => runSession({ session, now: clock, drivers: dmap(ds), resume: { events: prev, maxRounds }, ...extra });
  // Runs the steps, on the next call stops the discussion in the middle of a turn.
  const stopping = (ac: AbortController, ...steps: Step[]): ParticipantDriver => {
    const inner = scripted(...steps);
    let n = 0;
    return driverOf((req) => (n++ < steps.length ? inner.call(req) : (ac.abort(), new Promise<TurnResult>(() => {}))));
  };
  const cut = (events: SessionEvent[], pred: (e: SessionEvent) => boolean) => events.slice(0, events.findIndex(pred) + 1);
  const quiet = (calls: string[]) => driverOf(async (req) => { calls.push(req.participant.id); throw new Error("must not be called"); });

  it("after no_consensus with a higher limit: session_resumed, round 3, next number", async () => {
    const { session, prev } = await first(
      [scripted(amend("v1"), object()), scripted(object(), object())], { maxRounds: 2 },
    );
    expect(finishOf(prev).status).toBe("no_consensus");
    const run = await again(session, prev, 3, [scripted(agree()), scripted(agree())]);
    expect(run.events[0]).toMatchObject({ type: "session_resumed", seq: prev.length + 1, pid: process.pid, maxRounds: 3 });
    expect(types(run.events)).not.toContain("session_created");
    expect(of(run.events, "turn_started").map((e) => [e.turn, e.round, e.participantId])).toEqual([[5, 3, "p1"], [6, 3, "p2"]]);
    expect(finishOf(run.events).status).toBe("consensus");
    expect(run.state).toEqual(foldEvents([...prev, ...run.events]));
  });

  it("stop in the middle of p2's turn: the turn repeats with the same number, p1 not called", async () => {
    const ac = new AbortController();
    const { session, prev } = await first(
      [scripted(amend("v1"), amend("v2")), stopping(ac, object())], {}, { signal: ac.signal },
    );
    expect(finishOf(prev).status).toBe("stopped");
    const p1: string[] = [];
    const run = await again(session, prev, 5, [quiet(p1), scripted(agree())]);
    expect(p1).toEqual([]);
    expect(of(run.events, "turn_started").map((e) => [e.turn, e.round, e.participantId])).toEqual([[4, 2, "p2"]]);
    expect(of(run.events, "turn_completed")[0]).toMatchObject({ turn: 4, attempts: 1, version: 2 });
    expect(finishOf(run.events).status).toBe("consensus");
  });

  it("failure between turns: p3 continues in round 1", async () => {
    const { session, prev } = await first([scripted(amend("v1")), scripted(agree()), scripted(agree())]);
    const cutPrev = cut(prev, (e) => e.type === "turn_completed" && e.turn === 2);
    const calls: string[] = [];
    const run = await again(session, cutPrev, 5, [quiet(calls), quiet(calls), scripted(agree())]);
    expect(calls).toEqual([]);
    expect(of(run.events, "turn_started").map((e) => [e.turn, e.round, e.participantId])).toEqual([[3, 1, "p3"]]);
    expect(finishOf(run.events).status).toBe("consensus");
  });

  it("round finished: next round starts with the first active", async () => {
    const { session, prev } = await first([scripted(amend("v1"), agree()), scripted(object(), agree())]);
    const cutPrev = cut(prev, (e) => e.type === "turn_completed" && e.turn === 2);
    const run = await again(session, cutPrev, 5, [scripted(agree()), scripted(agree())]);
    expect(of(run.events, "turn_started").map((e) => [e.turn, e.round, e.participantId])[0]).toEqual([3, 2, "p1"]);
  });

  it("agreement already recorded: consensus result without calling participants", async () => {
    const { session, prev } = await first([scripted(amend("v1")), scripted(agree())]);
    const cutPrev = prev.filter((e) => e.type !== "session_finished");
    const calls: string[] = [];
    const run = await again(session, cutPrev, 5, [quiet(calls), quiet(calls)]);
    expect(types(run.events)).toEqual(["session_resumed", "session_finished"]);
    expect(finishOf(run.events)).toMatchObject({ status: "consensus", version: 1 });
    expect(calls).toEqual([]);
  });

  it("fewer than two active: failed", async () => {
    const { session, prev } = await first([scripted(amend("v1")), scripted({ error: "x", retryable: false })]);
    const cutPrev = prev.filter((e) => e.type !== "session_finished");
    const run = await again(session, cutPrev, 5, [scripted(), scripted()]);
    expect(finishOf(run.events)).toMatchObject({ status: "failed", reason: "Активных участников осталось меньше двух." });
  });

  it("question and dropped participant are kept", async () => {
    const ac = new AbortController();
    const { session, prev } = await first(
      [
        stopping(ac, amend("v1", { questions: [{ to: "p2", text: "ВОПРОС-ДВА" }] })),
        scripted(agree({ answers: [{ questionId: "q1", text: "ок" }], questions: [{ to: "p1", text: "ВОПРОС-ОДИН" }] })),
        scripted({ error: "x", retryable: false }),
      ],
      {}, { signal: ac.signal },
    );
    expect(of(prev, "participant_dropped").map((e) => e.participantId)).toEqual(["p3"]);
    const prompts: string[] = [];
    const calls: string[] = [];
    const run = await again(session, prev, 5, [
      spy(scripted(agree({ answers: [{ questionId: "q2", text: "ответ" }] })), prompts),
      scripted(agree()),
      quiet(calls),
    ]);
    expect(prompts[0]).toContain("ВОПРОС-ОДИН");
    expect(calls).toEqual([]);
    expect(of(run.events, "turn_started").map((e) => e.participantId)).toEqual(["p1", "p2"]);
    expect(finishOf(run.events)).toMatchObject({ status: "consensus", version: 1 });
  });

  it("no decision yet: the first answer must be amend", async () => {
    const ac = new AbortController();
    const { session, prev } = await first([stopping(ac), scripted()], {}, { signal: ac.signal });
    const run = await again(session, prev, 5, [scripted(agree(), amend("v1")), scripted(agree())]);
    expect(of(run.events, "turn_failed")[0]).toMatchObject({ participantId: "p1", kind: "invalid_response" });
    expect(of(run.events, "turn_completed")[0]).toMatchObject({ stance: "amend", version: 1, attempts: 2 });
  });

  it("owner message from earlier events is in the request; q and o numbering continues", async () => {
    const ac = new AbortController();
    let o = 0;
    const src = (...reqs: OwnerMessageRequest[]): OwnerMessageSource => ({
      take: (closing) => (closing || o++ > 0 ? [] : reqs), done: () => {}, reopen: () => {},
    });
    const { session, prev } = await first(
      [scripted(amend("v1", { questions: [{ to: "p2", text: "Q" }] })), stopping(ac)],
      {}, { signal: ac.signal, ownerMessages: src({ requestId: "r1", text: "Реплика-один" }) },
    );
    expect(of(prev, "owner_message")).toHaveLength(1);
    o = 0;
    const prompts: string[] = [];
    const run = await again(
      session, prev, 5,
      [scripted(), spy(scripted(agree({ answers: [{ questionId: "q1", text: "a" }], questions: [{ to: "p1", text: "Q2" }] })), prompts)],
      { ownerMessages: src({ requestId: "r2", text: "Реплика-два" }) },
    );
    expect(prompts[0]).toContain("Реплика-один");
    expect(of(run.events, "turn_completed")[0]!.questions[0]!.id).toBe("q2");
    expect(of(run.events, "owner_message").map((e) => e.id)).toEqual(["o2"]);
  });

  it("materials: section in the request; mismatch — SessionInputError before events", async () => {
    const text = "текст-материала-Ж";
    const m: CollectedMaterial = { id: "m1", name: "a.md", chars: text.length, sha256: createHash("sha256").update(text, "utf8").digest("hex"), text };
    const session = createSession(
      {
        topic: "Тема", framing: "", origin: "cli", limits: limits({ materialsChars: 1000 }), materials: [m],
        participants: [1, 2].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })),
      },
      { maxParticipants: 8, id: "s1", now: () => new Date("2026-01-01T00:00:00Z") },
    );
    const ac = new AbortController();
    const prev = (await runSession({
      session, now: clock, drivers: dmap([stopping(ac), scripted()]), signal: ac.signal, materials: [m],
    })).events;
    const prompts: string[] = [];
    await again(session, prev, 5, [spy(scripted(amend("v1")), prompts), scripted(agree())], { materials: [m] });
    expect(prompts[0]).toContain("# Материалы владельца");
    expect(prompts[0]).toContain(text);
    const seen: SessionEvent[] = [];
    await expect(
      again(session, prev, 5, [scripted(), scripted()], { materials: [{ ...m, text: "иной", chars: 4 }], onEvent: (e) => seen.push(e) }),
    ).rejects.toBeInstanceOf(SessionInputError);
    expect(seen).toEqual([]);
  });

  it("an unfinished round counts toward the limit", async () => {
    const ac = new AbortController();
    const { session, prev } = await first(
      [scripted(amend("v1"), amend("v2")), stopping(ac, object())], {}, { signal: ac.signal },
    );
    const run = await again(session, prev, 3, [scripted(amend("v3")), scripted(object(), object())]);
    expect(of(run.events, "turn_started").map((e) => [e.turn, e.round])).toEqual([[4, 2], [5, 3], [6, 3]]);
    expect(finishOf(run.events).status).toBe("no_consensus");
  });

  it("limit already exhausted: no_consensus at once", async () => {
    const { session, prev } = await first([scripted(amend("v1"), object()), scripted(object(), object())], { maxRounds: 2 });
    const calls: string[] = [];
    const run = await again(session, prev, 2, [quiet(calls), quiet(calls)]);
    expect(types(run.events)).toEqual(["session_resumed", "session_finished"]);
    expect(finishOf(run.events).status).toBe("no_consensus");
  });

  it("foreign journal: SessionInputError, no events", async () => {
    const { prev } = await first([scripted(amend("v1")), scripted(agree())]);
    const other = createSession(
      {
        topic: "Тема", framing: "", origin: "cli", limits: limits(),
        participants: [1, 2].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })),
      },
      { maxParticipants: 8, id: "другой", now: () => new Date("2026-01-01T00:00:00Z") },
    );
    const seen: SessionEvent[] = [];
    await expect(again(other, prev, 5, [scripted(), scripted()], { onEvent: (e) => seen.push(e) })).rejects.toBeInstanceOf(SessionInputError);
    expect(seen).toEqual([]);
  });
});

describe("runSession: token cap", () => {
  const scen = (path: string) => readScenario(fileURLToPath(new URL(`../scenarios/token-cap/${path}`, import.meta.url)));
  const fromFiles = async (dir: string) => {
    const [a, b] = await Promise.all([scen(`${dir}p1.json`), scen(`${dir}p2.json`)]);
    return [createScriptedDriver(a, { COUNCIL_DEV: "1" }), createScriptedDriver(b, { COUNCIL_DEV: "1" })];
  };
  const tok = (s: Step, inputTokens = 300, outputTokens = 200): Step => ({ ...s, inputTokens, outputTokens } as Step);
  const rawTok = (raw: string, inputTokens: number, outputTokens: number): Step => ({ raw, inputTokens, outputTokens });
  const dmap = (ds: ParticipantDriver[]) => Object.fromEntries(ds.map((d, i) => [`p${i + 1}`, d]));

  it("cap reached: stopped/token_cap after the third turn, the fourth not started", async () => {
    const { events, state } = await go(await fromFiles(""), { maxTotalTokens: 1200 });
    const f = finishOf(events);
    expect(f).toMatchObject({ status: "stopped", reason: "token_cap", version: 2 });
    expect(f.objectors.length).toBeGreaterThan(0);
    expect(f.objectors[0]!.participantId).toBe("p2");
    expect(f.objectors).toEqual(objectors(state));
    expect(f.agreed).toEqual(state.agreed);
    expect(of(events, "turn_started")).toHaveLength(3);
    expect(tokenUsage(state).total).toBe(1500);
  });

  it("agreement outranks the cap", async () => {
    const { events } = await go(await fromFiles("agree/"), { maxTotalTokens: 800 });
    const f = finishOf(events);
    expect(f.status).toBe("consensus");
    expect("reason" in f).toBe(false);
  });

  it("last turn of a round: token_cap, not no_consensus", async () => {
    const { events } = await go(await fromFiles(""), { maxRounds: 2, maxTotalTokens: 1900 });
    expect(of(events, "turn_started")).toHaveLength(4);
    expect(finishOf(events)).toMatchObject({ status: "stopped", reason: "token_cap" });
  });

  it("no cap: no_consensus, spend counted", async () => {
    const { events, state } = await go(await fromFiles(""), { maxRounds: 2 });
    expect(finishOf(events).status).toBe("no_consensus");
    expect(tokenUsage(state).total).toBe(2000);
  });

  it("incomplete accounting: tokens not reported, no stop", async () => {
    const { events, state } = await go(
      [scripted(amend("v1"), object()), scripted(object(), object())], { maxRounds: 2, maxTotalTokens: 100 },
    );
    expect(finishOf(events).status).toBe("no_consensus");
    expect(tokenUsage(state).incomplete).toBe(true);
  });

  it("exactly at the boundary: sum equals the cap, stop", async () => {
    const { events } = await go(await fromFiles(""), { maxTotalTokens: 1000 });
    expect(finishOf(events)).toMatchObject({ status: "stopped", reason: "token_cap" });
    expect(of(events, "turn_started")).toHaveLength(2);
  });

  it("failed outranks the cap", async () => {
    const { events } = await go(
      [scripted(amend("v1")), scripted(rawTok("мусор", 300, 200), rawTok("мусор", 300, 200))],
      { maxTotalTokens: 500 },
    );
    expect(finishOf(events).status).toBe("failed");
    expect(of(events, "participant_dropped")).toHaveLength(1);
  });

  it("spend of a failed attempt: in turn_failed, without double counting", async () => {
    const { events, state } = await go([
      scripted(rawTok("мусор", 120, 80), tok(amend("v1"), 10, 5)), scripted(agree()),
    ]);
    const [failure] = of(events, "turn_failed");
    expect(failure).toMatchObject({ kind: "invalid_response", usage: { inputTokens: 120, outputTokens: 80, costUsd: 0 } });
    expect(of(events, "turn_completed")[0]!.usage).toEqual({ inputTokens: 130, outputTokens: 85, costUsd: 0 });
    expect(tokenUsage(state).total).toBe(215);
    for (const e of events) SessionEventSchema.parse(e);
  });

  it("invalid answer without tokens and a call error: no usage field", async () => {
    let n = 0;
    const empty = driverOf(async () => (n++ === 0 ? { text: "мусор", usage: {} } : { text: textOf(amend("v1")), usage: {} }));
    const a = await go([empty, scripted(agree())]);
    const [f1] = of(a.events, "turn_failed");
    expect(f1!.kind).toBe("invalid_response");
    expect("usage" in f1!).toBe(false);
    const b = await go([scripted({ error: "сбой" }, amend("v1")), scripted(agree())]);
    const [f2] = of(b.events, "turn_failed");
    expect(f2!.kind).toBe("call_error");
    expect("usage" in f2!).toBe(false);
  });

  it("dropped out after invalid answers with spend: spend in the total, cap triggers", async () => {
    const { events, state } = await go(
      [scripted(amend("v1")), scripted(rawTok("мусор", 300, 200), rawTok("мусор", 300, 200)), scripted(object())],
      { maxTotalTokens: 800 },
    );
    expect(of(events, "participant_dropped")).toHaveLength(1);
    expect(tokenUsage(state).total).toBe(1000);
    expect(finishOf(events)).toMatchObject({ status: "stopped", reason: "token_cap" });
    expect(of(events, "turn_started")).toHaveLength(2);
  });

  it("owner stop with a set cap: no reason", async () => {
    const ac = new AbortController();
    const stopper = driverOf(() => (ac.abort(), new Promise<TurnResult>(() => {})));
    const { events } = await go([scripted(tok(amend("v1"))), stopper], { maxTotalTokens: 100000 }, { signal: ac.signal });
    const f = finishOf(events);
    expect(f.status).toBe("stopped");
    expect("reason" in f).toBe(false);
  });

  it("a queued message at a cap stop is written before session_finished", async () => {
    const source: OwnerMessageSource = {
      take: (closing) => (closing ? [{ requestId: "r1", text: "Поздняя реплика" }] : []), done: () => {}, reopen: () => {},
    };
    const { events } = await go(await fromFiles(""), { maxTotalTokens: 1200 }, { ownerMessages: source });
    const i = events.findIndex((e) => e.type === "owner_message");
    expect(i).toBeGreaterThan(0);
    expect(events[i + 1]).toMatchObject({ type: "session_finished", status: "stopped", reason: "token_cap" });
  });

  describe("continuation", () => {
    const first = async (over: Partial<Limits>) => {
      const ds = await fromFiles("");
      const session = mkSession(2, over);
      const run = await runSession({ session, now: clock, drivers: dmap(ds) });
      return { session, prev: run.events };
    };
    const more = (n: number, make: () => Step) => Array.from({ length: n }, make);
    const again = (session: ReturnType<typeof mkSession>, prev: SessionEvent[], resume: { maxRounds: number; maxTotalTokens?: number | null }) =>
      runSession({
        session, now: clock,
        drivers: dmap([
          scripted(...more(4, () => tok(amend("Новая версия")))), scripted(...more(4, () => tok(object()))),
        ]),
        resume: { events: prev, ...resume },
      });

    it("new cap: stop by the sum of all segments", async () => {
      const { session, prev } = await first({ maxTotalTokens: 1200 });
      expect(finishOf(prev)).toMatchObject({ reason: "token_cap" });
      const run = await again(session, prev, { maxRounds: 10, maxTotalTokens: 2500 });
      expect(of(run.events, "session_resumed")[0]!.maxTotalTokens).toBe(2500);
      expect(of(run.events, "turn_started")).toHaveLength(2);
      expect(finishOf(run.events)).toMatchObject({ status: "stopped", reason: "token_cap" });
      expect(tokenUsage(run.state).total).toBe(2500);
    });

    it("null removes the cap", async () => {
      const { session, prev } = await first({ maxTotalTokens: 1200 });
      const run = await again(session, prev, { maxRounds: 3, maxTotalTokens: null });
      expect(of(run.events, "session_resumed")[0]!.maxTotalTokens).toBeNull();
      expect(finishOf(run.events).status).toBe("no_consensus");
    });

    it("without the field the previous cap applies, the event has no field", async () => {
      const { session, prev } = await first({ maxRounds: 1, maxTotalTokens: 2200 });
      expect(finishOf(prev).status).toBe("no_consensus");
      const run = await again(session, prev, { maxRounds: 3 });
      expect("maxTotalTokens" in of(run.events, "session_resumed")[0]!).toBe(false);
      expect(of(run.events, "turn_started")).toHaveLength(3);
      expect(finishOf(run.events)).toMatchObject({ status: "stopped", reason: "token_cap" });
    });
  });
});

describe("owner folder: reading files during the session", () => {
  const ws = [{ name: "proj/src/a.ts", text: "const a = 1; // ТЕКСТ-А" }, { name: "proj/b.md", text: "bbb" }];
  const wsStats = folderStats(ws);
  const json = (stance: string, solution: string | null, extra: Extra = {}) =>
    JSON.stringify({ stance, reasoning: "r", solution, answers: [], questions: [], files: [], ...extra });
  const want = JSON.stringify({ stance: "object", reasoning: "r", solution: null, answers: [], questions: [], files: ["proj/src/a.ts"] });
  const bad = "это не JSON";
  const boom = new ParticipantCallError("call_error", "сбой", true);
  type Reply = string | ParticipantCallError;
  const seq = (replies: Reply[], prompts: string[] = []): ParticipantDriver => {
    let i = 0;
    return driverOf(async (req) => {
      prompts.push(req.prompt);
      const r = replies[i++];
      if (r === undefined) throw new Error("no answer");
      if (r instanceof Error) throw r;
      return { text: r, usage: { inputTokens: 10, outputTokens: 1 } };
    });
  };
  const withWs = (n = 2, files: readonly { name: string; text: string }[] = ws) =>
    createSession(
      {
        topic: "Тема", framing: "", origin: "cli", limits: limits(), workspace: files,
        participants: Array.from({ length: n }, (_, i) => ({ name: `N${i + 1}`, providerId: "scripted", model: "m", role: null })),
      },
      { maxParticipants: 8, id: "s1", now: () => new Date("2026-01-01T00:00:00Z") },
    );
  const runWs = (p1: ParticipantDriver, p2: ParticipantDriver = scripted(agree()), workspace: typeof ws | undefined = ws) =>
    runSession({ session: withWs(), now: clock, drivers: { p1, p2 }, workspace });
  const first = (events: SessionEvent[]) => of(events, "turn_completed")[0]!;

  it("1. read before the answer, spend adds up", async () => {
    const prompts: string[] = [];
    const run = await runWs(seq([want, json("amend", "R")], prompts));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("# Запрошенные файлы");
    expect(prompts[1]).toContain("## Файл: proj/src/a.ts");
    expect(prompts[1]).toContain("ТЕКСТ-А");
    const t = first(run.events);
    expect(t.attempts).toBe(2);
    expect(t.filesRead).toEqual([{ name: "proj/src/a.ts", chars: ws[0]!.text.length, shown: ws[0]!.text.length }]);
    expect(of(run.events, "turn_failed")).toHaveLength(0);
    expect(t.usage).toEqual({ inputTokens: 20, outputTokens: 2 });
  });

  it("2. folder listing in the first request of each turn; none without a folder", async () => {
    const prompts: string[] = [];
    await runWs(seq([json("amend", "R"), json("agree", null)], prompts), seq([json("agree", null)], prompts));
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    for (const p of prompts) expect(p).toContain("# Папка владельца");
    const plain: string[] = [];
    await go([spy(scripted(amend("v1")), plain), scripted(agree())]);
    expect(plain[0]).not.toContain("# Папка владельца");
  });

  it("3. file request on the first turn without a decision version", async () => {
    const run = await runWs(seq([want, json("amend", "R")]));
    expect(first(run.events).turn).toBe(1);
    expect(first(run.events).filesRead).toHaveLength(1);
  });

  it("4. a repeated request does not deliver files a second time", async () => {
    const prompts: string[] = [];
    const run = await runWs(seq([want, json("amend", "R", { files: ["proj/b.md"] })], prompts));
    expect(prompts).toHaveLength(2);
    const t = first(run.events);
    expect(t.attempts).toBe(2);
    expect(t.filesRead).toHaveLength(1);
  });

  it("5. without a folder the files field is ignored", async () => {
    const run = await go([seq([json("amend", "R", { files: ["x"] })]), scripted(agree())]);
    const t = first(run.events);
    expect(t.attempts).toBe(1);
    expect(t).not.toHaveProperty("filesRead");
  });

  it("6. read, invalid answer, valid: the correction carries files", async () => {
    const prompts: string[] = [];
    const run = await runWs(seq([want, bad, json("amend", "R")], prompts));
    expect(first(run.events).attempts).toBe(3);
    expect(prompts[2]).toContain("# Запрошенные файлы");
    expect(prompts[2]).toContain("# Исправь предыдущий ответ");
  });

  it("7. read, call failure, invalid answer: three calls and dropout", async () => {
    const prompts: string[] = [];
    const run = await runWs(seq([want, boom, bad, json("amend", "R")], prompts));
    expect(prompts).toHaveLength(3);
    const dropped = of(run.events, "participant_dropped")[0]!;
    expect(dropped.participantId).toBe("p1");
    expect(dropped.reason.startsWith("Исчерпаны три вызова хода")).toBe(true);
  });

  it("8. read, call failure, valid answer: three attempts", async () => {
    const run = await runWs(seq([want, boom, json("amend", "R")]));
    expect(first(run.events).attempts).toBe(3);
    expect(of(run.events, "participant_dropped")).toHaveLength(0);
  });

  it("9. createSession: workspace in the session, snapshot limit", () => {
    expect(withWs().workspace).toEqual(wsStats);
    expect(mkSession(2)).not.toHaveProperty("workspace");
    expect(withWs(2, [])).not.toHaveProperty("workspace");
    const huge = [{ name: "d/a", text: "x".repeat(FOLDER_LIMITS.snapshotChars + 1) }];
    expect(() => withWs(2, huge)).toThrow(SessionInputError);
    expect(() => withWs(2, huge)).toThrow(new RegExp(`${FOLDER_LIMITS.snapshotChars + 1}.*${FOLDER_LIMITS.snapshotChars}`));
  });

  it("10. runSession: snapshot does not match the session — error before calling a participant", async () => {
    let calls = 0;
    const counter = driverOf(async () => { calls += 1; return { text: json("agree", null), usage: {} }; });
    await expect(runWs(counter, counter, [ws[0]!])).rejects.toThrow(SessionInputError);
    await expect(runSession({ session: withWs(), drivers: { p1: counter, p2: counter } })).rejects.toThrow(SessionInputError);
    await expect(runSession({ session: mkSession(2), drivers: { p1: counter, p2: counter }, workspace: ws })).rejects.toThrow(SessionInputError);
    expect(calls).toBe(0);
  });
});

describe("owner wait", () => {
  const ask = { questions: [{ to: "owner", text: "Какой бюджет?" }] };
  const ask2 = { questions: [{ to: "owner", text: "Первый?" }, { to: "owner", text: "Второй?" }] };
  const T0 = Date.UTC(2026, 0, 1);
  type Wait = NonNullable<Parameters<typeof createSession>[0]["ownerWait"]>;
  const mk = (n: number, ownerWait?: Wait, over: Partial<Limits> = {}) => createSession(
    {
      topic: "Тема", framing: "", origin: "cli", limits: limits({ maxRounds: 3, ...over }), ownerWait,
      participants: Array.from({ length: n }, (_, i) => ({ name: `N${i + 1}`, providerId: "scripted", model: "m", role: null })),
    },
    { maxParticipants: 8, id: "s1", now: () => new Date(T0) },
  );
  const msg = (n: number, questionId?: string, text = `Ответ ${n}`): OwnerRequest => ({
    requestId: `r${n}`, text, ...(questionId !== undefined ? { questionId } : {}),
  });
  const rel = (id: string, waitId: string): OwnerRequest => ({ requestId: id, releaseWaitId: waitId });
  // Stand: clocks stand still, sleep is instant and by step number runs the test action.
  function rig() {
    const pending: OwnerRequest[] = [];
    const log: string[] = [];
    const on: Record<number, () => void> = {};
    const ac = new AbortController();
    let t = T0;
    let steps = 0;
    const opts = {
      signal: ac.signal, now: () => new Date(t), waitPollMs: 1,
      ownerMessages: {
        take: (cl: boolean) => { log.push(cl ? "take(true)" : "take(false)"); return pending.splice(0); },
        done: (id: string) => { log.push(`done:${id}`); },
        reopen: () => { log.push("reopen"); },
      } as OwnerMessageSource,
      onEvent: (e: SessionEvent) => { log.push(e.type); },
      sleep: async () => { steps += 1; if (steps > 100) throw new Error("wait never ends"); on[steps]?.(); },
    } satisfies Partial<RunSessionOptions>;
    return { pending, log, on, ac, opts, jump: (ms: number) => { t += ms; }, at: (ms: number) => { t = T0 + ms; }, steps: () => steps };
  }
  const run = (session: ReturnType<typeof mk>, ds: ParticipantDriver[], extra: Partial<RunSessionOptions>) =>
    runSession({ session, drivers: Object.fromEntries(ds.map((d, i) => [`p${i + 1}`, d])), ...extra });
  const seqOk = (events: SessionEvent[]) => expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  const waits = (events: SessionEvent[]) => events.filter((e) => e.type.startsWith("owner_wait_"));
  const counted = (d: ParticipantDriver, c: { n: number }): ParticipantDriver => driverOf((req) => (c.n++, d.call(req)));
  const PAUSE: Wait = { pauseAfterRound: true };
  const BOTH: Wait = { pauseAfterRound: true, waitForOwner: true };
  const WFO: Wait = { waitForOwner: true };
  const idx = (events: SessionEvent[], f: (e: SessionEvent) => boolean) => events.findIndex(f);

  it("1. modes off: no wait events", async () => {
    const r = rig();
    const { events } = await run(mk(2), [scripted(amend("v1", ask), object(), object()), scripted(object(), object(), object())], r.opts);
    expect(waits(events)).toEqual([]);
    expect(r.steps()).toBe(0);
    expect(r.log.filter((l) => l === "take(true)")).toHaveLength(1);
    seqOk(events);
  });

  it("2. pause after a round: start, drivers silent, release, turn 3; event before done", async () => {
    const r = rig();
    const c = { n: 0 };
    r.on[2] = () => { expect(c.n).toBe(2); r.pending.push(rel("a", "w1")); };
    r.on[4] = () => r.pending.push(rel("b", "w2"));
    const ds = [scripted(amend("v1"), object(), object()), scripted(object(), object(), object())].map((d) => counted(d, c));
    const { events } = await run(mk(2, PAUSE), ds, r.opts);
    const w = waits(events);
    expect(w[0]).toMatchObject({
      type: "owner_wait_started", waitId: "w1", reasons: ["round_boundary"], questionIds: [], afterTurn: 2,
      deadline: new Date(T0 + 300_000).toISOString(),
    });
    const i = idx(events, (e) => e.type === "owner_wait_finished");
    expect(events[i]).toMatchObject({ waitId: "w1", reason: "continued", requestId: "a" });
    expect(events[i - 1]).toMatchObject({ type: "owner_wait_started" });
    expect(events[i + 1]).toMatchObject({ type: "turn_started", turn: 3 });
    expect(r.log.indexOf("owner_wait_finished")).toBeLessThan(r.log.indexOf("done:a"));
    expect(events.slice(idx(events, (e) => e.type === "owner_wait_started"), i).some((e) => e.type === "turn_started")).toBe(false);
    expect(r.steps()).toBeGreaterThanOrEqual(2);
    seqOk(events);
  });

  describe("3. no wait", () => {
    it("in the middle of a round and after the last round", async () => {
      const r = rig();
      r.on[1] = () => r.pending.push(rel("a", "w1"));
      const { events } = await run(mk(2, PAUSE, { maxRounds: 2 }), [scripted(amend("v1"), object()), scripted(object(), object())], r.opts);
      expect(of(events, "owner_wait_started").map((e) => e.afterTurn)).toEqual([2]);
      expect(finishOf(events).status).toBe("no_consensus");
      const r2 = rig();
      const out = await run(mk(2, BOTH, { maxRounds: 1 }), [scripted(amend("v1")), scripted(object(ask))], r2.opts);
      expect(waits(out.events)).toEqual([]);
      expect(finishOf(out.events).status).toBe("no_consensus");
    });

    it("on agreement", async () => {
      const r = rig();
      const { events } = await run(mk(2, BOTH), [scripted(amend("v1")), scripted(agree())], r.opts);
      expect(waits(events)).toEqual([]);
      expect(finishOf(events).status).toBe("consensus");
    });

    it("on failure (fewer than two active)", async () => {
      const r = rig();
      const dead = driverOf(async () => { throw new ParticipantCallError("call_error", "сбой", false); });
      const { events } = await run(mk(2, BOTH), [scripted(amend("v1")), dead], r.opts);
      expect(waits(events)).toEqual([]);
      expect(finishOf(events).status).toBe("failed");
    });

    it("on token cap", async () => {
      const r = rig();
      const tk = (s: Step): Step => ({ ...s, inputTokens: 300, outputTokens: 200 } as Step);
      const { events } = await run(mk(2, BOTH, { maxTotalTokens: 900 }), [scripted(tk(amend("v1"))), scripted(tk(object(ask)))], r.opts);
      expect(waits(events)).toEqual([]);
      expect(finishOf(events)).toMatchObject({ status: "stopped", reason: "token_cap" });
    });
  });

  it("4. regular message: the wait continues with the same deadline; release; next turn sees the message", async () => {
    const r = rig();
    const prompts: string[] = [];
    r.on[1] = () => r.pending.push(msg(1, undefined, "Учтите срок"));
    r.on[2] = () => { r.jump(5000); r.pending.push(rel("a", "w1")); };
    r.on[3] = () => r.pending.push(rel("b", "w2"));
    const { events } = await run(mk(2, PAUSE), [spy(scripted(amend("v1"), object(), object()), prompts), scripted(object(), object(), object())], r.opts);
    const om = of(events, "owner_message")[0]!;
    expect(om).toMatchObject({ text: "Учтите срок", afterTurn: 2 });
    expect(of(events, "owner_wait_updated")).toHaveLength(0);
    expect(of(events, "owner_wait_started")[0]!.deadline).toBe(new Date(T0 + 300_000).toISOString());
    expect(idx(events, (e) => e.type === "owner_message")).toBeLessThan(idx(events, (e) => e.type === "owner_wait_finished"));
    expect(of(events, "owner_wait_finished")[0]).toMatchObject({ reason: "continued" });
    expect(prompts[1]).toContain("Учтите срок");
    seqOk(events);
  });

  it("5. answer wait: the answer releases the wait, the next turn gets 'Owner answer:'", async () => {
    const r = rig();
    const prompts: string[] = [];
    r.on[1] = () => r.pending.push(msg(1, "q1", "Сто тысяч"));
    const { events } = await run(mk(2, WFO), [scripted(amend("v1", ask), agree()), spy(scripted(object(), agree()), prompts)], r.opts);
    const s = idx(events, (e) => e.type === "owner_wait_started");
    expect(events[s]).toMatchObject({ reasons: ["owner_question"], questionIds: ["q1"], afterTurn: 1 });
    expect(events[s - 1]).toMatchObject({ type: "turn_completed", turn: 1 });
    expect(events[s + 1]).toMatchObject({ type: "owner_message", answers: [{ questionId: "q1", text: "Сто тысяч" }] });
    expect(events[s + 2]).toMatchObject({ type: "question_closed", questionId: "q1", reason: "answered" });
    expect(events[s + 3]).toMatchObject({ type: "owner_wait_finished", reason: "answered" });
    expect(events[s + 4]).toMatchObject({ type: "turn_started", turn: 2 });
    expect(prompts[0]).toContain("Ответ владельца:");
    seqOk(events);
  });

  it("6. two questions, answer to one: updated with the remainder, then answered", async () => {
    const r = rig();
    r.on[1] = () => r.pending.push(msg(1, "q1"));
    r.on[2] = () => r.pending.push(msg(2, "q2"));
    const { events } = await run(mk(2, WFO), [scripted(amend("v1", ask2), agree()), scripted(agree(), agree())], r.opts);
    expect(of(events, "owner_wait_started")[0]).toMatchObject({ questionIds: ["q1", "q2"] });
    expect(of(events, "owner_wait_updated")).toMatchObject([{ waitId: "w1", reasons: ["owner_question"], questionIds: ["q2"] }]);
    expect(of(events, "owner_wait_finished")).toMatchObject([{ reason: "answered" }]);
    expect(r.steps()).toBe(2);
    expect(idx(events, (e) => e.type === "owner_wait_updated")).toBeLessThan(idx(events, (e) => e.type === "turn_started" && e.turn === 2));
    seqOk(events);
  });

  it("7. two reasons at one boundary: the answer keeps the pause, release removes it", async () => {
    const r = rig();
    r.on[1] = () => r.pending.push(msg(1, "q1"));
    r.on[2] = () => r.pending.push(rel("a", "w1"));
    r.on[3] = () => r.pending.push(rel("b", "w2"));
    r.on[4] = () => r.pending.push(rel("c", "w3"));
    const { events } = await run(mk(2, BOTH), [scripted(amend("v1"), object(), object()), scripted(amend("v2", ask), object(), object())], r.opts);
    const w = waits(events);
    expect(w[0]).toMatchObject({ type: "owner_wait_started", waitId: "w1", reasons: ["round_boundary", "owner_question"], questionIds: ["q1"] });
    expect(w[1]).toMatchObject({ type: "owner_wait_updated", reasons: ["round_boundary"], questionIds: [] });
    expect(w[2]).toMatchObject({ type: "owner_wait_finished", reason: "continued", requestId: "a" });
    expect(of(events, "owner_wait_started")[0]!.waitId).toBe("w1");
    seqOk(events);
  });

  it("8. deadline passed: unanswered before expired, turn recorded, prompt 'left without an answer'; default deadline", async () => {
    const r = rig();
    const prompts: string[] = [];
    r.on[1] = () => r.jump(300_000);
    const { events } = await run(mk(2, WFO), [scripted(amend("v1", ask), object()), spy(scripted(object(), object()), prompts)], r.opts);
    const s = idx(events, (e) => e.type === "owner_wait_started");
    expect(events[s]).toMatchObject({ deadline: new Date(T0 + 300_000).toISOString() });
    expect(events[s + 1]).toMatchObject({ type: "question_closed", questionId: "q1", reason: "unanswered" });
    expect(events[s + 2]).toMatchObject({ type: "owner_wait_finished", reason: "expired" });
    expect(events[s + 3]).toMatchObject({ type: "turn_started", turn: 2 });
    expect(prompts[0]).toContain("остался без ответа");
    seqOk(events);
  });

  it("8a. deadline from the setting", async () => {
    const r = rig();
    r.on[1] = () => r.pending.push(rel("a", "w1"));
    const { events } = await run(mk(2, { pauseAfterRound: true, timeoutSec: 60 }, { maxRounds: 2 }), [scripted(amend("v1"), object()), scripted(object(), object())], r.opts);
    expect(of(events, "owner_wait_started")[0]!.deadline).toBe(new Date(T0 + 60_000).toISOString());
  });

  it("9. answer at the deadline boundary: answered, not expired, no duplicates", async () => {
    const r = rig();
    r.on[1] = () => { r.jump(400_000); r.pending.push(msg(1, "q1")); };
    const { events } = await run(mk(2, WFO), [scripted(amend("v1", ask), object()), scripted(object(), object())], r.opts);
    expect(of(events, "owner_wait_finished")).toMatchObject([{ reason: "answered" }]);
    expect(of(events, "owner_message")).toHaveLength(1);
    expect(of(events, "question_closed").filter((e) => e.questionId === "q1")).toMatchObject([{ reason: "answered" }]);
    seqOk(events);
  });

  it("10. continuation without an answer: unanswered, then continued", async () => {
    const r = rig();
    r.on[1] = () => r.pending.push(rel("a", "w1"));
    const { events } = await run(mk(2, WFO), [scripted(amend("v1", ask), object()), scripted(object(), object())], r.opts);
    const f = idx(events, (e) => e.type === "owner_wait_finished");
    expect(events[f - 1]).toMatchObject({ type: "question_closed", questionId: "q1", reason: "unanswered" });
    expect(events[f]).toMatchObject({ reason: "continued", requestId: "a" });
    expect(of(events, "question_closed").filter((e) => e.questionId === "q1")).toHaveLength(1);
  });

  it("11. stop during a wait: message, stopped, session_finished; no turns; take(true)", async () => {
    const r = rig();
    r.on[2] = () => { r.pending.push(msg(1, undefined, "Стоп-реплика")); r.ac.abort(); };
    const { events } = await run(mk(2, PAUSE), [scripted(amend("v1")), scripted(object())], r.opts);
    const s = idx(events, (e) => e.type === "owner_wait_started");
    expect(events.slice(s + 1).map((e) => e.type)).toEqual(["owner_message", "owner_wait_finished", "session_finished"]);
    expect(events[s + 2]).toMatchObject({ reason: "stopped" });
    expect(finishOf(events).status).toBe("stopped");
    expect(r.log).toContain("take(true)");
    seqOk(events);
  });

  it("12. stop and release at the same time: one finish, stopped, no turns", async () => {
    const r = rig();
    r.on[1] = () => { r.pending.push(rel("a", "w1")); r.ac.abort(); };
    const { events } = await run(mk(2, PAUSE), [scripted(amend("v1")), scripted(object())], r.opts);
    expect(of(events, "owner_wait_finished")).toHaveLength(1);
    expect(finishOf(events).status).toBe("stopped");
    expect(of(events, "turn_started")).toHaveLength(2);
  });

  it("13/14. two releases, a late one for w1 during w2, requestId repeat; ids w1, w2", async () => {
    const r = rig();
    r.on[1] = () => r.pending.push(rel("a", "w1"), rel("b", "w1"));
    r.on[2] = () => r.pending.push(rel("late", "w1"));
    r.on[3] = () => r.pending.push(rel("a", "w2"));
    r.on[4] = () => r.pending.push(rel("c", "w2"));
    const { events } = await run(mk(2, PAUSE), [scripted(amend("v1"), object(), object()), scripted(object(), object(), object())], r.opts);
    expect(of(events, "owner_wait_started").map((e) => e.waitId)).toEqual(["w1", "w2"]);
    expect(of(events, "owner_wait_finished")).toMatchObject([
      { waitId: "w1", reason: "continued", requestId: "a" }, { waitId: "w2", reason: "continued", requestId: "c" },
    ]);
    for (const id of ["a", "b", "late", "c"]) expect(r.log.filter((l) => l === `done:${id}`)).toHaveLength(id === "a" ? 2 : 1);
    seqOk(events);
  });

  it("15. only a pause after a round: the question is not held, closed before the asker's turn", async () => {
    const r = rig();
    r.on[1] = () => r.pending.push(rel("a", "w1"));
    const { events } = await run(mk(2, PAUSE, { maxRounds: 2 }), [scripted(amend("v1"), object()), scripted(object(), object(ask))], r.opts);
    const ws = of(events, "owner_wait_started");
    expect(ws.every((e) => e.questionIds.length === 0)).toBe(true);
    const ev = events.filter((e) => e.type === "question_closed");
    expect(ev).toEqual([]);
    const { events: e2 } = await run(mk(2, PAUSE, { maxRounds: 3 }), [scripted(amend("v1", ask), object(), object()), scripted(object(), object(), object())], (() => {
      const q = rig(); q.on[1] = () => q.pending.push(rel("a", "w1")); q.on[2] = () => q.pending.push(rel("b", "w2")); return q.opts;
    })());
    expect(of(e2, "owner_wait_started")[0]!.questionIds).toEqual([]);
    const closed = idx(e2, (x) => x.type === "question_closed" && x.reason === "unanswered");
    expect(e2[closed + 1]).toMatchObject({ type: "turn_started", turn: 3 });
  });

  it("16. wait longer than the turn timeout: no turn_failed, attempts and spend unchanged", async () => {
    const r = rig();
    r.on[1] = () => { r.jump(100_000); r.pending.push(rel("a", "w1")); };
    const { events } = await run(mk(2, { pauseAfterRound: true, timeoutSec: 1000 }, { maxRounds: 2, turnTimeoutSec: 30 }), [scripted(amend("v1"), object()), scripted(object(), object())], r.opts);
    expect(of(events, "turn_failed")).toEqual([]);
    expect(of(events, "turn_completed").every((e) => e.attempts === 1)).toBe(true);
    expect(of(events, "owner_wait_finished")[0]).toMatchObject({ reason: "continued" });
  });

  describe("17. continuation with an interrupted wait", () => {
    const prevOf = async () => {
      const session = mk(2, WFO);
      const r = rig();
      r.on[1] = () => r.pending.push(rel("a", "w1"));
      const { events } = await run(session, [scripted(amend("v1", ask), object()), scripted(object(), object())], r.opts);
      return { session, prev: events.slice(0, idx(events, (e) => e.type === "owner_wait_started") + 1) };
    };
    const resume = (session: ReturnType<typeof mk>, prev: SessionEvent[], r: ReturnType<typeof rig>) =>
      runSession({
        session, drivers: { p1: scripted(object(), object()), p2: scripted(object(), object()) },
        resume: { events: prev, maxRounds: 3 }, ...r.opts,
      });

    it("before the deadline: same waitId and deadline, no new started; release; turn", async () => {
      const { session, prev } = await prevOf();
      const r = rig();
      r.jump(10_000);
      r.on[1] = () => r.pending.push(rel("z", "w1"));
      const run2 = await resume(session, prev, r);
      expect(of(run2.events, "owner_wait_started")).toEqual([]);
      const f = idx(run2.events, (e) => e.type === "owner_wait_finished");
      expect(run2.events[f]).toMatchObject({ waitId: "w1", reason: "continued", requestId: "z" });
      expect(run2.events[f - 1]).toMatchObject({ type: "question_closed", reason: "unanswered" });
      expect(run2.events[f + 1]).toMatchObject({ type: "turn_started" });
      expect(run2.events[0]).toMatchObject({ type: "session_resumed", seq: prev.length + 1 });
      expect(run2.events.slice(0, f).some((e) => e.type === "turn_started")).toBe(false);
    });

    it("with a participant replacement: same wait deadline, drivers silent until release", async () => {
      const { session, prev } = await prevOf();
      const waitStart = of(prev, "owner_wait_started")[0]!;
      const r = rig();
      r.jump(10_000);
      const calls: string[] = [];
      let deadline: string | undefined;
      r.on[1] = () => { expect(calls).toEqual([]); r.pending.push(rel("z", "w1")); };
      const watch = (id: string, d: ParticipantDriver) => driverOf((req) => (calls.push(id), d.call(req)));
      const run2 = await runSession({
        session, ...r.opts,
        onEvent: (e, st) => { r.opts.onEvent(e); if (e.type === "session_resumed") deadline = st.waiting?.deadline; },
        drivers: { p1: watch("p1", scripted(object(), object())), p2: watch("p2", scripted()), p3: watch("p3", scripted(object(), object())) },
        resume: {
          events: prev, maxRounds: 3,
          replacements: [{ oldParticipantId: "p2", participant: { id: "p3", name: "N3", providerId: "scripted", model: "m", role: null } }],
        },
      });
      expect(deadline).toBe(waitStart.deadline);
      expect(of(run2.events, "owner_wait_started")).toEqual([]);
      expect(calls).not.toContain("p2");
      expect(calls).toContain("p3");
      expect(of(run2.events, "owner_wait_finished")[0]).toMatchObject({ waitId: "w1", reason: "continued" });
    });

    it("after the deadline: unanswered and expired before the first turn", async () => {
      const { session, prev } = await prevOf();
      const r = rig();
      r.jump(400_000);
      const run2 = await resume(session, prev, r);
      expect(run2.events.slice(0, 4).map((e) => e.type)).toEqual(["session_resumed", "question_closed", "owner_wait_finished", "turn_started"]);
      expect(of(run2.events, "owner_wait_finished")[0]).toMatchObject({ waitId: "w1", reason: "expired" });
      expect(r.steps()).toBe(0);
    });
  });
});

describe("runSession: continuation with a participant replacement", () => {
  const dmap = (ds: ParticipantDriver[]) => Object.fromEntries(ds.map((d, i) => [`p${i + 1}`, d]));
  const rep = (oldId: string, id: string, role: string | null = null) => ({
    oldParticipantId: oldId, participant: { id, name: `N${id}`, providerId: "scripted", model: "m", role },
  });
  const fatal = () => scripted({ error: "сбой", retryable: false });
  const tk = (s: Step): Step => ({ ...s, inputTokens: 300, outputTokens: 200 } as Step);
  /** p1 accepts v1, p2 drops out on the second turn: failed with 'fewer than two'. */
  async function dropped(first: Step[] = [amend("v1")]) {
    const session = mkSession(2);
    const run = await runSession({ session, now: clock, drivers: dmap([scripted(...first), fatal()]) });
    return { session, prev: run.events };
  }
  const resumeWith = (session: ReturnType<typeof mkSession>, prev: SessionEvent[], ds: ParticipantDriver[], replacements: ReturnType<typeof rep>[], extra: Partial<RunSessionOptions> & { maxTotalTokens?: number } = {}) => {
    const { maxTotalTokens, ...rest } = extra;
    return runSession({
      session, now: clock, drivers: dmap(ds), ...rest,
      resume: { events: prev, maxRounds: 5, replacements, ...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}) },
    });
  };
  const spyAll = (log: string[], id: string, d: ParticipantDriver) => driverOf((req) => (log.push(id), d.call(req)));

  it("a. reasonCode: 'fewer than two active' during a turn and at continuation start; token_cap and stopped have none", async () => {
    const { session, prev } = await dropped();
    expect(finishOf(prev)).toMatchObject({ status: "failed", reason: "Активных участников осталось меньше двух.", reasonCode: INSUFFICIENT_ACTIVE_REASON_CODE });
    const again = await runSession({ session, now: clock, drivers: dmap([scripted(), scripted()]), resume: { events: prev, maxRounds: 5 } });
    expect(finishOf(again.events)).toMatchObject({ status: "failed", reasonCode: INSUFFICIENT_ACTIVE_REASON_CODE });
    const capped = await go([scripted(tk(amend("v1"))), scripted(tk(object()))], { maxTotalTokens: 900 });
    expect(finishOf(capped.events)).toMatchObject({ status: "stopped", reason: "token_cap" });
    expect(finishOf(capped.events)).not.toHaveProperty("reasonCode");
    const ac = new AbortController();
    const stopped = await go([driverOf(async () => (ac.abort(), new Promise<TurnResult>(() => {}))), scripted()], {}, { signal: ac.signal });
    expect(finishOf(stopped.events)).toMatchObject({ status: "stopped" });
    expect(finishOf(stopped.events)).not.toHaveProperty("reasonCode");
  });

  it("b. replacing dropped p2 with p3: one session_resumed, p2 silent, p1 agrees again, agreement on the same version", async () => {
    const { session, prev } = await dropped();
    const log: string[] = [];
    const run = await resumeWith(session, prev, [
      spyAll(log, "p1", scripted(agree())), spyAll(log, "p2", scripted()), spyAll(log, "p3", scripted(agree())),
    ], [rep("p2", "p3")]);
    const resumed = of(run.events, "session_resumed");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.replacements).toEqual([rep("p2", "p3")]);
    expect(log).toEqual(["p1", "p3"]);
    expect(of(run.events, "turn_started").map((e) => [e.turn, e.round, e.participantId])).toEqual([[3, 2, "p1"], [4, 2, "p3"]]);
    expect(types(run.events)).not.toContain("participant_dropped");
    expect(types(run.events)).not.toContain("question_closed");
    expect(finishOf(run.events)).toMatchObject({ status: "consensus", version: 1 });
    expect(run.state.versions).toHaveLength(1);
    expect(run.state).toEqual(foldEvents([...prev, ...run.events]));
  });

  it("b2. without replacements the session_resumed event has no replacements key", async () => {
    const { session, prev } = await first2();
    const run = await runSession({ session, now: clock, drivers: dmap([scripted(agree()), scripted(agree())]), resume: { events: prev, maxRounds: 5 } });
    expect(run.events[0]).not.toHaveProperty("replacements");
    const empty = await runSession({ session, now: clock, drivers: dmap([scripted(agree()), scripted(agree())]), resume: { events: prev, maxRounds: 5, replacements: [] } });
    expect(empty.events[0]).not.toHaveProperty("replacements");
    async function first2() {
      const s = mkSession(2, { maxRounds: 1 });
      const r = await runSession({ session: s, now: clock, drivers: dmap([scripted(amend("v1")), scripted(object())]) });
      return { session: s, prev: r.events };
    }
  });

  it("c. interrupted turn of active p2: p3 takes the slot in the same round with number +1, p2's reasoning and the replacement note in the request", async () => {
    const ac = new AbortController();
    const inner = scripted(object({ reasoning: "РАССУЖДЕНИЕ-П2" }));
    let n = 0;
    const p2 = driverOf((req) => (n++ < 1 ? inner.call(req) : (ac.abort(), new Promise<TurnResult>(() => {}))));
    const session = mkSession(2);
    const prev = (await runSession({ session, now: clock, signal: ac.signal, drivers: dmap([scripted(amend("v1"), amend("v2")), p2]) })).events;
    expect(finishOf(prev).status).toBe("stopped");
    const prompts: string[] = [];
    const log: string[] = [];
    const run = await resumeWith(session, prev, [
      spyAll(log, "p1", scripted(agree())), spyAll(log, "p2", scripted()), spy(spyAll(log, "p3", scripted(agree())), prompts),
    ], [rep("p2", "p3")]);
    expect(log).not.toContain("p2");
    expect(of(run.events, "turn_started")[0]).toMatchObject({ participantId: "p3", turn: 5, round: 2 });
    expect(of(run.events, "turn_started").some((e) => e.turn === 4)).toBe(false);
    expect(prompts[0]).toContain("РАССУЖДЕНИЕ-П2");
    expect(prompts[0]).toContain("заменён участником p3");
  });

  it("d. open question to p2: after the replacement nobody asks it, status replaced, no question_closed", async () => {
    const ac = new AbortController();
    const session = mkSession(2);
    const prev = (await runSession({
      session, now: clock, signal: ac.signal,
      drivers: dmap([scripted(amend("v1", { questions: [{ to: "p2", text: "ВОПРОС-К-П2?" }] })), driverOf(() => (ac.abort(), new Promise<TurnResult>(() => {})))]),
    })).events;
    const prompts: string[] = [];
    const run = await resumeWith(session, prev, [scripted(agree()), scripted(), spy(scripted(agree()), prompts)], [rep("p2", "p3")]);
    expect(run.state.questions.find((q) => q.id === "q1")).toMatchObject({ to: "p2", status: "replaced" });
    expect(of(run.events, "question_closed")).toEqual([]);
    expect(prompts[0]).not.toContain("- q1 от p1:");
  });

  it("e. spend is not reset: a cap just above the spent amount triggers after the first new turn", async () => {
    const { session, prev } = await dropped([tk(amend("v1"))]);
    const run = await resumeWith(session, prev, [scripted(tk(agree())), scripted(), scripted(tk(agree()))], [rep("p2", "p3")], { maxTotalTokens: 600 });
    expect(finishOf(run.events)).toMatchObject({ status: "stopped", reason: "token_cap" });
    expect(of(run.events, "turn_started")).toHaveLength(1);
    expect(tokenUsage(run.state).total).toBe(1000);
  });

  it("i. the owner question of the replaced author is closed by the replacer's turn, agreement is reachable", async () => {
    const ac = new AbortController();
    const session = mkSession(2);
    const p1 = scripted(amend("v1"));
    let n = 0;
    const p1s = driverOf((req) => (n++ < 1 ? p1.call(req) : (ac.abort(), new Promise<TurnResult>(() => {}))));
    const p2 = scripted(agree({ questions: [{ to: "owner", text: "Бюджет?" }] }));
    const prev = (await runSession({ session, now: clock, signal: ac.signal, drivers: dmap([p1s, p2]) })).events;
    expect(of(prev, "question_closed")).toEqual([]);
    const run = await resumeWith(session, prev, [scripted(agree(), agree()), scripted(), scripted(agree())], [rep("p2", "p3")]);
    const closed = run.events.findIndex((e) => e.type === "question_closed");
    expect(run.events[closed]).toMatchObject({ questionId: "q1", reason: "unanswered" });
    expect(run.events[closed + 1]).toMatchObject({ type: "turn_started", participantId: "p3" });
    expect(finishOf(run.events).status).toBe("consensus");
    // closing the owner question resets agreement, as without a replacement: p1 agrees once more, no extra rounds
    expect(of(run.events, "turn_started").map((e) => e.participantId)).toEqual(["p1", "p3", "p1"]);
  });

  it("h. no driver for the new participant: SessionInputError and no events", async () => {
    const { session, prev } = await dropped();
    let seen = 0;
    await expect(resumeWith(session, prev, [scripted(), scripted()], [rep("p2", "p3")], { onEvent: () => { seen++; } })).rejects.toThrow(SessionInputError);
    await expect(resumeWith(session, prev, [scripted(), scripted()], [rep("p2", "p3")])).rejects.toThrow("Нет драйвера для участника p3.");
    expect(seen).toBe(0);
  });
});

describe("runSession: spend of attempts with a file request", () => {
  const WS = [{ name: "proj/src/a.ts", text: "const a = 1;" }];
  const askFiles = JSON.stringify({ stance: "object", reasoning: "r", solution: null, answers: [], questions: [], files: ["proj/src/a.ts"] });
  // answers in order: ready text with spend or a call error
  const replies = (...rs: (TurnResult | ParticipantCallError)[]): ParticipantDriver => {
    let i = 0;
    return driverOf(async () => {
      const r = rs[i++];
      if (r === undefined) throw new Error("no answer");
      if (r instanceof Error) throw r;
      return r;
    });
  };
  const wsSession = (n: number, over: Partial<Limits> = {}) =>
    createSession(
      {
        topic: "Тема", framing: "", origin: "cli", limits: limits(over), workspace: WS,
        participants: Array.from({ length: n }, (_, i) => ({ name: `N${i + 1}`, providerId: "scripted", model: "m", role: null })),
      },
      { maxParticipants: 8, id: "s1", now: () => new Date("2026-01-01T00:00:00Z") },
    );

  it("Total session spend: file request and dropout give the token_cap", async () => {
    const p1 = replies(
      { text: askFiles, usage: { inputTokens: 600, outputTokens: 400 } },
      new ParticipantCallError("timeout", "таймаут"),
      new ParticipantCallError("timeout", "таймаут"),
    );
    const run = await runSession({
      session: wsSession(3, { maxTotalTokens: 900, maxRounds: 1 }), now: clock,
      drivers: { p1, p2: scripted(amend("v1")), p3: scripted(object()) }, workspace: WS,
    });
    const { events, state } = run;
    expect(of(events, "participant_dropped").map((e) => e.participantId)).toEqual(["p1"]);
    expect(of(events, "turn_files_served")).toEqual([
      expect.objectContaining({ participantId: "p1", turn: 1, round: 1, attempt: 1, usage: expect.objectContaining({ inputTokens: 600, outputTokens: 400 }) }),
    ]);
    expect(tokenUsage(state).total).toBe(1000);
    expect(finishOf(events)).toMatchObject({ status: "stopped", reason: TOKEN_CAP_REASON });
    expect(of(events, "turn_started").map((e) => e.participantId)).toEqual(["p1"]);
  });
});
