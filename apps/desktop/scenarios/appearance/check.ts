// Theme (appearance) check: real main modules (createAppearanceState, createBridge, windowOptions), the core logger and a fake nativeTheme, without an Electron window.
//   COUNCIL_DEV=1 COUNCIL_HOME="<new empty folder inside the project>" node apps/desktop/scenarios/appearance/check.ts
// Writes only to subfolders of COUNCIL_HOME and does not delete it. Models are not called, the network is not used.
import "../../../../packages/core/scenarios/language-ru.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import net from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger, ensureDataDir, writeRegistry } from "../../../../packages/core/src/index.ts";
import type { Registry } from "../../../../packages/core/src/index.ts";
import { setProcessLanguage } from "../../../../packages/core/src/i18n/index.ts";
import { createBridge } from "../../src/main/bridge.ts";
import { APPEARANCE_FILE, WINDOW_BACKGROUNDS, createAppearanceState } from "../../src/main/appearance.ts";
import { windowOptions } from "../../src/main/window.ts";
import { THEME_ARG, themeFromArgv } from "../../src/shared/theme-arg.ts";
import { shell } from "../../src/shared/messages/shell.ts";
import type { BridgeEvent, ThemeMode } from "../../src/shared/bridge.ts";

const home = process.env.COUNCIL_HOME;
if (process.env.COUNCIL_DEV !== "1" || !home) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME (a new empty folder) are required. Run: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node apps/desktop/scenarios/appearance/check.ts");
  process.exit(2);
}
if (existsSync(resolve(home)) && (!statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0)) {
  console.error(`COUNCIL_HOME ${resolve(home)} already exists and is not empty: the script writes only to a new folder.`);
  process.exit(2);
}
mkdirSync(resolve(home), { recursive: true });
const root = realpathSync(resolve(home));

// network: counters are attached before the first request, the originals are called as before
let netCalls = 0;
const origConnect = net.Socket.prototype.connect, origFetch = globalThis.fetch;
net.Socket.prototype.connect = function (this: net.Socket, ...a: never[]) { netCalls++; return (origConnect as (...x: unknown[]) => net.Socket).apply(this, a); } as never;
globalThis.fetch = ((...a: Parameters<typeof fetch>) => { netCalls++; return origFetch(...a); }) as typeof fetch;

const sha = (p: string) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "no file");
let seq = 0;
function dataDir(): string {
  const dir = join(root, `case-${++seq}`);
  mkdirSync(dir);
  return dir;
}
const afile = (d: string) => join(d, APPEARANCE_FILE);

function seedConfig(dir: string): void {
  writeRegistry(ensureDataDir(dir), {
      providers: [],
      defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 1000, participants: [] },
  } as unknown as Registry);
}

// Fake Electron nativeTheme: themeSource follows applyMode, shouldUseDarkColors follows the source or the system.
function open(dir: string) {
  const nt = { source: "system" as ThemeMode, macDark: false };
  const events: BridgeEvent[] = [];
  const errors: string[] = [];
  const real = createLogger(dir, "desktop", { COUNCIL_DEV: "1" });
  const logger = { info: (m: string) => real.info(m), error: (m: string, c?: unknown) => { errors.push(m); real.error(m, c); } };
  const appearance = createAppearanceState({
    dataDir: dir,
    systemDark: () => (nt.source === "system" ? nt.macDark : nt.source === "dark"),
    applyMode: (m) => { nt.source = m; },
    send: (e) => events.push(e),
    logger,
  });
  const stub = <T>(v: T) => () => v;
  const bridge = createBridge({
    listSessions: stub([]), sessionExists: stub(false), sessionDrafts: stub([]), usageSummary: stub({}), watchSession: () => () => {},
    notices: stub([]), listTemplates: stub({ templates: [], errors: [] }), send: () => {}, logger, appearance,
  } as never);
  return { nt, events, errors, appearance, bridge };
}
type R = { ok: true; value: unknown } | { ok: false; error: string };
const call = async (b: ReturnType<typeof open>["bridge"], action: string, ...args: unknown[]) => (await b.call(action, args)) as R;
const theme = (s: { view(): { theme: string } }) => s.view().theme;

