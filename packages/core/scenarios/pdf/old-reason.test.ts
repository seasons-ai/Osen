import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findOldReason } from "./old-reason.ts";

const NEEDLE = "old «no text layer» reason";
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" });
const put = (repo: string, rel: string, text: string) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
function mkRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "old-reason-"));
  git(d, "init", "-q");
  git(d, "config", "user.email", "t@example.com");
  git(d, "config", "user.name", "t");
  git(d, "config", "commit.gpgsign", "false");
  git(d, "config", "core.quotepath", "true");
  return d;
}
const commit = (d: string) => { git(d, "add", "-A"); git(d, "commit", "-q", "--allow-empty", "-m", "x"); };

describe("findOldReason", () => {
  it("ignores a .gitignore-hidden file and an untracked file", () => {
    const d = mkRepo();
    try {
      put(d, ".gitignore", "docs/*\n!docs/kept.md\n");
      put(d, "docs/kept.md", "clean");
      commit(d);
      put(d, "docs/waiting.md", NEEDLE);
      put(d, "packages/new.ts", NEEDLE);
      expect(findOldReason(d, NEEDLE)).toEqual([]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("names a tracked docs file", () => {
    const d = mkRepo();
    try {
      put(d, "docs/a.md", `x ${NEEDLE} y`);
      commit(d);
      expect(findOldReason(d, NEEDLE)).toEqual(["docs/a.md"]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("skips a tracked file removed from the working copy", () => {
    const d = mkRepo();
    try {
      put(d, "docs/a.md", NEEDLE);
      commit(d);
      rmSync(join(d, "docs/a.md"));
      expect(findOldReason(d, NEEDLE)).toEqual([]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("throws with a reason outside a git repository", () => {
    const d = mkdtempSync(join(tmpdir(), "old-reason-nogit-"));
    try {
      // GIT_CEILING_DIRECTORIES keeps git from finding a repo above the temp dir
      process.env.GIT_CEILING_DIRECTORIES = dirname(d);
      expect(() => findOldReason(d, NEEDLE)).toThrow(/not a git repository/i);
    } finally { delete process.env.GIT_CEILING_DIRECTORIES; rmSync(d, { recursive: true, force: true }); }
  });

  // Own seeded generator: fast-check is not installed.
  function mulberry32(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const ROOTS = ["packages", "docs", "design", "other", "src"];
  const NAMES = ["a.md", "ёлка.txt", "my file.md", "Новый ёж.ts", "x.json"];
  const STATES = ["tracked", "ignored", "untracked", "deleted"] as const;

  it("finds exactly the tracked existing files of the three folders with the reason (seeded)", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rnd = mulberry32(seed);
      const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
      const n = seed === 1 ? 0 : Math.floor(rnd() * 41);
      const files = new Map<string, { state: (typeof STATES)[number]; has: boolean }>();
      for (let i = 0; i < n; i++) {
        const rel = `${pick(ROOTS)}/${pick(["", "sub/", "вложенная папка/"])}${i}-${pick(NAMES)}`;
        const state = seed === 2 ? "ignored" : pick(STATES);
        files.set(rel, { state, has: seed === 3 ? true : rnd() < 0.5 });
      }
      const d = mkRepo();
      try {
        put(d, ".gitignore", "*.ign\n");
        const real = new Map<string, string>();
        for (const [rel, f] of files) real.set(rel, f.state === "ignored" ? `${rel}.ign` : rel);
        for (const [rel, f] of files) put(d, real.get(rel)!, f.has ? `a ${NEEDLE} b` : "plain");
        for (const [rel, f] of files) if (f.state === "tracked" || f.state === "deleted") git(d, "add", "-f", "--", real.get(rel)!);
        git(d, "commit", "-q", "--allow-empty", "-m", "x");
        for (const [rel, f] of files) if (f.state === "deleted") rmSync(join(d, real.get(rel)!));
        const want = [...files].filter(([rel, f]) => f.state === "tracked" && f.has && /^(packages|docs|design)\//.test(rel)).map(([rel]) => rel).sort();
        expect(findOldReason(d, NEEDLE).sort(), `seed ${seed}`).toEqual(want);
      } finally { rmSync(d, { recursive: true, force: true }); }
    }
  });
});
