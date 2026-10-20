// Check of pinned CLI installs with the real council CLI (substitute package source and verified-versions record,
// `claude` stubs in the stand folder, 0 model calls, no network):
//   COUNCIL_DEV=1 node packages/core/scenarios/cli-pin/check.ts
// Data lives in COUNCIL_HOME (must be inside the repository) or in <repository>/.council-data/cli-pin-*;
// deleted on success, kept on failure. The real `claude` and `codex` are never launched: children get a PATH with the stand bin only.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { writeStub } from "./stub.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Run: COUNCIL_DEV=1 node packages/core/scenarios/cli-pin/check.ts");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
const entry = join(import.meta.dirname, "council-test.ts");
const given = process.env.COUNCIL_HOME ? resolve(process.env.COUNCIL_HOME) : undefined;
if (given && relative(repo, given).startsWith("..")) {
  console.error(`COUNCIL_HOME must be inside the repository (${repo}): ${given}`);
  process.exit(2);
}
const work = given ?? join(repo, ".council-data", `cli-pin-${Date.now()}-${randomBytes(3).toString("hex")}`);
const bin = join(work, "bin"), explicitDir = join(work, "explicit"), counters = join(work, "counters");
const homes = { a: join(work, "home-a"), b: join(work, "home-b"), c: join(work, "home-c"), e: join(work, "home-e") };
for (const d of [bin, explicitDir, counters, ...Object.values(homes)]) mkdirSync(d, { recursive: true });
const sourceLog = join(work, "source.jsonl");
writeFileSync(sourceLog, "");

// the login-shell lookup must not run the owner's shell: a stub shell that prints PATH only
const fakeShell = join(bin, "fake-shell");
writeFileSync(fakeShell, `#!/bin/sh\nprintf '\\n__COUNCIL_PATH__%s__COUNCIL_PATH__\\n' "$PATH"\n`);
chmodSync(fakeShell, 0o755);
const pathStub = join(bin, "claude"), pathCounter = join(counters, "path");
const explicitStub = join(explicitDir, "claude"), explicitCounter = join(counters, "explicit");
writeStub(pathStub, { version: "5.0.0", counter: pathCounter });
writeStub(explicitStub, { version: "6.0.0", counter: explicitCounter });
const count = (base: string, kind: string) => (existsSync(`${base}.${kind}`) ? readFileSync(`${base}.${kind}`, "utf8").split("\n").filter(Boolean).length : 0);
const launches = (base: string) => ["version", "help", "turn"].reduce((s, k) => s + count(base, k), 0);
const pinCounter = (agent: string, v: string) => join(counters, `pin.${agent}.${v}`);

const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
/** Hash of a folder tree: relative paths, kinds and file bytes. */
function treeHash(dir: string): string {
  const lines: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name), st = statSync(p);
      if (st.isDirectory()) { lines.push(`d ${relative(dir, p)}`); walk(p); } else lines.push(`f ${relative(dir, p)} ${hash(readFileSync(p))}`);
    }
  };
  if (existsSync(dir)) walk(dir); else lines.push("absent");
  return hash(lines.join("\n"));
}
const tmpLeftovers = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (name.startsWith(".install-") || name.endsWith(".tmp")) out.push(p);
      if (statSync(p).isDirectory()) walk(p);
    }
  };
  walk(join(dir, "cli"));
  return out;
};

