import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./cli.ts";
import { writeAcceptanceStub } from "./cli-agents/acceptance-stub.fixture.ts";
import { pinsPath } from "./cli-agents/pins.ts";
import type { PackageSource } from "./cli-agents/pins.ts";
import type { VerifiedRecord } from "./cli-agents/verified-record.ts";
import { setProcessLanguage } from "./i18n/index.ts";

// The stub answers --version, --help and `features list` with the real fixture texts, so install and inspection pass without a real CLI.
const fx = (name: string) => readFileSync(new URL(`./cli-agents/fixtures/${name}`, import.meta.url), "utf8");
const source: PackageSource = {
  async fetch(agent, version, dir) {
    const bin = join(dir, "node_modules", "pkg", "bin");
    mkdirSync(bin, { recursive: true });
    const exe = writeAcceptanceStub(bin, agent === "codex"
      ? { version: `codex-cli ${version}`, help: fx("codex-0.159.2-exec-help.txt"), features: fx("codex-0.159.2-features.txt") }
      : { version: `${version} (Claude Code)`, help: fx("claude-2.1.288-help.txt") });
    return { executable: exe, source: `fake:${agent}@${version}` };
  },
};

// No version is recorded as real: 9.9.9 needs --candidate to be accepted.
const record: VerifiedRecord = { entries: [] };
const PROBE_TIMEOUT = 120_000;

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
afterEach(() => setProcessLanguage("ru"));

async function run(argv: string[], home: string, extra: { env?: Record<string, string>; signal?: AbortSignal; onStdout?: (text: string) => void; ownRecord?: boolean } = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, {
    stdout: (t) => { out.push(t); extra.onStdout?.(t); },
    stderr: (t) => err.push(t),
    env: { COUNCIL_HOME: home, COUNCIL_DEV: "1", ...extra.env },
    ...(extra.signal ? { signal: extra.signal } : {}),
    cliPin: extra.ownRecord ? { source } : { source, record }, // ownRecord: the record of the data folder is read, as in the terminal
  });
  return { code, out: out.join(""), err: err.join("") };
}
const home = () => { const d = mkdtempSync(join(tmpdir(), "cli-accept-")); tmps.push(d); return d; };
const verifiedPath = (h: string) => join(h, "cli-verified.json");
const realEntries = (h: string) => existsSync(verifiedPath(h)) ? JSON.parse(readFileSync(verifiedPath(h), "utf8")).entries.filter((e: { level: string }) => e.level === "real") : [];
const probeLines = (text: string) => text.split("\n").filter((l) => /^\s+\d+\. /.test(l) || /^\d+\. /.test(l));

/** Files of the installed 9.9.9 stub: every path under cli/codex/9.9.9 that is named cli-stub.js. */
function findStub(dir: string): string | undefined {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      const found = findStub(p);
      if (found) return found;
    } else if (e === "cli-stub.js") return p;
  }
  return undefined;
}

