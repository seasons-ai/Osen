import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { providerMessages } from "../messages/providers.ts";
import { ParticipantCallError } from "./driver.ts";
import type { ParticipantDriver, TurnRequest, TurnResult } from "./driver.ts";

const delayMs = z.number().int().min(0).optional();
const expectPrompt = z.string().min(1).optional();
const tokens = z.number().int().min(0).optional();

export const ScenarioSchema = z.object({
  steps: z.array(
    z.union([
      z.strictObject({ response: z.record(z.string(), z.unknown()), inputTokens: tokens, outputTokens: tokens, delayMs, expectPrompt }),
      z.strictObject({ raw: z.string(), inputTokens: tokens, outputTokens: tokens, delayMs, expectPrompt }),
      z.strictObject({ error: z.string(), retryable: z.boolean().optional(), delayMs, expectPrompt }),
      z.strictObject({ timeout: z.literal(true), delayMs, expectPrompt }),
    ]),
  ),
}).strict();
export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScriptStep = Scenario["steps"][number];

export class ScriptedUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptedUnavailableError";
  }
}

/** Refusal to a scripted participant without COUNCIL_DEV=1: common text for council, the MCP server and the app. */
export const scriptedDevOnlyMessage = (): string => providerMessages().scriptedDevOnly;

const CHUNK = 40;

export function createScriptedDriver(
  scenario: Scenario,
  env: Record<string, string | undefined> = process.env,
  startStep = 0,
): ParticipantDriver {
  if (env.COUNCIL_DEV !== "1") {
    throw new ScriptedUnavailableError(scriptedDevOnlyMessage());
  }
  let next = startStep;
  // Stands write every request here (participant, language, text): only scripted participants, and only with COUNCIL_DEV=1.
  const promptLog = env.COUNCIL_SCRIPTED_PROMPT_LOG;
  return {
    async call(request: TurnRequest): Promise<TurnResult> {
      // The step is consumed at once, even if the call fails.
      const index = next++;
      request.signal.throwIfAborted();
      if (promptLog) appendFileSync(promptLog, `${JSON.stringify({ participantId: request.participant.id, language: request.language, prompt: request.prompt })}\n`);
      const step = scenario.steps[index];
      if (!step) {
        const n = scenario.steps.length;
        throw new ParticipantCallError(
          "call_error", providerMessages().scriptExhausted(n, n + 1), false,
        );
      }
      if (step.delayMs !== undefined) await sleep(step.delayMs, undefined, { signal: request.signal });
      if (step.expectPrompt !== undefined && !request.prompt.includes(step.expectPrompt)) {
        throw new ParticipantCallError(
          "call_error", providerMessages().scriptExpectPrompt(step.expectPrompt), false,
        );
      }
      if ("error" in step) throw new ParticipantCallError("call_error", step.error, step.retryable ?? true);
      if ("timeout" in step) throw new ParticipantCallError("timeout", providerMessages().scriptTimeout, true);
      const text = "response" in step ? JSON.stringify(step.response, null, 2) : step.raw;
      for (let i = 0; i < text.length; i += CHUNK) request.onChunk(text.slice(i, i + CHUNK));
      return {
        text,
        usage: {
          ...(step.inputTokens !== undefined ? { inputTokens: step.inputTokens } : {}),
          ...(step.outputTokens !== undefined ? { outputTokens: step.outputTokens } : {}),
          costUsd: 0,
        },
      };
    },
  };
}

export async function readScenario(path: string): Promise<Scenario> {
  try {
    return ScenarioSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (e) {
    throw new Error(providerMessages().scriptUnreadable(path, e instanceof Error ? e.message : String(e)));
  }
}
