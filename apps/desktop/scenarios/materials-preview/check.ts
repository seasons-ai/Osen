// Check of the materials preview on the real main-process modules (bridge, start, draft, settings, logger) and the core, without an Electron window.
//   COUNCIL_DEV=1 COUNCIL_HOME="<new empty folder>" node apps/desktop/scenarios/materials-preview/check.ts
// Writes only to COUNCIL_HOME and does not delete it. Participants are scripted: no real models are called.
import "../../../../packages/core/scenarios/language-ru.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_TEMPLATES_DIR, createLogger, ensureDataDir, loadTemplates, loadPreparedMaterials, readEvents, readRegistry, readSession, resolveLanguage, runStoredSession, savePreparedMaterials, writeRegistry } from "../../../../packages/core/src/index.ts";
import { setProcessLanguage } from "../../../../packages/core/src/i18n/index.ts";
import type { Registry } from "../../../../packages/core/src/index.ts";
import { createBridge } from "../../src/main/bridge.ts";
import { createLauncher } from "../../src/main/launcher.ts";
import { createMaterialsDraft } from "../../src/main/materials.ts";
import { previewMaterials } from "../../src/main/materials-preview.ts";
import { createSettings } from "../../src/main/settings.ts";
import { PREVIEW_RETRY_CODE } from "../../src/shared/setup.ts";
import type { MaterialsPreviewView, MaterialsView } from "../../src/shared/setup.ts";

const home = process.env.COUNCIL_HOME;
if (process.env.COUNCIL_DEV !== "1" || !home) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME (a new empty folder) are required. Run: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node apps/desktop/scenarios/materials-preview/check.ts");
  process.exit(2);
}
if (existsSync(resolve(home)) && (!statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0)) {
  console.error(`COUNCIL_HOME ${resolve(home)} already exists and is not empty: the script writes only to a new folder.`);
  process.exit(2);
}
mkdirSync(resolve(home), { recursive: true });
const dir = realpathSync(resolve(home)); // the materials builder rejects paths through symlinks

const here = dirname(fileURLToPath(import.meta.url));
const scenDir = resolve(here, "../../../../packages/core/scenarios/consensus");
const env = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: dir };
let checks = 0;
const ok = (s: string) => { checks++; console.log(`ok: ${s}`); };

// Registry: materials limit 1000 and one inert HTTP provider (saveDefaults requires participants from the registry; nobody calls it).
writeRegistry(ensureDataDir(dir), {
  providers: [{ id: "inert", kind: "openai-http", label: "Не используется", baseUrl: "http://127.0.0.1:9", models: ["m"] }],
  defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 1000, participants: [{ providerId: "inert", model: "m" }, { providerId: "inert", model: "m" }] },
} satisfies Registry);

// Fixtures
const proj = join(dir, "fx", "proj");
const rnd = randomBytes(6).toString("hex");
const ONDEMAND = `ONDEMAND_ONLY_${rnd}`;
const SECRET = `ctl-${randomBytes(8).toString("hex")}`;
const readme = (mark: string) => `# Проект ${mark}\n${"Описание проекта для проверки предпросмотра материалов. ".repeat(7)}\n`;
mkdirSync(join(proj, "src"), { recursive: true });
writeFileSync(join(proj, "README.md"), readme("PREVIEW_OLD"));
writeFileSync(join(proj, "src/a.ts"), `// ${ONDEMAND}\n${"export const value = 1234567890;\n".repeat(150)}`);
writeFileSync(join(proj, "bin.dat"), Buffer.from([0x62, 0x69, 0x6e, 0, 0, 1, 2, 3, 0]));
writeFileSync(join(proj, ".env"), `CONTROL_SECRET=${SECRET}\n`); // artificial control string, not a real secret
assert.ok(readFileSync(join(proj, "README.md"), "utf8").length > 300 && readFileSync(join(proj, "src/a.ts"), "utf8").length > 1000);

