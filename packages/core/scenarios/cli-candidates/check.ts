// Check of `council cli candidates` with the real council CLI (substitute release source and package source, `claude` and
// `codex` stubs, 0 model calls, no network):
//   COUNCIL_DEV=1 node packages/core/scenarios/cli-candidates/check.ts
// Data lives in COUNCIL_HOME (must be inside the repository) or in <repository>/.council-data/cli-candidates-*;
// deleted on success, kept on failure. The real `claude` and `codex` are never launched: children get a PATH with the stand bin only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { cliMessages } from "../../src/messages/cli.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Run: COUNCIL_DEV=1 node packages/core/scenarios/cli-candidates/check.ts");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
const entry = join(import.meta.dirname, "council-test.ts");
const given = process.env.COUNCIL_HOME ? resolve(process.env.COUNCIL_HOME) : undefined;
if (given && relative(repo, given).startsWith("..")) {
  console.error(`COUNCIL_HOME must be inside the repository (${repo}): ${given}`);
  process.exit(2);
}
const work = given ?? join(repo, ".council-data", `cli-candidates-${Date.now()}-${randomBytes(3).toString("hex")}`);
const bin = join(work, "bin"), counters = join(work, "counters");
mkdirSync(bin, { recursive: true });
mkdirSync(counters, { recursive: true });
const sourceLog = join(work, "source.jsonl");
writeFileSync(sourceLog, "");
const releasesFile = join(work, "releases.json");
const RELEASES = { claude: ["2.1.288", "2.1.290", "2.1.291"], codex: ["0.159.2", "0.160.0", "0.161.0"] };
const setReleases = (r: Record<string, string[] | "error">) => writeFileSync(releasesFile, JSON.stringify(r));
setReleases(RELEASES);

// the login-shell lookup must not run the owner's shell: a stub shell that prints PATH only
const fakeShell = join(bin, "fake-shell");
writeFileSync(fakeShell, `#!/bin/sh\nprintf '\\n__COUNCIL_PATH__%s__COUNCIL_PATH__\\n' "$PATH"\n`);
chmodSync(fakeShell, 0o755);

const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const stubHash = (agent: string) => hash(readFileSync(join(import.meta.dirname, "stubs", agent)));
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

let n = 0;
const ok = (s: string) => console.log(`ok ${++n}: ${s}`);
interface Result { code: number; out: string; err: string }
interface RunOpts { lang?: "en" | "ru"; builtin?: "claude-only" | "codex-only"; slowInstallMs?: number }
const childEnv = (home: string, o: RunOpts): Record<string, string> => ({
  PATH: `${bin}:/usr/bin:/bin`, HOME: homedir(), SHELL: fakeShell, COUNCIL_HOME: home, COUNCIL_DEV: "1", COUNCIL_LANG: o.lang ?? "en",
  CLI_CANDIDATES_STAND: JSON.stringify({ releases: releasesFile, counter: counters, log: sourceLog, ...(o.builtin ? { builtin: o.builtin } : {}), ...(o.slowInstallMs ? { slowInstallMs: o.slowInstallMs } : {}) }),
});
function run(home: string, args: string[], o: RunOpts = {}): Promise<Result> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [entry, ...args], { env: childEnv(home, o), cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const timer = setTimeout(() => { child.kill("SIGKILL"); rej(new Error(`timeout: council ${args.join(" ")}`)); }, 90_000);
    child.on("close", (code) => { clearTimeout(timer); res({ code: code ?? -1, out, err }); });
  });
}
const calls = () => readFileSync(sourceLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { agent: string; version: string; dir: string });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Cand { agent: string; version: string; status: string; violations: { code: string; name: string }[]; recorded: boolean }
interface Doc { schemaVersion: number; candidates: Cand[]; failures: { agent: string; code: string }[] }
const oneJson = (r: Result): Doc => {
  assert.equal(r.out.split("\n").filter(Boolean).length, 1, `expected one stdout line: ${r.out}`);
  return JSON.parse(r.out) as Doc;
};
const cand = (agent: string, version: string, status: string, violations: Cand["violations"] = [], recorded = false): Cand => ({ agent, version, status, violations, recorded });
const base = { checkedAt: "2026-10-20", os: "darwin-arm64", osenVersion: "1.0.0" };
let homeNo = 0;
/** A home with the base record of step 1: claude 2.1.288 and codex 0.159.2, level interface. */
function prepare(withRecord = true): string {
  const h = join(work, `home-${++homeNo}`);
  mkdirSync(h, { recursive: true });
  if (withRecord) {
    writeFileSync(join(h, "cli-verified.json"), JSON.stringify({ schemaVersion: 1, entries: [{ agent: "claude", version: "2.1.288", level: "interface", ...base }, { agent: "codex", version: "0.159.2", level: "interface", ...base }] }, null, 2));
  }
  return h;
}
const recordFile = (h: string) => join(h, "cli-verified.json");

