import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./cli.ts";
import { OWNER_FILE, sweepCandidateLeftovers } from "./cli-agents/candidates.ts";
import type { ReleaseSource } from "./cli-agents/candidates.ts";
import type { PackageSource } from "./cli-agents/pins.ts";
import type { VerifiedEntry } from "./cli-agents/verified-record.ts";
import { writeExecutable } from "./executable.testutil.ts";
import { setProcessLanguage } from "./i18n/index.ts";

const FIX = join(import.meta.dirname, "cli-agents", "fixtures");
const CLAUDE_HELP = join(FIX, "claude-2.1.288-help.txt");
const CODEX_HELP = join(FIX, "codex-0.159.2-exec-help.txt");
const CODEX_FEATURES = join(FIX, "codex-0.159.2-features.txt");

const real = (agent: "claude" | "codex", version: string): VerifiedEntry => ({ agent, version, level: "real", checkedAt: "2026-10-20", os: "darwin-arm64", osenVersion: "1.0.0", modelCalls: 2 });
const builtin = [real("claude", "2.1.288")];

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
afterEach(() => setProcessLanguage("ru"));
beforeEach(() => setProcessLanguage("en"));
const home = () => { const d = mkdtempSync(join(tmpdir(), "cli-cand-")); tmps.push(d); return d; };

// the claude fixture without the --tools option (a violating candidate)
const noTools = (() => {
  const d = mkdtempSync(join(tmpdir(), "cli-cand-fix-"));
  tmps.push(d);
  const lines = readFileSync(CLAUDE_HELP, "utf8").split("\n");
  const i = lines.findIndex((l) => l.startsWith("  --tools "));
  const f = join(d, "help.txt");
  writeFileSync(f, [...lines.slice(0, i), ...lines.slice(i + 5)].join("\n"));
  return f;
})();

const releases = (m: Record<string, string[]>): ReleaseSource => ({ list: async (agent) => m[agent] ?? [] });

// stub CLI: answers --version, --help (claude) or exec --help / features list (codex)
function source(violating: string[] = [], onFetch?: () => void | Promise<void>): PackageSource {
  return {
    async fetch(agent, version, dir) {
      await onFetch?.();
      const bin = join(dir, "node_modules", "pkg", "bin");
      mkdirSync(bin, { recursive: true });
      const exe = join(bin, agent);
      const help = agent === "claude" ? (violating.includes(version) ? noTools : CLAUDE_HELP) : CODEX_HELP;
      const body = agent === "claude"
        ? `case "$1" in --version) echo "${version} (Claude Code)";; *) cat '${help}';; esac`
        : `case "$1" in --version) echo "codex-cli ${version}";; features) cat '${CODEX_FEATURES}';; *) cat '${help}';; esac`;
      writeExecutable(exe, `#!/bin/sh\n${body}\n`);
      return { executable: exe, source: `fake:${agent}@${version}` };
    },
  };
}

async function run(argv: string[], h: string, pin: Record<string, unknown> = {}, extra: { signal?: AbortSignal } = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env: { COUNCIL_HOME: h, COUNCIL_DEV: "1" }, cliPin: { builtin, releases: releases({ claude: ["2.1.288", "2.1.300", "2.1.301"] }), source: source(["2.1.301"]), ...pin }, ...extra });
  return { code, out: out.join(""), err: err.join(""), outChunks: out };
}

