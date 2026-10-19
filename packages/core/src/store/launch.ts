import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { cliMessages } from "../messages/cli.ts";
import { SessionSchema } from "../protocol/schema.ts";
import type { Session } from "../protocol/schema.ts";
import type { CollectedMaterial } from "../materials.ts";
import type { FolderFile } from "../protocol/folder.ts";
import { isValidSessionId } from "./journal.ts";

/**
 * Launch file: the MCP server prepares a session and hands it to a detached `council run-prepared` process.
 * It holds no secrets: participants are rebuilt from the registry and the environment of the executor.
 */
export interface LaunchPayload {
  session: Session;
  materials?: CollectedMaterial[];
  workspace?: FolderFile[];
  /** Participant id (p1…) → absolute path of a scripted scenario; only for providerId "scripted". */
  scenarios: Record<string, string>;
  /** ISO time after which the file is stale and is not run. */
  deadline: string;
}

export class LaunchFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchFileError";
  }
}

export const launchDir = (dataDir: string): string => join(dataDir, "launch");
export const launchFilePath = (dataDir: string, id: string): string => join(launchDir(dataDir), `${id}.json`);
export const launchErrPath = (dataDir: string, id: string): string => join(launchDir(dataDir), `${id}.err`);

const LaunchSchema = z.object({
  session: SessionSchema,
  materials: z.array(z.object({ id: z.string(), name: z.string(), chars: z.number().int().min(0), sha256: z.string(), text: z.string() }).strict()).optional(),
  workspace: z.array(z.object({ name: z.string(), text: z.string() }).strict()).optional(),
  scenarios: z.record(z.string(), z.string().refine((p) => isAbsolute(p))),
  deadline: z.string().refine((d) => !Number.isNaN(Date.parse(d))),
}).strict();

export function writeLaunchFile(dataDir: string, payload: LaunchPayload): string {
  const id = payload.session.id;
  if (!isValidSessionId(id)) throw new LaunchFileError(cliMessages().launchBadId(id));
  mkdirSync(launchDir(dataDir), { recursive: true, mode: 0o700 });
  const path = launchFilePath(dataDir, id);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/** Reads and always deletes the file; any problem is a LaunchFileError with the reason. */
export function readLaunchFile(path: string, now: Date = new Date()): LaunchPayload {
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
  const parsed = LaunchSchema.safeParse(json);
  if (!parsed.success) throw new LaunchFileError(t.launchInvalid(path, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")));
  if (now.getTime() > Date.parse(parsed.data.deadline)) throw new LaunchFileError(t.launchExpired(parsed.data.deadline));
  return parsed.data as LaunchPayload;
}
