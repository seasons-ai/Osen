// Interface language check: real main modules (createLanguageState, createBridge, closeWarningText), the core (resolveLanguage, loadEnv) and a council process, without an Electron window.
//   COUNCIL_DEV=1 COUNCIL_HOME="<new empty folder inside the project>" node apps/desktop/scenarios/language/check.ts
//   ... --seed-only   only prepare the data folder for the app window (without preferences.json)
// Writes only to subfolders of COUNCIL_HOME and does not delete it. Models are not called, the network is not used.
// The default language is checked here too, so language-ru.ts is not imported: COUNCIL_LANG is cleared and set explicitly in each case's environment.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDataDir, loadEnv, sessionsDir, writeRegistry } from "../../../../packages/core/src/index.ts";
import type { Registry } from "../../../../packages/core/src/index.ts";
import { getProcessLanguage, setProcessLanguage } from "../../../../packages/core/src/i18n/index.ts";
import type { Language } from "../../../../packages/core/src/i18n/index.ts";
import { createBridge } from "../../src/main/bridge.ts";
import { closeWarningText, createLanguageState } from "../../src/main/language.ts";
import { shell } from "../../src/shared/messages/shell.ts";
import type { BridgeEvent } from "../../src/shared/bridge.ts";
import { seedJournals } from "../tariffs/fixture.ts";

delete process.env["COUNCIL_LANG"];
const home = process.env.COUNCIL_HOME;
const seedOnly = process.argv.includes("--seed-only");
if (process.env.COUNCIL_DEV !== "1" || !home) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME (a new empty folder) are required. Run: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node apps/desktop/scenarios/language/check.ts");
  process.exit(2);
}
if (existsSync(resolve(home)) && (!statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0)) {
  console.error(`COUNCIL_HOME ${resolve(home)} already exists and is not empty: the script writes only to a new folder.`);
  process.exit(2);
}
mkdirSync(resolve(home), { recursive: true });
const root = realpathSync(resolve(home));
const project = resolve(import.meta.dirname, "../../../..");

// network: counters are attached before the first request, the originals are called as before
let netCalls = 0;
const origConnect = net.Socket.prototype.connect, origFetch = globalThis.fetch;
net.Socket.prototype.connect = function (this: net.Socket, ...a: never[]) { netCalls++; return (origConnect as (...x: unknown[]) => net.Socket).apply(this, a); } as never;
globalThis.fetch = ((...a: Parameters<typeof fetch>) => { netCalls++; return origFetch(...a); }) as typeof fetch;

const sha = (p: string) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "no file");
const list = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(join(d, e.name)).map((f) => `${e.name}/${f}`) : [e.name])).sort();
const sessionHashes = (d: string) => (existsSync(sessionsDir(d)) ? Object.fromEntries(readdirSync(sessionsDir(d)).sort().map((s) => [s, sha(join(sessionsDir(d), s, "events.jsonl"))])) : {});

let seq = 0;
// Case data folder: empty or with config.json and fixture sessions; preferences.json is put there by the case itself.
function dataDir(withData: boolean, own?: string): string {
  const dir = own ?? join(root, `case-${++seq}`);
  if (!own) mkdirSync(dir);
  if (withData) {
    writeRegistry(ensureDataDir(dir), {
      providers: [],
      defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 1000, participants: [] },
    } as unknown as Registry);
    seedJournals(dir);
  }
  return dir;
}
const prefs = (d: string) => join(d, "preferences.json");

