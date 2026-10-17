import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { FolderFile } from "../protocol/folder.ts";
import { SessionEventSchema } from "../protocol/schema.ts";
import type { SessionEvent } from "../protocol/schema.ts";
import { storeMessages } from "../messages/store.ts";

export class SessionExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionExistsError";
  }
}

export class MaterialSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialSnapshotError";
  }
}

export function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}

export function sessionsDir(dataDir: string): string {
  return join(dataDir, "sessions");
}

export function sessionDir(dataDir: string, id: string): string {
  if (!isValidSessionId(id)) throw new Error(storeMessages().sessionIdInvalid(id));
  return join(sessionsDir(dataDir), id);
}

export function eventsPath(dataDir: string, id: string): string {
  return join(sessionDir(dataDir, id), "events.jsonl");
}

export function stopRequestPath(dataDir: string, id: string): string {
  return join(sessionDir(dataDir, id), "stop-requested");
}

export function resumeLockPath(dataDir: string, id: string): string {
  return join(sessionDir(dataDir, id), "resume.lock");
}

export function materialsDir(dataDir: string, id: string): string {
  return join(sessionDir(dataDir, id), "materials");
}

export function materialPath(dataDir: string, id: string, materialId: string): string {
  if (!/^m[1-9]\d*$/.test(materialId)) throw new Error(storeMessages().materialIdInvalid(materialId));
  return join(materialsDir(dataDir, id), `${materialId}.txt`);
}

export function writeMaterialSnapshots(
  dataDir: string, id: string, materials: readonly { id: string; text: string }[],
): void {
  if (materials.length === 0) return;
  const why = (e: unknown) => (e as NodeJS.ErrnoException).code ?? (e as Error).message;
  try {
    mkdirSync(materialsDir(dataDir, id));
  } catch (e) {
    throw new MaterialSnapshotError(storeMessages().materialsDirNotCreated(why(e)));
  }
  for (const m of materials) {
    try {
      writeFileSync(materialPath(dataDir, id, m.id), m.text, { encoding: "utf8", flag: "wx" });
    } catch (e) {
      throw new MaterialSnapshotError(storeMessages().materialSaveFailed(m.id, why(e)));
    }
  }
}

export function workspaceDir(dataDir: string, id: string): string {
  return join(sessionDir(dataDir, id), "workspace");
}

/** Folder snapshot: files by workspace/<name> paths. All names are checked before the first write. */
export function writeWorkspaceSnapshot(dataDir: string, id: string, files: readonly FolderFile[]): void {
  if (files.length === 0) return;
  const root = workspaceDir(dataDir, id);
  const targets = files.map((f) => {
    const path = resolve(root, f.name);
    if (f.name.length === 0 || isAbsolute(f.name) || !path.startsWith(root + sep)) {
      throw new MaterialSnapshotError(storeMessages().folderFileOutside(f.name));
    }
    return path;
  });
  const why = (e: unknown) => (e as NodeJS.ErrnoException).code ?? (e as Error).message;
  files.forEach((f, i) => {
    try {
      mkdirSync(dirname(targets[i]!), { recursive: true });
      writeFileSync(targets[i]!, f.text, { encoding: "utf8", flag: "wx" });
    } catch (e) {
      throw new MaterialSnapshotError(storeMessages().folderFileSaveFailed(f.name, why(e)));
    }
  });
}

/** Reads the folder snapshot: links are skipped, names use "/", order by name. */
export function readWorkspaceSnapshot(dataDir: string, id: string): FolderFile[] {
  const root = workspaceDir(dataDir, id);
  if (!existsSync(root)) return [];
  const out: FolderFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + e.name;
      if (e.isDirectory()) walk(join(dir, e.name), name + "/");
      else if (e.isFile()) out.push({ name, text: readFileSync(join(dir, e.name), "utf8") });
    }
  };
  walk(root, "");
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function createSessionJournal(dataDir: string, id: string): void {
  const dir = sessionDir(dataDir, id);
  mkdirSync(sessionsDir(dataDir), { recursive: true });
  try {
    mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new SessionExistsError(storeMessages().sessionExists(id));
    throw e;
  }
}

export function appendEvent(dataDir: string, id: string, event: SessionEvent): void {
  appendFileSync(eventsPath(dataDir, id), JSON.stringify(event) + "\n");
}

/** Why reading stopped before the end of the file: a line from a newer version, or damage. */
export type JournalStopReason = "newer_version" | "corrupted";

// The line is complete: it is a JSON object with a numeric seq and string ts and type, but the schema did not accept it — an event of a newer version
function isFutureEvent(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.seq === "number" && typeof o.ts === "string" && typeof o.type === "string";
}

export function readEvents(
  dataDir: string, id: string, fromOffset = 0,
): { events: SessionEvent[]; offset: number; size: number; stopped: JournalStopReason | null } | null {
  if (!isValidSessionId(id)) return null;
  let buf: Buffer;
  try {
    buf = readFileSync(eventsPath(dataDir, id));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
  const events: SessionEvent[] = [];
  let offset = fromOffset;
  let stopped: JournalStopReason | null = null;
  for (;;) {
    const end = buf.indexOf(0x0a, offset);
    if (end === -1) {
      if (offset < buf.length) stopped = "corrupted";
      break;
    }
    let json: unknown;
    try {
      json = JSON.parse(buf.toString("utf8", offset, end));
    } catch {
      stopped = "corrupted";
      break;
    }
    const parsed = SessionEventSchema.safeParse(json);
    if (!parsed.success) {
      stopped = isFutureEvent(json) ? "newer_version" : "corrupted";
      break;
    }
    events.push(parsed.data);
    offset = end + 1;
  }
  return { events, offset, size: buf.length, stopped };
}