/** Lines of the logs that record a probe; a plan refusal or a usage error writes none. */
const probeLogLines = (h: string): string[] => {
  const log = join(h, "logs", "app.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.includes("probe=")) : [];
};

const installCandidate = async (h: string) => {
  const r = await run(["cli", "install", "codex", "--version", "9.9.9", "--candidate"], h);
  expect(r.code, r.err).toBe(0);
};

describe("council cli accept", () => {
  beforeEach(() => setProcessLanguage("en"));

  it("plan without consent: prints the plan and the bound 7, exit 2, no probe, nothing recorded", async () => {
    const h = home();
    await installCandidate(h);
    const r = await run(["cli", "accept", "codex", "9.9.9", "--candidate"], h);
    expect(r.code).toBe(2);
    expect(r.out).toContain("Upper bound of model calls: 7");
    expect(r.out).toContain("Version: 9.9.9");
    expect(r.out).toContain("sha256:");
    expect(probeLogLines(h)).toEqual([]);
    expect(existsSync(verifiedPath(h))).toBe(false);
  });

  it("consent to another bound: --max-calls 6 and 8 are refused with the exact bound 7, exit 2, no probe", async () => {
    const h = home();
    await installCandidate(h);
    for (const n of ["6", "8"]) {
      const r = await run(["cli", "accept", "codex", "9.9.9", "--candidate", "--max-calls", n], h);
      expect(r.code, n).toBe(2);
      expect(r.err, n).toContain("upper bound of model calls, 7");
    }
    expect(probeLogLines(h)).toEqual([]);
    expect(existsSync(verifiedPath(h))).toBe(false);
  });

  it("version not installed: refused with the reason and the install command, exit 2, nothing installed", async () => {
    const h = home();
    const r = await run(["cli", "accept", "codex", "9.9.8", "--candidate", "--max-calls", "7"], h);
    expect(r.code).toBe(2);
    expect(r.err).toContain("not installed");
    expect(r.err).toContain("council cli install codex --version 9.9.8");
    expect(existsSync(join(h, "cli"))).toBe(false);
    expect(probeLogLines(h)).toEqual([]);
  });

  it("installed file changed: sha256 mismatch refused, exit 2, no plan, no probe", async () => {
    const h = home();
    await installCandidate(h);
    appendFileSync(findStub(join(h, "cli", "codex", "9.9.9"))!, "\n// changed\n");
    const r = await run(["cli", "accept", "codex", "9.9.9", "--candidate", "--max-calls", "7"], h);
    expect(r.code).toBe(2);
    expect(r.err).toContain("sha256");
    expect(r.out).not.toContain("Upper bound");
    expect(probeLogLines(h)).toEqual([]);
  });

  it("version without a real record: accept without --candidate is refused, exit 2, no probe", async () => {
    const h = home();
    await installCandidate(h);
    const r = await run(["cli", "accept", "codex", "9.9.9", "--max-calls", "7"], h);
    expect(r.code).toBe(2);
    expect(r.err).toContain("not real");
    expect(probeLogLines(h)).toEqual([]);
    expect(existsSync(verifiedPath(h))).toBe(false);
  });

  it("wrong arguments: reason and usage in stderr, exit 2, cli folder and sessions unchanged", async () => {
    const h = home();
    for (const argv of [
      ["cli", "accept", "codex"],
      ["cli", "install", "claude", "--max-calls", "7"],
      ["cli", "list", "--model", "x"],
      ["run", "--save-fixture", "x"],
      ["cli", "accept", "codex", "9.9.9", "--candidate", "--max-calls", "abc"],
      ["cli", "accept", "codex", "9.9.9", "--candidate", "--max-calls", "0"],
    ]) {
      const r = await run(argv, h);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err, argv.join(" ")).toContain("Usage:");
    }
    expect(existsSync(join(h, "cli"))).toBe(false);
    // a usage error stops before the data folder is prepared: no sessions folder either
    expect(existsSync(join(h, "sessions"))).toBe(false);
  });

  it("all probes passed: exit 0, seven probe lines, one real entry with 7 calls; list shows real", async () => {
    const h = home();
    await installCandidate(h);
    const r = await run(["cli", "accept", "codex", "9.9.9", "--candidate", "--max-calls", "7"], h);
    expect(r.code, r.err).toBe(0);
    const lines = probeLines(r.out);
    expect(lines).toHaveLength(7);
    for (const l of lines) expect(l).toMatch(/: ok$/);
    const real = realEntries(h);
    expect(real).toHaveLength(1);
    expect(real[0]).toMatchObject({ agent: "codex", version: "9.9.9", level: "real", modelCalls: 7 });
    expect(readdirSync(join(h, "sessions"))).toEqual([]);

    const list = await run(["cli", "list"], h, { ownRecord: true });
    expect(list.code).toBe(0);
    expect(list.out).toMatch(/9\.9\.9[\s\S]*real/);
  }, PROBE_TIMEOUT);

  it.each([
    ["not JSON", "{bad"],
    ["schema-invalid", JSON.stringify({ schemaVersion: 1, entries: [{ agent: "codex", version: "x" }] })],
  ])("corrupted verified record (%s): refused before the plan with the file path, exit 1, no probe, file unchanged", async (_label, bytes) => {
    const h = home();
    await installCandidate(h);
    writeFileSync(verifiedPath(h), bytes);
    const r = await run(["cli", "accept", "codex", "9.9.9", "--candidate", "--max-calls", "7"], h, { ownRecord: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain(verifiedPath(h));
    expect(probeLines(r.out)).toEqual([]);
    expect(probeLogLines(h)).toEqual([]);
    expect(readFileSync(verifiedPath(h), "utf8")).toBe(bytes);
  }, PROBE_TIMEOUT);

  it("re-acceptance: one entry with the data of the second run, the summary matches the file", async () => {
    const h = home();
    await installCandidate(h);
    const old = { agent: "codex", version: "9.9.9", level: "real", checkedAt: "2026-10-01", os: "old-os", osenVersion: "0.0.1", modelCalls: 3 };
    writeFileSync(verifiedPath(h), JSON.stringify({ schemaVersion: 1, entries: [old] }));
    const r = await run(["cli", "accept", "codex", "9.9.9", "--candidate", "--max-calls", "7"], h, { ownRecord: true });
    expect(r.code, r.err).toBe(0);
    const real = realEntries(h);
    expect(real).toHaveLength(1);
    expect(real[0].checkedAt).toBe(new Date().toISOString().slice(0, 10));
    expect(real[0].os).not.toBe("old-os");
    expect(real[0].osenVersion).not.toBe("0.0.1");
    expect(real[0].modelCalls).toBe(7);
    expect(r.out).toContain(`model calls: ${real[0].modelCalls}`);
  }, PROBE_TIMEOUT);

  it("a probe failed: exit 5, the instructions probe is named, later probes not run, no real entry", async () => {
    const h = home();
    await installCandidate(h);
    const r = await run(["cli", "accept", "codex", "9.9.9", "--candidate", "--max-calls", "7"], h, { env: { STUB_MODE: "leak" } });
    expect(r.code).toBe(5);
    expect(r.err).toContain("user and project instructions");
    // the instructions probe is the fifth; the stop and resume probes after it are not run
    const lines = probeLines(r.out);
    expect(lines).toHaveLength(5);
    expect(lines[4]).toContain("user and project instructions");
    expect(realEntries(h)).toEqual([]);
  }, PROBE_TIMEOUT);

  it("stop of the command during the stop probe: exit 1, interrupted, no real entry", async () => {
    const h = home();
    await installCandidate(h);
    const controller = new AbortController();
    let armed = false;
    const r = await run(["cli", "accept", "codex", "9.9.9", "--candidate", "--max-calls", "7"], h, {
      signal: controller.signal,
      // the fifth probe line is printed when the instructions probe ends; the stop probe starts at once and its first chunk comes after about 300 ms
      onStdout: (t) => {
        if (!armed && t.includes("5. user and project instructions")) {
          armed = true;
          setTimeout(() => controller.abort(), 100);
        }
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("interrupted");
    expect(probeLines(r.out).some((l) => /^\s*6\. /.test(l))).toBe(false);
    expect(realEntries(h)).toEqual([]);
  }, PROBE_TIMEOUT);

  it("--save-fixture: the anonymized valid turn is written as codex-9.9.9-turn.jsonl", async () => {
    const h = home();
    await installCandidate(h);
    const fixtures = join(h, "fx");
    const r = await run(["cli", "accept", "codex", "9.9.9", "--candidate", "--max-calls", "7", "--save-fixture", fixtures], h);
    expect(r.code, r.err).toBe(0);
    expect(readdirSync(fixtures)).toEqual(["codex-9.9.9-turn.jsonl"]);
    expect(readFileSync(join(fixtures, "codex-9.9.9-turn.jsonl"), "utf8").length).toBeGreaterThan(0);
  }, PROBE_TIMEOUT);

  it("without --save-fixture only the local record and the log appear in the data folder", async () => {
    const h = home();
    await installCandidate(h);
    // relative path and content of every file: an added or rewritten file outside the record and the log is a failure
    const tree = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((e) => statSync(join(dir, e)).isFile())
      .map((e) => (e === "cli-verified.json" || e.startsWith("logs/") ? e : `${e} ${readFileSync(join(dir, e), "base64")}`)).sort();
    const before = tree(h);
    const r = await run(["cli", "accept", "codex", "9.9.9", "--candidate", "--max-calls", "7"], h);
    expect(r.code, r.err).toBe(0);
    const added = tree(h).filter((e) => !before.includes(e));
    expect(added.filter((e) => e !== "cli-verified.json" && !e.startsWith("logs/"))).toEqual([]);
    expect(added).toContain("cli-verified.json");
  }, PROBE_TIMEOUT);

  it("help lists cli accept in en and ru", async () => {
    for (const [lang, folder] of [["en", "<folder>"], ["ru", "<папка>"]] as const) {
      setProcessLanguage(lang);
      const r = await run(["--help"], home());
      expect(r.code).toBe(0);
      expect(r.out).toContain(`council cli accept <agent> <version> [--candidate] [--model <id>] [--max-calls <N>] [--save-fixture ${folder}]`);
    }
  });
});
