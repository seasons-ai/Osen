// Check of `council cli accept` with the real council CLI and a codex stub (node script, 0 model calls, no network):
//   COUNCIL_DEV=1 node packages/core/scenarios/cli-acceptance/check.ts
// Each run spawns council-test.ts, whose substitute package source installs the acceptance stub as codex 9.9.9 into the data folder.
// Children get PATH = the stand bin folder + /usr/bin:/bin, a fake SHELL and the owner's HOME (the pinned environment points
// the probes at the pinned config folder). The real claude and codex are never launched.
// Data lives in COUNCIL_HOME (must be inside the repository) or in <repository>/.council-data/cli-acceptance-*;
// deleted on success, kept on failure. Each step uses a fresh sub-home under homes/.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { findPersonalData } from "../../src/cli-agents/turn-fixtures.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Run: COUNCIL_DEV=1 node packages/core/scenarios/cli-acceptance/check.ts");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
const entry = join(import.meta.dirname, "council-test.ts");
const given = process.env.COUNCIL_HOME ? resolve(process.env.COUNCIL_HOME) : undefined;
if (given && relative(repo, given).startsWith("..")) {
  console.error(`COUNCIL_HOME must be inside the repository (${repo}): ${given}`);
  process.exit(2);
}
const work = given ?? join(repo, ".council-data", `cli-acceptance-${Date.now()}-${randomBytes(3).toString("hex")}`);
const bin = join(work, "bin"), logs = join(work, "turns"), states = join(work, "state"), pidDir = join(work, "pids");
for (const d of [bin, logs, states, pidDir]) mkdirSync(d, { recursive: true });
const fakeShell = join(bin, "fake-shell");
writeFileSync(fakeShell, "#!/bin/sh\nexit 0\n");
chmodSync(fakeShell, 0o755);
const CYR = /[А-Яа-яЁё]/;
const PROBES = 7;
// Modes of the stub that must fail: the probe that fails is the one at `index` (1-based), so the stub is launched `index` times.
const FAIL_MODES = [
  { mode: "leak", index: 5, name: "user and project instructions" },
  { mode: "tool", index: 3, name: "tool call" },
  { mode: "mcp", index: 4, name: "MCP server" },
  { mode: "survive", index: 6, name: "stop in the middle of a turn" },
  { mode: "err", index: 1, name: "valid turn" },
  { mode: "resume_fail", index: 7, name: "turn after the stop" },
] as const;

