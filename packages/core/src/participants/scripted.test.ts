import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createScriptedDriver, readScenario, ScenarioSchema, ScriptedUnavailableError } from "./scripted.ts";
import type { Scenario } from "./scripted.ts";
import { ParticipantCallError } from "./driver.ts";
import type { TurnRequest } from "./driver.ts";
import { createSession, runSession } from "../engine.ts";

const DEV = { COUNCIL_DEV: "1" };

function mk(controller = new AbortController()) {
  const chunks: string[] = [];
  const request = {
    participant: { id: "p1" },
    prompt: "x",
    timeoutSec: 5,
    signal: controller.signal,
    onChunk: (t: string) => { chunks.push(t); },
  } as unknown as TurnRequest;
  return { request, chunks, controller };
}

const driver = (steps: Scenario["steps"]) => createScriptedDriver({ steps }, DEV);
const fail = async (p: Promise<unknown>): Promise<unknown> => {
  try { await p; } catch (e) { return e; }
  throw new Error("error expected");
};

describe("scripted", () => {
  it("returns answers in order", async () => {
    const d = driver([{ response: { stance: "amend" } }, { response: { stance: "agree" } }]);
    expect(JSON.parse((await d.call(mk().request)).text).stance).toBe("amend");
    expect(JSON.parse((await d.call(mk().request)).text).stance).toBe("agree");
  });

  it("two drivers give identical texts", async () => {
    const steps: Scenario["steps"] = [{ response: { a: 1 } }, { raw: "r" }];
    const a = driver(steps), b = driver(steps);
    for (let i = 0; i < 2; i++) {
      expect((await a.call(mk().request)).text).toBe((await b.call(mk().request)).text);
    }
  });

  it("timeout consumes a step, the next call goes on", async () => {
    const d = driver([{ raw: "1" }, { timeout: true }, { raw: "3" }]);
    expect((await d.call(mk().request)).text).toBe("1");
    const e = await fail(d.call(mk().request));
    expect(e).toBeInstanceOf(ParticipantCallError);
    expect(e).toMatchObject({ kind: "timeout", retryable: true });
    expect((await d.call(mk().request)).text).toBe("3");
  });

  it("error: retryable is true by default, can be false", async () => {
    const d = driver([{ error: "бум" }, { error: "бам", retryable: false }]);
    expect(await fail(d.call(mk().request))).toMatchObject({ kind: "call_error", message: "бум", retryable: true });
    expect(await fail(d.call(mk().request))).toMatchObject({ kind: "call_error", message: "бам", retryable: false });
  });

  it("raw is returned as is", async () => {
    const d = driver([{ raw: "не json {" }]);
    expect((await d.call(mk().request)).text).toBe("не json {");
  });

  it("script exhaustion", async () => {
    const d = driver([{ raw: "1" }, { raw: "2" }]);
    await d.call(mk().request);
    await d.call(mk().request);
    const e = await fail(d.call(mk().request));
    expect(e).toBeInstanceOf(ParticipantCallError);
    expect((e as ParticipantCallError).message).toContain("Сценарий исчерпан");
    expect((e as ParticipantCallError).retryable).toBe(false);
  });

  it("without COUNCIL_DEV=1 no driver is created", () => {
    for (const env of [{}, { COUNCIL_DEV: "0" }]) {
      let err: unknown;
      try { createScriptedDriver({ steps: [] }, env); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ScriptedUnavailableError);
      expect((err as Error).message).toContain("COUNCIL_DEV");
    }
    expect(() => createScriptedDriver({ steps: [] }, DEV)).not.toThrow();
  });

  it("chunks are joined into text", async () => {
    const long = "я".repeat(95);
    const { request, chunks } = mk();
    const r = await driver([{ raw: long }]).call(request);
    expect(chunks.join("")).toBe(r.text);
    expect(chunks.length).toBe(3);
    const empty = mk();
    await driver([{ raw: "" }]).call(empty.request);
    expect(empty.chunks).toEqual([]);
  });

  it("spend is zero, no tokens", async () => {
    const r = await driver([{ raw: "x" }]).call(mk().request);
    expect(r.usage).toEqual({ costUsd: 0 });
    expect("inputTokens" in r.usage).toBe(false);
  });

  it("abort during delayMs", async () => {
    const m = mk();
    const started = Date.now();
    const p = driver([{ raw: "x", delayMs: 10000 }]).call(m.request);
    setTimeout(() => m.controller.abort(), 5);
    const e = await fail(p);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(e).not.toBeInstanceOf(ParticipantCallError);
  });

  it("an already aborted signal rejects the call", async () => {
    const m = mk();
    m.controller.abort();
    await fail(driver([{ raw: "x" }]).call(m.request));
  });

  it("delayMs without abort completes", async () => {
    expect((await driver([{ raw: "ok", delayMs: 20 }]).call(mk().request)).text).toBe("ok");
  });

  it("schema rejects invalid steps", () => {
    const bad = (step: unknown) => ScenarioSchema.safeParse({ steps: [step] }).success;
    expect(bad({ response: {}, error: "x" })).toBe(false);
    expect(bad({ raw: "x", extra: 1 })).toBe(false);
    expect(bad({ raw: "x", delayMs: -1 })).toBe(false);
    expect(bad({})).toBe(false);
    expect(bad({ raw: "x", delayMs: 0 })).toBe(true);
  });

  describe("expectPrompt", () => {
    const withPrompt = (prompt: string) => ({ ...mk().request, prompt }) as TurnRequest;

    it("text is in the request: regular result", async () => {
      const d = driver([{ raw: "ok", expectPrompt: "# Реплики" }]);
      expect((await d.call(withPrompt("a\n# Реплики владельца\nb"))).text).toBe("ok");
    });

    it("no text: non-retryable error, step consumed", async () => {
      const d = driver([{ raw: "1", expectPrompt: "# Реплики" }, { raw: "2" }]);
      const e = await fail(d.call(withPrompt("пусто")));
      expect(e).toBeInstanceOf(ParticipantCallError);
      expect(e).toMatchObject({ kind: "call_error", retryable: false });
      expect((e as Error).message).toContain("# Реплики");
      expect((await d.call(withPrompt("пусто"))).text).toBe("2");
    });

    it("missing-text error outranks the outcome of any step kind", async () => {
      const steps: Scenario["steps"] = [
        { response: { a: 1 }, expectPrompt: "Z" },
        { raw: "r", expectPrompt: "Z" },
        { error: "своя", expectPrompt: "Z" },
        { timeout: true, expectPrompt: "Z" },
      ];
      const d = driver(steps);
      for (let i = 0; i < steps.length; i++) {
        const e = await fail(d.call(withPrompt("нет")));
        expect(e).toMatchObject({ kind: "call_error", retryable: false });
        expect((e as Error).message).toContain("«Z»");
      }
    });

    it("the check runs after delayMs", async () => {
      const started = Date.now();
      const e = await fail(driver([{ raw: "x", delayMs: 60, expectPrompt: "Z" }]).call(withPrompt("нет")));
      expect(e).toMatchObject({ kind: "call_error", retryable: false });
      expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    });

    it("schema", () => {
      const ok = (step: unknown) => ScenarioSchema.safeParse({ steps: [step] }).success;
      expect(ok({ raw: "x", expectPrompt: "" })).toBe(false);
      expect(ok({ raw: "x", expectPrompt: 5 })).toBe(false);
      expect(ok({ raw: "x", expectPrompt: "a", extra: 1 })).toBe(false);
      expect(ok({ raw: "x", expectPrompt: "a" })).toBe(true);
    });

    it("owner-message scripts are readable", async () => {
      for (const n of ["p1", "p2"]) {
        const s = await readScenario(fileURLToPath(new URL(`../../scenarios/owner-message/${n}.json`, import.meta.url)));
        expect(s.steps).toHaveLength(2);
      }
    });
  });

  it("startStep skips steps; equal to the number of steps — script exhausted", async () => {
    const steps = [{ raw: "a" }, { raw: "b" }];
    const req = () => ({ participant: {} as never, prompt: "", language: "ru" as const, timeoutSec: 1, signal: new AbortController().signal, onChunk: () => {} });
    const d = createScriptedDriver({ steps }, { COUNCIL_DEV: "1" }, 1);
    expect((await d.call(req())).text).toBe("b");
    await expect(d.call(req())).rejects.toThrow("Сценарий исчерпан: в сценарии шагов 2, это вызов №3.");
    const e = createScriptedDriver({ steps }, { COUNCIL_DEV: "1" }, 2);
    await expect(e.call(req())).rejects.toThrow("Сценарий исчерпан");
  });

  it("readScenario", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scripted-"));
    try {
      const ok = join(dir, "ok.json");
      const notJson = join(dir, "bad.json");
      const badSchema = join(dir, "schema.json");
      const missing = join(dir, "нет.json");
      await writeFile(ok, JSON.stringify({ steps: [{ raw: "a" }] }));
      await writeFile(notJson, "{ не json");
      await writeFile(badSchema, JSON.stringify({ steps: [{ nope: 1 }] }));
      expect(await readScenario(ok)).toEqual({ steps: [{ raw: "a" }] });
      for (const p of [missing, notJson, badSchema]) {
        const e = await fail(readScenario(p));
        expect(e).toBeInstanceOf(Error);
        expect((e as Error).message).toContain(p);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("scripted: step tokens", () => {
  it("response with tokens: the call's usage contains them", async () => {
    const d = driver([{ response: { a: 1 }, inputTokens: 300, outputTokens: 200 }]);
    expect((await d.call(mk().request)).usage).toEqual({ inputTokens: 300, outputTokens: 200, costUsd: 0 });
  });

  it("step without tokens: previous usage", async () => {
    const d = driver([{ response: { a: 1 } }, { raw: "r" }]);
    expect((await d.call(mk().request)).usage).toEqual({ costUsd: 0 });
    expect((await d.call(mk().request)).usage).toEqual({ costUsd: 0 });
  });

  it("raw with tokens and only inputTokens", async () => {
    const d = driver([{ raw: "r", inputTokens: 5, outputTokens: 0 }, { response: {}, inputTokens: 7 }]);
    expect((await d.call(mk().request)).usage).toEqual({ inputTokens: 5, outputTokens: 0, costUsd: 0 });
    expect((await d.call(mk().request)).usage).toEqual({ inputTokens: 7, costUsd: 0 });
  });

  it("negative, fractional, string tokens and tokens on error/timeout are rejected", () => {
    const bad = (step: object) => ScenarioSchema.safeParse({ steps: [step] }).success;
    expect(bad({ raw: "r", inputTokens: -1 })).toBe(false);
    expect(bad({ raw: "r", outputTokens: 1.5 })).toBe(false);
    expect(bad({ response: {}, inputTokens: "5" })).toBe(false);
    expect(bad({ error: "e", inputTokens: 1 })).toBe(false);
    expect(bad({ timeout: true, outputTokens: 1 })).toBe(false);
    expect(bad({ raw: "r", inputTokens: 0 })).toBe(true);
  });

  it("a finished turn in the journal contains the step tokens", async () => {
    const step = (stance: string, solution: string | null): Scenario["steps"][number] => ({
      response: { stance, reasoning: "r", solution, answers: [], questions: [] }, inputTokens: 11, outputTokens: 22,
    });
    const session = createSession(
      {
        topic: "Тема", framing: "", origin: "cli", limits: { maxRounds: 3, turnTimeoutSec: 30, contextChars: 20000 },
        participants: [1, 2].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })),
      },
      { maxParticipants: 8, id: "s1" },
    );
    const { events } = await runSession({
      session, drivers: { p1: driver([step("amend", "v1")]), p2: driver([step("agree", null)]) },
    });
    const done = events.filter((e) => e.type === "turn_completed");
    expect(done).toHaveLength(2);
    for (const e of done) expect(e.usage).toEqual({ inputTokens: 11, outputTokens: 22, costUsd: 0 });
  });

  it("token-cap scripts are readable", async () => {
    for (const f of ["p1", "p2", "agree/p1", "agree/p2"]) {
      const s = await readScenario(fileURLToPath(new URL(`../../scenarios/token-cap/${f}.json`, import.meta.url)));
      expect(s.steps.length).toBeGreaterThan(0);
    }
  });
});

describe("scripted: recording requests for stands", () => {
  it("COUNCIL_SCRIPTED_PROMPT_LOG: a JSON line per call with the participant, language and request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scripted-log-"));
    const log = join(dir, "prompts.jsonl");
    const d = createScriptedDriver({ steps: [{ raw: "a" }] }, { ...DEV, COUNCIL_SCRIPTED_PROMPT_LOG: log });
    const req = { participant: { id: "p2" } as TurnRequest["participant"], prompt: "ЗАПРОС\nдве строки", language: "en" as const, timeoutSec: 1, signal: new AbortController().signal, onChunk: () => {} };
    await d.call(req);
    await expect(d.call(req)).rejects.toThrow();
    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([{ participantId: "p2", language: "en", prompt: "ЗАПРОС\nдве строки" }, { participantId: "p2", language: "en", prompt: "ЗАПРОС\nдве строки" }]);
    await rm(dir, { recursive: true, force: true });
  });
});
