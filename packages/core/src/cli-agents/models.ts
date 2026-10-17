import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { providerMessages } from "../messages/providers.ts";
import { DEFAULT_MODEL } from "./types.ts";
import { declaredFlags } from "./flags.ts";
import type { CliAgent } from "./types.ts";

export interface ModelList {
  models: string[];
  confirmed: boolean;
  reason?: string;
}

type Env = Record<string, string | undefined>;

export interface ModelDeps {
  claudeInitialize(path: string, env: Env, args: readonly string[]): Promise<string>;
  readCodexModelsCache(env: Env): Promise<string>;
}

const RESPONSE_TIMEOUT_MS = 10_000;
const STDERR_TAIL_MAX = 2_000;
// Service request without a user message: the model is not started. --bare is not used: it disables the keychain.
const REQUIRED_FLAGS = ["--print", "--input-format", "--output-format", "--verbose", "--no-session-persistence"];
const REQUEST_ARGS = ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"];
// Isolation from the owner's settings, hooks, MCP servers and skills; each flag only if the help text declares it.
const ISOLATION_ARGS: readonly (readonly string[])[] = [["--strict-mcp-config"], ["--setting-sources", ""], ["--tools", ""], ["--disable-slash-commands"]];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const unique = (ids: string[]): string[] => [...new Set(ids)].filter((id) => id !== DEFAULT_MODEL);

/** Identifiers of visible models from the codex cache; hidden ones (`visibility: "hide"`) the CLI itself does not show. */
export function parseCodexModelsCache(raw: unknown): string[] {
  if (!isRecord(raw) || !Array.isArray(raw.models)) return [];
  return unique(raw.models.flatMap((m): string[] =>
    isRecord(m) && typeof m.slug === "string" && m.visibility !== "hide" ? [m.slug] : []));
}

/** Models from claude's reply to the service request `initialize` (`response.response.models[].value`). */
export function parseClaudeInitializeModels(raw: unknown): string[] {
  if (!isRecord(raw) || !isRecord(raw.response) || !isRecord(raw.response.response)) return [];
  const models = raw.response.response.models;
  if (!Array.isArray(models)) return [];
  return unique(models.flatMap((m): string[] => (isRecord(m) && typeof m.value === "string" ? [m.value] : [])));
}

/** Alias examples from the flag description in the CLI help. */
export function parseHelpAliases(help: string, flag: string): string[] {
  const lines = help.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^\\s*${flag}\\b`).test(line));
  if (start < 0) return [];
  const description = [lines[start] ?? ""];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*-{1,2}[a-zA-Z]/.test(line)) break;
    description.push(line);
  }
  return unique([...description.join(" ").matchAll(/'([a-zA-Z][\w.-]*)'/g)].map((m) => m[1] ?? ""));
}

/** First whole `control_response` line with this request identifier. */
function matchingResponse(stdout: string, requestId: string): string | undefined {
  for (const line of stdout.split("\n").slice(0, -1)) {
    try {
      const p: unknown = JSON.parse(line);
      if (isRecord(p) && p.type === "control_response" && isRecord(p.response) && p.response.request_id === requestId) return line;
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function claudeInitialize(path: string, env: Env, args: readonly string[], timeoutMs = RESPONSE_TIMEOUT_MS): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "council-models-"));
  try {
    return await new Promise<string>((resolve, reject) => {
      const requestId = randomUUID();
      const child = spawn(path, [...args], { cwd, detached: true, env: { ...env, COUNCIL_PARTICIPANT: "1" }, stdio: "pipe", shell: false });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          if (child.pid === undefined) throw new Error("no pid");
          process.kill(-child.pid, "SIGTERM");
        } catch {
          try { child.kill(); } catch { /* already finished */ }
        }
        outcome();
      };
      const timer = setTimeout(() => {
        settle(() => { reject(new Error(providerMessages().probeTimeout(timeoutMs))); });
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        const line = matchingResponse(stdout, requestId);
        if (line !== undefined) settle(() => { resolve(line); });
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_MAX); });
      child.on("error", (e) => { settle(() => { reject(new Error(providerMessages().probeSpawnFailed(e.message))); }); });
      child.on("exit", (code, signal) => {
        settle(() => {
          const tail = stderr.trim();
          const m = providerMessages();
          reject(new Error(m.probeExited(code === null ? m.probeSignal(String(signal)) : m.probeCode(code), tail)));
        });
      });
      child.stdin.on("error", () => {});
      child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } })}\n`);
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export function readCodexModelsCache(env: Env): Promise<string> {
  const home = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return readFile(join(home, "models_cache.json"), "utf8");
}

const realDeps: ModelDeps = { claudeInitialize, readCodexModelsCache };

export async function listModels(agent: CliAgent, options: {
  path: string;
  env: Env;
  help: string;
  deps?: Partial<ModelDeps>;
}): Promise<ModelList> {
  const deps = { ...realDeps, ...options.deps };
  const fromHelp = parseHelpAliases(options.help, "--model");
  let why: string;
  try {
    if (agent === "claude") {
      const flags = declaredFlags(options.help);
      const missing = REQUIRED_FLAGS.filter((f) => !flags.has(f));
      if (missing.length > 0) {
        why = providerMessages().modelsFlagMissing(missing.join(", "));
      } else {
        const args = [...REQUEST_ARGS, ...ISOLATION_ARGS.filter(([f]) => flags.has(f!)).flat()];
        const models = parseClaudeInitializeModels(JSON.parse(await deps.claudeInitialize(options.path, options.env, args)));
        if (models.length > 0) return { models, confirmed: true };
        why = providerMessages().modelsNoList;
      }
    } else {
      const models = parseCodexModelsCache(JSON.parse(await deps.readCodexModelsCache(options.env)));
      if (models.length > 0) return { models, confirmed: true };
      why = providerMessages().modelsCacheEmpty;
    }
  } catch (e) {
    why = agent === "claude" ? errorText(e) : providerMessages().modelsCacheUnread(errorText(e));
  }
  if (fromHelp.length > 0) return { models: fromHelp, confirmed: false, reason: providerMessages().modelsFromHelp(agent, why) };
  return { models: [], confirmed: false, reason: providerMessages().modelsUnavailable(agent, why) };
}
