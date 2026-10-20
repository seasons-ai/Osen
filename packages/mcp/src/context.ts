import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { InspectDeps, Logger } from "@model-council/core";
import type { z } from "zod";
import { mcpMessages } from "./messages.ts";

/** Expected tool error: the message goes to the agent as is; logText is what to write to the log instead of the message. */
export class ToolError extends Error {
  readonly logText: string | undefined;
  constructor(message: string, logText?: string) { super(message); this.logText = logText; }
}

export interface ToolContext {
  dataDir: string;
  env: Record<string, string | undefined>;
  logger: Logger;
  builtinTemplatesDir: string;
  scenariosDir: string | null;         // null — scripted participants are off (no COUNCIL_DEV=1)
  shutdown: AbortSignal;               // server stop: only wakes the waits of council_status; no session lives in the server process (council_start and council_resume run in their own executor)
  councilLaunch: { command: string; args: string[]; env: Record<string, string> }; // how to start `council`: args go before `run-prepared <file>`, env is merged over the executor environment
  startTimeoutMs?: number;             // for tests: wait for the first event of a started session, 15000 by default
  startPollMs?: number;                // for tests: the step of that wait, 100 by default
  spawnExecutor?: (file: string, errPath: string) => Promise<number>; // for tests: runs the executor in this process (needed for inspectDeps stubs); resolves with the exit code
  inspectDeps?: Partial<InspectDeps>;  // for tests: replaces the CLI lookup and inspection
  pollMs?: number;                     // for tests: storage polling step, 250 by default
}

export interface Tool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: S;                      // field types only; bounds and meaning are checked by run, which answers with ToolError
  run(ctx: ToolContext, input: z.infer<z.ZodObject<S>>): Promise<unknown>; // the result goes to the agent as JSON
}

export const defineTool = <S extends z.ZodRawShape>(tool: Tool<S>): Tool<S> => tool;

// ponytail: the round-limit bounds, the scripted provider and the scenario list repeat apps/desktop (shared/setup.ts, main/setup-data.ts); a shared session launch in core is a separate change
export const ROUNDS_BOUNDS = { min: 1, max: 20 } as const;

export const SCRIPTED_PROVIDER_ID = "scripted";
export const scriptedProviderLabel = (): string => mcpMessages().scriptedLabel;

export function listScenarios(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join("/"))
    .sort();
}

// model comes from the agent: only a name from the list is accepted, going outside the folder gives null
export function scenarioPath(dir: string | null, model: string): string | null {
  return dir !== null && listScenarios(dir).includes(model) ? join(dir, model) : null;
}

// ponytail: repeats resumeScenarioPath from apps/desktop/src/main/resume.ts; a shared session launch in core is a separate change
// Sessions from MCP and the app store the scenario name in model, sessions of the council command store the invocation path; a relative path is not resolved: the working folder is different.
export function resumeScenarioPath(dir: string | null, model: string): string | null {
  if (dir === null) return null;
  const named = scenarioPath(dir, model);
  if (named !== null) return named;
  try {
    return isAbsolute(model) && statSync(model).isFile() ? model : null;
  } catch {
    return null;
  }
}
