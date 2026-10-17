import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

// The file appears at once with the pid: a write to a temp file, then link.
function create(file: string): boolean {
  const mine = `${file}.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(mine, String(process.pid));
    linkSync(mine, file);
    return true;
  } catch (e) {
    if (code(e) === "EEXIST") return false;
    throw e;
  } finally {
    rmSync(mine, { force: true });
  }
}

function owner(file: string, isAlive: (pid: number) => boolean): "none" | "alive" | "dead" {
  let text: string;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch (e) {
    if (code(e) === "ENOENT") return "none";
    throw e;
  }
  const pid = Number(text);
  return text !== "" && Number.isInteger(pid) && pid > 0 && isAlive(pid) ? "alive" : "dead";
}

function remove(file: string): void {
  try { unlinkSync(file); } catch (e) { if (code(e) !== "ENOENT") throw e; }
}

/** Tries to take the lock file with the identifier of the current process.
 *  true — the lock is taken (the caller removes it: unlink); false — the lock is held by a live process or is being seized right now by another one.
 *  Other filesystem errors are propagated as they are. */
export function tryPidLock(path: string, isAlive: (pid: number) => boolean): boolean {
  const guard = `${path}.takeover`;
  for (;;) {
    if (create(path)) return true;
    const o = owner(path, isAlive);
    if (o === "none") continue;
    if (o === "alive") return false;
    // Only the holder of the watchdog lock, having re-read the owner, removes the lock of a dead process.
    if (!create(guard)) {
      const g = owner(guard, isAlive);
      if (g === "alive") return false;
      // ponytail: the dead watchdog lock is removed without protection — a window between the process dying inside the seizure and the arrival of two rivals; if needed — an OS-level lock.
      if (g === "dead") remove(guard);
      continue;
    }
    try {
      const again = owner(path, isAlive);
      if (again === "alive") return false;
      if (again === "dead") remove(path);
      if (create(path)) return true;
    } finally {
      remove(guard);
    }
  }
}
