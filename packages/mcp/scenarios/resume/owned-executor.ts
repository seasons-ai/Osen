import { spawnSync } from "node:child_process";

// SIGKILL a recorded detached executor pid only if it was not confirmed exited, is alive,
// and its command line contains the stand's data folder (a reused pid belongs to a foreign process).
// ps runs with a UTF-8 locale and both sides are NFC-normalized: without it ps escapes Cyrillic.
export function killOwnedExecutor(pid: number, dataDir: string, exited: Set<number>): boolean {
  if (exited.has(pid)) return false;
  try { process.kill(pid, 0); } catch { return false; }
  const ps = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, LC_ALL: "en_US.UTF-8" },
  });
  const cmd = ps.stdout ?? "";
  if (!cmd.normalize("NFC").includes(dataDir.normalize("NFC"))) return false;
  try { process.kill(pid, "SIGKILL"); return true; } catch { return false; }
}
