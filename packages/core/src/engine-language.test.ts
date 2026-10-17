import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, runSession, SessionInputError } from "./engine.ts";
import type { RunSessionOptions } from "./engine.ts";
import { setProcessLanguage, getProcessLanguage } from "./i18n/process-language.ts";
import { createScriptedDriver } from "./participants/scripted.ts";
import type { Scenario } from "./participants/scripted.ts";
import type { ParticipantDriver, TurnRequest, TurnResult } from "./participants/driver.ts";
import { INSUFFICIENT_ACTIVE_REASON_CODE } from "./protocol/schema.ts";
import type { Limits, SessionEvent } from "./protocol/schema.ts";

type Step = Scenario["steps"][number];

const amend = (text: string): Step => ({ response: { stance: "amend", reasoning: "r", solution: text, answers: [], questions: [] } });
const agree = (): Step => ({ response: { stance: "agree", reasoning: "r", solution: null, answers: [], questions: [] } });
const scripted = (...steps: Step[]) => createScriptedDriver({ steps }, { COUNCIL_DEV: "1" });
const driverOf = (fn: (req: TurnRequest) => Promise<TurnResult>): ParticipantDriver => ({ call: fn });
const limits = (over: Partial<Limits> = {}): Limits => ({ maxRounds: 5, turnTimeoutSec: 30, contextChars: 20000, ...over });
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `N${i + 1}`, providerId: "scripted", model: "m", role: null }));
const input = (n: number, topic = "T", drafts?: { synthesizerId?: string }) => ({
  topic, framing: "", origin: "cli" as const, limits: limits(), participants: people(n), ...(drafts ? { drafts } : {}),
});
const opt = { maxParticipants: 8, id: "s1", now: () => new Date("2026-01-01T00:00:00Z") };
const messageOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(SessionInputError); return (e as Error).message; }
  throw new Error("no throw");
};
const go = (drivers: ParticipantDriver[], over: Partial<Limits> = {}, extra: Partial<RunSessionOptions> = {}) =>
  runSession({
    session: createSession({ ...input(drivers.length), limits: limits(over) }, opt),
    drivers: Object.fromEntries(drivers.map((d, i) => [`p${i + 1}`, d])), ...extra,
  });
const of = <T extends SessionEvent["type"]>(events: SessionEvent[], type: T) =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);

describe("Core messages in the selected language: engine", () => {
  const before = getProcessLanguage();
  afterEach(() => { setProcessLanguage(before); vi.useRealTimers(); });

  it("session input refusals: en and ru, same values", () => {
    setProcessLanguage("en");
    expect(messageOf(() => createSession(input(2, "  "), opt))).toBe("Topic is required.");
    expect(messageOf(() => createSession(input(1), opt))).toBe("At least 2 participants are required, got 1.");
    expect(messageOf(() => createSession(input(3, "T", { synthesizerId: "p7" }), opt))).toBe("Synthesizer p7 is not in the lineup: allowed are p1–p3.");
    setProcessLanguage("ru");
    expect(messageOf(() => createSession(input(2, "  "), opt))).toBe("Тема обязательна.");
    expect(messageOf(() => createSession(input(1), opt))).toBe("Нужно не меньше 2 участников, получено 1.");
    expect(messageOf(() => createSession(input(3, "T", { synthesizerId: "p7" }), opt))).toBe("Синтезатор p7 не входит в состав: допустимы p1–p3.");
  });

  it("refusal without a driver in the process language", async () => {
    setProcessLanguage("en");
    const session = createSession(input(2), opt);
    await expect(runSession({ session, drivers: { p1: scripted(agree()) } })).rejects.toThrow("No driver for participant p2.");
  });

  it("turn timeout is written in the process language, kind stays timeout", async () => {
    setProcessLanguage("en");
    vi.useFakeTimers();
    const hang = driverOf((req) => new Promise<TurnResult>((_, reject) => {
      req.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const p = go([scripted(amend("v1")), hang], { turnTimeoutSec: 1 });
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1000);
    const { events } = await p;
    expect(of(events, "turn_failed")[0]).toMatchObject({ kind: "timeout", message: "Turn timeout: 1 s." });
  });

  it("dropout reason and finish reason in en, codes unchanged", async () => {
    setProcessLanguage("en");
    const { events } = await go([scripted(amend("v1")), scripted({ error: "fatal", retryable: false })]);
    expect(of(events, "participant_dropped")[0]!.reason).toBe("Non-retryable error: fatal");
    expect(of(events, "session_finished")[0]).toMatchObject({
      status: "failed", reason: "Fewer than two active participants remain.", reasonCode: INSUFFICIENT_ACTIVE_REASON_CODE,
    });
  });

  it("call exhaustion: English reason", async () => {
    setProcessLanguage("en");
    const { events } = await go([scripted(amend("v1")), scripted({ error: "a" }, { error: "b" })]);
    expect(of(events, "participant_dropped")[0]!.reason).toBe("Retry failed: b");
  });

  it("with ru the dropout reason is unchanged", async () => {
    setProcessLanguage("ru");
    const { events } = await go([scripted(amend("v1")), scripted({ error: "fatal", retryable: false })]);
    expect(of(events, "participant_dropped")[0]!.reason).toBe("Неповторяемая ошибка: fatal");
    expect(of(events, "session_finished")[0]!.reason).toBe("Активных участников осталось меньше двух.");
  });
});
