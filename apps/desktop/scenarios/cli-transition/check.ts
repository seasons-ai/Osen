// Check of the CLI transition reminder (change 182) on the real main-process modules (createCliTransition, createSettings, createBridge)
// and the core (176 pins, 175 record, 180 candidates), with a fake clock, CLI stubs and scripted participants: 0 model calls, no network.
//   COUNCIL_DEV=1 node apps/desktop/scenarios/cli-transition/check.ts                      full run; folder .council-data/cli-transition-check-* is created and removed on success
//   COUNCIL_DEV=1 COUNCIL_HOME=<new folder inside the project> node .../check.ts           full run in that folder (kept)
//   COUNCIL_DEV=1 COUNCIL_HOME=<new folder inside the project> node .../check.ts --seed-only   only prepare the folder for the app window and print the launch command
//   ... --seed-only --broken-pin    the same for the broken-pin folder (claude 2.1.288 active but its executable changed, 2.1.280 previous)
// Change 190 adds two steps: an unwritable cli-reminder.json (one check in 23 hours) and a recorded attempt time in the future.
// The real claude and codex are never launched: every executable is a shell stub from the stand folder.
import "../../../../packages/core/scenarios/language-ru.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createLogger, ensureDataDir, initialRegistry, readRegistry, setProcessLanguage, writeRegistry } from "../../../../packages/core/src/index.ts";
import type { Registry } from "../../../../packages/core/src/index.ts";
import { activePin, installPin, pinsPath, usePin } from "../../../../packages/core/src/cli-agents/pins.ts";
import type { PackageSource } from "../../../../packages/core/src/cli-agents/pins.ts";
import { addLocalEntry, loadVerifiedRecord } from "../../../../packages/core/src/cli-agents/verified-record.ts";
import { providerMessages } from "../../../../packages/core/src/messages/providers.ts";
import { createBridge } from "../../src/main/bridge.ts";
import { standCandidateDeps } from "../../src/main/cli-stand.ts";
import { REMINDER_FILE, createCliTransition, reminderPath } from "../../src/main/cli-transition.ts";
import { historyItems } from "../../src/main/history.ts";
import { createSettings } from "../../src/main/settings.ts";
import { settings as catalog } from "../../src/shared/messages/settings.ts";
import { checkPeriod } from "../../src/shared/settings.ts";
import type { SettingsView } from "../../src/shared/settings.ts";

const repo = resolve(import.meta.dirname, "../../../..");
const seedOnly = process.argv.includes("--seed-only");
const brokenPinOnly = process.argv.includes("--broken-pin");
if (process.env.COUNCIL_DEV !== "1" || (seedOnly && !process.env.COUNCIL_HOME)) {
  console.error("COUNCIL_DEV=1 is required (and, with --seed-only, COUNCIL_HOME: a new folder inside the project). Run: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node apps/desktop/scenarios/cli-transition/check.ts [--seed-only]");
  process.exit(2);
}
const given = process.env.COUNCIL_HOME ? resolve(process.env.COUNCIL_HOME) : undefined;
if (given && relative(repo, given).startsWith("..")) {
  console.error(`COUNCIL_HOME must be inside the project (${repo}): ${given}`);
  process.exit(2);
}
if (given && existsSync(given) && (!statSync(given).isDirectory() || readdirSync(given).length > 0)) {
  console.error(`COUNCIL_HOME ${given} already exists and is not empty: the script writes only to a new folder.`);
  process.exit(2);
}
const work = given ?? join(repo, ".council-data", `cli-transition-check-${Date.now()}-${randomBytes(3).toString("hex")}`);
mkdirSync(work, { recursive: true });
const DAY = 86_400_000, HOUR = 3_600_000;

// ---------- stubs ----------
const fx = (name: string) => readFileSync(join(repo, "packages/core/src/cli-agents/fixtures", name), "utf8");
const CLAUDE_HELP = fx("claude-2.1.288-help.txt");
const CODEX_HELP = fx("codex-0.159.2-exec-help.txt");
const CODEX_FEATURES = fx("codex-0.159.2-features.txt");

