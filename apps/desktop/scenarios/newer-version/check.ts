// Check of the "newer version" and "corrupted journal" sessions in the app: real main modules (history, window texts, export, bridge and resume launch), fixture journals, without an Electron window.
//   COUNCIL_DEV=1 COUNCIL_HOME="<new empty folder inside the project>" node apps/desktop/scenarios/newer-version/check.ts
//   ... --seed-only   only prepare the folder for the app window
//   ... --seed-only --live-pid <pid>   and session D (running, newer version) with this pid: its exit produces a completion notification in the window
// Writes only to COUNCIL_HOME and does not delete it. Models are not called.
import "../../../../packages/core/scenarios/language-ru.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createLogger, ensureDataDir, eventsPath, readRegistry, readSession, resolveLanguage, writeRegistry } from "../../../../packages/core/src/index.ts";
import type { Registry } from "../../../../packages/core/src/index.ts";
import { BUILTIN_TEMPLATES_DIR, loadTemplates, userTemplatesDir } from "../../../../packages/core/src/index.ts";
import { createBridge } from "../../src/main/bridge.ts";
import { createFinishNotifier } from "../../src/main/finish-notify.ts";
import { historyItems } from "../../src/main/history.ts";
import { createLauncher } from "../../src/main/launcher.ts";
import { sessionMarkdown } from "../../src/main/markdown.ts";
import { partialView } from "../../src/shared/partial.ts";
import { IDS, N, seedFixtures, seedLive } from "./fixture.ts";

const home = process.env.COUNCIL_HOME;
const seedOnly = process.argv.includes("--seed-only");
const pidArg = process.argv.indexOf("--live-pid");
const livePid = pidArg > 0 ? Number(process.argv[pidArg + 1]) : null;
if (livePid !== null && !(Number.isInteger(livePid) && livePid > 1)) {
  console.error("--live-pid: the pid of a live process is required");
  process.exit(2);
}
if (process.env.COUNCIL_DEV !== "1" || !home) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME (a new empty folder) are required. Run: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node apps/desktop/scenarios/newer-version/check.ts");
  process.exit(2);
}
if (existsSync(resolve(home)) && (!statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0)) {
  console.error(`COUNCIL_HOME ${resolve(home)} already exists and is not empty: the script writes only to a new folder.`);
  process.exit(2);
}
mkdirSync(resolve(home), { recursive: true });
const dir = realpathSync(resolve(home));
const env = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: dir };
let checks = 0;
const ok = (s: string) => { checks++; console.log(`ok: ${s}`); };

writeRegistry(ensureDataDir(dir), {
  providers: [],
  defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 1000, participants: [] },
} as unknown as Registry);
seedFixtures(dir);
const sha = (id: string) => createHash("sha256").update(readFileSync(eventsPath(dir, id))).digest("hex");
const hashes = () => ({ [IDS.A]: sha(IDS.A), [IDS.B]: sha(IDS.B), [IDS.C]: sha(IDS.C) });
if (seedOnly) {
  if (livePid !== null) seedLive(dir, livePid);
  console.log(`Data folder prepared: ${dir}`);
  console.log(`Sessions: ${IDS.A} (newer version, interrupted, up to №${N.A}), ${IDS.B} (corrupted, interrupted, up to №${N.B}), ${IDS.C} (newer version, running, up to №${N.C})${livePid !== null ? `, ${IDS.D} (newer version, running while pid ${livePid} is alive, up to №${N.D})` : ""}`);
  console.log(`cd "${resolve(import.meta.dirname, "../../../..")}" && COUNCIL_DEV=1 COUNCIL_HOME="${dir}" npm run desktop`);
  process.exit(0);
}

const before = hashes();
const status = (id: string) => readSession(dir, id)!.status;
const statusBefore = { a: status(IDS.A), b: status(IDS.B), c: status(IDS.C) };
const logger = createLogger(dir, "desktop", env);
const launcher = createLauncher({
  dataDir: dir, env, logger, materials: null as never, registry: () => readRegistry(dir),
  catalog: () => loadTemplates({ builtinDir: BUILTIN_TEMPLATES_DIR, userDir: userTemplatesDir(dir) }),
  scenarioPath: () => null, run: (() => { throw new Error("launch is not expected"); }) as never,
});
const stub = <T>(v: T) => () => v;
const bridge = createBridge({
  listSessions: () => historyItems(dir, new Map(), new Set()), sessionExists: stub(true), sessionDrafts: stub([]), watchSession: () => () => {}, notices: stub([]),
  listTemplates: stub({ templates: [], errors: [] }), resumeSession: (id: string, rounds: number) => launcher.resume(id, rounds), send: () => {}, logger,
} as never);
type R = { ok: true; value: unknown } | { ok: false; error: string };
const call = async (a: string, ...args: unknown[]) => (await bridge.call(a, args)) as R;

