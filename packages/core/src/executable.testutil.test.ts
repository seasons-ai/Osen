import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeExecutable } from "./executable.testutil.ts";

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 225001;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exec-testutil-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeExecutable", () => {
  it("property: content and mode as given, inode kept on rewrite", { timeout: 60_000 }, () => {
    const rnd = mulberry32(SEED);
    const pick = (n: number) => Math.floor(rnd() * n);
    const paths = [join(dir, "a"), join(dir, "b"), join(dir, "c")];
    const modes = [0o755, 0o700, 0o775];
    const allBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const inodes = new Map<string, number>();
    const steps = 12 + pick(9);
    for (let step = 0; step < steps; step++) {
      const p = paths[pick(paths.length)]!;
      const mode = modes[pick(modes.length)]!;
      const kind = pick(4);
      const content: string | Buffer =
        kind === 0 ? "" : kind === 1 ? allBytes : kind === 2 ? `line1\nline2 ${pick(1000)}\n\n` : Buffer.from([pick(256), pick(256)]);
      const ctx = `seed=${SEED} step=${step}`;
      expect(writeExecutable(p, content, mode), ctx).toBe(p);
      expect(readFileSync(p).equals(Buffer.from(content)), `${ctx} content`).toBe(true);
      const st = statSync(p);
      expect(st.mode & 0o777, `${ctx} mode`).toBe(mode);
      if (!inodes.has(p)) inodes.set(p, st.ino);
      expect(st.ino, `${ctx} inode`).toBe(inodes.get(p));
    }
  });

  it("a rewritten script runs with the new content", { timeout: 60_000 }, () => {
    const p = join(dir, "s");
    writeExecutable(p, "#!/bin/sh\necho first\n");
    writeExecutable(p, "#!/bin/sh\necho second\n");
    expect(execFileSync(p, { encoding: "utf8" }).trim()).toBe("second");
  });

  it("a binary copy of /usr/bin/true runs", { timeout: 60_000 }, () => {
    const p = join(dir, "t");
    writeExecutable(p, readFileSync("/usr/bin/true"));
    expect(spawnSync(p, [], { stdio: "ignore" }).status).toBe(0);
  });

  it("throws with the path when the warm-up cannot run (mode 0o644)", { timeout: 60_000 }, () => {
    const p = join(dir, "n");
    expect(() => writeExecutable(p, "x", 0o644)).toThrow(p);
  });
});