/** A CLI stub: answers --version, the help args the core reads, and `features list` for codex. `noTools` renames --tools in the help (a launch-contract violation). */
function stubScript(agent: "claude" | "codex", version: string, noTools = false): string {
  const help = agent === "claude" ? (noTools ? CLAUDE_HELP.replaceAll("--tools", "--toolz") : CLAUDE_HELP) : CODEX_HELP;
  const body = agent === "claude"
    ? `  --help) cat <<'__HELP__'\n${help}\n__HELP__\n    ;;`
    : `  exec) cat <<'__HELP__'\n${help}\n__HELP__\n    ;;\n  features) cat <<'__FEATURES__'\n${CODEX_FEATURES}\n__FEATURES__\n    ;;`;
  return `#!/bin/sh\ncase "$1" in\n  --version) echo "${version} (stub)" ;;\n${body}\nesac\nexit 0\n`;
}
const writeExe = (path: string, text: string) => { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, text); chmodSync(path, 0o755); };

/** 176 package source: "installs" a stub that reports the requested version. */
const stubSource: PackageSource = {
  async fetch(agent, version, dir) {
    const exe = join(dir, "node_modules", "pkg", "bin", agent);
    writeExe(exe, stubScript(agent, version));
    return { executable: exe, source: `stand:${agent}@${version}` };
  },
};

interface Seed { dir: string; stand: string; bin: string; standJson: string; explicit: string; shell: string; env: Record<string, string> }

/** The folder composition of Live Scenario step 2. `nowMs` is the clock the activation date is counted from. */
async function seed(dir: string, nowMs: number): Promise<Seed> {
  mkdirSync(dir, { recursive: true });
  const stand = join(dir, "stand"), bin = join(stand, "bin");
  const shell = join(bin, "fake-shell"), explicit = join(stand, "explicit", "claude"), standJson = join(stand, "cli-stand.json");
  writeExe(join(bin, "codex"), stubScript("codex", "0.159.2")); // the PATH source for codex
  writeExe(shell, `#!/bin/sh\nprintf '\\n__COUNCIL_PATH__%s__COUNCIL_PATH__\\n' "$PATH"\n`); // the login-shell lookup must not run the owner's shell
  writeExe(explicit, stubScript("claude", "2.1.288")); // used by the "explicit path" step
  writeExe(join(stand, "pkgs", "claude-2.1.302"), stubScript("claude", "2.1.302", true)); // no --tools in the help
  const pkg = join(stand, "pkgs", "claude-2.1.302");
  writeFileSync(standJson, `${JSON.stringify({ releases: { claude: ["2.1.301", "2.1.302"], codex: [] }, packages: { "claude@2.1.302": pkg } }, null, 2)}\n`);

  writeRegistry(ensureDataDir(dir), initialRegistry(["claude", "codex"]));
  const entry = (agent: "claude" | "codex", version: string, level: "real" | "interface", checkedAt: string) => {
    const r = addLocalEntry(dir, { agent, version, level, checkedAt, os: "darwin-arm64", osenVersion: "1.0.0", ...(level === "real" ? { modelCalls: 2 } : {}) });
    assert.ok(r.ok, r.ok ? "" : r.reason);
  };
  entry("claude", "2.1.288", "real", "2026-10-07");
  entry("claude", "2.1.300", "real", "2026-10-15");
  entry("claude", "2.1.301", "interface", "2026-10-18");
  entry("codex", "0.159.2", "real", "2026-10-16");
  const at = () => new Date(nowMs - 40 * DAY);
  for (const version of ["2.1.288", "2.1.300"]) { // 176 itself writes pins.json: 2.1.288 becomes active (40 days ago), 2.1.300 is only installed
    const r = await installPin(dir, "claude", { version }, { source: stubSource, record: loadVerifiedRecord(dir), now: at });
    assert.ok(r.ok, r.text);
  }
  const env = { PATH: `${bin}:/usr/bin:/bin`, SHELL: shell, HOME: process.env.HOME ?? "", COUNCIL_DEV: "1", COUNCIL_HOME: dir, COUNCIL_CLI_STAND: standJson };
  return { dir, stand, bin, standJson, explicit, shell, env };
}

