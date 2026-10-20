import type { Usage } from "../protocol/schema.ts";
import { providerMessages } from "../messages/providers.ts";
import type { CliAgent } from "./types.ts";

export type CliOutput =
  | { ok: true; text: string; usage: Usage }
  | { ok: false; diagnostic: string; toolCall?: string };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const tokens = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
const tail = (s: string) => s.slice(-2000);

function parseClaudeV1(stdout: string): CliOutput {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    // noise around the document: take the last result object among the lines that parse
    const found: unknown[] = [];
    for (const line of stdout.split("\n")) {
      try { found.push(...[JSON.parse(line.trim())].flat()); } catch { /* not JSON */ } // an array line (verbose form) adds its events
    }
    data = found;
  }
  const ev = Array.isArray(data) ? data.findLast((e) => isObj(e) && e.type === "result") : data;
  if (!isObj(ev) || ev.type !== "result") return { ok: false, diagnostic: tail(stdout) };
  const m = providerMessages();
  if ("is_error" in ev && typeof ev.is_error !== "boolean") {
    return { ok: false, diagnostic: `${m.claudeBadIsError(typeof ev.is_error)}\n${tail(stdout)}` };
  }
  if (ev.is_error === true) return { ok: false, diagnostic: typeof ev.result === "string" ? ev.result : JSON.stringify(ev) };
  const text = isObj(ev.structured_output) ? JSON.stringify(ev.structured_output) : typeof ev.result === "string" ? ev.result : "";
  if (!text.trim()) return { ok: false, diagnostic: `${m.claudeNoText}\n${tail(stdout)}` };
  const u = isObj(ev.usage) ? ev.usage : {};
  const reported = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].filter((v) => v !== undefined);
  // one invalid part makes the sum unknown: the input count is then absent, never computed from the rest
  const parts = reported.every((v) => tokens(v) !== undefined) ? reported.map((v) => tokens(v)!) : [];
  const outputTokens = tokens(u.output_tokens);
  const cost = ev.total_cost_usd;
  const usage: Usage = {
    ...(parts.length ? { inputTokens: parts.reduce((a, b) => a + b, 0) } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
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

function parseCodexV1(stdout: string): CliOutput {
  let text: string | undefined;
  let usage: Usage = {};
  let toolCall: string | undefined;
  let badText = false;
  const errors: string[] = [];
  for (const line of stdout.split("\n")) {
    let ev: unknown;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!isObj(ev) || typeof ev.type !== "string") continue;
    const item = isObj(ev.item) ? ev.item : undefined;
    if ((ev.type === "item.started" || ev.type === "item.completed") && item) {
      if (typeof item.type === "string" && CODEX_TOOL_ITEMS.has(item.type)) toolCall ??= item.type;
      else if (ev.type === "item.completed" && item.type === "agent_message" && "text" in item) {
        if (typeof item.text === "string") text = item.text;
        else badText = true;
      }
    } else if (ev.type === "turn.completed" && isObj(ev.usage)) {
      const inputTokens = tokens(ev.usage.input_tokens);
      const outputTokens = tokens(ev.usage.output_tokens);
      usage = { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
    } else if (ev.type === "error" || ev.type.endsWith(".failed")) errors.push(codexMessage(ev));
  }
  const m = providerMessages();
  if (toolCall) return { ok: false, diagnostic: m.codexToolCall(toolCall), toolCall };
  if (errors.length) return { ok: false, diagnostic: errors.join("\n") };
  if (badText) return { ok: false, diagnostic: `${m.codexBadText}\n${tail(stdout)}` };
  if (!text?.trim()) return { ok: false, diagnostic: `${m.codexNoText}\n${tail(stdout)}` };
  return { ok: true, text, usage };
}

export interface ParseBranch {
  agent: CliAgent;
  id: string;
  /** Inclusive x.y.z bounds of the CLI versions this branch reads. */
  from: string;
  to: string;
  parse: (stdout: string) => CliOutput;
}

// A new output format gets a new branch with its own range; never edit an old branch.
export const PARSE_BRANCHES: readonly ParseBranch[] = [
  { agent: "claude", id: "claude-json-v1", from: "0.0.0", to: "2.1.288", parse: parseClaudeV1 },
  { agent: "codex", id: "codex-jsonl-v1", from: "0.0.0", to: "0.159.2", parse: parseCodexV1 },
];

const nums = (v: string) => v.split(".").map(Number);
function cmp(a: string, b: string): number {
  const [x, y] = [nums(a), nums(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** Branch for a CLI version: its range, else the nearest lower branch, else the oldest; unknown version means the newest. */
export function selectBranch(agent: CliAgent, version: string | undefined, table: readonly ParseBranch[] = PARSE_BRANCHES): ParseBranch {
  const own = table.filter((b) => b.agent === agent).sort((a, b) => cmp(a.from, b.from));
  const newest = own[own.length - 1];
  if (!newest) throw new Error(`no parse branch for ${agent}`);
  if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) return newest;
  return own.findLast((b) => cmp(b.from, version) <= 0) ?? own[0]!;
}

export const parseClaudeOutput = (stdout: string, version?: string): CliOutput => selectBranch("claude", version).parse(stdout);
export const parseCodexOutput = (stdout: string, version?: string): CliOutput => selectBranch("codex", version).parse(stdout);