describe("council cli candidates", () => {
  it("machine output: --json is byte-identical in en and ru, valid, language-independent", async () => {
    const outs: string[] = [];
    for (const lang of ["en", "ru"] as const) {
      setProcessLanguage(lang);
      const r = await run(["cli", "candidates", "--agent", "claude", "--json"], home());
      expect(r.code).toBe(0);
      expect(r.outChunks).toHaveLength(1);
      outs.push(r.out);
    }
    expect(outs[0]).toBe(outs[1]);
    expect(outs[0]).not.toMatch(/[А-Яа-я]/);
    const doc = JSON.parse(outs[0]!);
    expect(doc).toEqual({
      schemaVersion: 1,
      candidates: [
        { agent: "claude", version: "2.1.300", status: "ok", violations: [], recorded: true },
        { agent: "claude", version: "2.1.301", status: "violates", violations: [{ code: "missing_flag", name: "--tools" }], recorded: false },
      ],
      failures: [],
    });
  }, 60_000);

  it("contract violation: named in the text output, not recorded, exit 0, no leftovers", async () => {
    const h = home();
    const r = await run(["cli", "candidates", "--agent", "claude"], h);
    expect(r.code).toBe(0);
    expect(r.out).toContain("claude (base 2.1.288)");
    expect(r.out).toContain("2.1.300  fits");
    expect(r.out).toContain("2.1.301  violates the contract");
    expect(r.out).toContain("flag --tools is not declared");
    const rec = JSON.parse(readFileSync(join(h, "cli-verified.json"), "utf8"));
    expect(JSON.stringify(rec)).toContain("2.1.300");
    expect(JSON.stringify(rec)).not.toContain("2.1.301");
    expect(existsSync(join(h, "cli-candidates"))).toBe(false);
    expect(existsSync(join(h, "cli"))).toBe(false);
  });

  it("labels differ between en and ru", async () => {
    setProcessLanguage("ru");
    const r = await run(["cli", "candidates", "--agent", "claude"], home());
    expect(r.out).toContain("2.1.300  подходит");
    expect(r.out).toContain("2.1.301  нарушает контракт");
    expect(r.out).toContain("флаг --tools не объявлен");
  });

  it("argument errors exit 2", async () => {
    const h = home();
    for (const argv of [["cli", "candidates", "--agent", "x"], ["list", "--agent", "claude"], ["cli", "candidates", "extra"], ["cli", "install", "claude", "--agent", "claude"], ["cli", "candidates", "--version", "1.0.0"], ["cli", "candidates", "--candidate"], ["cli", "list", "--json"]]) {
      const r = await run(argv, h);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.out, argv.join(" ")).toBe("");
      expect(r.err, argv.join(" ")).toMatch(/\S/);
    }
    expect(existsSync(join(h, "cli-candidates"))).toBe(false);
  });

  it("interrupted: exit 1, stdout empty, nothing recorded, no leftovers", async () => {
    const h = home();
    const ac = new AbortController();
    const r = await run(["cli", "candidates", "--agent", "claude", "--json"], h, { source: source([], () => ac.abort()) }, { signal: ac.signal });
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("The check was interrupted; temporary installs were removed, nothing was recorded.");
    expect(existsSync(join(h, "cli-verified.json"))).toBe(false);
    expect(existsSync(join(h, "cli-candidates"))).toBe(false);
  });

  it("interruption after a recorded candidate names the recorded pair, not \"nothing was recorded\"", async () => {
    const h = home();
    const ac = new AbortController();
    let fetches = 0;
    const r = await run(["cli", "candidates", "--agent", "claude", "--json"], h, { releases: releases({ claude: ["2.1.288", "2.1.290", "2.1.291"] }), source: source([], () => { if (++fetches === 2) ac.abort(); }) }, { signal: ac.signal });
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("claude 2.1.290");
    expect(r.err).not.toContain("2.1.291");
    expect(r.err).not.toContain("nothing was recorded");
    const entries = (JSON.parse(readFileSync(join(h, "cli-verified.json"), "utf8")) as { entries: VerifiedEntry[] }).entries;
    expect(entries.map((e) => `${e.agent}@${e.version}:${e.level}`)).toEqual(["claude@2.1.290:interface"]);
    expect(existsSync(join(h, "cli-candidates"))).toBe(false);
  });

  it("interruption after a no_base refusal of another agent: exit 1, interruption line, empty stdout (--json)", async () => {
    // claude is checked first, so the refused agent is claude (no built-in entry) and the interrupted one is codex
    const h = home();
    const ac = new AbortController();
    const r = await run(["cli", "candidates", "--json"], h, { builtin: [real("codex", "0.159.2")], releases: releases({ claude: ["2.1.300"], codex: ["0.159.2", "0.160.0"] }), source: source([], () => ac.abort()) }, { signal: ac.signal });
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("The check was interrupted; temporary installs were removed, nothing was recorded.");
    expect(existsSync(join(h, "cli-candidates"))).toBe(false);
  });

  it("no base version: exit 2 and nothing installed", async () => {
    const h = home();
    const r = await run(["cli", "candidates", "--agent", "claude"], h, { builtin: [] });
    expect(r.code).toBe(2);
    expect(r.err).toContain("No base version for claude");
    expect(existsSync(join(h, "cli-candidates"))).toBe(false);
  });

  it("--agent codex checks only codex", async () => {
    const r = await run(["cli", "candidates", "--agent", "codex"], home(), { builtin: [real("claude", "2.1.288"), real("codex", "0.159.2")], releases: releases({ claude: ["2.1.300"], codex: ["0.159.2", "0.160.0"] }) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("codex (base 0.159.2)");
    expect(r.out).toContain("0.160.0  fits");
    expect(r.out).not.toContain("claude");
  });
});

// ---- signals and leftovers (change 201) ----
const STAND_ENTRY = join(import.meta.dirname, "..", "scenarios", "cli-candidates", "council-test.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Real council process on the stand entry; the install of `slowOnly` takes 20 s; `signal` is sent once its prefix exists. */
async function standSignal(signal: NodeJS.Signals, releasesList: string[], slowOnly: string, waitPrefix: string, h: string) {
  const w = home();
  const releasesFile = join(w, "releases.json");
  writeFileSync(releasesFile, JSON.stringify({ claude: releasesList, codex: [] }));
  const log = join(w, "source.jsonl");
  writeFileSync(log, "");
  const env = {
    PATH: "/usr/bin:/bin", HOME: w, COUNCIL_HOME: h, COUNCIL_DEV: "1", COUNCIL_LANG: "en",
    CLI_CANDIDATES_STAND: JSON.stringify({ releases: releasesFile, counter: join(w, "counters"), log, slowInstallMs: 20_000, slowOnly }),
  };
  const child = spawn(process.execPath, [STAND_ENTRY, "cli", "candidates", "--agent", "claude", "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const exited = new Promise<{ code: number | null; sig: string | null }>((res) => child.on("close", (code, sig) => res({ code, sig })));
  const t0 = Date.now();
  const dir = join(h, "cli-candidates");
  while (!(existsSync(dir) && readdirSync(dir).some((x) => x.startsWith(`${waitPrefix}-`)))) {
    if (Date.now() - t0 > 20_000) { child.kill("SIGKILL"); throw new Error(`prefix did not appear: ${err}`); }
    await sleep(50);
  }
  child.kill(signal);
  const res = await Promise.race([exited, sleep(15_000).then(() => { child.kill("SIGKILL"); return { code: -999, sig: null }; })]);
  return { ...res, out, err };
}

describe("council cli candidates: SIGTERM and SIGHUP", () => {
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    it(`${signal} during the install: exit 1, empty stdout, interruption line, no cli-candidates`, async () => {
      const h = home();
      const r = await standSignal(signal, ["2.1.288", "2.1.290"], "claude@2.1.290", "claude-2.1.290", h);
      expect({ code: r.code, sig: r.sig }).toEqual({ code: 1, sig: null });
      expect(r.out).toBe("");
      expect(r.err).toContain("The check was interrupted; temporary installs were removed, nothing was recorded.");
      expect(existsSync(join(h, "cli-candidates"))).toBe(false);
    }, 40_000);
  }

  it("SIGTERM after a recorded candidate: the line names claude 2.1.290, the record entry stays", async () => {
    const h = home();
    const r = await standSignal("SIGTERM", ["2.1.288", "2.1.290", "2.1.291"], "claude@2.1.291", "claude-2.1.291", h);
    expect({ code: r.code, sig: r.sig }).toEqual({ code: 1, sig: null });
    expect(r.out).toBe("");
    expect(r.err).toContain("claude 2.1.290");
    expect(r.err).not.toContain("nothing was recorded");
    expect(readFileSync(join(h, "cli-verified.json"), "utf8")).toContain('"2.1.290"');
    expect(existsSync(join(h, "cli-candidates"))).toBe(false);
  }, 40_000);
});

describe("council cli candidates: leftovers of a killed run", () => {
  const prefix = (h: string, name: string, owner?: string, ageMs = 0) => {
    const p = join(h, "cli-candidates", name);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "payload"), "x");
    if (owner !== undefined) writeFileSync(join(p, OWNER_FILE), owner);
    const t = new Date(Date.now() - ageMs);
    utimesSync(p, t, t);
    return p;
  };
  const deadPid = () => new Promise<number>((res) => {
    const c = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    c.on("close", () => res(c.pid!));
  });
  const HOUR = 3_600_000;

  it("removes dead-owner and stale no-owner prefixes, keeps live-owner and fresh ones, the folder goes when emptied", async () => {
    const h = home();
    const dead = prefix(h, "claude-2.1.290-dead", String(await deadPid()));
    const stale = prefix(h, "claude-2.1.290-stale", undefined, HOUR + 60_000);
    const staleNum = prefix(h, "claude-2.1.290-nan", "abc", HOUR + 60_000);
    const live = prefix(h, "claude-2.1.290-live", String(process.pid), 5 * HOUR);
    const fresh = prefix(h, "claude-2.1.290-fresh", undefined, 60_000);
    const freshNum = prefix(h, "claude-2.1.290-nanfresh", "abc", 60_000);
    const r = await run(["cli", "candidates", "--agent", "claude", "--json"], h, { releases: releases({ claude: ["2.1.288"] }) });
    expect(r.code).toBe(0);
    for (const p of [dead, stale, staleNum]) expect(existsSync(p), p).toBe(false);
    for (const p of [live, fresh, freshNum]) expect(existsSync(join(p, "payload")), p).toBe(true);
  });

  it("an emptied cli-candidates folder disappears even with no candidate checked", async () => {
    const h = home();
    prefix(h, "claude-2.1.290-dead", String(await deadPid()));
    const r = await run(["cli", "candidates", "--agent", "claude", "--json"], h, { releases: releases({ claude: ["2.1.288"] }) });
    expect(r.code).toBe(0);
    expect(existsSync(join(h, "cli-candidates"))).toBe(false);
  });

  it("each prefix holds owner.pid with the pid of the running process before the install starts", async () => {
    const h = home();
    const base = source();
    const seen: string[] = [];
    const spy: PackageSource = { fetch: async (agent, version, dir, signal) => { seen.push(readFileSync(join(dir, OWNER_FILE), "utf8")); return base.fetch(agent, version, dir, signal); } };
    const r = await run(["cli", "candidates", "--agent", "claude", "--json"], h, { source: spy });
    expect(r.code).toBe(0);
    expect(seen).toEqual([String(process.pid), String(process.pid)]);
  });

  it.skipIf(process.getuid?.() === 0)("an owner pid that answers EPERM (pid 1, another user) counts as alive: the stale prefix stays", async () => {
    const h = home();
    const p = prefix(h, "claude-2.1.290-root", "1", 5 * HOUR);
    await run(["cli", "candidates", "--agent", "claude", "--json"], h, { releases: releases({ claude: ["2.1.288"] }) });
    expect(existsSync(join(p, "payload"))).toBe(true);
  });

  it("a file in place of cli-candidates stays byte-identical", async () => {
    const h = home();
    writeFileSync(join(h, "cli-candidates"), "keep");
    await run(["cli", "candidates", "--agent", "claude", "--json"], h, { releases: releases({ claude: ["2.1.288"] }) });
    expect(readFileSync(join(h, "cli-candidates"), "utf8")).toBe("keep");
  });
});

// Own seeded generator: fast-check is not wired in.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("sweepCandidateLeftovers: property", () => {
  const HOUR = 3_600_000;
  const NOW = 1_800_000_000_000;
  const DEAD = 424242, LIVE = 31337;
  type Kind = "dead" | "live" | "own" | "none" | "nan" | "zero";
  const KINDS: Kind[] = ["dead", "live", "own", "none", "nan", "zero"];
  const AGES = [0, 1000, HOUR - 1, HOUR, HOUR + 1, 2 * HOUR];

  for (let seed = 1; seed <= 60; seed++) {
    it(`seed ${seed}`, () => {
      const rnd = mulberry32(seed);
      const int = (n: number) => Math.floor(rnd() * n);
      const dataDir = home();
      const dir = join(dataDir, "cli-candidates");
      if (int(8) !== 0) mkdirSync(dir, { recursive: true });
      const count = existsSync(dir) ? int(9) : 0;
      const items: { path: string; kind: Kind; age: number }[] = [];
      for (let i = 0; i < count; i++) {
        const kind = KINDS[int(KINDS.length)]!, age = AGES[int(AGES.length)]!;
        const path = join(dir, `claude-2.1.${i}-s${i}`);
        mkdirSync(path);
        const content = kind === "dead" ? String(DEAD) : kind === "live" ? String(LIVE) : kind === "own" ? String(process.pid) : kind === "nan" ? "abc" : kind === "zero" ? "0" : undefined;
        if (content !== undefined) writeFileSync(join(path, OWNER_FILE), `${content}\n`);
        const t = new Date(NOW - age);
        utimesSync(path, t, t);
        items.push({ path, kind, age });
      }
      if (existsSync(dir) && rnd() < 0.3) writeFileSync(join(dir, "stray-file"), "x"); // non-directory entries are left alone
      const throwing = items.length && rnd() < 0.5 ? items[int(items.length)]!.path : undefined;
      const removed: string[] = [];
      const opts = {
        now: () => NOW,
        alive: (pid: number) => pid !== DEAD,
        remove: (p: string) => { if (p === throwing) throw new Error("EBUSY"); removed.push(p); rmSync(p, { recursive: true, force: true }); },
      };
      const shouldGo = (x: { kind: Kind; age: number }) => x.kind === "dead" || ((x.kind === "none" || x.kind === "nan" || x.kind === "zero") && x.age > HOUR);
      const expected = items.filter((x) => shouldGo(x) && x.path !== throwing).map((x) => x.path).sort();
      expect(() => sweepCandidateLeftovers(dataDir, opts)).not.toThrow();
      expect(removed.sort()).toEqual(expected);
      for (const x of items) if (!shouldGo(x)) expect(existsSync(x.path), `${x.kind} age ${x.age}`).toBe(true);
      const after = existsSync(dir) ? readdirSync(dir).sort() : [];
      sweepCandidateLeftovers(dataDir, { ...opts, remove: (p) => { if (p !== throwing) removed.push(`again:${p}`); } });
      expect(removed.filter((p) => p.startsWith("again:"))).toEqual([]);
      expect(existsSync(dir) ? readdirSync(dir).sort() : []).toEqual(after);
    });
  }
});