// Real application modules
const logger = createLogger(dir, "desktop", env);
const draft = createMaterialsDraft({ limits: () => { const { materialsChars, materialsIgnore } = readRegistry(dir).defaults; return { materialsChars, materialsIgnore }; } });
const prompts: string[] = [];
const runs: Promise<unknown>[] = [];
const run: typeof runStoredSession = (o) => {
  const drivers = Object.fromEntries(Object.entries(o.drivers).map(([k, d]) => [k, { ...d, call: (req: Parameters<typeof d.call>[0]) => { prompts.push(req.prompt); return d.call(req); } }]));
  const r = runStoredSession({ ...o, drivers });
  runs.push(r);
  return r;
};
const launcher = createLauncher({ dataDir: dir, env, logger, materials: draft, registry: () => readRegistry(dir), catalog: () => loadTemplates({ builtinDir: BUILTIN_TEMPLATES_DIR, userDir: join(dir, "templates") }), scenarioPath: (m) => (m === "p1" || m === "p2" ? join(scenDir, `${m}.json`) : null), run });
const settings = createSettings({ dataDir: dir, env, reloadEnv: () => {}, logger, inspect: async (p) => ({ status: { id: p.id, kind: p.kind, label: p.label, available: false, reason: "не осматривается", models: [], modelsConfirmed: false } }) });
const stub = <T>(v: T) => () => v;
const bridge = createBridge({
  listSessions: stub([]), sessionExists: stub(false), watchSession: () => () => {}, notices: stub([]), listTemplates: stub({ templates: [], errors: [] }),
  registry: async () => ({}) as never, startSession: (input) => launcher.start(input), lastParticipants: stub(null), resumeOptions: async () => ({}) as never,
  resumeSession: async () => ({ droppedOwnerRequests: [] }), stopSession: () => {}, acceptVersion: () => ({}) as never, sendOwnerMessage: () => ({ requestId: "r" }), continueWait: () => ({ requestId: "r" }),
  previewMaterials: (refresh) => previewMaterials({ dataDir: dir, logger, materials: draft }, refresh), prepareRerun: () => ({}) as never, copyText: () => {},
  exportSession: async () => null, setPinned: () => {}, settings, templates: { open: stub(null), create: stub(null), save: stub(null), remove: () => {} } as never,
  materials: draft, pickMaterials: async () => null, send: () => {}, logger,
});

type R = { ok: true; value: unknown } | { ok: false; error: string };
const call = (a: string, ...args: unknown[]): Promise<R> => bridge.call(a, args);
async function good<T>(a: string, ...args: unknown[]): Promise<T> {
  const r = await call(a, ...args);
  assert.ok(r.ok, `${a}: expected success, got: ${r.ok ? "" : r.error}`);
  return r.value as T;
}
async function bad(what: string, a: string, ...args: unknown[]): Promise<string> {
  const r = await call(a, ...args);
  assert.ok(!r.ok, `${what}: expected rejection`);
  return r.error;
}
const preview = (refresh: boolean) => good<MaterialsPreviewView>("previewMaterials", refresh);
const attach = async () => { await good("clearMaterials"); await good("attachMaterials", [proj]); };
const setLimit = async (n: number) => { await good("saveDefaults", { ...readRegistry(dir).defaults, maxTotalTokens: null, materialsChars: n }); };
const sessionsDir = join(dir, "sessions");
const sessionIds = () => (existsSync(sessionsDir) ? readdirSync(sessionsDir).sort() : []);
const preparedDir = join(dir, "prepared-materials");
const setsCount = () => (existsSync(preparedDir) ? readdirSync(preparedDir).length : 0);
const setBytes = (h: string) => readFileSync(join(preparedDir, h, "set.json"));
const topic = "Как назвать кота";
const two = [{ providerId: "scripted", model: "p1", role: null }, { providerId: "scripted", model: "p2", role: null }];
const start = (preparedHandle: string) => call("startSession", { templateId: null, topic, participants: two, maxRounds: 3, useMaterials: true, preparedHandle });
const newSession = async (handle: string) => {
  const before = new Set(sessionIds());
  const r = await start(handle);
  assert.ok(r.ok && (r.value as { id: string | null }).id !== null, `start by set ${handle}: ${r.ok ? (r.value as { error?: string }).error : r.error}`);
  const id = (r.value as { id: string }).id;
  await Promise.allSettled(runs);
  assert.ok(!before.has(id) && readSession(dir, id), "session created");
  return id;
};
const logText = () => readFileSync(join(dir, "logs", "app.log"), "utf8");
const forbidden = [SECRET, ONDEMAND, dir];
const textsOf = (id: string) => [readFileSync(join(sessionsDir, id, "events.jsonl"), "utf8"), logText()];
// A rejection for a prepared set arrives as a value with the preview_retry code, not as a bridge error.
const retryError = (what: string, r: R): string => {
  assert.ok(r.ok, `${what}: expected a rejection as a value, got a bridge error`);
  const v = r.value as { id: unknown; code?: string; error?: string };
  assert.ok(v.id === null && v.code === PREVIEW_RETRY_CODE && typeof v.error === "string", `${what}: expected a value with id null and code ${PREVIEW_RETRY_CODE}`);
  return v.error;
};
const fail = (what: string, handle: string, reDesc: RegExp) => start(handle).then((r) => {
  const error = retryError(what, r);
  assert.match(error, reDesc, `${what}: rejection text`);
  assert.ok(error.endsWith("Обновите предпросмотр."), `${what}: rejection tail: ${error}`);
});

