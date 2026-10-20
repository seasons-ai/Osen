import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseClaudeOutput, parseCodexOutput } from "../../src/cli-agents/output-parse.ts";
import { NEUTRAL_REPLY, TURN_FIXTURE_DIR, findPersonalData } from "../../src/cli-agents/turn-fixtures.ts";

const repo = resolve(import.meta.dirname, "../../../..");
const script = join(import.meta.dirname, "capture.ts");
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "capture-test-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const capture = (args: string[]) => spawnSync(process.execPath, [script, ...args], {
  cwd: repo, encoding: "utf8", input: "", timeout: 120_000,
  env: { ...process.env, COUNCIL_DEV: "1", COUNCIL_LANG: "en" },
});

describe("fixture capture script", () => {
  it("refuses to run without a mode", () => {
    const out = tmp();
    const r = capture(["--out", out]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Usage");
    expect(readdirSync(out)).toEqual([]);
  });

  it.each([[[]], [["--max-calls", "1"]]])("refuses --real without a usable --max-calls (%j) before starting any process", (extra) => {
    const out = tmp();
    const r = capture(["--real", "--out", out, ...extra]);
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain("mode:");
    expect(readdirSync(out)).toEqual([]);
  });

  it("--stub writes anonymized, parsable fixtures and never touches the repository fixtures folder", () => {
    const before = readdirSync(TURN_FIXTURE_DIR).sort();
    const out = tmp();
    const r = capture(["--stub", "--out", out]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("0 model calls");
    expect(r.stdout.match(/anonymization: ok/g)).toHaveLength(2);
    expect(readdirSync(out).sort()).toEqual(["claude-2.1.288-turn.json", "codex-0.159.2-turn.jsonl"]);
    const claude = readFileSync(join(out, "claude-2.1.288-turn.json"), "utf8");
    const codex = readFileSync(join(out, "codex-0.159.2-turn.jsonl"), "utf8");
    for (const text of [claude, codex]) {
      expect(findPersonalData(text)).toEqual([]);
      expect(text).toContain(JSON.stringify(JSON.stringify(NEUTRAL_REPLY)).slice(1, -1));
    }
    expect(parseClaudeOutput(claude, "2.1.288").ok).toBe(true);
    expect(parseCodexOutput(codex, "0.159.2").ok).toBe(true);
    expect(readdirSync(TURN_FIXTURE_DIR).sort()).toEqual(before);
  });
});
