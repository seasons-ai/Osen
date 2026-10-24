import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { cliMessages } from "../messages/cli.ts";
import { SessionSchema } from "../protocol/schema.ts";
import type { Session } from "../protocol/schema.ts";
import type { CollectedMaterial } from "../materials.ts";
import type { FolderFile } from "../protocol/folder.ts";
import { isValidSessionId } from "./journal.ts";
import type { ReplacementInput } from "./resume.ts";

/**
 * Launch file: the MCP server prepares a session and hands it to a detached `council run-prepared` process.
 * It holds no secrets: participants are rebuilt from the registry and the environment of the executor.
 */
export interface LaunchPayload {
  kind?: "start";
  session: Session;
  materials?: CollectedMaterial[];
  workspace?: FolderFile[];
  /** Participant id (p1…) → absolute path of a scripted scenario; only for providerId "scripted". */
  scenarios: Record<string, string>;
  /** ISO time after which the file is stale and is not run. */
  deadline: string;
}

/** Resume kind: the MCP server hands `council_resume` to a detached `council run-prepared` process. */
export interface LaunchResumePayload {
  kind: "resume";
  sessionId: string;
  rounds?: number;
  /** null = no cap; absent = keep as in the plan. */
  maxTotalTokens?: number | null;
  replacements?: ReplacementInput[];
  message?: string;
  /** ResumePlan.journalBytes at the time of the MCP plan. */
  journalBytes: number;
  /** Scripted participant `model` value → absolute scenario path. */
  scenarios: Record<string, string>;
  /** ISO time after which the file is stale and is not run. */
  deadline: string;
}

export type LaunchFile = LaunchPayload | LaunchResumePayload;

export class LaunchFileError extends Error {
  /** expired: the launch deadline has passed (the executor refuses with the code launch_expired, not with plain text) */
  readonly expired: boolean;
  constructor(message: string, expired = false) {
    super(message);
    this.expired = expired;
    this.name = "LaunchFileError";
  }
}

export const launchDir = (dataDir: string): string => join(dataDir, "launch");
/** One launch = one launchId: parallel launches of the same session never share, overwrite or delete each other's files. */
export const launchFilePath = (dataDir: string, id: string, launchId: string): string => join(launchDir(dataDir), `${id}.${launchId}.json`);
/** The executor's stderr file and the accepted file are named after the launch file. */
export const launchErrPath = (launchFile: string): string => launchFile.replace(/\.json$/, ".err");
export const launchAcceptedPath = (launchFile: string): string => launchFile.replace(/\.json$/, ".accepted.json");

const scenariosSchema = z.record(z.string(), z.string().refine((p) => isAbsolute(p)));
const deadlineSchema = z.string().refine((d) => !Number.isNaN(Date.parse(d)));

const LaunchSchema = z.object({
  kind: z.literal("start").optional(),
  session: SessionSchema,
  materials: z.array(z.object({ id: z.string(), name: z.string(), chars: z.number().int().min(0), sha256: z.string(), text: z.string() }).strict()).optional(),
  workspace: z.array(z.object({ name: z.string(), text: z.string() }).strict()).optional(),
  scenarios: scenariosSchema,
  deadline: deadlineSchema,
}).strict();

const LaunchResumeSchema = z.object({
  kind: z.literal("resume"),
  sessionId: z.string().refine(isValidSessionId),
  rounds: z.number().int().min(1).optional(),
  maxTotalTokens: z.number().int().min(1).nullable().optional(),
  replacements: z.array(z.object({ participantId: z.string(), providerId: z.string(), model: z.string(), name: z.string().optional() }).strict()).optional(),
  message: z.string().optional(),
  journalBytes: z.number().int().min(0),
  scenarios: scenariosSchema,
  deadline: deadlineSchema,
}).strict();

export function writeLaunchFile(dataDir: string, payload: LaunchFile, launchId: string = randomUUID()): string {
  const id = payload.kind === "resume" ? payload.sessionId : payload.session.id;
  if (!isValidSessionId(id)) throw new LaunchFileError(cliMessages().launchBadId(id));
  mkdirSync(launchDir(dataDir), { recursive: true, mode: 0o700 });
  const path = launchFilePath(dataDir, id, launchId);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/** Reads and always deletes the file; any problem is a LaunchFileError with the reason. */
export function readLaunchFile(path: string, now: Date = new Date()): LaunchFile {
  const t = cliMessages();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new LaunchFileError((e as NodeJS.ErrnoException).code === "ENOENT" ? t.launchMissing(path) : t.launchUnreadable(path, (e as Error).message));
  }
  rmSync(path, { force: true });
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new LaunchFileError(t.launchDamaged(path));
  }
  const resume = typeof json === "object" && json !== null && (json as { kind?: unknown }).kind === "resume";
  const parsed = resume ? LaunchResumeSchema.safeParse(json) : LaunchSchema.safeParse(json);
  if (!parsed.success) throw new LaunchFileError(t.launchInvalid(path, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")));
  if (now.getTime() > Date.parse(parsed.data.deadline)) throw new LaunchFileError(t.launchExpired(parsed.data.deadline), true);
  return parsed.data as LaunchFile;
}

/** Removes launch files, .err, .accepted.json and their temp copies older than maxAgeMs (left by a killed server or executor); returns how many were removed. */
export function sweepLaunchDir(dataDir: string, maxAgeMs = 60_000, now = Date.now()): number {
  const dir = launchDir(dataDir);
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!/\.(json|err|tmp)$/.test(name)) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile() || st.mtimeMs >= now - maxAgeMs) continue;
      rmSync(path, { force: true });
      removed++;
    } catch { /* gone meanwhile */ }
  }
  return removed;
}
