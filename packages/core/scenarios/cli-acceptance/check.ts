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
import { isInsideRepo } from "../inside-repo.ts";
import { findPersonalData } from "../../src/cli-agents/turn-fixtures.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Run: COUNCIL_DEV=1 node packages/core/scenarios/cli-acceptance/check.ts");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
const entry = join(import.meta.dirname, "council-test.ts");
const given = process.env.COUNCIL_HOME ? resolve(process.env.COUNCIL_HOME) : undefined;
if (given && !isInsideRepo(repo, given)) {
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
  { mode: "outside", index: 2, name: "file outside the working folder" },
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
interface RunOpts { lang?: "en" | "ru"; mode?: string; limits?: { timeoutMs?: number; maxBytes?: number }; onSpawn?: (child: ChildProcess, tag: string) => void }
let runNo = 0;
function run(home: string, args: string[], o: RunOpts = {}): Promise<Result> {
  const tag = `run-${String(++runNo).padStart(3, "0")}`;
  const state = join(states, tag);
  mkdirSync(state, { recursive: true });
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: homedir(), SHELL: fakeShell, COUNCIL_HOME: home, COUNCIL_DEV: "1", COUNCIL_LANG: o.lang ?? "en",
    STUB_MODE: o.mode ?? "good", STUB_LOG: join(logs, `${tag}.log`), STUB_ARGV_LOG: join(logs, `${tag}.argv`), STUB_STATE: state, STUB_PIDFILE: join(pidDir, `${tag}.pid`),
    ...(o.limits ? { CLI_ACCEPT_STAND_LIMITS: JSON.stringify(o.limits) } : {}),
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
  const argvLines = readFileSync(join(logs, `${pass.tag}.argv`), "utf8").split("\n").filter(Boolean);
  const UPDATE_OFF = "-c check_for_update_on_startup=false";
  assert.ok(argvLines.includes(`exec --help ${UPDATE_OFF}`), argvLines.join("\n"));
  assert.ok(argvLines.includes(`features list ${UPDATE_OFF}`), argvLines.join("\n"));
  ok("acceptance reads of codex help and features list carry -c check_for_update_on_startup=false (stub argv log)");
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

  // ---- 7: corrupted local record ----
  const h7 = H("corrupt");
  await install(h7);
  const recFile = join(h7, "cli-verified.json");
  writeFileSync(recFile, "{bad");
  const bytes7 = readFileSync(recFile);
  const r7 = await accept(h7, ["--candidate", "--max-calls", "7"]);
  assert.equal(r7.code, 1, `${r7.out}\n${r7.err}`);
  assert.ok(r7.err.includes(recFile), r7.err);
  assert.deepEqual(turnPids(r7), []);
  assert.ok(readFileSync(recFile).equals(bytes7));
  assert.deepEqual(planLines(r7.out), []);
  ok("corrupted record: exit 1, stderr names the file's absolute path, no plan, no stub launch, file unchanged byte for byte");

  // ---- 8: re-acceptance replaces the real entry ----
  const h8 = H("reaccept");
  await install(h8);
  const old = { agent: "codex", version: "9.9.9", level: "real", checkedAt: "2026-10-01", os: "old-os", osenVersion: "0.0.1", sha256: installed(h8).sha256, modelCalls: 3 };
  writeFileSync(join(h8, "cli-verified.json"), JSON.stringify({ schemaVersion: 1, entries: [old] }));
  const r8 = await accept(h8, ["--candidate", "--max-calls", "7"]);
  assert.equal(r8.code, 0, `${r8.out}\n${r8.err}`);
  const real8 = realOf(h8);
  assert.equal(real8.length, 1, JSON.stringify(real8));
  assert.equal(real8[0]!.checkedAt, new Date().toISOString().slice(0, 10));
  assert.notEqual(real8[0]!.os, "old-os");
  assert.ok(real8[0]!.modelCalls >= 1 && real8[0]!.modelCalls <= 7);
  assert.ok(r8.out.includes(`model calls: ${real8[0]!.modelCalls}`), r8.out);
  ok(`re-acceptance: one real entry for 9.9.9, dated today (not 2026-10-01), modelCalls ${real8[0]!.modelCalls} equal to the printed summary`);

  // ---- 9: SIGTERM and SIGHUP during a probe ----
  for (const sig of ["SIGTERM", "SIGHUP"] as const) {
    const h = H(`signal-${sig.toLowerCase()}`);
    await install(h);
    let c: ChildProcess | undefined;
    let t = "";
    const pend = accept(h, ["--candidate", "--max-calls", "7"], { mode: "slow", onSpawn: (cp, tg) => { c = cp; t = tg; } });
    assert.ok(await waitFor(() => turnPids({ tag: t }).length >= 1, 90_000), "the first probe was not launched");
    const pids = turnPids({ tag: t });
    c!.kill(sig);
    const r = await pend;
    assert.equal(r.code, 1, `${sig}: ${r.out}\n${r.err}`);
    assert.ok(r.err.includes("interrupted"), r.err);
    assert.ok(await waitFor(() => pids.every((p) => !isAlive(p)), 5000), `${sig}: stub processes left: ${pids.filter(isAlive).join(", ")}`);
    assert.deepEqual(realOf(h), []);
    ok(`${sig} during the first probe: exit 1, stderr says interrupted, no stub process alive within 5 s, no real entry`);
  }

  // ---- 10: a stop while the CLI reads its help or feature list (before the first probe) ----
  // the stub hangs on that call with a non-detached child `sleep 30` and writes the child's pid to STUB_PIDFILE
  for (const mode of ["help_hang", "features_hang"] as const) {
    for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
      const h = H(`${mode}-${sig.toLowerCase()}`);
      await install(h);
      let c: ChildProcess | undefined;
      let t = "";
      const pend = accept(h, ["--candidate", "--max-calls", "7"], { mode, onSpawn: (cp, tg) => { c = cp; t = tg; } });
      const pidFile = (): string => join(pidDir, `${t}.pid`);
      assert.ok(await waitFor(() => existsSync(pidFile()) && readFileSync(pidFile(), "utf8") !== "", 90_000), `${mode}: the stub did not start its child`);
      const pid = Number(readFileSync(pidFile(), "utf8"));
      assert.ok(isAlive(pid), `${mode}: the child ${pid} must be alive before the stop`);
      c!.kill(sig);
      const r = await pend;
      assert.equal(r.code, 1, `${mode} ${sig}: ${r.out}\n${r.err}`);
      assert.ok(r.err.includes("interrupted"), r.err);
      assert.deepEqual(turnPids(r), [], `${mode} ${sig}: a probe was launched`);
      const goneInTime = await waitFor(() => !isAlive(pid), 5000);
      if (!goneInTime) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      assert.ok(goneInTime, `${mode} ${sig}: the reader's child ${pid} outlived the stop`);
      assert.deepEqual(realOf(h), []);
      ok(`${sig} while the stub hangs in ${mode === "help_hang" ? "--help" : "features list"}: exit 1, interrupted, no probe launched, the reader's child gone within 5 s, no real entry`);
    }
  }

  // ---- 11: a probe's child ignores SIGTERM; the stub itself exits on SIGTERM, so the group leader is gone before the grace (change 200) ----
  // the child writes its own pid to STUB_PIDFILE once its trap is set; it holds no pipes, so the probe result comes back as soon as the stub exits
  const ignorerPid = async (t: string): Promise<number> => {
    const f = join(pidDir, `${t}.pid`);
    assert.ok(await waitFor(() => existsSync(f) && readFileSync(f, "utf8").trim() !== "", 90_000), "the stub did not start its SIGTERM-ignoring child");
    return Number(readFileSync(f, "utf8").trim());
  };
  {
    const h = H("term-ignorer");
    await install(h);
    let c: ChildProcess | undefined;
    let t = "";
    const pend = accept(h, ["--candidate", "--max-calls", "7"], { mode: "term_ignorer", onSpawn: (cp, tg) => { c = cp; t = tg; } });
    const pid = await ignorerPid(t);
    assert.ok(isAlive(pid), "the SIGTERM-ignoring child must be alive before the stop");
    c!.kill("SIGTERM");
    const r = await pend;
    assert.equal(r.code, 1, `${r.out}\n${r.err}`);
    assert.ok(r.err.includes("interrupted"), r.err);
    assert.equal(turnPids(r).length, 1, "a probe after the first one was launched");
    const gone = await waitFor(() => !isAlive(pid), 5000);
    if (!gone) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    assert.ok(gone, `the probe's SIGTERM-ignoring child ${pid} outlived the stop`);
    assert.deepEqual(realOf(h), []);
    ok("SIGTERM during the first probe whose stub leaves a SIGTERM-ignoring child: exit 1, interrupted, no further probe, the child gone within 5 s, no real entry");
  }
  {
    const h = H("term-ignorer-stop");
    await install(h);
    let t = "";
    const r = await accept(h, ["--candidate", "--max-calls", "7"], { mode: "term_ignorer_stop", onSpawn: (_cp, tg) => { t = tg; } });
    const pid = await ignorerPid(t);
    const gone = await waitFor(() => !isAlive(pid), 5000);
    if (!gone) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    assert.ok(gone, `the stop turn's SIGTERM-ignoring child ${pid} outlived the turn`);
    assert.equal(realOf(h).length, 1);
    ok("the stop probe's turn leaves a SIGTERM-ignoring child: the turn stop kills it within the stop grace, the probe passes, all 7 probes pass, exit 0, one real entry");
  }

  // ---- 12: reasons of failed help/capability reads are in the session language (change 207) ----
  const LANG_TEXT = {
    ru: { head: "не удалось прочитать справку или возможности CLI", exited: "завершился с кодом 3", noAnswer: "нет ответа за 500 мс", large: "вывод больше 64 байт" },
    en: { head: "could not read the CLI help or capabilities", exited: "exited with code 3", noAnswer: "no answer within 500 ms", large: "the output is larger than 64 bytes" },
  } as const;
  const FOREIGN = { ru: ["exited with", "no answer within", "output is larger"], en: ["завершился", "нет ответа", "вывод больше"] } as const;
  for (const lang of ["ru", "en"] as const) {
    const t = LANG_TEXT[lang];
    const noForeign = (r: Result) => { for (const f of FOREIGN[lang]) assert.ok(!r.err.includes(f), `${lang}: foreign text "${f}" in ${r.err}`); };
    {
      const h = H(`help-fail-${lang}`);
      await install(h);
      const r = await accept(h, ["--candidate", "--max-calls", "7"], { lang, mode: "help_fail" });
      assert.equal(r.code, 5, `${lang}: ${r.out}\n${r.err}`);
      if (lang === "ru") assert.ok(CYR.test(r.err), r.err);
      assert.ok(r.err.includes(t.head), r.err);
      assert.ok(r.err.includes(t.exited), r.err);
      assert.ok(r.err.includes("boom"), r.err);
      noForeign(r);
      assert.deepEqual(turnPids(r), []);
      assert.deepEqual(realOf(h), []);
      ok(`${lang}: the help exits with code 3 and "boom": exit 5, reason "${t.exited}" with boom verbatim, no foreign frames, no probe launched, no real entry`);
    }
    {
      const h = H(`help-hang-limit-${lang}`);
      await install(h);
      let tg = "";
      const r = await accept(h, ["--candidate", "--max-calls", "7"], { lang, mode: "help_hang", limits: { timeoutMs: 500 }, onSpawn: (_cp, x) => { tg = x; } });
      assert.equal(r.code, 5, `${lang}: ${r.out}\n${r.err}`);
      assert.ok(r.err.includes(t.head) && r.err.includes(t.noAnswer), r.err);
      noForeign(r);
      const pidFile = join(pidDir, `${tg}.pid`);
      assert.ok(existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "", "the stub did not start its child");
      const pid = Number(readFileSync(pidFile, "utf8"));
      const gone = await waitFor(() => !isAlive(pid), 5000);
      if (!gone) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      assert.ok(gone, `${lang}: the hung child ${pid} outlived the read`);
      assert.deepEqual(turnPids(r), []);
      ok(`${lang}: the help hangs with a 500 ms limit: exit 5, reason "${t.noAnswer}", no foreign frames, the hung child gone within 5 s`);
    }
    {
      const h = H(`help-large-${lang}`);
      await install(h);
      const r = await accept(h, ["--candidate", "--max-calls", "7"], { lang, limits: { maxBytes: 64 } });
      assert.equal(r.code, 5, `${lang}: ${r.out}\n${r.err}`);
      assert.ok(r.err.includes(t.head) && r.err.includes(t.large), r.err);
      noForeign(r);
      assert.deepEqual(turnPids(r), []);
      ok(`${lang}: the help is larger than a 64-byte limit: exit 5, reason "${t.large}", no foreign frames`);
    }
  }

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
