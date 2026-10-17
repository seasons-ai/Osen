// Check of named lineups in the app on the real main-process modules (bridge, start, lineups) and the core, without an Electron window.
//   COUNCIL_DEV=1 COUNCIL_HOME="<new empty folder>" node apps/desktop/scenarios/lineups/check.ts
//   COUNCIL_DEV=1 COUNCIL_HOME="<new empty folder>" node apps/desktop/scenarios/lineups/check.ts --seed-only   (only prepare the folder for the app window)
// Writes only to COUNCIL_HOME and does not delete it. Participants are scripted: real models are not called.
import "../../../../packages/core/scenarios/language-ru.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_TEMPLATES_DIR, createLogger, ensureDataDir, envFilePath, inspectProviders, listSessions, loadTemplates, lineupsPath, readRegistry, runStoredSession, userTemplatesDir, writeRegistry } from "../../../../packages/core/src/index.ts";
import type { Registry } from "../../../../packages/core/src/index.ts";
import { resolveLanguage } from "../../../../packages/core/src/index.ts";
import { setProcessLanguage } from "../../../../packages/core/src/i18n/index.ts";
import { launch } from "../../src/shared/messages/launch.ts";
import { createBridge } from "../../src/main/bridge.ts";
import { createLauncher } from "../../src/main/launcher.ts";
import { lineupsView, saveLineupInput } from "../../src/main/lineups.ts";
import { listScenarios, scenarioPath } from "../../src/main/setup-data.ts";
import type { LineupSaveResult, LineupsView } from "../../src/shared/setup.ts";

const home = process.env.COUNCIL_HOME;
const seedOnly = process.argv.includes("--seed-only");
if (process.env.COUNCIL_DEV !== "1" || !home) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME (a new empty folder) are required. Run: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node apps/desktop/scenarios/lineups/check.ts");
  process.exit(2);
}
if (existsSync(resolve(home)) && (!statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0)) {
  console.error(`COUNCIL_HOME ${resolve(home)} already exists and is not empty: the script writes only to a new folder.`);
  process.exit(2);
}
mkdirSync(resolve(home), { recursive: true });
const dir = realpathSync(resolve(home));

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
// The same scripted model names as in the app: a path relative to packages/core/scenarios (for example consensus/p1.json).
const scenariosDir = join(root, "packages/core/scenarios");
const P1 = "consensus/p1.json", P2 = "consensus/p2.json";
assert.ok(listScenarios(scenariosDir).includes(P1) && listScenarios(scenariosDir).includes(P2), "scenarios consensus/p1.json and p2.json found");
const env = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: dir };
let checks = 0;
const ok = (s: string) => { checks++; console.log(`ok: ${s}`); };

// Seed: a registry without real providers, the lineup "Старый" with a missing provider, a sample materials file.
writeRegistry(ensureDataDir(dir), {
  providers: [],
  defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 1000, participants: [] },
} satisfies Registry);
const OLD_ID = "5b0c1d3e-7a42-4c8e-9f10-2a6b8d4e1c01";
writeFileSync(lineupsPath(dir), `${JSON.stringify([{ id: OLD_ID, name: "Старый", participants: [{ providerId: "scripted", model: P1, role: "Автор" }, { providerId: "local-llm", model: "llama-3", role: "Критик" }] }], null, 2)}\n`);
mkdirSync(join(dir, "fx"), { recursive: true });
writeFileSync(join(dir, "fx", "sample.md"), "# Образец\nКороткий файл для проверки материалов в окне приложения.\n");

if (seedOnly) {
  console.log(`Data folder prepared: ${dir}`);
  console.log(`cd "${root}" && COUNCIL_DEV=1 COUNCIL_HOME="${dir}" npm run desktop`);
  process.exit(0);
}

// Real app modules; the lineups/saveLineup binding repeats apps/desktop/src/main/index.ts.
const logger = createLogger(dir, "desktop", env);
const runs: Promise<unknown>[] = [];
const run: typeof runStoredSession = (o) => { const r = runStoredSession(o); runs.push(r); return r; };
const scenPath = (m: string) => scenarioPath(scenariosDir, m);
const launcher = createLauncher({ dataDir: dir, env, logger, materials: null as never, registry: () => readRegistry(dir), catalog: () => loadTemplates({ builtinDir: BUILTIN_TEMPLATES_DIR, userDir: userTemplatesDir(dir) }), scenarioPath: scenPath, run });
const stub = <T>(v: T) => () => v;
const makeBridge = () => createBridge({
  listSessions: stub([]), sessionExists: stub(false), watchSession: () => () => {}, notices: stub([]), listTemplates: stub({ templates: [], errors: [] }),
  registry: async () => ({}) as never, startSession: (input) => launcher.start(input),
  lineups: async () => {
    const reg = readRegistry(dir);
    const found = await inspectProviders(reg, { env, keyFile: envFilePath(dir) });
    return lineupsView(dir, reg, found.map((f) => f.status), (m) => (scenPath(m) === null ? launch().scenarioUnavailable(m) : null));
  },
  saveLineup: (input) => saveLineupInput(dir, input),
  lastParticipants: stub(null), resumeOptions: async () => ({}) as never,
  resumeSession: async () => ({ droppedOwnerRequests: [] }), stopSession: () => {}, acceptVersion: () => ({}) as never, sendOwnerMessage: () => ({ requestId: "r" }), continueWait: () => ({ requestId: "r" }),
  previewMaterials: async () => ({}) as never, prepareRerun: () => ({}) as never, copyText: () => {},
  exportSession: async () => null, setPinned: () => {}, settings: {} as never, templates: { open: stub(null), create: stub(null), save: stub(null), remove: () => {} } as never,
  materials: { snapshot: stub(null) } as never, pickMaterials: async () => null, send: () => {}, logger,
} as never);