let n = 0;
const ok = (s: string) => console.log(`ok ${++n}: ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
/** Hash of a folder tree: relative paths, kinds and file bytes. */
function treeHash(dir: string): string {
  const lines: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { lines.push(`d ${relative(dir, p)}`); walk(p); } else lines.push(`f ${relative(dir, p)} ${hash(readFileSync(p))}`);
    }
  };
  if (existsSync(dir)) walk(dir); else lines.push("absent");
  return hash(lines.join("\n"));
}
/** Path of the installed stub file: the file named cli-stub.js under the 9.9.9 folder. */
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
const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

interface Result { code: number; out: string; err: string; tag: string }
interface RunOpts { lang?: "en" | "ru"; mode?: string; onSpawn?: (child: ChildProcess, tag: string) => void }
let runNo = 0;
function run(home: string, args: string[], o: RunOpts = {}): Promise<Result> {
  const tag = `run-${String(++runNo).padStart(3, "0")}`;
  const state = join(states, tag);
  mkdirSync(state, { recursive: true });
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: homedir(), SHELL: fakeShell, COUNCIL_HOME: home, COUNCIL_DEV: "1", COUNCIL_LANG: o.lang ?? "en",
    STUB_MODE: o.mode ?? "good", STUB_LOG: join(logs, `${tag}.log`), STUB_STATE: state, STUB_PIDFILE: join(pidDir, `${tag}.pid`),
  };
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [entry, ...args], { env, cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    o.onSpawn?.(child, tag);
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const timer = setTimeout(() => { child.kill("SIGKILL"); rej(new Error(`timeout: council ${args.join(" ")}`)); }, 120_000);
    child.on("close", (code) => { clearTimeout(timer); res({ code: code ?? -1, out, err, tag }); });
  });
}
/** Pids of the stub launches of one run: one line per turn launch (the stub writes it before anything else). */
const turnPids = (r: { tag: string }): number[] => {
  const f = join(logs, `${r.tag}.log`);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map(Number) : [];
};
const probeLines = (t: string) => t.split("\n").filter((l) => /^\d+\. /.test(l)); // results: printed without indent
const planLines = (t: string) => t.split("\n").filter((l) => /^\s+\d+\. /.test(l)); // the plan lists the probes indented
const H = (name: string): string => {
  const d = join(work, "homes", name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
};
const installed = (home: string) => JSON.parse(readFileSync(join(home, "cli", "pins.json"), "utf8")).agents.codex.installed.find((i: { version: string }) => i.version === "9.9.9") as { sha256: string };
const stubOf = (home: string) => findStub(join(home, "cli", "codex", "9.9.9"));
/** Real entries of the data folder's record; none when the file was never written. */
const realOf = (home: string): { agent: string; version: string; checkedAt: string; os: string; osenVersion: string; sha256: string; modelCalls: number; level: string }[] => {
  const f = join(home, "cli-verified.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).entries.filter((e: { level: string }) => e.level === "real") : [];
};
const install = async (home: string): Promise<void> => {
  const r = await run(home, ["cli", "install", "codex", "--version", "9.9.9", "--candidate"]);
  assert.equal(r.code, 0, r.err);
};
const accept = (home: string, extra: string[], o: RunOpts = {}): Promise<Result> => run(home, ["cli", "accept", "codex", "9.9.9", ...extra], o);
// the owner's agent folders: only top-level names are listed, contents are never read
const owner = ["/.claude", "/.codex"].map((d) => homedir() + d);
const ownerNames = () => owner.map((p) => { try { return `${p}:${readdirSync(p).filter((x) => !x.endsWith(".tmp")).sort().join(",")}`; } catch { return `${p}:absent`; } });
const namesBefore = ownerNames();

let success = false;
try {
  // ---- 1: the plan ----
  const h1 = H("plan");
  await install(h1);
  const stub = stubOf(h1)!;
  const r1 = await accept(h1, ["--candidate"]);
  assert.equal(r1.code, 2, r1.err);
  assert.match(r1.out, /^Version: 9\.9\.9$/m);
  assert.ok(r1.out.includes(`Path: ${stub}`), r1.out);
  assert.ok(r1.out.includes(`sha256: ${installed(h1).sha256}`), r1.out);
  assert.equal(planLines(r1.out).length, PROBES, r1.out);
  assert.ok(r1.out.includes("Upper bound of model calls: 7"), r1.out);
  assert.deepEqual(probeLines(r1.out), []);
  ok("plan: version 9.9.9, path and sha256 equal to the install record, 7 probes, upper bound 7; exit 2");
  assert.deepEqual(turnPids(r1), []);
  assert.equal(existsSync(join(h1, "cli-verified.json")), false);
  ok("plan: no stub launch (turn counter 0), no probe line, cli-verified.json not created");

  // ---- 2: refusals ----
  for (const bound of ["6", "8"]) {
    const r = await accept(h1, ["--candidate", "--max-calls", bound]);
    assert.equal(r.code, 2, r.err);
    assert.ok(r.err.includes("upper bound of model calls, 7"), r.err);
    assert.deepEqual(turnPids(r), []);
  }
  ok("--max-calls 6 and --max-calls 8: exit 2, stderr names the bound 7, no stub launch");
  const r2c = await run(h1, ["cli", "accept", "codex", "9.9.8", "--candidate", "--max-calls", "7"]);
  assert.equal(r2c.code, 2);
  assert.match(r2c.err, /not installed/);
  assert.ok(r2c.err.includes("council cli install codex --version 9.9.8"), r2c.err);
  assert.equal(existsSync(join(h1, "cli", "codex", "9.9.8")), false);
  ok("version 9.9.8 not installed: exit 2, stderr gives the install command, nothing created");
  const r2d = await accept(h1, ["--max-calls", "7"]);
  assert.equal(r2d.code, 2, r2d.err);
  assert.match(r2d.err, /not real/);
  assert.deepEqual(turnPids(r2d), []);
  ok("without --candidate, 9.9.9 has no real record: exit 2, stderr says not real, no stub launch");

  // ---- 3: PASS ----
  const h3 = H("pass");
  await install(h3);
  // a session made before the probes: `council list` and the sessions folder must not change afterwards
  const scen = join(repo, "packages/core/scenarios/consensus");
  const sess = await run(h3, ["--topic", "Acceptance stand: a session made before the probes", "--participant", `scripted:${join(scen, "p1.json")}`, "--participant", `scripted:${join(scen, "p2.json")}`, "--max-rounds", "1"]);
  assert.ok([0, 3].includes(sess.code), `${sess.out}\n${sess.err}`);
  assert.ok(readdirSync(join(h3, "sessions")).length > 0, "a session must exist before the probes");
  const listBefore = (await run(h3, ["list"])).out;
  const sessionsBefore = treeHash(join(h3, "sessions"));
  const pass = await accept(h3, ["--candidate", "--max-calls", "7"]);
  assert.equal(pass.code, 0, `${pass.out}\n${pass.err}`);
  const lines = probeLines(pass.out);
  assert.equal(lines.length, PROBES, pass.out);
  for (const l of lines) assert.match(l, /: ok$/, l);
  ok("PASS with --max-calls 7: 7 probe lines, all ok, exit 0");
  const real = realOf(h3);
  assert.equal(real.length, 1, JSON.stringify(real));
  const e = real[0]!;
  assert.match(e.checkedAt, /^\d{4}-\d\d-\d\d$/);
  assert.ok(e.os && e.osenVersion, JSON.stringify(e));
  assert.equal(e.agent, "codex");
  assert.equal(e.version, "9.9.9");
  assert.equal(e.sha256, installed(h3).sha256);
  assert.ok(e.modelCalls >= 1 && e.modelCalls <= 7, `modelCalls ${e.modelCalls}`);
  ok(`exactly one real entry: checkedAt ${e.checkedAt}, os, osenVersion, version 9.9.9, sha256 equal to the install record, modelCalls ${e.modelCalls} <= 7`);
  assert.equal(turnPids(pass).length, PROBES, "the stub is launched once per probe");
  ok("the stub was launched 7 times in total, no more");
  assert.equal((await run(h3, ["list"])).out, listBefore);
  assert.equal(treeHash(join(h3, "sessions")), sessionsBefore);
  ok("council list output and the sessions folder are the same before and after the acceptance");
  const cl = await run(h3, ["cli", "list"]);
  assert.equal(cl.code, 0, cl.err);
  assert.match(cl.out, /9\.9\.9[\s\S]*real/);
  ok("council cli list: 9.9.9 shown with level real");
  assert.equal(existsSync(join(h3, "fx")), false);
  ok("without --save-fixture the fixture folder is not created");

  // ---- 4: each failing mode on a clean record ----
  for (const m of FAIL_MODES) {
    const h = H(`mode-${m.mode}`);
    await install(h);
    const r = await accept(h, ["--candidate", "--max-calls", "7"], { mode: m.mode });
    assert.equal(r.code, 5, `${m.mode}: ${r.out}\n${r.err}`);
    const lines = probeLines(r.out);
    assert.equal(lines.length, m.index, `${m.mode}: ${r.out}`);
    assert.ok(lines[m.index - 1]!.includes(m.name), `${m.mode}: ${lines[m.index - 1]}`);
    assert.ok(r.err.includes(`Probe ${m.name} failed`), `${m.mode}: ${r.err}`);
    assert.equal(turnPids(r).length, m.index, `${m.mode}: the stub was launched ${turnPids(r).length} times, expected ${m.index}`);
    assert.deepEqual(realOf(h), []);
    if (m.mode === "survive") {
      // the survivor is the child the stub started before its first output; the stand removes it by the pid the stub saved
      const pidFile = join(pidDir, `${r.tag}.pid`);
      const pid = Number(readFileSync(pidFile, "utf8"));
      assert.ok(r.err.includes(String(pid)), r.err);
      assert.equal(execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim(), "sleep", "the saved pid must be the stub's sleep child");
      process.kill(pid, "SIGTERM");
    }
    ok(`${m.mode}: exit 5, probe ${m.index} "${m.name}" named, ${m.index} stub launches (later probes not run), no real entry`);
  }

  // ---- 5: language ----
  const h5 = H("lang");
  await install(h5);
  const enPlan = await accept(h5, ["--candidate"], { lang: "en" });
  const ruPlan = await accept(h5, ["--candidate"], { lang: "ru" });
  const enRef = await accept(h5, ["--candidate", "--max-calls", "6"], { lang: "en" });
  const ruRef = await accept(h5, ["--candidate", "--max-calls", "6"], { lang: "ru" });
  assert.equal(enPlan.code, 2);
  assert.equal(ruPlan.code, 2);
  assert.equal(enRef.code, 2);
  assert.equal(ruRef.code, 2);
  assert.ok(enPlan.out.includes("Upper bound of model calls: 7"), enPlan.out);
  assert.ok(ruPlan.out.includes("Верхняя граница вызовов модели: 7"), ruPlan.out);
  assert.notEqual(enPlan.out, ruPlan.out);
  assert.notEqual(enRef.err, ruRef.err);
  assert.ok(!CYR.test(enRef.err) && CYR.test(ruRef.err), `${enRef.err}\n${ruRef.err}`);
  assert.ok(enRef.err.includes("7") && ruRef.err.includes("7"));
  ok("COUNCIL_LANG en and ru: plan and refusal texts differ (ru in Cyrillic, en not), exit codes 2 and 2, bound 7 in both");

  // ---- 6: Ctrl+C during the stop probe ----
  const h6 = H("sigint");
  await install(h6);
  let child: ChildProcess | undefined;
  let tag = "";
  const pending = accept(h6, ["--candidate", "--max-calls", "7"], { onSpawn: (c, t) => { child = c; tag = t; } });
  // the sixth launch is the stop probe; the signal arrives before its first output (about 300 ms after its launch)
  assert.ok(await waitFor(() => turnPids({ tag }).length >= 6, 90_000), "the stop probe was not launched");
  const launched = turnPids({ tag });
  child!.kill("SIGINT");
  const r6 = await pending;
  assert.equal(r6.code, 1, `${r6.out}\n${r6.err}`);
  assert.ok(r6.err.includes("interrupted"), r6.err);
  assert.equal(probeLines(r6.out).filter((l) => l.startsWith("6. ")).length, 0, r6.out);
  ok("SIGINT during the stop probe: exit 1, stderr says the acceptance is interrupted, probe 6 not reported");
  assert.ok(await waitFor(() => launched.every((p) => !isAlive(p)), 5000), `stub processes left: ${launched.filter(isAlive).join(", ")}`);
  ok("no stub process left: the pids of all 6 launches are gone within 5 s");
  assert.deepEqual(realOf(h6), []);
  ok("no real entry after the interruption");

  // ---- 6a: turn fixture ----
  const h6p = H("fixture-pass");
  await install(h6p);
  const fxPass = join(h6p, "fx");
  const fp = await accept(h6p, ["--candidate", "--max-calls", "7", "--save-fixture", fxPass]);
  assert.equal(fp.code, 0, `${fp.out}\n${fp.err}`);
  assert.deepEqual(readdirSync(fxPass), ["codex-9.9.9-turn.jsonl"]);
  assert.deepEqual(findPersonalData(readFileSync(join(fxPass, "codex-9.9.9-turn.jsonl"), "utf8")), []);
  ok("PASS with --save-fixture: the folder holds exactly codex-9.9.9-turn.jsonl, findPersonalData finds nothing in it");
  const h6l = H("fixture-leak");
  await install(h6l);
  const fxLeak = join(h6l, "fx");
  const fl = await accept(h6l, ["--candidate", "--max-calls", "7", "--save-fixture", fxLeak], { mode: "leak" });
  assert.equal(fl.code, 5, fl.err);
  assert.deepEqual(readdirSync(fxLeak), ["codex-9.9.9-turn.jsonl"]);
  ok("LEAK with --save-fixture: the valid turn passed before the failure, the fixture is written");
  const h6e = H("fixture-err");
  await install(h6e);
  const fe = await accept(h6e, ["--candidate", "--max-calls", "7", "--save-fixture", join(h6e, "fx")], { mode: "err" });
  assert.equal(fe.code, 5, fe.err);
  assert.equal(existsSync(join(h6e, "fx")), false);
  ok("ERR with --save-fixture: the valid turn failed, no fixture file, no fixture folder");

  // ---- 6b: changed installed file ----
  const h6b = H("changed");
  await install(h6b);
  appendFileSync(stubOf(h6b)!, "\n// changed\n");
  const rb = await accept(h6b, ["--candidate", "--max-calls", "7"]);
  assert.equal(rb.code, 2, rb.err);
  assert.match(rb.err, /sha256/);
  assert.deepEqual(turnPids(rb), []);
  ok("installed stub changed after install: exit 2, stderr names the sha256 mismatch, no stub launch");

  // ---- safety ----
  assert.deepEqual(ownerNames(), namesBefore);
  ok("safety: top-level entries of ~/.claude and ~/.codex unchanged; the stub was the only binary launched");
  console.log("all checks passed");
  success = true;
} catch (e) {
  console.error(`FAILED after ${n} checks: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  console.error(`Data folder kept: ${work}`);
  process.exitCode = 1;
} finally {
  if (success) rmSync(work, { recursive: true, force: true });
}
