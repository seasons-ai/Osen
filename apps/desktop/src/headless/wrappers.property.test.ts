import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

const BIN = join(import.meta.dirname, "../../resources/bin");
const WRAPPERS = ["osen-mcp", "council"] as const;
const REQUIREMENT = "Обёртки не зависят от места установки и PATH";

// Own seeded generator: fast-check is not wired in.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["plain", "with space", "Папка", "it's", 'dq"uote', "$HOME", "-dash", "a`b`", "star*", "tab\there", "~tilde", "semi;colon", "ё и й"];
const ARGS = ["", " ", "a b", "--help", "-x", "--", "$HOME", "'q'", '"q"', "*", "~", "Привет мир", "a\tb", "-", "--topic=x y"];

// Fake Osen: prints $0, the two variables and every argument, each followed by NUL; exits with STUB_EXIT.
const STUB = `#!/bin/sh
printf '%s\\0' "$0" "\${ELECTRON_RUN_AS_NODE-UNSET}" "\${NODE_OPTIONS-UNSET}" "$@"
exit "\${STUB_EXIT:-0}"
`;

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Built { launch: string; stub: string; entry: string; cwd: string }

// Bundle <root>/<name>.app, renamed after creation, then 0–3 symlinks (absolute and relative targets) in other folders.
function build(seed: number, wrapper: (typeof WRAPPERS)[number]): Built {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const name = () => NAMES[int(NAMES.length)]!;
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wrappers-"));
  roots.push(root);
  const parent = join(root, `${name()} ${seed}`);
  const before = join(parent, `${name()}.app`);
  const contents = join(before, "Contents");
  const outMain = join(contents, "Resources/app.asar.unpacked/out/main");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources/bin"), { recursive: true });
  mkdirSync(outMain, { recursive: true });
  writeFileSync(join(contents, "MacOS/Osen"), STUB, { mode: 0o755 });
  writeFileSync(join(contents, "Resources/bin", wrapper), readFileSync(join(BIN, wrapper)), { mode: 0o755 });
  const app = join(parent, `${name()} renamed.app`);
  renameSync(before, app);
  let launch = join(app, "Contents/Resources/bin", wrapper);
  for (let i = int(4); i > 0; i--) {
    const dir = join(root, `links ${i}`, name());
    mkdirSync(dir, { recursive: true });
    const link = join(dir, `${name()} ${wrapper}`);
    symlinkSync(rnd() < 0.5 ? launch : relative(dir, launch), link);
    launch = link;
  }
  const cwd = join(root, "cwd", name());
  mkdirSync(cwd, { recursive: true });
  return { launch, stub: join(app, "Contents/MacOS/Osen"), entry: join(app, `Contents/Resources/app.asar.unpacked/out/main/${wrapper}.mjs`), cwd };
}

function run(b: Built, args: string[], exit: number) {
  const r = spawnSync(b.launch, args, { env: { STUB_EXIT: String(exit), NODE_OPTIONS: "--max-old-space-size=1" }, cwd: b.cwd, encoding: "utf8" });
  const parts = r.stdout.split("\0");
  parts.pop(); // after the last NUL
  return { status: r.status, stderr: r.stderr, parts, error: r.error };
}

describe("wrappers", () => {
  it(`${REQUIREMENT}: random install paths, symlink chains, renames, arguments and exit codes`, () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rnd = mulberry32(seed * 7919);
      const wrapper = WRAPPERS[seed % 2]!;
      const b = build(seed, wrapper);
      const args = Array.from({ length: Math.floor(rnd() * 6) }, () => ARGS[Math.floor(rnd() * ARGS.length)]!);
      const exit = rnd() < 0.5 ? 0 : 1 + Math.floor(rnd() * 100);
      const r = run(b, args, exit);
      const ctx = `seed ${seed}: ${b.launch}`;
      expect(r.error, ctx).toBeUndefined();
      expect(r.stderr, ctx).toBe("");
      expect(r.status, ctx).toBe(exit);
      // $0 of the stub is the Osen inside the renamed bundle, then the entry file, then the caller's arguments unchanged
      expect(r.parts, ctx).toEqual([b.stub, "1", "UNSET", b.entry, ...args]);
    }
  }, 60_000);

  it("--help example: argument passed, exit code 0, nothing but the stub output", () => {
    const b = build(1000, "council");
    const r = run(b, ["--help"], 0);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.parts).toEqual([b.stub, "1", "UNSET", b.entry, "--help"]);
  });

  it("wrappers name no install location or user and differ only in the entry file", () => {
    const [mcp, council] = WRAPPERS.map((w) => readFileSync(join(BIN, w), "utf8"));
    for (const text of [mcp!, council!]) {
      expect(text).not.toContain("/Applications");
      expect(text).not.toContain("/Users/");
      expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    }
    expect(mcp!.replaceAll("osen-mcp.mjs", "X")).toBe(council!.replaceAll("council.mjs", "X"));
  });
});
