import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// A real council process on the stand entry (acceptance stub as codex 9.9.9), stopped by a signal in the middle of the first probe.
const entry = join(import.meta.dirname, "../scenarios/cli-acceptance/council-test.ts");
const tmps: string[] = [];
const stubPids = (log: string): number[] => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map(Number) : [];
const alive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms: number) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await sleep(50); return f(); };

afterEach(() => {
  for (const d of tmps.splice(0)) {
    for (const pid of stubPids(join(d, "stub.log"))) { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }
    const pidFile = join(d, "child.pid");
    if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already gone */ } }
    rmSync(d, { recursive: true, force: true });
  }
});

function council(args: string[], home: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [entry, ...args], {
    env: { PATH: `/usr/bin:/bin:${dirname(process.execPath)}`, HOME: home, COUNCIL_HOME: home, COUNCIL_DEV: "1", COUNCIL_LANG: "en", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  child.stdout.resume();
  const done = new Promise<{ code: number | null; signal: string | null }>((res) => child.on("close", (code, signal) => res({ code, signal })));
  return { child, done, stderr: () => err };
}

describe.each(["SIGTERM", "SIGHUP"] as const)("council cli accept stopped by %s", (sig) => {
  it("finishes the probe group, skips later probes, says interrupted, records nothing, exits 1", async () => {
    const home = mkdtempSync(join(tmpdir(), "cli-accept-sig-"));
    tmps.push(home);
    const log = join(home, "stub.log");
    const install = council(["cli", "install", "codex", "--version", "9.9.9", "--candidate"], home);
    expect((await install.done).code, install.stderr()).toBe(0);

    const accept = council(["cli", "accept", "codex", "9.9.9", "--candidate", "--max-calls", "7"], home, { STUB_MODE: "slow", STUB_LOG: log });
    expect(await until(() => stubPids(log).length > 0, 30_000)).toBe(true);
    const pid = stubPids(log)[0]!;
    accept.child.kill(sig);
    const { code, signal } = await accept.done;

    expect(signal).toBeNull();
    expect(code).toBe(1);
    expect(accept.stderr().toLowerCase()).toContain("interrupted");
    expect(await until(() => !alive(pid), 5000)).toBe(true);
    expect(stubPids(log)).toHaveLength(1);
    const record = join(home, "cli-verified.json");
    const entries = existsSync(record) ? JSON.parse(readFileSync(record, "utf8")).entries : [];
    expect(entries.filter((e: { level: string }) => e.level === "real")).toEqual([]);
  }, 60_000);
});

// The stub hangs while the CLI reads its help (or feature list) before the first probe, with a non-detached child `sleep 30`.
describe.each([
  ["SIGTERM", "help_hang"], ["SIGHUP", "help_hang"], ["SIGTERM", "features_hang"], ["SIGHUP", "features_hang"],
] as const)("council cli accept stopped by %s while the CLI reads its help or features (%s)", (sig, mode) => {
  it("stops the reading process with its group, runs no probe, says interrupted, records nothing, exits 1", async () => {
    const home = mkdtempSync(join(tmpdir(), "cli-accept-sig-"));
    tmps.push(home);
    const log = join(home, "stub.log");
    const pidFile = join(home, "child.pid");
    const install = council(["cli", "install", "codex", "--version", "9.9.9", "--candidate"], home);
    expect((await install.done).code, install.stderr()).toBe(0);

    const accept = council(["cli", "accept", "codex", "9.9.9", "--candidate", "--max-calls", "7"], home, { STUB_MODE: mode, STUB_LOG: log, STUB_PIDFILE: pidFile });
    expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "", 30_000)).toBe(true);
    const child = Number(readFileSync(pidFile, "utf8"));
    const childAlive = () => { try { process.kill(child, 0); return true; } catch { return false; } };
    expect(childAlive()).toBe(true);
    accept.child.kill(sig);
    const { code, signal } = await accept.done;

    expect(signal).toBeNull();
    expect(code).toBe(1);
    expect(accept.stderr().toLowerCase()).toContain("interrupted");
    expect(await until(() => !childAlive(), 5000)).toBe(true);
    expect(stubPids(log)).toEqual([]);
    const record = join(home, "cli-verified.json");
    const entries = existsSync(record) ? JSON.parse(readFileSync(record, "utf8")).entries : [];
    expect(entries.filter((e: { level: string }) => e.level === "real")).toEqual([]);
  }, 60_000);
});