type R = { ok: true; value: unknown } | { ok: false; error: string };
let bridge = makeBridge();
const call = (a: string, ...args: unknown[]): Promise<R> => bridge.call(a, args);
async function good<T>(a: string, ...args: unknown[]): Promise<T> {
  const r = await call(a, ...args);
  assert.ok(r.ok, `${a}: expected success, got: ${r.ok ? "" : r.error}`);
  return r.value as T;
}
async function bad(what: string, a: string, ...args: unknown[]): Promise<string> {
  const r = await call(a, ...args);
  assert.ok(!r.ok, `${what}: expected a refusal`);
  return r.error;
}
const lineups = () => good<LineupsView>("lineups");
const save = (name: string, participants: unknown[], extra: Record<string, unknown> = {}) => good<LineupSaveResult>("saveLineup", { name, participants, ...extra });
const file = lineupsPath(dir);
const sessions = () => listSessions(dir);
const sc = (model: string, role: string | null) => ({ providerId: "scripted", model, role });
const topic = "Как назвать кота";
const startInput = (participants: unknown[]) => ({ templateId: null, topic, participants, maxRounds: 3 });
const names = (ps: { providerId: string; model: string; role: string | null }[]) => ps.map((p) => `${p.providerId}:${p.model}:${p.role}`);

// 1
const v0 = await lineups();
assert.equal(v0.error, null);
assert.equal(v0.lineups.length, 1);
const old = v0.lineups[0]!;
assert.equal(old.name, "Старый");
assert.equal(old.available, false);
assert.equal(old.participants[0]!.available, true);
assert.equal(old.participants[1]!.available, false);
assert.ok(old.participants[1]!.reason?.includes("local-llm"), `the reason names local-llm: ${old.participants[1]!.reason}`);
ok("lineups on a fresh folder: \"Старый\", error null, lineup unavailable, position 1 available, position 2 unavailable with a reason about local-llm");

// 2
assert.deepEqual(Object.keys(old), ["id", "name", "available", "participants"]);
for (const p of old.participants) assert.deepEqual(Object.keys(p), ["providerId", "model", "role", "available", "reason", "modelNote"]);
ok("the lineup and position DTO contain exactly the contract fields");

// 3
const r3 = await save("Ревью", [sc(P2, "Критик"), sc(P1, "Автор")], { apiKey: "sk-stand-secret", topic: "тема не должна попасть" });
assert.equal(r3.ok, true);
assert.deepEqual(sessions(), []);
const tplDir = userTemplatesDir(dir);
assert.deepEqual(existsSync(tplDir) ? readdirSync(tplDir) : [], []);
assert.ok(!readFileSync(file, "utf8").includes("sk-stand-secret") && !readFileSync(file, "utf8").includes("тема не должна"), "extra fields did not reach the file");
ok("saveLineup \"Ревью\": ok, no sessions, no templates, extra fields (apiKey, topic) did not reach lineups.json");

// 4
bridge = makeBridge();
const v4 = await lineups();
assert.deepEqual(v4.lineups.map((l) => l.name), ["Старый", "Ревью"]);
const rev = v4.lineups[1]!;
assert.deepEqual(names(rev.participants), [`scripted:${P2}:Критик`, `scripted:${P1}:Автор`]);
assert.ok(rev.available && rev.participants.every((p) => p.available), "all positions of \"Ревью\" are available");
ok("after restart (new bridge): \"Старый\" and \"Ревью\", order, models and roles preserved, all positions available");

// 5
const before5 = readFileSync(file);
const err5 = await save("Ревью", [sc(P1, "Автор"), sc(P2, "Критик")]);
assert.equal(err5.ok, false);
assert.match((err5 as { error: string }).error, /уже занято/);
assert.ok(before5.equals(readFileSync(file)), "lineups.json bytes unchanged");
assert.deepEqual(names((await lineups()).lineups[1]!.participants), [`scripted:${P2}:Критик`, `scripted:${P1}:Автор`]);
ok("taken name: refusal \"уже занято\", lineups.json bytes equal, order of \"Ревью\" unchanged");

// 6
const errStart = await bad("start by \"Старый\" as is", "startSession", startInput(old.participants.map((p) => ({ providerId: p.providerId, model: p.model, role: p.role }))));
assert.match(errStart, /не найден в реестре/);
assert.deepEqual(sessions(), []);
ok(`start by the positions of "Старый": refusal ("${errStart}"), no sessions, provider not substituted`);

