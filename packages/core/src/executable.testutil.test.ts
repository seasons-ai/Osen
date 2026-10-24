import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detachExecutable, linkExecutable, linkPrototypesForTest, sweepStalePrototypeDirs, writeExecutable } from "./executable.testutil.ts";

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

describe("linkExecutable", () => {
  const LINK_SEED = 228001;
  const CONTENTS = ["", "#!/bin/sh\necho a\n\nexit 0\n", "#!/bin/sh\necho b\n"];

  const errCode = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (e) {
      return (e as NodeJS.ErrnoException).code;
    }
    return undefined;
  };

  it("linkExecutable: prototypes never change, links of one content share an inode until detached", { timeout: 120_000 }, () => {
    const rnd = mulberry32(LINK_SEED);
    const pick = (n: number) => Math.floor(rnd() * n);
    const contents = CONTENTS.slice(0, 1 + pick(3));
    if (!contents.includes("")) contents[0] = "";
    if (!contents.some((c) => c.includes("\n"))) contents.push(CONTENTS[1]!);
    const paths = Array.from({ length: 1 + pick(5) }, (_, i) => join(dir, `p${i}`));
    const state = new Map<string, { base: string; expected: string; detached: boolean }>();
    const used = new Set<string>();
    const protoBytes = new Map<string, Buffer>();
    const steps = 15 + pick(11);
    for (let step = 0; step < steps; step++) {
      const ctx = `seed=${LINK_SEED} step=${step}`;
      const p = paths[pick(paths.length)]!;
      const st = state.get(p);
      const op = pick(5);
      if (op === 0 || st === undefined) {
        const c = contents[pick(contents.length)]!;
        expect(linkExecutable(p, c), `${ctx} link return`).toBe(p);
        used.add(c);
        state.set(p, { base: c, expected: c, detached: false });
        const proto = linkPrototypesForTest().get(c)!;
        if (!protoBytes.has(proto)) protoBytes.set(proto, readFileSync(proto));
      } else if (op === 1) {
        if (!st.detached) {
          expect(detachExecutable(p), `${ctx} detach return`).toBe(p);
          st.detached = true;
        }
      } else if (op === 2) {
        const extra = `# ${pick(1000)}\n`;
        if (st.detached) {
          appendFileSync(p, extra);
          st.expected += extra;
        } else {
          expect(errCode(() => appendFileSync(p, extra)), `${ctx} append through link`).toBe("EACCES");
        }
      } else if (op === 3) {
        if (!st.detached) expect(errCode(() => writeExecutable(p, "#!/bin/sh\nexit 1\n")), `${ctx} writeExecutable on link`).toBe("EACCES");
      }
      for (const [proto, bytes] of protoBytes) {
        expect(readFileSync(proto).equals(bytes), `${ctx} prototype ${proto} changed`).toBe(true);
      }
      for (const [path, s] of state) {
        expect(readFileSync(path, "utf8"), `${ctx} content of ${path}`).toBe(s.expected);
        const ino = statSync(path).ino;
        const protoIno = statSync(linkPrototypesForTest().get(s.base)!).ino;
        if (s.detached) expect(ino, `${ctx} detached ${path} shares the prototype inode`).not.toBe(protoIno);
        else expect(ino, `${ctx} link ${path} does not share the prototype inode`).toBe(protoIno);
      }
      const protos = new Set([...used].map((c) => linkPrototypesForTest().get(c)));
      expect(protos.size, `${ctx} prototypes per distinct content`).toBe(used.size);
    }
  });

  it("links of one content share an inode and both run", { timeout: 60_000 }, () => {
    const c = "#!/bin/sh\necho linked\n";
    const a = linkExecutable(join(dir, "a"), c);
    const b = linkExecutable(join(dir, "b"), c);
    expect(statSync(a).ino).toBe(statSync(b).ino);
    expect(execFileSync(a, { encoding: "utf8" }).trim()).toBe("linked");
    expect(execFileSync(b, { encoding: "utf8" }).trim()).toBe("linked");
  });

  it("sweepStalePrototypeDirs removes pool dirs of dead processes and keeps the own pool", { timeout: 60_000 }, () => {
    linkExecutable(join(dir, "own"), "#!/bin/sh\nexit 0\n");
    const ownPool = dirname([...linkPrototypesForTest().values()][0]!);
    const deadPid = spawnSync("/usr/bin/true").pid!;
    const stale = join(tmpdir(), `exec-proto-${deadPid}-test`);
    mkdirSync(stale);
    writeFileSync(join(stale, "0"), "x");
    try {
      sweepStalePrototypeDirs();
      expect(existsSync(stale), "dead-pid dir removed").toBe(false);
      expect(existsSync(ownPool), "own pool kept").toBe(true);
    } finally {
      rmSync(stale, { recursive: true, force: true });
    }
  });
});
