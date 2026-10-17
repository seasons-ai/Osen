import { accessSync, constants, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { history } from "../shared/messages/history.ts";

export const PINS_FILE = "history-pins.json";

export interface Pins { ids: string[]; error: string | null }

// the language is the process one at the time of the error (the catalog without an argument)
const failed = (why: (t: ReturnType<typeof history>) => string): Pins => { const t = history(); return { ids: [], error: t.pinsReadFailed(PINS_FILE, why(t)) }; };

// the reasons contain no file content: only the OS error code or a generic wording
export function readPins(dataDir: string): Pins {
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, PINS_FILE), "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ids: [], error: null };
    return failed((t) => t.pinsWhyNoAccess(code));
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return failed((t) => t.pinsWhyJson);
  }
  const ids = typeof data === "object" && data !== null ? (data as Record<string, unknown>)["pinnedSessionIds"] : undefined;
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) return failed((t) => t.pinsWhyShape);
  return { ids: ids as string[], error: null };
}

export function setPinned(dataDir: string, id: string, pinned: boolean): void {
  const cur = readPins(dataDir);
  if (cur.error !== null) throw new Error(history().pinsBroken(PINS_FILE));
  const has = cur.ids.includes(id);
  if (has === pinned) return;
  const ids = pinned ? [...cur.ids, id] : cur.ids.filter((x) => x !== id);
  const file = join(dataDir, PINS_FILE);
  // ponytail: the temp file name is by pid; two apps on one folder writing at once — the last one wins
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    // a rename would replace even a read-only file: the owner's write prohibition is respected
    if (existsSync(file)) accessSync(file, constants.W_OK);
    writeFileSync(tmp, `${JSON.stringify({ pinnedSessionIds: ids }, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(history().pinsSaveFailed(PINS_FILE, code));
  }
}

// an error message goes out once; after the error disappears and reappears — again
export function onceReporter(report: (message: string) => void): (error: string | null) => void {
  let last: string | null = null;
  return (error) => {
    if (error !== null && error !== last) report(error);
    last = error;
  };
}