let n = 0;
const ok = (s: string) => console.log(`ok ${++n}: ${s}`);
interface Result { code: number; out: string; err: string }
interface RunOpts { lang?: "en" | "ru"; mode?: "ok" | "error" | "wrong-version"; env?: Record<string, string> }
function run(home: string, args: string[], o: RunOpts = {}): Promise<Result> {
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: homedir(), SHELL: fakeShell, COUNCIL_HOME: home, COUNCIL_DEV: "1", COUNCIL_LANG: o.lang ?? "en",
    CLI_PIN_STAND: JSON.stringify({ log: sourceLog, counter: join(counters, "pin"), mode: o.mode ?? "ok" }), ...o.env,
  };
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [entry, ...args], { env, cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const timer = setTimeout(() => rej(new Error(`timeout: council ${args.join(" ")}`)), 90_000);
    child.on("close", (code) => { clearTimeout(timer); res({ code: code ?? -1, out, err }); });
  });
}
const pinsFile = (home: string) => join(home, "cli", "pins.json");
const claudePins = (home: string) => JSON.parse(readFileSync(pinsFile(home), "utf8")).agents.claude;
const sourceCalls = () => readFileSync(sourceLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { agent: string; version: string; dir: string });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const claudeStatus = (r: Result) => {
  const find = (v: unknown): Record<string, unknown> | undefined => {
    if (Array.isArray(v)) { for (const x of v) { const f = find(x); if (f) return f; } return undefined; }
    if (v && typeof v === "object") {
      if ((v as { id?: unknown }).id === "claude") return v as Record<string, unknown>;
      for (const x of Object.values(v)) { const f = find(x); if (f) return f; }
    }
    return undefined;
  };
  const s = find(JSON.parse(r.out) as unknown);
  assert.ok(s, `no claude provider in: ${r.out.slice(0, 300)}`);
  return s;
};
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// safety baseline: only list top-level names of the owner's agent folders, never read their contents.
// Folder mtimes are not used: other agent sessions running at the same time touch these folders constantly.
const owner = ["/.claude", "/.codex"].map((d) => homedir() + d);
const names = () => owner.map((p) => { try { return `${p}:${readdirSync(p).filter((x) => !x.endsWith(".tmp")).sort().join(",")}`; } catch { return `${p}:absent`; } });
const namesBefore = names();

