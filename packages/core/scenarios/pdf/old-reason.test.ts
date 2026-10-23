import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findOldReason, gitEnv } from "./old-reason.ts";

const NEEDLE = "old «no text layer» reason";
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: gitEnv(), stdio: "pipe" });
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
  // Defect found 2026-10-23: under the pre-push hook git exports GIT_DIR and friends, and this test
  // committed its fixtures into the real repository and set core.bare there.
  it("under inherited git hook bindings, touches neither the bound repository nor reads it", () => {
    const sentinel = mkdtempSync(join(tmpdir(), "old-reason-sentinel-"));
    const KEYS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_CEILING_DIRECTORIES"];
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    const nogit = mkdtempSync(join(tmpdir(), "old-reason-nogit-"));
    let d = "";
    try {
      execFileSync("git", ["init", "-q"], { cwd: sentinel, env: { ...process.env, GIT_DIR: join(sentinel, ".git"), GIT_WORK_TREE: sentinel, GIT_INDEX_FILE: join(sentinel, ".git/index") } });
      put(sentinel, "docs/s.md", NEEDLE);
      const configBefore = readFileSync(join(sentinel, ".git/config"), "utf8");
      const gitDir = join(sentinel, ".git");
      Object.assign(process.env, { GIT_DIR: gitDir, GIT_WORK_TREE: sentinel, GIT_INDEX_FILE: join(gitDir, "index"), GIT_OBJECT_DIRECTORY: join(gitDir, "objects"), GIT_COMMON_DIR: gitDir, GIT_PREFIX: "", GIT_CEILING_DIRECTORIES: dirname(nogit) });
      d = mkRepo();
      put(d, "docs/a.md", NEEDLE);
      commit(d);
      expect(findOldReason(d, NEEDLE)).toEqual(["docs/a.md"]);
      expect(() => findOldReason(nogit, NEEDLE)).toThrow(/not a git repository/i);
      for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      expect(readFileSync(join(sentinel, ".git/config"), "utf8")).toBe(configBefore);
      expect(existsSync(join(sentinel, ".git/index"))).toBe(false);
      expect(readdirSync(join(sentinel, ".git/refs/heads"))).toEqual([]);
    } finally {
      for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      for (const p of [sentinel, nogit, d]) if (p) rmSync(p, { recursive: true, force: true });
    }
  });

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