// Real language state and a real bridge on substitute remaining dependencies; notices are collected the same way as in main/index.ts.
function open(dir: string, extraEnv: Record<string, string> = {}) {
  const env = loadEnv({ COUNCIL_DEV: "1", COUNCIL_HOME: dir, ...extraEnv }, join(root, "no-env-cwd"));
  const events: BridgeEvent[] = [];
  const logger = { info: () => {}, error: () => {} };
  const language = createLanguageState({ env, dataDir: dir, send: (e) => events.push(e), logger });
  const stub = <T>(v: T) => () => v;
  const bridge = createBridge({
    listSessions: stub([]), sessionExists: stub(false), sessionDrafts: stub([]), usageSummary: stub({}), watchSession: () => () => {},
    notices: () => [language.invalidNotice()].filter((x): x is string => x !== null),
    listTemplates: stub({ templates: [], errors: [] }), send: () => {}, logger, language,
  } as never);
  return { bridge, events, language };
}
type R = { ok: true; value: unknown } | { ok: false; error: string };
const call = async (b: ReturnType<typeof open>["bridge"], action: string, ...args: unknown[]) => (await b.call(action, args)) as R;
const view = async (b: ReturnType<typeof open>["bridge"]) => { const r = await call(b, "language"); assert.ok(r.ok); return r.value as { language: string; source: string; locked: boolean }; };

if (seedOnly) {
  const dir = dataDir(true, root);
  console.log(`Data folder prepared: ${dir}`);
  console.log(`files: ${list(dir).join(", ")}`);
  console.log(`preferences.json: ${existsSync(prefs(dir)) ? "present" : "absent (default language English)"}`);
  console.log(`cd "${project}" && COUNCIL_HOME="${dir}" npm run desktop`);
  process.exit(0);
}

let checks = 0;
async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const text = await fn();
    checks++;
    console.log(`check ${checks} — ok: ${text}`);
  } catch (e) {
    console.log(`FAIL: check ${checks + 1} (${name}) — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

await check("empty folder", async () => {
  const dir = dataDir(false);
  const { bridge } = open(dir);
  const v = await view(bridge);
  assert.deepEqual(v, { language: "en", source: "default", locked: false });
  assert.equal(existsSync(prefs(dir)), false);
  assert.equal(getProcessLanguage(), "en");
  return `language ${v.language}, source ${v.source}, locked ${v.locked}, process language ${getProcessLanguage()}, preferences.json not created`;
});

await check("data folder without the file", async () => {
  const dir = dataDir(true);
  const cfg = sha(join(dir, "config.json")), ses = sessionHashes(dir), filesBefore = list(dir);
  const { bridge } = open(dir);
  const v = await view(bridge);
  assert.equal(v.language, "en");
  assert.equal(sha(join(dir, "config.json")), cfg);
  assert.deepEqual(sessionHashes(dir), ses);
  assert.deepEqual(list(dir), filesBefore);
  assert.equal(existsSync(prefs(dir)), false);
  return `language ${v.language}; sessions ${Object.keys(ses).length}, sha256 config.json ${cfg.slice(0, 12)}…, journals and the file list (${filesBefore.length}) unchanged; no file`;
});

await check("the variable takes precedence over the file", async () => {
  const dir = dataDir(false);
  writeFileSync(prefs(dir), '{ "language": "en" }\n');
  const v = await view(open(dir, { COUNCIL_LANG: "ru" }).bridge);
  assert.deepEqual(v, { language: "ru", source: "env", locked: true });
  return `file en, COUNCIL_LANG=ru: language ${v.language}, source ${v.source}, locked ${v.locked}`;
});

await check("unknown variable value", async () => {
  const dir = dataDir(false);
  writeFileSync(prefs(dir), '{ "language": "ru" }\n');
  const v = await view(open(dir, { COUNCIL_LANG: "de" }).bridge);
  assert.deepEqual(v, { language: "ru", source: "file", locked: false });
  return `file ru, COUNCIL_LANG=de: language ${v.language}, source ${v.source}, locked ${v.locked}`;
});

await check("variable in the data folder's .env", async () => {
  const dir = dataDir(false);
  writeFileSync(join(dir, ".env"), "COUNCIL_LANG=ru\n");
  const v = await view(open(dir).bridge);
  assert.deepEqual(v, { language: "ru", source: "env", locked: true });
  return `COUNCIL_LANG=ru only in the data folder's .env (loadEnv): language ${v.language}, source ${v.source}`;
});

