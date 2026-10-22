import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParticipantCallError } from "../participants/driver.ts";
import type { ParticipantDriver, TurnRequest, TurnResult } from "../participants/driver.ts";
import { planLaunch } from "./args.ts";
import { classifyFailure, toCallError } from "./errors.ts";
import { runProcess } from "./process.ts";
import { verifiedRecordFor } from "./discovery.ts";
import { checkPinnedLaunch } from "./launch-guard.ts";
import type { GuardDeps } from "./launch-guard.ts";
import { activePin } from "./pins.ts";
import { parseClaudeOutput, parseCodexOutput } from "./output-parse.ts";
import { providerMessages } from "../messages/providers.ts";
import type { CliRuntime } from "./types.ts";

const strictObject = (properties: Record<string, unknown>) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});

/** JSON Schema of the participant reply: passed to CLIs that can answer by schema. */
export const TURN_RESPONSE_JSON_SCHEMA: Record<string, unknown> = strictObject({
  stance: { type: "string", enum: ["amend", "agree", "object"] },
  reasoning: { type: "string" },
  solution: { type: ["string", "null"] },
  answers: { type: "array", items: strictObject({ questionId: { type: "string" }, text: { type: "string" } }) },
  questions: { type: "array", items: strictObject({ to: { type: "string" }, text: { type: "string" } }) },
  files: { type: "array", items: { type: "string" } },
});

export { parseClaudeOutput, parseCodexOutput } from "./output-parse.ts";
export type { CliOutput } from "./output-parse.ts";

export function createCliDriver(runtime: CliRuntime, deps: {
  guard?: Partial<GuardDeps>;
  // used only by the fixture capture script; product callers never pass it
  onOutput?: (raw: { stdout: string; stderr: string; exitCode: number | null }) => void;
} = {}): ParticipantDriver {
  const { agent } = runtime;
  return {
    async call(request: TurnRequest): Promise<TurnResult> {
      if (runtime.pinned && runtime.pinDataDir) {
        // re-read pins.json: a `cli use` or a replaced binary after inspection must stop the turn before any process starts
        const active = activePin(runtime.pinDataDir, agent);
        if (active.state === "pin") {
          const r = await checkPinnedLaunch({ agent, pin: active, launchPath: runtime.path, record: verifiedRecordFor(runtime.pinDataDir), env: runtime.env }, deps.guard);
          if (!r.ok) throw new ParticipantCallError("call_error", r.reason, false);
        } else {
          // pins.json is gone, unreadable or without this agent: the session stays pinned, so no launch of the old path and no PATH fallback
          throw new ParticipantCallError("call_error", providerMessages().pinGoneMidSession(agent, runtime.path, active.state === "rejected" ? active.reason : ""), false);
        }
      }
      const dir = await mkdtemp(join(tmpdir(), "council-turn-"));
      try {
        const cwd = join(dir, "cwd");
        const schemaFile = join(dir, "schema.json");
        await mkdir(cwd);
        await writeFile(schemaFile, JSON.stringify(TURN_RESPONSE_JSON_SCHEMA));
        const plan = planLaunch({
          agent, flags: runtime.flags, version: runtime.version, features: runtime.features, pinned: runtime.pinned, model: request.participant.model, language: request.language,
          schema: { json: JSON.stringify(TURN_RESPONSE_JSON_SCHEMA), file: schemaFile },
        });
        if (!plan.ok) throw new ParticipantCallError("call_error", plan.reason, false);
        const run = await runProcess({
          command: runtime.path, args: plan.args, cwd, stdin: request.prompt,
          env: { ...runtime.env, COUNCIL_PARTICIPANT: "1" }, signal: request.signal,
        });
        if (run.aborted) throw new ParticipantCallError("timeout", providerMessages().callAborted(agent), true);
        deps.onOutput?.({ stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode });
        const out = agent === "claude" ? parseClaudeOutput(run.stdout, runtime.version) : parseCodexOutput(run.stdout, runtime.version);
        if (out.ok && !run.spawnError && run.exitCode === 0) {
          // ponytail: the reply comes as one chunk; streaming output (stream-json) when the live discussion UI needs it
          request.onChunk(out.text);
          return { text: out.text, usage: out.usage };
        }
        if (!out.ok && out.toolCall) {
          throw new ParticipantCallError("call_error", providerMessages().toolDespiteIsolation(agent, out.toolCall), false);
        }
        const failure = classifyFailure(agent, {
          command: runtime.path, exitCode: run.exitCode, signal: run.signal, spawnError: run.spawnError,
          text: `${run.stderr}\n${out.ok ? "" : out.diagnostic}`,
        });
        throw toCallError(failure);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
