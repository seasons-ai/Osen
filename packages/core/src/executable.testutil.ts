import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdtempSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Writes an executable test file so that tests can run it under short deadlines.
 * On macOS the first launch of a new inode is checked by the system
 * (com.apple.provenance) and can take over 10 s under load; rewriting the
 * content in place (same inode) does not trigger the check again, while
 * rename-over or copy does. So a new path is warmed up once with a trivial
 * script, then the real content is written in place.
 * Binary content: write a Buffer with a Mach-O into a given path only once;
 * rewriting a launched Mach-O in place gets SIGKILL on the next launch.
 */
export function writeExecutable(path: string, content: string | Buffer, mode = 0o755): string {
  if (!existsSync(path)) {
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, mode);
    const r = spawnSync(path, [], { stdio: "ignore", env: {}, timeout: 120_000 });
    if (r.error || r.signal !== null || r.status !== 0) {
      const why = r.error ? String((r.error as NodeJS.ErrnoException).code ?? r.error.message) : r.signal ? `signal ${r.signal}` : `status ${r.status}`;
      throw new Error(`warm-up launch of ${path} failed: ${why}`);
    }
  }
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

const pool = new Map<string, string>();
let poolDir: string | undefined;
let protoCounter = 0;
let detachCounter = 0;

/** Test-only read-only view of the per-process prototype pool (content to prototype path). */
export const linkPrototypesForTest = (): ReadonlyMap<string, string> => pool;

/**
 * Removes pool dirs left by dead processes: vitest workers killed by a signal skip the "exit" handler.
 * Dirs of other live processes (EPERM counts as alive) and of this process are kept.
 */
export function sweepStalePrototypeDirs(): void {
  for (const name of readdirSync(tmpdir())) {
    const m = /^exec-proto-(\d+)-/.exec(name);
    if (!m || Number(m[1]) === process.pid) continue;
    try {
      process.kill(Number(m[1]), 0);
      continue;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") continue;
    }
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/**
 * Installs `content` at `path` as a hard link to one warmed, read-only prototype per content,
 * so the macOS first-launch check is paid once per content, not once per install.
 * All links of one content share an inode: never write through a link (the prototype is 0o555,
 * so such writes fail with EACCES); call detachExecutable first to modify one.
 * Falls back to a plain writeExecutable when the temp dir is on another device (EXDEV).
 */
export function linkExecutable(path: string, content: string): string {
  let proto = pool.get(content);
  if (proto === undefined) {
    if (poolDir === undefined) {
      sweepStalePrototypeDirs();
      poolDir = mkdtempSync(join(tmpdir(), `exec-proto-${process.pid}-`));
      const dirToRemove = poolDir;
      process.on("exit", () => rmSync(dirToRemove, { recursive: true, force: true }));
    }
    proto = writeExecutable(join(poolDir, String(protoCounter++)), content);
    chmodSync(proto, 0o555);
    pool.set(content, proto);
  }
  try {
    lstatSync(path);
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    linkSync(proto, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    writeExecutable(path, content);
  }
  return path;
}

/**
 * Replaces a linked executable with a private writable copy (new inode, same content).
 * The new inode gets the macOS first-launch check once; accepted for the few detached files.
 */
export function detachExecutable(path: string): string {
  const tmp = `${path}.detach-${process.pid}-${detachCounter++}`;
  copyFileSync(path, tmp);
  chmodSync(tmp, 0o755);
  renameSync(tmp, path);
  return path;
}