/** Change 189: claude 2.1.280 and 2.1.288 pinned (active 2.1.288, previous 2.1.280), then the 2.1.288 executable gets extra bytes: only the sha256 differs, the pre-launch check fails. */
async function seedBrokenPin(dir: string, nowMs: number): Promise<Seed> {
  const s = await seedBare(dir);
  for (const version of ["2.1.280", "2.1.288"]) {
    const r = addLocalEntry(dir, { agent: "claude", version, level: "real", checkedAt: "2026-10-07", os: "darwin-arm64", osenVersion: "1.0.0", modelCalls: 2 });
    assert.ok(r.ok, r.ok ? "" : r.reason);
  }
  for (const version of ["2.1.280", "2.1.288"]) {
    const r = await installPin(dir, "claude", { version }, { source: stubSource, record: loadVerifiedRecord(dir), now: () => new Date(nowMs - 40 * DAY) });
    assert.ok(r.ok, r.text);
  }
  const u = usePin(dir, "claude", "2.1.288", { record: loadVerifiedRecord(dir), now: () => new Date(nowMs - 40 * DAY) });
  assert.ok(u.ok, u.text);
  const a = (JSON.parse(readFileSync(pinsPath(dir), "utf8")) as { agents: { claude: { active: string; previous: string | null } } }).agents.claude;
  assert.deepEqual([a.active, a.previous], ["2.1.288", "2.1.280"]);
  const pin = activePin(dir, "claude");
  assert.equal(pin.state, "pin");
  if (pin.state === "pin") appendFileSync(pin.path, "# changed after the pin\n");
  return s;
}

// ---------- seed-only ----------
if (seedOnly && brokenPinOnly) {
  const dir = realpathSync(work);
  const s = await seedBrokenPin(dir, Date.now());
  console.log(`Data folder prepared: ${dir}`);
  console.log("claude: pinned by Osen, active 2.1.288 (its executable was changed after the pin: the pre-launch check fails), previous 2.1.280 (real 2026-10-07)");
  console.log(`cd "${repo}" && COUNCIL_DEV=1 COUNCIL_HOME="${dir}" COUNCIL_CLI_STAND="${s.standJson}" PATH="${s.bin}:$PATH" npm run desktop`);
  process.exit(0);
}
if (seedOnly) {
  const dir = realpathSync(work);
  const s = await seed(dir, Date.now());
  console.log(`Data folder prepared: ${dir}`);
  console.log("claude: pinned by Osen, active 2.1.288 (real 2026-10-07, activated 40 days ago), 2.1.300 installed (real 2026-10-15); record: 2.1.301 interface");
  console.log("stand source: releases claude 2.1.301, 2.1.302; 2.1.302 has no --tools in the help (the 180 check reports `violates`)");
  console.log("codex: no pin, PATH stub 0.159.2 (real 2026-10-16); no sessions, no cli-reminder.json");
  console.log(`cd "${repo}" && COUNCIL_DEV=1 COUNCIL_HOME="${dir}" COUNCIL_CLI_STAND="${s.standJson}" PATH="${s.bin}:$PATH" npm run desktop`);
  process.exit(0);
}