await check("change via the bridge", async () => {
  const dir = dataDir(false);
  const { bridge, events } = open(dir);
  const r = await call(bridge, "setLanguage", "ru");
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.deepEqual(r.value, { language: "ru", source: "file", locked: false });
  assert.deepEqual(JSON.parse(readFileSync(prefs(dir), "utf8")), { language: "ru" });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(prefs(dir), "utf8"))), ["language"]);
  const lang = events.filter((e) => e.type === "language");
  assert.equal(lang.length, 1);
  assert.equal(events.length, 1);
  assert.equal(getProcessLanguage(), "ru");
  return `file ${JSON.stringify(JSON.parse(readFileSync(prefs(dir), "utf8")))}, language events ${lang.length}, process language ${getProcessLanguage()}, bridge answer source=${(r.value as { source: string }).source}`;
});

await check("change with the variable set", async () => {
  const dir = dataDir(false);
  writeFileSync(prefs(dir), '{ "language": "en" }\n');
  const before = sha(prefs(dir));
  const { bridge, events } = open(dir, { COUNCIL_LANG: "ru" });
  const r = await call(bridge, "setLanguage", "en");
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, shell("ru").languageLocked);
  assert.equal(sha(prefs(dir)), before);
  assert.equal(events.length, 0);
  assert.equal(getProcessLanguage(), "ru");
  return `refusal «${!r.ok && r.error}» (language ru), file sha256 unchanged, events ${events.length}`;
});

await check("corrupted file", async () => {
  const dir = dataDir(false);
  writeFileSync(prefs(dir), "not json");
  const before = sha(prefs(dir));
  const { bridge } = open(dir);
  const v = await view(bridge);
  assert.equal(v.language, "en");
  const n = await call(bridge, "notices");
  assert.ok(n.ok);
  const notices = n.value as string[];
  assert.equal(notices.length, 1);
  assert.equal(notices[0], shell("en").languageFileNotice("not_json", null));
  assert.match(notices[0]!, /^The language file preferences\.json /);
  assert.equal(sha(prefs(dir)), before);
  const r = await call(bridge, "setLanguage", "ru");
  assert.ok(r.ok);
  assert.deepEqual(JSON.parse(readFileSync(prefs(dir), "utf8")), { language: "ru" });
  const n2 = await call(bridge, "notices");
  assert.ok(n2.ok);
  assert.deepEqual(n2.value, []);
  return `language ${v.language}, notices 1 («${notices[0]!.slice(0, 48)}…»), bytes unchanged; after choosing «Русский» the file is replaced, notices 0`;
});

await check("corrupted file with the variable set", async () => {
  const dir = dataDir(false);
  writeFileSync(prefs(dir), "not json");
  const { bridge } = open(dir, { COUNCIL_LANG: "ru" });
  const v = await view(bridge);
  const n = await call(bridge, "notices");
  assert.ok(n.ok);
  assert.deepEqual(n.value, []);
  assert.equal(v.language, "ru");
  return `language ${v.language} (${v.source}), notices ${(n.value as string[]).length}`;
});

await check("write denied", async () => {
  const dir = dataDir(false);
  writeFileSync(prefs(dir), '{ "language": "en" }\n');
  chmodSync(prefs(dir), 0o444);
  const before = sha(prefs(dir));
  const { bridge, events } = open(dir);
  const r = await call(bridge, "setLanguage", "ru");
  chmodSync(prefs(dir), 0o644);
  assert.equal(r.ok, false);
  const text = !r.ok ? r.error : "";
  assert.match(text, /EACCES/);
  assert.equal(text, shell("en").languageWriteFailed("EACCES"));
  assert.equal((await view(bridge)).language, "en");
  assert.equal(getProcessLanguage(), "en");
  assert.equal(sha(prefs(dir)), before);
  assert.deepEqual(list(dir).filter((f) => f.endsWith(".tmp")), []);
  assert.equal(events.length, 0);
  return `refusal «${text}», language en, file bytes unchanged, no *.tmp, events 0`;
});