// Step 2. Preview without starting
await attach();
const A0 = await preview(false);
assert.ok(A0.initial?.includes(readme("PREVIEW_OLD").trim()), "initial contains the full README text");
assert.ok(A0.manifest, "manifest is not empty");
ok("initial contains the full README, manifest is not empty");
const av = (n: string) => A0.available.find((x) => x.name.endsWith(n));
assert.equal(av("README.md")?.initial, true, "README is in the initial set");
assert.equal(av("a.ts")?.initial, false, "a.ts is not in the initial set");
assert.ok(av("a.ts")?.reason, "a.ts has a reason");
ok("available: README is initial, src/a.ts is on request with a reason");
for (const n of [".env", "bin.dat"]) assert.ok(A0.skipped.find((x) => x.name.endsWith(n))?.reason, `skipped has ${n} with a reason`);
ok("skipped contains .env and bin.dat with reasons");
const wire = JSON.stringify(A0);
for (const f of forbidden) assert.ok(!wire.includes(f), `the bridge response has no ${f === dir ? "COUNCIL_HOME path" : f}`);
ok("the bridge response contains no .env control string, ONDEMAND_ONLY mark or COUNCIL_HOME path");
assert.ok(existsSync(join(preparedDir, A0.handle, "set.json")), "set.json on disk");
assert.deepEqual(sessionIds(), [], "no sessions");
assert.equal(prompts.length, 0, "no requests to participants");
ok("set on disk, sessions 0, requests to participants 0");

// Step 3. Start by the accepted set after the source changes
writeFileSync(join(proj, "README.md"), readme("PREVIEW_NEW"));
const id3 = await newSession(A0.handle);
const snap = readFileSync(join(sessionsDir, id3, "materials", "m1.txt"), "utf8");
assert.ok(snap.includes("PREVIEW_OLD") && !snap.includes("PREVIEW_NEW"), "m1.txt snapshot is from the set, not from the source");
ok("m1.txt snapshot contains PREVIEW_OLD and not PREVIEW_NEW");
assert.ok(prompts.length > 0, "there were requests to participants");
for (const p of prompts) {
  assert.ok(p.includes(A0.initial!) && p.includes(A0.manifest!), "the request contains exact initial and manifest");
  assert.ok(!p.includes("PREVIEW_NEW"), "the request does not contain PREVIEW_NEW");
}
ok(`${prompts.length} requests to participants: exact initial and manifest, without PREVIEW_NEW`);
for (const t of textsOf(id3)) for (const f of [...forbidden, "PREVIEW_OLD"]) assert.ok(!t.includes(f), `events.jsonl and app.log do not contain ${f === dir ? "COUNCIL_HOME path" : f}`);
ok("events.jsonl and app.log contain no .env, COUNCIL_HOME path, README text or ONDEMAND_ONLY mark");
assert.ok(logText().includes(`prepared set ${A0.handle}`), "app.log has a start line with the set");
ok("app.log start line with “prepared set <handle>”");
assert.ok(readEvents(dir, id3)!.events.length > 0);

