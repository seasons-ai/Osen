import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";

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