// 1
const items = historyItems(dir, new Map(), new Set());
const item = (id: string) => items.find((i) => i.id === id)!;
assert.deepEqual(item(IDS.A).partial, { reason: "newer_version", lastEvent: N.A });
assert.deepEqual(item(IDS.B).partial, { reason: "corrupted", lastEvent: N.B });
assert.deepEqual(item(IDS.C).partial, { reason: "newer_version", lastEvent: N.C });
assert.deepEqual([item(IDS.A).status, item(IDS.B).status, item(IDS.C).status], ["interrupted", "interrupted", "running"]);
assert.deepEqual([status(IDS.A), status(IDS.B), status(IDS.C)], ["interrupted", "interrupted", "running"]);
ok(`reads the history as is: C ${IDS.C} newer_version up to №${N.C}, statuses A, B — interrupted (dead pid), C — running (live pid 1); historyItems: ${IDS.A} has partial newer_version, lastEvent ${N.A}; ${IDS.B} has corrupted, lastEvent ${N.B}`);
const listed = await call("listSessions");
assert.ok(listed.ok && (listed.value as { id: string; partial: unknown }[]).find((i) => i.id === IDS.A)!.partial !== null);
ok("the listSessions bridge returns partial");

// 2 ru
const pa = item(IDS.A).partial, pb = item(IDS.B).partial;
const va = partialView(pa, "ru")!, vb = partialView(pb, "ru")!;
assert.equal(va.badge, "нужна новая версия");
assert.ok(va.message.includes(`до события №${N.A}`) && va.mark === `прочитано до события №${N.A}`);
assert.equal(vb.badge, "журнал повреждён");
assert.ok(vb.message.includes(`до события №${N.B}`));
ok("ru: badges «нужна новая версия» and «журнал повреждён», the mark and the message with the event number");

// 3 en and the default language
const d = resolveLanguage({ ...process.env, COUNCIL_LANG: undefined } as never, resolve(dir, "no-prefs"));
assert.deepEqual({ l: d.language, s: d.source }, { l: "en", s: "default" });
const ea = partialView(pa, "en")!, eb = partialView(pb, "en")!, ed = partialView(pa, d.language)!;
assert.equal(ea.badge, "newer version needed");
assert.ok(ea.message.includes("The session was written by a newer version of the app") && ea.message.includes(`No. ${N.A}`));
assert.equal(eb.badge, "journal corrupted");
assert.deepEqual(ed, ea);
assert.ok(![ea, eb].some((v) => /[А-Яа-яЁё]/.test(v.badge + v.mark + v.message)));
ok("en and the default language (en): «newer version needed», «journal corrupted», message without Cyrillic");

// 4 export
const fa = readSession(dir, IDS.A)!;
const md = sessionMarkdown(fa.state, fa.status, "ru", pa);
assert.ok(md.startsWith(`> Сессия записана более новой версией приложения. Показано начало журнала до события №${N.A}`), md.slice(0, 200));
assert.ok(md.includes("Статус: нужна новая версия") && !md.includes("Статус: прервана"), md.slice(0, 400));
assert.ok(sessionMarkdown(fa.state, fa.status, "en", pa).startsWith("> The session was written by a newer version of the app."));
assert.ok(!sessionMarkdown(fa.state, fa.status, "ru", null).startsWith(">"));
ok("export: the first line is the newer-version mark (ru and en); without partial there is no mark");

// 5 resume
const ra = await call("resumeSession", IDS.A, 2), rb = await call("resumeSession", IDS.B, 2);
assert.ok(!ra.ok && ra.error.includes("журнал записан более новой версией"), JSON.stringify(ra));
assert.ok(!rb.ok && rb.error.includes("журнал сессии повреждён"), JSON.stringify(rb));
ok(`resume refused: A «${(ra as { error: string }).error}»; B «${(rb as { error: string }).error}»`);

// 6 completion notification: D is running while the stand's child process is alive; after it exits, one show with the badge
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"], { stdio: "ignore" });
seedLive(dir, child.pid!);
const shaD = sha(IDS.D);
const shown: { title: string; body: string }[] = [];
const notifier = createFinishNotifier({
  isSupported: () => true, focused: () => false, openId: () => null, activate: () => {}, logger,
  show: (text, on) => { shown.push(text); on.shown(); },
});
const observe = () => {
  const list = historyItems(dir, new Map(), new Set());
  notifier.observe(list);
  return list.find((i) => i.id === IDS.D)!;
};
const d1 = observe();
assert.deepEqual({ s: d1.status, p: d1.partial }, { s: "running", p: { reason: "newer_version", lastEvent: N.D } });
assert.equal(shown.length, 0);
child.kill();
await once(child, "exit");
const d2 = observe();
assert.equal(d2.status, "interrupted");
assert.equal(shown.length, 1, JSON.stringify(shown));
assert.equal(shown[0]!.title, "нужна новая версия");
assert.ok(shown[0]!.body.includes(`Тема ${IDS.D}`) && shown[0]!.body.includes(`прочитано до события №${N.D}`), shown[0]!.body);
assert.ok(!JSON.stringify(shown).includes("Обсуждение прервано"));
observe();
assert.equal(shown.length, 1);
assert.equal(sha(IDS.D), shaD);
ok(`completion notification: D ${IDS.D} running → interrupted after the stand's process exits; one show «${shown[0]!.title}» / «${shown[0]!.body.replace("\n", " · ")}»; no «Обсуждение прервано»; a repeated poll gives no show; the D journal is unchanged`);

// 7 journals unchanged
assert.deepEqual(hashes(), before);
assert.deepEqual({ a: status(IDS.A), b: status(IDS.B), c: status(IDS.C) }, statusBefore);
for (const id of [IDS.A, IDS.B, IDS.C]) assert.ok(!existsSync(resolve(dir, "sessions", id, "resume.lock")));
ok("sha256 of all three journals is equal before and after all checks, statuses unchanged, no resume.lock");

console.log(`Result: checks ${checks}, all passed; real model calls 0; data folder ${dir}`);
