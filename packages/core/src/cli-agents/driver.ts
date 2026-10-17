import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParticipantCallError } from "../participants/driver.ts";
import type { ParticipantDriver, TurnRequest, TurnResult } from "../participants/driver.ts";
import type { Usage } from "../protocol/schema.ts";
import { planLaunch } from "./args.ts";
import { classifyFailure, toCallError } from "./errors.ts";
import { runProcess } from "./process.ts";
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

export type CliOutput =
  | { ok: true; text: string; usage: Usage }
  | { ok: false; diagnostic: string; toolCall?: string };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const tokens = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
const tail = (s: string) => s.slice(-2000);

export function parseClaudeOutput(stdout: string): CliOutput {
  let data: unknown;
  try { data = JSON.parse(stdout); } catch { return { ok: false, diagnostic: tail(stdout) }; }
  const ev = Array.isArray(data) ? data.findLast((e) => isObj(e) && e.type === "result") : data;
  if (!isObj(ev) || ev.type !== "result") return { ok: false, diagnostic: tail(stdout) };
  if (ev.is_error === true) return { ok: false, diagnostic: typeof ev.result === "string" ? ev.result : JSON.stringify(ev) };
  const text = isObj(ev.structured_output) ? JSON.stringify(ev.structured_output) : typeof ev.result === "string" ? ev.result : "";
  if (!text.trim()) return { ok: false, diagnostic: providerMessages().claudeNoText };
  const u = isObj(ev.usage) ? ev.usage : {};
  const parts = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].map(tokens).filter((n) => n !== undefined);
  const outputTokens = tokens(u.output_tokens);
  const usage: Usage = {
    ...(parts.length ? { inputTokens: parts.reduce((a, b) => a + b, 0) } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(typeof ev.total_cost_usd === "number" && ev.total_cost_usd >= 0 ? { costUsd: ev.total_cost_usd } : {}),
  };
  return { ok: true, text, usage };
}

// Codex item kinds that mean a tool call (list from Widget: adapters/codex.ts).
const CODEX_TOOL_ITEMS = new Set(["command_execution", "mcp_tool_call", "web_search", "file_change"]);

function codexMessage(ev: Json): string {
  const msg = [isObj(ev.error) ? ev.error.message : undefined, ev.message, ev.error].find((v) => typeof v === "string" && v.trim() !== "");
  if (typeof msg !== "string") return JSON.stringify(ev);
  try { // some versions put the HTTP error envelope into a JSON string
    const body: unknown = JSON.parse(msg);
    if (isObj(body) && isObj(body.error) && typeof body.error.message === "string" && body.error.message.trim()) return body.error.message;
  } catch { /* plain text */ }
  return msg;
}

export function parseCodexOutput(stdout: string): CliOutput {
  let text: string | undefined;
  let usage: Usage = {};
  let toolCall: string | undefined;
  const errors: string[] = [];
  for (const line of stdout.split("\n")) {
    let ev: unknown;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!isObj(ev) || typeof ev.type !== "string") continue;
    const item = isObj(ev.item) ? ev.item : undefined;
    if ((ev.type === "item.started" || ev.type === "item.completed") && item) {
      if (typeof item.type === "string" && CODEX_TOOL_ITEMS.has(item.type)) toolCall ??= item.type;
      else if (ev.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") text = item.text;
    } else if (ev.type === "turn.completed" && isObj(ev.usage)) {
      const inputTokens = tokens(ev.usage.input_tokens);
      const outputTokens = tokens(ev.usage.output_tokens);
      usage = { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
    } else if (ev.type === "error" || ev.type.endsWith(".failed")) errors.push(codexMessage(ev));
  }
  if (toolCall) return { ok: false, diagnostic: providerMessages().codexToolCall(toolCall), toolCall };
  if (errors.length) return { ok: false, diagnostic: errors.join("\n") };
  if (!text?.trim()) return { ok: false, diagnostic: providerMessages().codexNoText };
  return { ok: true, text, usage };
}

export function createCliDriver(runtime: CliRuntime): ParticipantDriver {
  const { agent } = runtime;
  const parse = agent === "claude" ? parseClaudeOutput : parseCodexOutput;
  return {
    async call(request: TurnRequest): Promise<TurnResult> {
      const dir = await mkdtemp(join(tmpdir(), "council-turn-"));
      try {
        const cwd = join(dir, "cwd");
        const schemaFile = join(dir, "schema.json");
        await mkdir(cwd);
        await writeFile(schemaFile, JSON.stringify(TURN_RESPONSE_JSON_SCHEMA));
        const plan = planLaunch({
          agent, flags: runtime.flags, version: runtime.version, features: runtime.features, model: request.participant.model, language: request.language,
          schema: { json: JSON.stringify(TURN_RESPONSE_JSON_SCHEMA), file: schemaFile },
        });
        if (!plan.ok) throw new ParticipantCallError("call_error", plan.reason, false);
        const run = await runProcess({
          command: runtime.path, args: plan.args, cwd, stdin: request.prompt,
          env: { ...runtime.env, COUNCIL_PARTICIPANT: "1" }, signal: request.signal,
        });
        if (run.aborted) throw new ParticipantCallError("timeout", providerMessages().callAborted(agent), true);
        const out = parse(run.stdout);
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