// safety baseline: only list top-level names of the owner's agent folders, never read their contents.
const owner = ["/.claude", "/.codex"].map((d) => homedir() + d);
const names = () => owner.map((p) => { try { return `${p}:${readdirSync(p).filter((x) => !x.endsWith(".tmp")).sort().join(",")}`; } catch { return `${p}:absent`; } });
const namesBefore = names();

let success = false;
try {
  // ---- 2, 3 ----
  const H = prepare();
  const baseBytes = readFileSync(recordFile(H), "utf8");
  const r2 = await run(H, ["cli", "candidates", "--json"]);
  assert.equal(r2.code, 0, r2.err);
  const d2 = oneJson(r2);
  assert.deepEqual(d2, {
    schemaVersion: 1,
    candidates: [
      cand("claude", "2.1.290", "ok", [], true),
      cand("claude", "2.1.291", "violates", [{ code: "missing_flag", name: "--tools" }]),
      cand("codex", "0.160.0", "ok", [], true),
      cand("codex", "0.161.0", "violates", [{ code: "missing_feature", name: "shell_tool" }]),
    ],
    failures: [],
  });
  ok("step 2 cli candidates --json: one JSON line; claude 2.1.290 and codex 0.160.0 (reworded help) fit and are recorded; 2.1.291 violates (missing --tools), 0.161.0 violates (missing shell_tool); no failures; exit 0");
  const rec = JSON.parse(readFileSync(recordFile(H), "utf8")) as { entries: Record<string, unknown>[] };
  const added = rec.entries.filter((e) => !JSON.parse(baseBytes).entries.some((b: Record<string, unknown>) => b.agent === e.agent && b.version === e.version));
  assert.equal(added.length, 2, JSON.stringify(added));
  assert.equal(rec.entries.length, 4);
  for (const [agent, version] of [["claude", "2.1.290"], ["codex", "0.160.0"]] as const) {
    const e = added.find((x) => x.agent === agent && x.version === version);
    assert.ok(e, `no entry for ${agent}@${version}`);
    assert.equal(e.level, "interface");
    assert.equal(e.sha256, stubHash(agent));
    assert.ok(!("modelCalls" in e));
  }
  assert.ok(!rec.entries.some((e) => e.level === "real"));
  assert.ok(!existsSync(join(H, "cli-candidates")) && !existsSync(join(H, "cli")));
  assert.deepEqual(readdirSync(H).filter((x) => x.endsWith(".tmp")), []);
  ok("step 3 the record got exactly two new interface entries (claude 2.1.290, codex 0.160.0), sha256 of the installed stub bytes, no modelCalls, no real entries; <home>/cli-candidates and <home>/cli do not exist");

  // ---- 4 ----
  const bytes4 = readFileSync(recordFile(H));
  const mark4 = calls().length;
  const r4 = await run(H, ["cli", "candidates", "--json"]);
  assert.equal(r4.code, 0, r4.err);
  assert.deepEqual(oneJson(r4).candidates, [
    cand("claude", "2.1.290", "already_recorded"),
    cand("claude", "2.1.291", "violates", [{ code: "missing_flag", name: "--tools" }]),
    cand("codex", "0.160.0", "already_recorded"),
    cand("codex", "0.161.0", "violates", [{ code: "missing_feature", name: "shell_tool" }]),
  ]);
  const fetched4 = calls().slice(mark4).map((c) => `${c.agent}@${c.version}`);
  assert.deepEqual(fetched4, ["claude@2.1.291", "codex@0.161.0"]);
  assert.deepEqual(readFileSync(recordFile(H)), bytes4);
  ok("step 4 repeat: recorded candidates are already_recorded and not installed again; violating ones are fetched and checked again; the record is byte-identical");

  // ---- 5 ----
  const mark5 = calls().length;
  const r5 = await run(H, ["cli", "candidates", "--agent", "codex", "--json"]);
  assert.equal(r5.code, 0, r5.err);
  assert.deepEqual(oneJson(r5).candidates.map((c) => c.agent), ["codex", "codex"]);
  assert.deepEqual(calls().slice(mark5).map((c) => c.agent), ["codex"]);
  ok("step 5a --agent codex --json: only codex candidates, and only codex was fetched");
  const en = await run(H, ["cli", "candidates", "--json"], { lang: "en" });
  const ru = await run(H, ["cli", "candidates", "--json"], { lang: "ru" });
  assert.equal(en.code, 0);
  assert.equal(ru.code, 0);
  assert.equal(en.out, ru.out);
  ok("step 5b --json under en and ru: byte-identical documents");
  const textRepeat = await run(H, ["cli", "candidates", "--agent", "claude"], { lang: "en" });
  assert.match(textRepeat.out, /^claude \(base 2\.1\.288\)$/m);
  assert.match(textRepeat.out, /^ {2}2\.1\.290 {2}already recorded$/m);
  assert.match(textRepeat.out, /^ {2}2\.1\.291 {2}violates the contract$/m);
  assert.match(textRepeat.out, /^ {4}.*--tools/m);
  const textEn = await run(prepare(), ["cli", "candidates", "--agent", "claude"], { lang: "en" });
  assert.match(textEn.out, /^ {2}2\.1\.290 {2}fits$/m);
  assert.match(textEn.out, /violates the contract/);
  const textRu = await run(prepare(), ["cli", "candidates", "--agent", "claude"], { lang: "ru" });
  assert.match(textRu.out, /^claude \(база 2\.1\.288\)$/m);
  assert.match(textRu.out, /^ {2}2\.1\.290 {2}подходит$/m);
  assert.match(textRu.out, /^ {2}2\.1\.291 {2}нарушает контракт$/m);
  assert.doesNotMatch(textRu.out, /fits|violates/);
  const textRuRepeat = await run(H, ["cli", "candidates", "--agent", "claude"], { lang: "ru" });
  assert.match(textRuRepeat.out, /уже записана/);
  ok("step 5c text output: en says fits, violates the contract, already recorded; ru says подходит, нарушает контракт, уже записана");

  // ---- 6 ----
  const F = prepare();
  setReleases({ claude: "error", codex: RELEASES.codex });
  const mark6a = calls().length;
  const r6a = await run(F, ["cli", "candidates", "--json"]);
  setReleases(RELEASES);
  assert.equal(r6a.code, 1, r6a.out + r6a.err);
  assert.match(r6a.err, /claude/);
  const d6a = oneJson(r6a);
  assert.deepEqual(d6a.failures, [{ agent: "claude", code: "source_unavailable" }]);
  assert.deepEqual(d6a.candidates.map((c) => c.agent), ["codex", "codex"]);
  assert.deepEqual(calls().slice(mark6a).map((c) => c.agent), ["codex", "codex"]);
  ok("step 6a release source fails for claude: stderr names claude, codex is still checked, failures [{claude, source_unavailable}], exit 1");
  const G = prepare(false);
  const mark6b = calls().length;
  const r6b = await run(G, ["cli", "candidates", "--json"], { builtin: "claude-only" });
  assert.equal(r6b.code, 2, r6b.out + r6b.err);
  const d6b = oneJson(r6b);
  assert.deepEqual(d6b.failures, [{ agent: "codex", code: "no_base" }]);
  assert.deepEqual(d6b.candidates.map((c) => `${c.agent}@${c.version}`), ["claude@2.1.290", "claude@2.1.291"]);
  assert.ok(calls().slice(mark6b).every((c) => c.agent === "claude"));
  assert.match(r6b.err, /codex/);
  assert.ok(!existsSync(recordFile(G)) || !JSON.stringify(readFileSync(recordFile(G), "utf8")).includes("codex"));
  ok("step 6b no base version for codex (built-in record without codex, no local entries): failures [{codex, no_base}], claude still checked, nothing fetched for codex, exit 2");
  const mark6c = calls().length;
  const r6c = await run(F, ["cli", "candidates", "--agent", "x"]);
  assert.equal(r6c.code, 2, r6c.err);
  const r6d = await run(F, ["providers", "--agent", "claude"]);
  assert.equal(r6d.code, 2, r6d.err);
  assert.equal(calls().length, mark6c);
  ok("step 6c --agent x and `providers --agent claude`: exit 2, nothing fetched");

  // ---- 7 ----
  const I = prepare();
  const before7 = readFileSync(recordFile(I));
  const mark7 = calls().length;
  const child = spawn(process.execPath, [entry, "cli", "candidates", "--json"], { env: childEnv(I, { slowInstallMs: 30_000 }), cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  let out7 = "", err7 = "";
  child.stdout.on("data", (c) => (out7 += c));
  child.stderr.on("data", (c) => (err7 += c));
  const exited = new Promise<number>((res) => child.on("close", (c) => res(c ?? -1)));
  const started = Date.now();
  const prefixSeen = () => existsSync(join(I, "cli-candidates")) && readdirSync(join(I, "cli-candidates")).some((x) => x.startsWith("claude-2.1.290-"));
  while (!prefixSeen()) {
    if (Date.now() - started > 20_000) { child.kill("SIGKILL"); throw new Error(`the install prefix did not appear\n${err7}`); }
    await sleep(50);
  }
  child.kill("SIGINT");
  const code7 = await Promise.race([exited, sleep(20_000).then(() => { child.kill("SIGKILL"); return -999; })]);
  assert.equal(code7, 1, err7);
  assert.equal(out7, "");
  assert.equal(err7.trim(), cliMessages("en").candidatesInterrupted);
  assert.match(err7, /interrupted/);
  assert.ok(!existsSync(join(I, "cli-candidates")));
  assert.deepEqual(readFileSync(recordFile(I)), before7);
  assert.equal(calls().slice(mark7).length, 1);
  ok("step 7a SIGINT during the install of claude 2.1.290: exact en interruption line, empty stdout, exit 1, <home>/cli-candidates removed, the record unchanged, nothing further fetched");
  // 7a2: an interruption is exit 1 whatever was refused before it (claude has no base, codex is interrupted), en and ru
  for (const lang of ["en", "ru"] as const) {
    const I2 = prepare(false);
    const mark7a2 = calls().length;
    const c2 = spawn(process.execPath, [entry, "cli", "candidates", "--json"], { env: childEnv(I2, { lang, builtin: "codex-only", slowInstallMs: 30_000 }), cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let o2 = "", e2 = "";
    c2.stdout.on("data", (c) => (o2 += c));
    c2.stderr.on("data", (c) => (e2 += c));
    const x2 = new Promise<number>((res) => c2.on("close", (c) => res(c ?? -1)));
    const t2 = Date.now();
    while (!(existsSync(join(I2, "cli-candidates")) && readdirSync(join(I2, "cli-candidates")).some((x) => x.startsWith("codex-0.160.0-")))) {
      if (Date.now() - t2 > 20_000) { c2.kill("SIGKILL"); throw new Error(`the install prefix did not appear\n${e2}`); }
      await sleep(50);
    }
    c2.kill("SIGINT");
    const k2 = await Promise.race([x2, sleep(20_000).then(() => { c2.kill("SIGKILL"); return -999; })]);
    assert.equal(k2, 1, e2);
    assert.equal(o2, "");
    assert.equal(e2.trim(), cliMessages(lang).candidatesInterrupted);
    assert.match(e2, lang === "en" ? /interrupted/ : /прервана/);
    assert.ok(!existsSync(join(I2, "cli-candidates")));
    assert.deepEqual(calls().slice(mark7a2).map((c) => c.agent), ["codex"]);
  }
  ok("step 7a2 claude has no base (no_base), SIGINT during the install of codex 0.160.0, en and ru: exit 1 (not 2), empty stdout under --json, exact interruption line, nothing left");
  const J = prepare(false);
  writeFileSync(recordFile(J), "{not json");
  const corrupted = readFileSync(recordFile(J));
  const mark7b = calls().length;
  const r7b = await run(J, ["cli", "candidates", "--json"]);
  assert.equal(r7b.code, 1, r7b.out + r7b.err);
  assert.ok(r7b.err.includes(recordFile(J)), `stderr must name ${recordFile(J)}: ${r7b.err}`);
  assert.deepEqual(readFileSync(recordFile(J)), corrupted);
  assert.equal(calls().length, mark7b);
  assert.ok(!existsSync(join(J, "cli-candidates")));
  ok("step 7b corrupted cli-verified.json: exit 1, stderr names the file path, the file is byte-identical, nothing fetched");

  // ---- 7b of the scenario: base from the active pin ----
  const K = prepare();
  mkdirSync(join(K, "cli"));
  const pins = join(K, "cli", "pins.json");
  writeFileSync(pins, JSON.stringify({ schemaVersion: 1, agents: { claude: { installed: [{ version: "2.1.290", path: "bin/claude", source: "stand", sha256: "a".repeat(64), installedAt: "2026-10-20T00:00:00Z" }], active: "2.1.290", previous: null, activatedAt: "2026-10-20T00:00:00Z" } } }, null, 2));
  const pinBytes = readFileSync(pins), cliTree = treeHash(join(K, "cli"));
  const mark7c = calls().length;
  const r7c = await run(K, ["cli", "candidates", "--agent", "claude"]);
  assert.equal(r7c.code, 0, r7c.err);
  assert.match(r7c.out, /^claude \(base 2\.1\.290\)$/m);
  assert.doesNotMatch(r7c.out, /2\.1\.288/);
  assert.match(r7c.out, /^ {2}2\.1\.291 {2}violates the contract$/m);
  assert.doesNotMatch(r7c.out, /^ {2}2\.1\.290 /m);
  assert.deepEqual(calls().slice(mark7c).map((c) => c.version), ["2.1.291"]);
  assert.deepEqual(readFileSync(pins), pinBytes);
  assert.equal(treeHash(join(K, "cli")), cliTree);
  ok("step 7c base from the active pin (claude 2.1.290): header names the base, only 2.1.291 is checked; pins.json and the whole cli/ tree unchanged");

  // ---- 7d: corrupted pins.json is no base, not the built-in record (change 192) ----
  const P = prepare();
  mkdirSync(join(P, "cli"));
  const badPins = join(P, "cli", "pins.json");
  writeFileSync(badPins, "{bad");
  const recordBefore7d = readFileSync(recordFile(P));
  const mark7d = calls().length;
  const r7d = await run(P, ["cli", "candidates", "--agent", "claude", "--json"]);
  assert.equal(r7d.code, 2, r7d.out + r7d.err);
  assert.deepEqual(oneJson(r7d), { schemaVersion: 1, candidates: [], failures: [{ agent: "claude", code: "no_base" }] });
  const t7d = await run(P, ["cli", "candidates", "--agent", "claude"]);
  assert.equal(t7d.code, 2, t7d.out + t7d.err);
  assert.ok((t7d.out + t7d.err).includes(badPins), `the text must name ${badPins}: ${t7d.out}${t7d.err}`);
  assert.equal(calls().length, mark7d);
  assert.deepEqual(readFileSync(recordFile(P)), recordBefore7d);
  assert.equal(readFileSync(badPins, "utf8"), "{bad");
  assert.ok(!existsSync(join(P, "cli-candidates")));
  ok("step 7d pins.json = {bad: --json failures [{claude, no_base}], the text names the pins.json path, exit 2; nothing fetched, cli-verified.json and pins.json byte-identical, no cli-candidates folder");

  // ---- 7e: a file system error is install_failed, not a stack (change 192) ----
  const Q = prepare();
  const blocker = join(Q, "cli-candidates");
  writeFileSync(blocker, "keep");
  const mark7e = calls().length;
  const r7e = await run(Q, ["cli", "candidates", "--json"]);
  assert.equal(r7e.code, 1, r7e.out + r7e.err);
  const d7e = oneJson(r7e);
  assert.deepEqual(d7e.candidates, []);
  assert.deepEqual(d7e.failures, [
    { agent: "claude", code: "install_failed" }, { agent: "claude", code: "install_failed" },
    { agent: "codex", code: "install_failed" }, { agent: "codex", code: "install_failed" },
  ]);
  assert.doesNotMatch(r7e.err, /^\s+at /m, `stderr must have no stack: ${r7e.err}`);
  for (const v of ["claude 2.1.290", "claude 2.1.291", "codex 0.160.0", "codex 0.161.0"]) assert.ok(r7e.err.includes(`Could not check ${v}: `), `stderr must give the reason for ${v}: ${r7e.err}`);
  const t7e = await run(Q, ["cli", "candidates", "--agent", "claude"]);
  assert.equal(t7e.code, 1, t7e.out + t7e.err);
  assert.match(t7e.out + t7e.err, /Could not check claude 2\.1\.290: .*EEXIST/);
  assert.doesNotMatch(t7e.err, /^\s+at /m);
  assert.equal(calls().length, mark7e);
  assert.equal(readFileSync(blocker, "utf8"), "keep");
  ok("step 7e a file in place of cli-candidates: --json is one document with install_failed for each of the 4 candidates, no stack, exit 1; text names the reason; the file is unchanged");

  // ---- 8 ----
  const files = readdirSync(counters);
  const kinds = new Set(files.map((f) => f.slice(f.lastIndexOf(".") + 1)));
  assert.ok(files.length > 0);
  for (const k of kinds) assert.ok(["version", "help", "features"].includes(k), `unexpected launch kind: ${k} (${files.join(", ")})`);
  assert.ok(!files.some((f) => f.endsWith(".turn")));
  assert.ok(kinds.has("version") && kinds.has("help") && kinds.has("features"));
  ok("step 8 launch counters over all runs: only --version, help and features list; not a single turn");

  // ---- 9 ----
  const L = prepare(false);
  const r9 = await run(L, ["providers", "--json"]);
  assert.ok([0, 1].includes(r9.code), `providers exit ${r9.code}\n${r9.err}`);
  assert.ok(!existsSync(join(L, "cli-candidates")));
  const scripted = (f: string) => `scripted:${join(repo, "packages/core/scenarios/consensus", f)}`;
  const r9b = await run(L, ["--topic", "Stand topic", "--participant", scripted("p1.json"), "--participant", scripted("p2.json"), "--max-rounds", "2"]);
  assert.equal(r9b.code, 0, `session exit ${r9b.code}\n${r9b.err}`);
  assert.ok(!existsSync(join(L, "cli-candidates")));
  ok("step 9 other commands: `providers` and a session launch (scripted participants) do not create <home>/cli-candidates");

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