// ---------- full run ----------
let n = 0;
const ok = (s: string) => console.log(`ok ${++n} ${s}`);
const NOW0 = Date.parse("2026-10-20T12:00:00Z");
let clock = NOW0;
const now = () => new Date(clock);
const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const sha = (p: string) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "absent");
function treeHash(d: string): string {
  if (!existsSync(d)) return "absent";
  const lines: string[] = [];
  const walk = (x: string) => { for (const name of readdirSync(x).sort()) { const p = join(x, name); if (statSync(p).isDirectory()) walk(p); else lines.push(`${relative(d, p)} ${sha(p)}`); } };
  walk(d);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

interface Child { id: string | null; done: Promise<number>; out: () => string }
function runCouncil(s: Seed, args: string[], lang = "en"): Promise<{ code: number; out: string }> {
  return new Promise((res, rej) => {
    const c = spawn(process.execPath, [join(repo, "packages/core/src/council.ts"), ...args], { cwd: repo, env: { ...s.env, COUNCIL_LANG: lang }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => rej(new Error(`timeout: council ${args.join(" ")}`)), 90_000);
    c.on("close", (code) => { clearTimeout(t); res({ code: code ?? -1, out }); });
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, f: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error(`timeout waiting for: ${what}`); await sleep(150); }
}

interface Rig { s: Seed; view(): Promise<SettingsView>; call(a: string, ...args: unknown[]): Promise<{ ok: boolean; value?: unknown; error?: string }>; t: ReturnType<typeof createCliTransition>; releaseCalls: () => number; copied: string[]; running(): boolean; logFile: string }
/** Real createCliTransition + createSettings + createBridge wired as index.ts does, on the stand seam and the fake clock. */
function rig(s: Seed): Rig {
  const logger = createLogger(s.dir, "desktop", s.env);
  const copied: string[] = [];
  let calls = 0;
  const running = () => historyItems(s.dir, new Map(), new Set()).some((i) => i.status === "running");
  const t = createCliTransition({
    dataDir: s.dir, logger, env: s.env, now, monotonic: () => clock, osenVersion: "1.0.0", running, onChecked: () => {},
    candidateDeps: () => {
      const d = standCandidateDeps(s.standJson);
      return { releases: { list: (agent) => { calls++; return d.releases.list(agent); } }, source: d.source };
    },
  });
  const st = createSettings({ dataDir: s.dir, env: s.env, reloadEnv: () => {}, logger, now, transition: t });
  const stub = <T>(v: T) => () => v;
  const bridge = createBridge({
    listSessions: () => historyItems(s.dir, new Map(), new Set()), sessionExists: stub(false), sessionDrafts: stub([]), settings: st,
    copyText: (x: string) => { copied.push(x); }, watchSession: () => () => {}, notices: stub([]), listTemplates: stub({ templates: [], errors: [] }), send: () => {}, logger,
  } as never);
  const call: Rig["call"] = async (a, ...args) => (await bridge.call(a, args)) as never;
  const view = async () => {
    const r = await call("settings");
    assert.ok(r.ok, `settings: ${r.error}`);
    return r.value as SettingsView;
  };
  return { s, view, call, t, releaseCalls: () => calls, copied, running, logFile: join(s.dir, "logs", "app.log") };
}
const card = (v: SettingsView, id: string) => v.providers.find((p) => p.id === id)!.cli!;
const rbytes = (s: Seed) => (existsSync(reminderPath(s.dir)) ? readFileSync(reminderPath(s.dir), "utf8") : null);
const pins = (s: Seed) => readFileSync(pinsPath(s.dir), "utf8");
const activeOf = (s: Seed) => (JSON.parse(pins(s)) as { agents: { claude: { active: string; previous: string | null } } }).agents.claude;
const setStandJson = (s: Seed, patch: Record<string, unknown>) => writeFileSync(s.standJson, `${JSON.stringify({ ...JSON.parse(readFileSync(s.standJson, "utf8")), ...patch }, null, 2)}\n`);
const setClaudePath = (s: Seed, path: string | undefined) => {
  const reg = readRegistry(s.dir);
  writeRegistry(s.dir, { ...reg, providers: reg.providers.map((p) => { if (p.id !== "claude" || p.kind !== "cli") return p; const { path: _old, ...rest } = p; return path ? { ...rest, path } : rest; }) } as Registry);
};

let child: Child | null = null;
let main: Seed | null = null;
let success = false;
try {
  const dir = realpathSync(work);
  setProcessLanguage("en");

  // ---- "Файла нет": a fresh folder without pins ----
  const fresh = await seedBare(join(dir, "fresh"));
  {
    const r = rig(fresh);
    const v = await r.view();
    assert.equal(rbytes(fresh), null, "view must not create cli-reminder.json");
    assert.equal(v.transition.periodDays, 30);
    assert.equal(v.transition.fileError, null);
    await r.t.maybeCheck();
    assert.equal(rbytes(fresh), null, "no active pin: no check and no file");
    assert.equal(r.releaseCalls(), 0);
    ok("data-directory: no file, no pins: the window state does not create cli-reminder.json, the period is 30, no candidate check");
  }

  // ---- seed (steps 2) ----
  const s = await seed(join(dir, "main"), NOW0);
  main = s;
  const R = rig(s);
  assert.equal(rbytes(s), null);
  ok("seed: claude pinned 2.1.288 (40 days) + 2.1.300 installed, record 2.1.301 interface, codex on PATH, no sessions, no cli-reminder.json");

  // ---- 3: the first check writes the file once; cards ----
  let v = await R.view();
  assert.equal(rbytes(s), null, "view before the first check must not write");
  await R.t.maybeCheck();
  const first = rbytes(s)!;
  assert.ok(first, "the first check writes cli-reminder.json");
  const written = JSON.parse(first) as { schemaVersion: number; periodDays: number; lastCheck: { at: string; candidates: { version: string; status: string; violations: { name: string }[] }[]; failures: unknown[] } };
  assert.equal(written.lastCheck.at, stamp(NOW0));
  assert.equal(R.releaseCalls(), 1, "one release listing for the one pinned agent");
  assert.ok(first.endsWith("}\n"));
  v = await R.view();
  const c = card(v, "claude"), x = card(v, "codex");
  assert.equal(c.source, "pin");
  assert.equal(v.providers.find((p) => p.id === "claude")!.version, "2.1.288");
  assert.deepEqual([c.level, c.checkedAt], ["real", "2026-10-07"]);
  assert.equal(c.pin?.version, "2.1.288");
  assert.equal(c.pin?.activatedAt, stamp(NOW0 - 40 * DAY));
  assert.equal(x.source, "path");
  assert.deepEqual([x.target, x.install, x.due], [null, null, null]);
  assert.equal(x.pin, null);
  assert.equal(v.transition.periodDays, 30);
  assert.equal(v.transition.fileError, null);
  assert.ok(!("file" in v.transition), "the view carries no file system path field");
  ok("step 3 first maybeCheck: cli-reminder.json written once with the attempt time; claude card = pin, 2.1.288, real 2026-10-07, activation date; codex card = PATH without target; period 30");

  // ---- 4: due, candidate, violation; no second check ----
  assert.deepEqual(c.due, { from: "2.1.288", to: "2.1.300", ageDays: 40, acceptedAt: "2026-10-15" });
  assert.deepEqual(c.target, { version: "2.1.300", acceptedAt: "2026-10-15" });
  assert.deepEqual(c.candidates, [{ version: "2.1.301" }]);
  assert.deepEqual(c.violations, [{ version: "2.1.302", names: ["--tools"] }]);
  assert.deepEqual(c.check, { at: stamp(NOW0), outcome: "ok" });
  assert.equal(c.install, null);
  await R.t.maybeCheck();
  await R.view();
  assert.equal(rbytes(s), first, "a second maybeCheck/view must not change the file");
  assert.equal(R.releaseCalls(), 1);
  ok("step 4 due 2.1.288 -> 2.1.300 (40 days); candidate 2.1.301 interface without target; 2.1.302 violates [--tools]; no second check, file bytes unchanged");

  // ---- 5: period ----
  const sessionsBefore = treeHash(join(s.dir, "sessions"));
  let r = await R.call("setTransitionPeriod", 60);
  assert.ok(r.ok, r.error);
  assert.equal(card(r.value as SettingsView, "claude").due, null, "with period 60 (age 40) the due reminder is gone");
  const saved = JSON.parse(rbytes(s)!) as { periodDays: number; lastCheck: { at: string } };
  assert.equal(saved.periodDays, 60);
  assert.equal(saved.lastCheck.at, written.lastCheck.at);
  const at60 = rbytes(s);
  for (const bad of [0, 400]) {
    r = await R.call("setTransitionPeriod", bad);
    assert.ok(!r.ok);
    assert.equal(r.error, checkPeriod(bad));
    assert.equal(rbytes(s), at60, `${bad}: file bytes unchanged`);
  }
  r = await R.call("setTransitionPeriod", 30);
  assert.ok(r.ok, r.error);
  assert.ok(card(r.value as SettingsView, "claude").due);
  assert.equal(JSON.parse(rbytes(s)!).lastCheck.at, written.lastCheck.at);
  ok("step 5 period 60: due gone, file has 60 and the same lastCheck.at; 0 and 400 refused with the bounds, file unchanged; back to 30");

  // ---- 6: switch ----
  const pinsBefore = pins(s);
  // cancel = the window makes no call: nothing to run, pins.json is as it was
  assert.equal(pins(s), pinsBefore);
  r = await R.call("switchCli", "claude", "2.1.300");
  assert.ok(r.ok, r.error);
  assert.deepEqual(activeOf(s), { ...activeOf(s), active: "2.1.300", previous: "2.1.288" });
  assert.equal(card(r.value as SettingsView, "claude").pin?.version, "2.1.300");
  const list = await runCouncil(s, ["cli", "list"]);
  assert.equal(list.code, 0, list.out);
  assert.match(list.out, /2\.1\.300[^\n]*(active|активн)/i, list.out);
  assert.equal(treeHash(join(s.dir, "sessions")), sessionsBefore, "sessions are not touched");
  ok("step 6 cancel makes no call (pins.json unchanged); switchCli claude 2.1.300: active 2.1.300, previous 2.1.288; real `council cli list` shows 2.1.300 active; sessions unchanged");

  // ---- 7: rollback ----
  r = await R.call("rollbackCli", "claude");
  assert.ok(r.ok, r.error);
  assert.equal(activeOf(s).active, "2.1.288");
  const list2 = await runCouncil(s, ["cli", "list"]);
  assert.match(list2.out, /2\.1\.288[^\n]*(active|активн)/i, list2.out);
  ok("step 7 rollbackCli: active 2.1.288 again (real `council cli list` agrees)");

  // ---- 8: a running session blocks both actions; a confirmation pressed while a session runs reaches main as switchCli/rollbackCli and is refused ----
  {
    const args = ["--topic", "Pause", "--participant", "scripted:packages/core/scenarios/owner-wait/p1.json", "--participant", "scripted:packages/core/scenarios/owner-wait/p2.json", "--wait-for-owner"];
    const done = runCouncil(s, args);
    child = { id: null, done: done.then((x) => x.code), out: () => "" };
    await until("a running session in the history", () => R.running());
    const id = historyItems(s.dir, new Map(), new Set()).find((i) => i.status === "running")!.id;
    child.id = id;
    assert.equal((await R.view()).transition.running, true);
    assert.deepEqual(Object.keys((await R.view()).transition).sort(), ["fileError", "periodDays", "running"]);
    const p8 = pins(s);
    for (const lang of ["en", "ru"] as const) {
      setProcessLanguage(lang);
      for (const [a, ...args] of [["switchCli", "claude", "2.1.300"], ["rollbackCli", "claude"]] as const) {
        const bad = await R.call(a, ...args);
        assert.ok(!bad.ok, `${a}: refused while a session runs`);
        assert.equal(bad.error, catalog().cliSessionRunning, `${a} ${lang}`);
      }
    }
    setProcessLanguage("en");
    assert.equal(pins(s), p8, "pins.json unchanged by the refused actions");
    const stop = await runCouncil(s, ["stop", id]);
    assert.equal(stop.code, 0, stop.out);
    await until("the session is no longer running", () => !R.running());
    await done;
    child = null;
    assert.equal((await R.view()).transition.running, false);
    r = await R.call("switchCli", "claude", "2.1.300");
    assert.ok(r.ok, r.error);
    r = await R.call("rollbackCli", "claude");
    assert.ok(r.ok, r.error);
    assert.equal(activeOf(s).active, "2.1.288");
    ok("step 8 running session (real council process), confirmation while a session is running: running=true, view without a file field, switch and rollback refused with the localized reason (en, ru), pins unchanged; after `council stop` the actions work again");
  }

  // ---- 9: explicit path, not installed version ----
  {
    const p9 = pins(s);
    setClaudePath(s, s.explicit);
    v = await R.view();
    const e = card(v, "claude");
    assert.equal(e.source, "explicit");
    assert.deepEqual([e.target, e.due, e.install], [null, null, null]);
    assert.equal(e.pin?.version, "2.1.288", "the pin is still reported (shown as unused)");
    setClaudePath(s, undefined);
    assert.equal(card(await R.view(), "claude").source, "pin");
    const rec = addLocalEntry(s.dir, { agent: "claude", version: "2.1.310", level: "real", checkedAt: "2026-10-19", os: "darwin-arm64", osenVersion: "1.0.0", modelCalls: 2 });
    assert.ok(rec.ok);
    const cmd = card(await R.view(), "claude").install;
    assert.deepEqual(cmd, { version: "2.1.310", command: "council cli install claude --version 2.1.310" });
    const cp = await R.call("copyText", cmd!.command);
    assert.ok(cp.ok, cp.error);
    assert.deepEqual(R.copied, ["council cli install claude --version 2.1.310"]);
    assert.equal(pins(s), p9, "nothing installed");
    assert.ok(!existsSync(join(s.dir, "cli", "claude", "2.1.310")));
    ok("step 9 config.json path = stub: source explicit, no target/due/install; path removed: pin again; record 2.1.310 real (not installed): install command shown, copyText through the bridge called, nothing installed");
  }

  // ---- 11: a failed check ----
  {
    setStandJson(s, { failReleases: "registry is down" });
    clock = NOW0 + 25 * HOUR;
    const before = rbytes(s);
    await R.t.maybeCheck();
    const after = JSON.parse(rbytes(s)!) as { lastCheck: { at: string; failures: { agent: string; code: string }[] } };
    assert.notEqual(rbytes(s), before);
    assert.equal(after.lastCheck.at, stamp(clock));
    assert.deepEqual(after.lastCheck.failures, [{ agent: "claude", code: "source_unavailable" }]);
    const log = readFileSync(R.logFile, "utf8");
    assert.match(log, /CLI candidate check finished with failures: claude=source_unavailable/);
    assert.match(log.split("\n").filter((l) => l.includes("finished with failures"))[0]!, /error/i);
    v = await R.view();
    assert.deepEqual(card(v, "claude").check, { at: stamp(clock), outcome: "source_unavailable" });
    const calls = R.releaseCalls();
    clock += 23 * HOUR;
    await R.t.maybeCheck();
    assert.equal(R.releaseCalls(), calls, "no retry within 24 h of a failed attempt");
    ok("step 11 failing release source after 25 h: outcome source_unavailable recorded with the new attempt time, error line in logs/app.log, the window state still returns a view, no retry for 24 h");
  }

  // ---- 190a: the reminder file cannot be written ----
  {
    const saved = clock;
    const u = await seed(join(dir, "unwritable"), clock);
    const file = reminderPath(u.dir);
    writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, periodDays: 30, lastCheck: { at: stamp(clock - 2 * DAY), candidates: [], failures: [] } }, null, 2)}\n`);
    chmodSync(file, 0o444);
    try {
      const original = rbytes(u);
      const U = rig(u);
      const attempt = stamp(clock);
      await U.t.maybeCheck();
      for (let i = 0; i < 23; i++) { clock += HOUR; await U.t.maybeCheck(); }
      assert.equal(U.releaseCalls(), 1, "one check in 23 hourly ticks");
      assert.deepEqual(card(await U.view(), "claude").check?.notSaved, { file, code: "EACCES" });
      assert.equal(card(await U.view(), "claude").check?.at, attempt);
      assert.equal(rbytes(u), original, "the read-only file keeps its bytes");
      assert.match(readFileSync(U.logFile, "utf8"), /CLI candidate check result not saved/);
      clock += HOUR;
      await U.t.maybeCheck();
      assert.equal(U.releaseCalls(), 2, "24 hours after the attempt the check runs again");
      assert.equal(rbytes(u), original);
    } finally {
      chmodSync(file, 0o644);
      clock = saved;
    }
    ok("step 190a read-only cli-reminder.json (chmod 444): 1 check in 24 hourly ticks (counter 1), the card carries notSaved {file, EACCES} with the attempt time, the error line is in logs/app.log, the file bytes are unchanged; after 24 h the check runs again (counter 2)");
  }

  // ---- 190b: a recorded attempt time in the future ----
  {
    const saved = clock;
    const f = await seed(join(dir, "future"), clock);
    writeFileSync(reminderPath(f.dir), `${JSON.stringify({ schemaVersion: 1, periodDays: 30, lastCheck: { at: stamp(clock + 3 * DAY), candidates: [], failures: [] } }, null, 2)}\n`);
    const F = rig(f);
    await F.t.maybeCheck();
    assert.equal(F.releaseCalls(), 1, "a future attempt time does not block the check");
    assert.equal(JSON.parse(rbytes(f)!).lastCheck.at, stamp(clock));
    clock = saved;
    ok("step 190b recorded attempt time 3 days in the future: the next tick runs the check once (counter 1) and records the current time");
  }

  // ---- 10a: a broken file (en and ru) ----
  {
    for (const lang of ["en", "ru"] as const) {
      setProcessLanguage(lang);
      writeFileSync(reminderPath(s.dir), "{not json");
      v = await R.view();
      assert.ok(v.transition.fileError?.includes(REMINDER_FILE), `${lang}: ${v.transition.fileError}`);
      assert.ok(!("file" in v.transition), `${lang}: no file field next to fileError`);
      assert.equal(v.transition.periodDays, 30);
      const calls = R.releaseCalls();
      clock += 25 * HOUR;
      await R.t.maybeCheck();
      assert.equal(R.releaseCalls(), calls, "a damaged file: no check");
      assert.equal(rbytes(s), "{not json");
    }
    setProcessLanguage("en");
    r = await R.call("setTransitionPeriod", 45);
    assert.ok(r.ok, r.error);
    assert.equal((r.value as SettingsView).transition.fileError, null);
    assert.equal(JSON.parse(rbytes(s)!).periodDays, 45);
    ok("step 10a damaged cli-reminder.json (en, ru): fileError names the file, maybeCheck does not run, bytes unchanged; saving the period replaces it");
  }

  // ---- "Другие компоненты": council providers and a short session ignore the file ----
  {
    const sc = ["--topic", "Short", "--participant", "scripted:packages/core/scenarios/consensus/p1.json", "--participant", "scripted:packages/core/scenarios/consensus/p2.json", "--max-rounds", "1"];
    const keep = rbytes(s);
    for (const [seedDir, expected] of [[s, keep], [fresh, null]] as const) {
      const p = await runCouncil(seedDir, ["providers"]);
      assert.equal(p.code, 0, p.out);
      const sess = await runCouncil(seedDir, sc);
      assert.match(sess.out, /Outcome: /, sess.out); // the session finishes, consensus or not: any exit code
      assert.equal(rbytes(seedDir), expected, "council must not create or change cli-reminder.json");
    }
    ok("data-directory: `council providers` and a short scripted session do not create (fresh folder) or change (existing file) cli-reminder.json");
  }

  // ---- change 189: the active pin fails the pre-launch check ----
  {
    const b = await seedBrokenPin(join(dir, "broken"), NOW0);
    const B = rig(b);
    const pin = activePin(b.dir, "claude");
    assert.equal(pin.state, "pin");
    if (pin.state !== "pin") throw new Error("unreachable");
    const expected = providerMessages().pinSha256Mismatch("claude", "2.1.288", pin.path, pin.sha256, sha(pin.path));
    let bv = await B.view();
    let bc = card(bv, "claude");
    const pc = bv.providers.find((p) => p.id === "claude")!;
    assert.equal(pc.available, false);
    assert.equal(pc.reason, expected);
    assert.equal(bc.source, "pin");
    assert.equal(bc.pin?.version, "2.1.288");
    assert.equal(bc.pin?.previous, "2.1.280");
    ok("step 189a broken pin: claude card unavailable with the guard's checksum reason, source pin, pin 2.1.288, previous 2.1.280");

    const pj = await runCouncil(b, ["providers", "--json"]);
    const item = (JSON.parse(pj.out.split("\n").find((l) => l.startsWith("{"))!) as { providers: { id: string; available: boolean; source: string | null; reason: string | null }[] }).providers.find((p) => p.id === "claude")!;
    assert.deepEqual([item.available, item.source, item.reason], [false, "pin", expected], pj.out);
    ok("step 189b `council providers --json` on the broken pin: claude available false, source pin, the same reason");

    const rb = await B.call("rollbackCli", "claude");
    assert.ok(rb.ok, rb.error);
    assert.equal(activeOf(b).active, "2.1.280");
    bv = await B.view();
    bc = card(bv, "claude");
    const ac = bv.providers.find((p) => p.id === "claude")!;
    assert.deepEqual([ac.available, ac.version, bc.source], [true, "2.1.280", "pin"]);
    ok("step 189c rollbackCli through the bridge: pins.json active 2.1.280, the view shows claude available, version 2.1.280, source pin");
  }

  success = true;
} catch (e) {
  console.error(`FAIL after ${n} checks: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  console.error(`data folder kept: ${work}`);
} finally {
  const live = child as Child | null;
  if (live?.id && main) await runCouncil(main, ["stop", live.id]).catch(() => undefined); // the stand's own stop command, never a signal
}
if (!success) process.exit(1);
console.log(`all ${n} checks passed`);
if (!given) rmSync(work, { recursive: true, force: true });
process.exit(0);

/** A folder with the registry and the stubs but without pins and record entries. */
async function seedBare(dir: string): Promise<Seed> {
  mkdirSync(dir, { recursive: true });
  const stand = join(dir, "stand"), bin = join(stand, "bin"), shell = join(bin, "fake-shell");
  writeExe(join(bin, "codex"), stubScript("codex", "0.159.2"));
  writeExe(join(bin, "claude"), stubScript("claude", "2.1.288"));
  writeExe(shell, `#!/bin/sh\nprintf '\\n__COUNCIL_PATH__%s__COUNCIL_PATH__\\n' "$PATH"\n`);
  const standJson = join(stand, "cli-stand.json");
  writeFileSync(standJson, `${JSON.stringify({ releases: { claude: [], codex: [] }, packages: {} })}\n`);
  writeRegistry(ensureDataDir(dir), initialRegistry(["claude", "codex"]));
  const env = { PATH: `${bin}:/usr/bin:/bin`, SHELL: shell, HOME: process.env.HOME ?? "", COUNCIL_DEV: "1", COUNCIL_HOME: dir, COUNCIL_CLI_STAND: standJson };
  return { dir, stand, bin, standJson, explicit: "", shell, env };
}
