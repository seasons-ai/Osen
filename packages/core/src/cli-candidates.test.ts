import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./cli.ts";
import type { ReleaseSource } from "./cli-agents/candidates.ts";
import type { PackageSource } from "./cli-agents/pins.ts";
import type { VerifiedEntry } from "./cli-agents/verified-record.ts";
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
      writeFileSync(exe, `#!/bin/sh\n${body}\n`);
      chmodSync(exe, 0o755);
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
  });

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
    expect(r.err).toContain("interrupted");
    expect(existsSync(join(h, "cli-verified.json"))).toBe(false);
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