// 7
const fixed = [sc(P1, "Автор"), sc(P2, "Критик")];
const s7 = await good<{ id: string }>("startSession", startInput(fixed));
await Promise.allSettled(runs);
const list7 = sessions();
assert.equal(list7.length, 1);
assert.equal(list7[0]!.id, s7.id);
assert.deepEqual(list7[0]!.participants.map((p) => `${p.providerId}:${p.role}`), ["scripted:Автор", "scripted:Критик"]);
const oldRaw = JSON.parse(readFileSync(file, "utf8")).find((l: { name: string }) => l.name === "Старый");
assert.equal(oldRaw.participants[1].providerId, "local-llm");
ok("fixed form (position 2 is a scripted participant): session created and finished, roles \"Автор\" and \"Критик\"; \"Старый\" in the file did not change");

// 8
const s8 = await good<{ id: string }>("startSession", startInput(rev.participants.map((p) => ({ providerId: p.providerId, model: p.model, role: p.role }))));
await Promise.allSettled(runs);
const sess8 = sessions().find((s) => s.id === s8.id);
assert.ok(sess8, "the session by \"Ревью\" was created");
assert.deepEqual(sess8.participants.map((p) => `${p.model}:${p.role}`), [`${P2}:Критик`, `${P1}:Автор`]);
ok("start by \"Ревью\": session created, participant order and roles match the lineup");

// 9
const good9 = readFileSync(file);
writeFileSync(file, "{not json");
const broken = readFileSync(file);
const v9 = await lineups();
assert.deepEqual(v9.lineups, []);
assert.ok(v9.error && v9.error.length > 0, "the reason is not empty");
const r9 = await save("Новый", [sc(P1, null), sc(P2, null)]);
assert.equal(r9.ok, false);
assert.ok(broken.equals(readFileSync(file)), "the corrupted file is unchanged");
writeFileSync(file, good9);
assert.equal((await lineups()).lineups.length, 2);
ok("corrupted file: lineups empty with a reason, saveLineup refused, file untouched; after the bytes are restored there are two lineups again");

// 10. English: refusals in the action language, return to ru without recreating the bridge, default language
const noCyr = (what: string, t: string) => assert.doesNotMatch(t, /[А-Яа-яЁё]/, `${what}: Cyrillic in English text: ${t}`);
const GHOST = "nope/ghost.json";
assert.equal((await save("Призрак", [sc(GHOST, null), sc(P1, null)])).ok, true);
const ghostPos = async () => (await lineups()).lineups.find((l) => l.name === "Призрак")!.participants[0]!;
const badSave = { name: "Сломанный", participants: [{ providerId: "scripted", role: null }] };
const badStart = startInput([sc(GHOST, null), sc(P1, null)]);
const fileBefore = readFileSync(file);
setProcessLanguage("en");
{
  const e1 = await bad("scenario unavailable (en)", "startSession", badStart);
  assert.equal(e1, `Scenario “${GHOST}” is unavailable.`);
  noCyr("start", e1);
  const pos = await ghostPos();
  assert.equal(pos.available, false);
  assert.equal(pos.reason, `Scenario “${GHOST}” is unavailable.`);
  noCyr("lineup position", pos.reason!);
  const r = await good<LineupSaveResult>("saveLineup", badSave);
  assert.equal(r.ok, false);
  assert.equal((r as { error: string }).error, "Invalid lineup save request: participant 1 has no model.");
  noCyr("lineup save", (r as { error: string }).error);
  assert.ok(fileBefore.equals(readFileSync(file)), "lineups.json bytes unchanged");
  assert.deepEqual(sessions().length, 2, "no new sessions");
  ok("en: unavailable scenario at start and in a lineup position, invalid save gives \"Invalid lineup save request: …\", lineups.json unchanged, no Cyrillic");
}
setProcessLanguage("ru");
assert.equal(await bad("scenario unavailable (ru)", "startSession", badStart), `Сценарий «${GHOST}» недоступен.`);
assert.equal((await ghostPos()).reason, `Сценарий «${GHOST}» недоступен.`);
assert.equal(((await good<LineupSaveResult>("saveLineup", badSave)) as { error: string }).error, "Некорректный запрос сохранения состава: у участника 1 нет модели.");
assert.ok(fileBefore.equals(readFileSync(file)), "lineups.json bytes unchanged");
ok("return to ru without recreating the bridge: the same three refusals in Russian");

{
  const defDir = join(dir, "lang-default");
  mkdirSync(defDir);
  const envNoLang = { ...process.env };
  delete envNoLang["COUNCIL_LANG"];
  const resolved = resolveLanguage(envNoLang, defDir);
  assert.deepEqual({ language: resolved.language, source: resolved.source }, { language: "en", source: "default" });
  setProcessLanguage(resolved.language);
  assert.equal(await bad("default language", "startSession", badStart), `Scenario “${GHOST}” is unavailable.`);
  setProcessLanguage("ru");
  ok("default language en (no COUNCIL_LANG, folder without preferences.json, source default): the start refusal is in English");
}

console.log(`Result: ${checks} checks, all passed; real model calls 0; data folder ${dir}`);