// Step 4. Staleness and refresh
await attach();
const A = await preview(false);
const afterRemove = await good<MaterialsView>("removeMaterial", "m1");
assert.notEqual(afterRemove.stamp, A.stamp, "the draft stamp changed");
let sess = sessionIds().length, reqs = prompts.length;
assert.match(retryError("stale A", await start(A.handle)), /Предпросмотр устарел/);
assert.deepEqual([sessionIds().length, prompts.length], [sess, reqs]);
ok("removing a material changes the stamp; start by set A: “Предпросмотр устарел”, no new sessions or requests");

await attach();
const B = await preview(false);
await setLimit(2000);
const stale = await start(B.handle);
assert.match(retryError("limit change", stale), /Предпросмотр устарел/, "limit change: rejected as stale");
assert.deepEqual([sessionIds().length, prompts.length], [sess, reqs]);
await setLimit(1000);
ok("limit changed to 2000: start by set B rejected as stale, no new sessions; limit restored");

const bBytes = setBytes(B.handle);
const C = await preview(true);
assert.notEqual(C.handle, B.handle, "the refresh produced a new set");
assert.ok(bBytes.equals(setBytes(B.handle)), "set B unchanged");
ok("previewMaterials(true): new handle C, set B bytes unchanged");

const cBytes = setBytes(C.handle), sets = setsCount(), viewBefore = await good<MaterialsView>("materials");
renameSync(proj, `${proj}-moved`);
const refreshErr = await bad("source unavailable", "previewMaterials", true);
assert.ok(!refreshErr.includes(dir), `reason without an absolute path: ${refreshErr}`);
assert.equal(setsCount(), sets, "no new sets");
assert.ok(cBytes.equals(setBytes(C.handle)), "set C unchanged");
const viewAfter = await good<MaterialsView>("materials");
assert.deepEqual(viewAfter, viewBefore, "draft and stamp unchanged");
assert.equal(viewAfter.stamp, C.stamp, "draft stamp is the stamp of set C");
renameSync(`${proj}-moved`, proj);
ok(`refresh error (“${refreshErr.replace(/\s+/g, " ").slice(0, 80)}”): no path, same number of sets, set C and draft unchanged`);

const id4 = await newSession(C.handle);
const snap4 = readFileSync(join(sessionsDir, id4, "materials", "m1.txt"), "utf8");
assert.ok(C.initial!.includes(snap4.trim()) && snap4.includes("PREVIEW_NEW"), "snapshot matches the preview text of C");
ok("start by set C after the failed refresh succeeded, snapshot matches the preview of C");

// Step 5. Handle rejections
await attach();
const D = await preview(false); // non-empty draft, unchanged until the end of the step
assert.equal((await good<MaterialsView>("materials")).stamp, D.stamp);
sess = sessionIds().length; reqs = prompts.length;
const unchanged = () => assert.deepEqual([sessionIds().length, prompts.length], [sess, reqs], "no new sessions or requests");

await fail("unknown", randomBytes(16).toString("hex"), /не найден/); unchanged();
ok("unknown handle: “не найден”, “Обновите предпросмотр.”");

const other = join(dir, "other-home");
mkdirSync(other, { recursive: true });
const foreign = savePreparedMaterials(other, draft.snapshot());
await fail("foreign", foreign.id, /не найден/); unchanged();
ok("set from another data folder: “не найден”");

const E = await preview(false);
const f = join(preparedDir, E.handle, "set.json");
const bytes = readFileSync(f);
bytes[Math.floor(bytes.length / 2)] ^= 1;
writeFileSync(f, bytes);
await fail("corrupted", E.handle, /повреждён/); unchanged();
ok("corrupted set: “повреждён”");

const old = savePreparedMaterials(dir, draft.snapshot(), { now: () => new Date(Date.now() - 25 * 3600 * 1000) });
await fail("older than 24 hours", old.id, /24 часов/); unchanged();
ok("set older than 24 hours: “24 часов”");

