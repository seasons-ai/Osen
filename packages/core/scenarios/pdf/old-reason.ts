import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Files of packages/, docs/, design/ tracked by git that contain `needle` (paths relative to `repo`).
// Untracked and ignored files are not looked at; a tracked file missing from the working copy is skipped.
// Throws with git's reason when the tracked list cannot be obtained.
export function findOldReason(repo: string, needle: string): string[] {
  const r = spawnSync("git", ["ls-files", "-z", "--", "packages", "docs", "design"], { cwd: repo, encoding: "utf8", maxBuffer: 2 ** 28 });
  if (r.error) throw new Error(`git ls-files failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ls-files failed (status ${r.status}): ${r.stderr.trim()}`);
  const hits: string[] = [];
  for (const rel of r.stdout.split("\0").filter(Boolean)) {
    const f = join(repo, rel);
    let st;
    try { st = statSync(f); } catch { continue; }
    if (st.isFile() && st.size < 4 * 2 ** 20 && readFileSync(f, "utf8").includes(needle)) hits.push(rel);
  }
  return hits;
}