let checks = 0;
async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const text = await fn();
    checks++;
    console.log(`step ${checks} — ok: ${text}`);
  } catch (e) {
    console.log(`FAIL: step ${checks + 1} (${name}) — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

await check("empty folder defaults", async () => {
  const dir = dataDir();
  writeFileSync(join(dir, "preferences.json"), '{"language":"ru"}\n');
  seedConfig(dir);
  const { appearance, errors, nt } = open(dir);
  assert.equal(theme(appearance), "osen");
  assert.equal(existsSync(afile(dir)), false);
  assert.deepEqual(errors, []);
  assert.equal(nt.source, "dark");
  const opts = windowOptions("/preload.js", false, "osen");
  assert.equal(opts.backgroundColor, "#17130F");
  assert.deepEqual(opts.webPreferences?.additionalArguments, [`${THEME_ARG}osen`]);
  assert.equal(themeFromArgv(opts.webPreferences!.additionalArguments!), "osen");
  return `theme osen, appearance.json not created, logger errors 0, background ${opts.backgroundColor}, argument ${opts.webPreferences!.additionalArguments![0]}`;
});

await check("set through the bridge", async () => {
  const dir = dataDir();
  writeFileSync(join(dir, "preferences.json"), '{"language":"ru"}\n');
  seedConfig(dir);
  const prefs = sha(join(dir, "preferences.json")), cfg = sha(join(dir, "config.json"));
  const { bridge, events, appearance } = open(dir);
  const r = await call(bridge, "setAppearance", { mode: "light", lightTheme: "len" });
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.deepEqual(JSON.parse(readFileSync(afile(dir), "utf8")), { mode: "light", lightTheme: "len" });
  const ev = events.filter((e) => e.type === "appearance");
  assert.equal(ev.length, 1);
  assert.equal(events.length, 1);
  assert.equal((ev[0] as { view: { theme: string } }).view.theme, "len");
  assert.equal(appearance.background(), "#F5F5F2");
  assert.equal(appearance.background(), WINDOW_BACKGROUNDS.len);
  assert.equal(sha(join(dir, "preferences.json")), prefs);
  assert.equal(sha(join(dir, "config.json")), cfg);
  return `file {mode light, lightTheme len}, 1 appearance event (theme len), background ${appearance.background()}, preferences.json and config.json sha256 unchanged`;
});

await check("unknown value in the file", async () => {
  const dir = dataDir();
  writeFileSync(afile(dir), '{ "lightTheme": "sakura" }\n');
  const a = open(dir);
  assert.equal(theme(a.appearance), "osen");
  assert.equal(a.appearance.view().lightTheme, "tuman");
  const dir2 = dataDir();
  writeFileSync(afile(dir2), '{ "mode": "light", "lightTheme": "sakura" }\n');
  const before = sha(afile(dir2));
  const b = open(dir2);
  assert.equal(theme(b.appearance), "tuman");
  assert.equal(b.errors.length, 1);
  assert.match(b.errors[0]!, /sakura/);
  assert.equal(sha(afile(dir2)), before);
  const log = readFileSync(join(dir2, "logs", "app.log"), "utf8").split("\n").filter((l) => l.includes("sakura"));
  assert.equal(log.length, 1);
  assert.match(log[0]!, / ERROR \[desktop\] /);
  return `mode missing: theme osen, light theme tuman; mode light + sakura: theme tuman, 1 logger error, 1 line in logs/app.log, file bytes unchanged`;
});

await check("read-only file", async () => {
  if (process.getuid?.() === 0) return "skipped: running as root, chmod does not restrict it";
  const dir = dataDir();
  const { bridge, events, appearance } = open(dir);
  assert.ok((await call(bridge, "setAppearance", { mode: "light", lightTheme: "len" })).ok);
  chmodSync(afile(dir), 0o444);
  try {
    const before = sha(afile(dir)), viewBefore = appearance.view(), evBefore = events.length;
    const out: string[] = [];
    for (const lang of ["ru", "en"] as const) {
      setProcessLanguage(lang);
      const r = await call(bridge, "setAppearance", { lightTheme: "inei" });
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.error, shell(lang).appearanceWriteFailed("EACCES"));
      assert.match(!r.ok ? r.error : "", /EACCES/);
      assert.deepEqual(appearance.view(), viewBefore);
      assert.equal(sha(afile(dir)), before);
      assert.equal(events.length, evBefore);
      out.push(`${lang}: «${!r.ok ? r.error : ""}»`);
    }
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
    return `refusals ${out.join(" / ")}; view, file bytes and events unchanged, no *.tmp`;
  } finally {
    chmodSync(afile(dir), 0o644);
    setProcessLanguage("ru");
  }
});

await check("system mode", async () => {
  const dir = dataDir();
  const { bridge, events, appearance, nt } = open(dir);
  nt.macDark = true;
  assert.ok((await call(bridge, "setAppearance", { mode: "system", lightTheme: "tuman" })).ok);
  assert.equal(theme(appearance), "osen");
  events.length = 0;
  nt.macDark = false;
  appearance.systemChanged();
  assert.equal(theme(appearance), "tuman");
  assert.equal(events.length, 1);
  assert.ok((await call(bridge, "setAppearance", { mode: "light" })).ok);
  events.length = 0;
  nt.macDark = true;
  appearance.systemChanged();
  assert.equal(theme(appearance), "tuman");
  assert.equal(events.length, 0);
  return "system + dark Mac: osen; Mac turns light: tuman, 1 event; mode light + Mac dark: stays tuman, 0 events";
});

await check("persistence", async () => {
  const dir = dataDir();
  const a = open(dir);
  assert.ok((await call(a.bridge, "setAppearance", { mode: "light", lightTheme: "pergament" })).ok);
  assert.ok((await call(a.bridge, "setAppearance", { mode: "system", lightTheme: "inei" })).ok);
  const b = open(dir);
  assert.deepEqual(b.appearance.view(), a.appearance.view());
  assert.equal(b.appearance.view().mode, "system");
  assert.equal(b.appearance.view().lightTheme, "inei");
  return `a new state reads the last choice: ${JSON.stringify(b.appearance.view())}`;
});

await check("network", async () => {
  assert.equal(netCalls, 0);
  return `connections ${netCalls}, models not called`;
});

console.log(`appearance check: ${checks} steps passed`);