const trav = await start(`../sessions/${id3}`);
const travErr = retryError("path traversal", trav);
assert.ok(/Недопустимый идентификатор/.test(travErr) && travErr.endsWith("Обновите предпросмотр."), `path traversal: ${travErr}`);
unchanged();
ok("path traversal: “Недопустимый идентификатор”, “Обновите предпросмотр.”");
assert.ok(loadPreparedMaterials(dir, D.handle), "set D intact");

// Step 6. English: rejections in the action's language, language switch without recreating the bridge, default language
const noCyr = (what: string, t: string) => assert.doesNotMatch(t, /[А-Яа-яЁё]/, `${what}: Cyrillic in an English rejection: ${t}`);
const big = join(dir, "fx", "big.txt");
writeFileSync(big, "x".repeat(11000)); // 11000 > 10 × limit 1000
const overRu = async () => { await attach(); const before = await good<MaterialsView>("materials"); const v = await good<MaterialsView>("attachMaterials", [big]); return { before, v }; };
const ruOver = await overRu();
assert.match(ruOver.v.error ?? "", /^Не добавлено: объём \d+ знаков больше границы 10000 \(10 × лимит сессии 1000\)$/);
const nums = ruOver.v.error!.match(/\d+/g)!;
setProcessLanguage("en");
{
  await good("clearMaterials");
  const sets0 = setsCount();
  const empty = await bad("empty preview", "previewMaterials", false);
  assert.equal(empty, "No materials attached: nothing to show");
  assert.equal(setsCount(), sets0, "set not created");
  ok("en: preview without materials — “No materials attached: nothing to show”, set not created");

  await attach();
  const S = await preview(false);
  await good<MaterialsView>("removeMaterial", "m1");
  const sess6 = sessionIds().length, reqs6 = prompts.length;
  const enStale = retryError("stale (en)", await start(S.handle));
  assert.match(enStale, /^The preview is outdated: .+ Refresh the preview\.$/);
  noCyr("stale set", enStale);
  assert.deepEqual([sessionIds().length, prompts.length], [sess6, reqs6], "no new sessions or requests");
  ok(`en: start by a stale set — a value with code ${PREVIEW_RETRY_CODE}, “${enStale}”, no session`);

  await attach();
  const before = await good<MaterialsView>("materials");
  const v = await good<MaterialsView>("attachMaterials", [big]);
  assert.equal(v.error, `Not added: ${nums[0]} characters exceed the bound of ${nums[1]} (${nums[2]} × session limit ${nums[3]})`);
  noCyr("draft limit", v.error!);
  assert.deepEqual({ ...v, error: null }, { ...before, error: null }, "draft unchanged");
  assert.equal(v.stamp, before.stamp, "stamp unchanged");
  ok(`en: adding beyond the limit — “${v.error}”, draft and stamp unchanged`);
}
setProcessLanguage("ru");
assert.equal((await good<MaterialsView>("attachMaterials", [big])).error, ruOver.v.error);
await good("clearMaterials");
assert.equal(await bad("empty preview (ru)", "previewMaterials", false), "Материалы не приложены: показывать нечего");
ok("switch back to ru without recreating the bridge: the same rejections in Russian (limit, empty preview)");

{
  const defDir = join(dir, "lang-default");
  mkdirSync(defDir);
  const envNoLang = { ...process.env };
  delete envNoLang["COUNCIL_LANG"];
  const resolved = resolveLanguage(envNoLang, defDir);
  assert.deepEqual({ language: resolved.language, source: resolved.source }, { language: "en", source: "default" });
  setProcessLanguage(resolved.language);
  await good("clearMaterials");
  const e = await bad("empty preview (default)", "previewMaterials", false);
  assert.equal(e, "No materials attached: nothing to show");
  setProcessLanguage("ru");
  ok("default language en (no COUNCIL_LANG, folder without preferences.json, source default): preview rejection in English");
}

console.log(`Total: ${checks} checks, all passed; real model calls 0; data folder ${dir}`);