await check("window texts and refusals", async () => {
  const out: string[] = [];
  for (const lang of ["en", "ru"] as Language[]) {
    setProcessLanguage(lang);
    for (const n of [1, 2]) {
      const w = closeWarningText(n);
      assert.equal(w.message, shell(lang).closeWarningTitle);
      assert.equal(w.detail, shell(lang).closeWarningDetail(n));
      assert.deepEqual(w.buttons, [shell(lang).closeStay, shell(lang).closeAbort]);
    }
  }
  assert.notEqual(closeWarningText(1, "en").detail, closeWarningText(1, "ru").detail);
  assert.notEqual(closeWarningText(2, "en").detail, closeWarningText(2, "ru").detail);
  assert.notEqual(closeWarningText(1, "en").message, closeWarningText(1, "ru").message);
  assert.match(closeWarningText(2, "en").detail, /\(2\)/);
  assert.match(closeWarningText(2, "ru").detail, /\(2\)/);
  out.push(`close window for 1 and 2 sessions: «${closeWarningText(1, "en").message}» / «${closeWarningText(1, "ru").message}»`);

  const { bridge } = open(dataDir(false));
  const cases: [string, string, unknown[], (l: Language) => string][] = [
    ["openSession", "openSession", ["../x"], (l) => shell(l).invalidSessionId("../x")],
    ["sendOwnerMessage", "sendOwnerMessage", ["s1", "   "], (l) => shell(l).ownerMessageEmpty],
    ["usageSummary", "usageSummary", ["2026-10-10", "2026-10-09"], (l) => shell(l).periodReversed],
  ];
  for (const [name, action, args, expected] of cases) {
    const texts: string[] = [];
    for (const lang of ["en", "ru"] as Language[]) {
      setProcessLanguage(lang);
      const r = await call(bridge, action, ...args);
      assert.equal(r.ok, false, `${name} (${lang}) must be a refusal`);
      assert.equal(!r.ok && r.error, expected(lang));
      texts.push(!r.ok ? r.error : "");
    }
    assert.notEqual(texts[0], texts[1]);
    out.push(`${name}: «${texts[0]}» / «${texts[1]}»`);
  }
  setProcessLanguage("en");
  return out.join("; ");
});

await check("a change does not alter what was written", async () => {
  const dir = dataDir(true);
  const cfg = sha(join(dir, "config.json")), ses = sessionHashes(dir), filesBefore = list(dir);
  const { bridge } = open(dir);
  for (const l of ["ru", "en", "ru", "en", "ru"]) assert.ok((await call(bridge, "setLanguage", l)).ok);
  assert.equal(sha(join(dir, "config.json")), cfg);
  assert.deepEqual(sessionHashes(dir), ses);
  const diff = list(dir).filter((f) => !filesBefore.includes(f));
  assert.deepEqual(diff, ["preferences.json"]);
  assert.deepEqual(filesBefore.filter((f) => !list(dir).includes(f)), []);
  return `after 5 changes sha256 config.json and ${Object.keys(ses).length} journals unchanged; new files only ${diff.join(", ")}, none vanished`;
});

await check("council without a data folder", async () => {
  const codes: string[] = [];
  for (const lang of [undefined, "ru"]) {
    const absent = join(root, `absent-${lang ?? "none"}`, "data");
    const env: Record<string, string | undefined> = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: absent, COUNCIL_LANG: lang };
    if (lang === undefined) delete env["COUNCIL_LANG"];
    const r = spawnSync(process.execPath, [join(project, "packages/core/src/council.ts"), "--help"], { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
    assert.equal(r.status, 0, `exit code ${r.status}, stderr: ${r.stderr}`);
    assert.equal(existsSync(absent), false, "help created a data folder");
    assert.equal(existsSync(join(root, `absent-${lang ?? "none"}`)), false);
    codes.push(`${lang ? "COUNCIL_LANG=ru" : "no variable"}: code ${r.status}, folder not created`);
  }
  return codes.join("; ");
});

await check("network", async () => {
  assert.equal(netCalls, 0);
  return `connections ${netCalls}, fetch 0 (shared counter)`;
});

console.log(`Result: checks ${checks}, all passed; real model calls 0; network requests ${netCalls}`);