let success = false;
try {
  const A = homes.a;
  // ---- 1 ----
  const r1 = await run(A, ["cli", "list"]);
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /No pinned installs/);
  assert.equal(existsSync(join(A, "cli")), false);
  ok("1 list on a fresh data folder: no-pins text, exit 0, cli/ not created");

  // ---- 2 ----
  const r2a = await run(A, ["cli", "install", "claude"]);
  assert.equal(r2a.code, 0, r2a.err);
  assert.equal(claudePins(A).active, "1.1.0");
  assert.deepEqual(claudePins(A).installed.map((i: { version: string }) => i.version), ["1.1.0"]);
  const activatedAt = claudePins(A).activatedAt as string;
  assert.match(activatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  ok("2a install without --version: newest real 1.1.0 installed and active, activatedAt set");
  await sleep(1100);
  const r2b = await run(A, ["cli", "install", "claude", "--version", "1.0.0"]);
  assert.equal(r2b.code, 0, r2b.err);
  const p2 = claudePins(A);
  assert.equal(p2.active, "1.1.0");
  assert.equal(p2.activatedAt, activatedAt);
  assert.deepEqual(p2.installed.map((i: { version: string }) => i.version), ["1.1.0", "1.0.0"]);
  for (const i of p2.installed as { version: string; path: string; source: string; sha256: string; installedAt: string }[]) {
    const file = join(A, "cli", "claude", i.version, i.path);
    assert.ok(existsSync(file), file);
    assert.equal(i.sha256, hash(readFileSync(file)));
    const shasum = execFileSync("/usr/bin/shasum", ["-a", "256", file], { encoding: "utf8" }).split(/\s+/)[0];
    assert.equal(i.sha256, shasum);
    assert.equal(i.source, `stand:claude@${i.version}`);
    assert.match(i.installedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  }
  assert.notEqual(p2.installed[1].installedAt, activatedAt, "second install happened 1 s later");
  ok("2b install --version 1.0.0: installed, active stays 1.1.0, activatedAt unchanged; path, source, version, sha256 equal node crypto and shasum -a 256");
  assert.deepEqual(sourceCalls().map((c) => `${c.agent}@${c.version}`), ["claude@1.1.0", "claude@1.0.0"]);
  for (const c of sourceCalls()) assert.ok(c.dir.startsWith(join(A, "cli", "claude", ".install-")), c.dir);
  ok("2c source called exactly twice, each time with agent, version and a temp folder inside <data>/cli/claude/");
  const r2d = await run(A, ["cli", "install", "claude", "--version", "1.0.0"]);
  assert.equal(r2d.code, 0);
  assert.match(r2d.out, /already installed/);
  assert.equal(sourceCalls().length, 2);
  ok("2d repeated install: already installed, source not called");

  // ---- 3 ----
  let before = treeHash(join(A, "cli"));
  const r3a = await run(A, ["cli", "install", "claude", "--version", "2.0.0"]);
  assert.equal(r3a.code, 2);
  assert.match(r3a.err, /2\.0\.0/);
  assert.equal(treeHash(join(A, "cli")), before);
  assert.equal(sourceCalls().length, 2);
  ok("3a install of an interface-level version: exit 2, cli/ tree unchanged, source not called");
  const pinsBeforeCand = readFileSync(pinsFile(A), "utf8");
  const r3b = await run(A, ["cli", "install", "claude", "--version", "2.0.0", "--candidate"]);
  assert.equal(r3b.code, 0, r3b.err);
  assert.equal(claudePins(A).active, "1.1.0");
  assert.ok(claudePins(A).installed.some((i: { version: string }) => i.version === "2.0.0"));
  assert.equal(claudePins(A).activatedAt, activatedAt);
  assert.notEqual(readFileSync(pinsFile(A), "utf8"), pinsBeforeCand);
  ok("3b install --candidate: installed, not active, activatedAt unchanged");
  const pinsText = readFileSync(pinsFile(A), "utf8");
  const treeBefore = treeHash(join(A, "cli"));
  for (const args of [["use", "claude", "2.0.0"], ["use", "claude", "9.9.9"], ["install", "gemini"]]) {
    const r = await run(A, ["cli", ...args]);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.err}`);
    assert.ok(r.err.trim().length > 0);
  }
  assert.equal(readFileSync(pinsFile(A), "utf8"), pinsText);
  assert.equal(treeHash(join(A, "cli")), treeBefore);
  ok("3c use claude 2.0.0, use claude 9.9.9, install gemini: exit 2, pins.json and cli/ unchanged");
  // failures on codex (nothing installed for it): the agent folder must disappear again
  for (const mode of ["error", "wrong-version"] as const) {
    const r = await run(A, ["cli", "install", "codex", "--version", "1.0.0", "--candidate"], { mode });
    assert.equal(r.code, 1, `${mode}: ${r.out}${r.err}`);
    assert.ok(r.err.trim().length > 0);
    if (mode === "wrong-version") assert.match(r.err, /9\.9\.9/);
    assert.deepEqual(tmpLeftovers(A), []);
    assert.equal(existsSync(join(A, "cli", "codex")), false);
    assert.equal(readFileSync(pinsFile(A), "utf8"), pinsText);
    assert.equal(treeHash(join(A, "cli")), treeBefore);
  }
  assert.equal(sourceCalls().filter((c) => c.agent === "codex").length, 2);
  ok("3d source error and a stub of another version: exit 1, no .install-* or .tmp left, pins.json and cli/ tree byte-identical");
  const rf = await run(homes.e, ["cli", "install", "claude"], { mode: "error" });
  assert.equal(rf.code, 1);
  assert.equal(existsSync(join(homes.e, "cli")), false);
  ok("3e failed first install on a fresh data folder: exit 1, cli/ does not exist afterwards");

  // ---- 4 ----
  const sess = join(A, "sessions", "fake-session");
  mkdirSync(sess, { recursive: true });
  writeFileSync(join(sess, "events.jsonl"), '{"type":"fake"}\n');
  const sessBefore = treeHash(join(A, "sessions"));
  await sleep(1100);
  const r4a = await run(A, ["cli", "use", "claude", "1.0.0"]);
  assert.equal(r4a.code, 0, r4a.err);
  const p4 = claudePins(A);
  assert.equal(p4.active, "1.0.0");
  assert.equal(p4.previous, "1.1.0");
  assert.ok(p4.activatedAt > activatedAt, `${p4.activatedAt} > ${activatedAt}`);
  ok("4a use claude 1.0.0: active 1.0.0, previous 1.1.0, activatedAt updated");
  const pinsNow = readFileSync(pinsFile(A), "utf8");
  const r4b = await run(A, ["cli", "use", "claude", "1.0.0"]);
  assert.equal(r4b.code, 0);
  assert.match(r4b.out, /already active/);
  assert.equal(readFileSync(pinsFile(A), "utf8"), pinsNow);
  ok("4b repeated use: already active, exit 0, pins.json byte-identical");
  const r4c = await run(A, ["cli", "rollback", "claude"]);
  assert.equal(r4c.code, 0, r4c.err);
  assert.equal(claudePins(A).active, "1.1.0");
  assert.equal(claudePins(A).previous, null);
  const afterRollback = readFileSync(pinsFile(A), "utf8");
  const r4d = await run(A, ["cli", "rollback", "claude"]);
  assert.equal(r4d.code, 2);
  assert.match(r4d.err, /no previous version/);
  assert.equal(readFileSync(pinsFile(A), "utf8"), afterRollback);
  ok("4c rollback: active 1.1.0, previous null; repeated rollback refused with exit 2, pins.json unchanged");
  assert.equal(treeHash(join(A, "sessions")), sessBefore);
  assert.equal(existsSync(join(A, "config.json")), false, "use/rollback must not create config.json");
  ok("4d sessions/ identical before and after use and rollback; config.json untouched (not created)");

  // ---- 5 ----
  const pinPath = join(A, "cli", "claude", "1.1.0", claudePins(A).installed.find((i: { version: string }) => i.version === "1.1.0").path as string);
  const r5a = await run(A, ["providers", "--json"]);
  assert.equal(r5a.code, 0, r5a.err);
  const s5a = claudeStatus(r5a);
  assert.equal(s5a.path, pinPath);
  assert.equal(s5a.available, true);
  assert.equal(launches(pathCounter), 0);
  assert.ok(launches(pinCounter("claude", "1.1.0")) > 0);
  ok("5a active pin and a stub on PATH: providers shows the pin path, the PATH stub was not launched");
  const configPath = join(A, "config.json");
  const cfgText = readFileSync(configPath, "utf8");
  const cfg = JSON.parse(cfgText);
  const prov = cfg.providers.find((p: { id: string }) => p.id === "claude");
  assert.ok(prov, "claude provider in config.json");
  prov.path = explicitStub;
  writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  const r5b = await run(A, ["providers", "--json"]);
  assert.equal(claudeStatus(r5b).path, explicitStub);
  assert.ok(launches(explicitCounter) > 0);
  assert.equal(launches(pathCounter), 0);
  ok("5b provider.path in config.json: the explicit path wins over the pin");
  writeFileSync(configPath, cfgText);
  const r5c = await run(A, ["providers", "--json"]);
  assert.equal(claudeStatus(r5c).path, pinPath);
  ok("5c explicit path removed: the pin path again");
  rmSync(pinPath);
  const explicitBefore = launches(explicitCounter);
  const r5d = await run(A, ["providers", "--json"]);
  const s5d = claudeStatus(r5d);
  assert.equal(s5d.available, false);
  assert.ok(String(s5d.reason).includes(pinPath), String(s5d.reason));
  assert.equal(launches(pathCounter), 0, "the PATH stub must not run when the pinned file is gone");
  assert.equal(launches(explicitCounter), explicitBefore);
  const r5e = await run(A, ["providers"]);
  assert.ok(r5e.out.includes(pinPath), r5e.out);
  ok("5d pinned file deleted: provider unavailable, reason names the pin path, the PATH stub got 0 launches (--version, --help, turns)");

  // ---- 6 ----
  const r6u = await run(A, ["cli", "use", "claude", "1.0.0"]);
  assert.equal(r6u.code, 0, r6u.err);
  const scen = join(work, "agree.json");
  writeFileSync(scen, JSON.stringify({ steps: [
    { response: { stance: "agree", reasoning: "Agreed.", solution: null, answers: [], questions: [] } },
    { response: { stance: "agree", reasoning: "Agreed.", solution: null, answers: [], questions: [] } },
  ] }));
  const envLog = join(work, "env.log");
  writeFileSync(envLog, "");
  const talk = (home: string) => run(home, ["--topic", "Check the pinned environment", "--participant", "claude", "--participant", `scripted:${scen}`, "--max-rounds", "2"], { env: { COUNCIL_PIN_ENV_LOG: envLog } });
  const r6 = await talk(A);
  assert.ok([0, 3].includes(r6.code), `discussion exit ${r6.code}\n${r6.out}\n${r6.err}`);
  const blocks = readFileSync(envLog, "utf8").split("---\n").filter(Boolean);
  assert.ok(blocks.length > 0, "the pinned stub must have taken a turn");
  const cfgDir = join(realpathSync(A), "cli", "claude", "1.0.0", "config");
  for (const b of blocks) {
    assert.match(b, new RegExp(`^CLAUDE_CONFIG_DIR=${escapeRe(cfgDir)}$`, "m"));
    assert.match(b, /^DISABLE_AUTOUPDATER=1$/m);
    assert.match(b, /^DISABLE_UPDATES=1$/m);
    assert.match(b, /^COUNCIL_PARTICIPANT=1$/m);
  }
  assert.ok(count(pinCounter("claude", "1.0.0"), "turn") > 0);
  assert.equal(launches(pathCounter), 0);
  ok("6a turn of the pinned claude: CLAUDE_CONFIG_DIR=<data>/cli/claude/<v>/config, DISABLE_AUTOUPDATER=1, DISABLE_UPDATES=1, COUNCIL_PARTICIPANT=1");
  writeFileSync(envLog, "");
  const r6b = await talk(homes.b);
  assert.ok([0, 3].includes(r6b.code), `discussion exit ${r6b.code}\n${r6b.out}\n${r6b.err}`);
  const blocksB = readFileSync(envLog, "utf8").split("---\n").filter(Boolean);
  assert.ok(blocksB.length > 0);
  for (const b of blocksB) {
    assert.match(b, /^COUNCIL_PARTICIPANT=1$/m);
    for (const k of ["CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "DISABLE_UPDATES", "CODEX_HOME"]) assert.match(b, new RegExp(`^${k}=$`, "m"));
  }
  assert.ok(count(pathCounter, "turn") > 0);
  ok("6b no pins (PATH stub): COUNCIL_PARTICIPANT=1 and the pin variables empty");

  // ---- 7 ----
  const C = homes.c;
  assert.equal((await run(C, ["cli", "install", "claude"])).code, 0);
  const pf = pinsFile(C);
  writeFileSync(pf, "{ not json");
  const corrupted = readFileSync(pf);
  const stateBefore = treeHash(join(C, "cli"));
  for (const args of [["list"], ["install", "claude"], ["install", "claude", "--version", "1.0.0"], ["use", "claude", "1.1.0"], ["rollback", "claude"]]) {
    const r = await run(C, ["cli", ...args]);
    assert.equal(r.code, 1, `${args.join(" ")}: ${r.out}${r.err}`);
    assert.ok(r.err.includes(pf), `${args.join(" ")}: stderr must name ${pf}: ${r.err}`);
    assert.deepEqual(readFileSync(pf), corrupted);
  }
  assert.equal(treeHash(join(C, "cli")), stateBefore);
  ok("7a corrupted pins.json: list, install, use, rollback refuse with exit 1 and the pins.json path; file byte-identical");
  const r7 = await run(C, ["providers", "--json"]);
  assert.equal(r7.code, 0, r7.err);
  const s7 = claudeStatus(r7);
  assert.equal(s7.path, pathStub);
  assert.ok(String(s7.warning).includes("pins.json"), String(s7.warning));
  assert.deepEqual(readFileSync(pf), corrupted);
  ok("7b corrupted pins.json: providers works by PATH (the PATH stub) with a warning naming pins.json");
  const en = await run(A, ["cli", "use", "claude", "9.9.9"], { lang: "en" });
  const ru = await run(A, ["cli", "use", "claude", "9.9.9"], { lang: "ru" });
  assert.equal(en.code, 2);
  assert.equal(ru.code, 2);
  assert.notEqual(en.err, ru.err);
  assert.match(en.err, /not installed/);
  assert.match(ru.err, /не установлена/);
  ok("7c cli use claude 9.9.9 under en and ru: texts differ, exit codes equal (2)");

  // ---- safety ----
  assert.deepEqual(names(), namesBefore);
  ok("safety: top-level entries of ~/.claude and ~/.codex unchanged; every launched binary was a stand stub (PATH held only the stand bin and /usr/bin:/bin, SHELL was a stub)");
  success = true;
} catch (e) {
  console.error(`FAILED after ${n} checks: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  console.error(`Stand folder kept: ${work}`);
  process.exitCode = 1;
} finally {
  if (success) rmSync(work, { recursive: true, force: true });
}
