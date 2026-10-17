// Check of "Excluded by rules" and the return in session setup on the real main-process modules (bridge, start, draft, preview, session rerun) and the core, without an Electron window.
//   COUNCIL_DEV=1 COUNCIL_HOME="<new empty folder inside the project>" node apps/desktop/scenarios/folder-ignore/check.ts
//   ... --seed-only   (only prepare the registry and the fixture for the app window; prints the proj path)
// Writes only to COUNCIL_HOME and does not delete it. Participants are scripted: real models are not called.
import "../../../../packages/core/scenarios/language-ru.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_TEMPLATES_DIR, createLogger, ensureDataDir, loadTemplates, readRegistry, runStoredSession, writeRegistry } from "../../../../packages/core/src/index.ts";
import type { Registry } from "../../../../packages/core/src/index.ts";
import { setProcessLanguage } from "../../../../packages/core/src/i18n/index.ts";
import { createBridge } from "../../src/main/bridge.ts";
import { createLauncher } from "../../src/main/launcher.ts";
import { createMaterialsDraft } from "../../src/main/materials.ts";
import { previewMaterials } from "../../src/main/materials-preview.ts";
import { prepareRerun } from "../../src/main/rerun.ts";
import { createSettings } from "../../src/main/settings.ts";
import { sessionSetup } from "../../src/shared/messages/session-setup.ts";
import type { MaterialsPreviewView, MaterialsView, RerunView } from "../../src/shared/setup.ts";

const home = process.env.COUNCIL_HOME;
const seedOnly = process.argv.includes("--seed-only");
if (process.env.COUNCIL_DEV !== "1" || !home) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME (a new empty folder) are required. Run: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node apps/desktop/scenarios/folder-ignore/check.ts");
  process.exit(2);
}
if (existsSync(resolve(home)) && (!statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0)) {
  console.error(`COUNCIL_HOME ${resolve(home)} already exists and is not empty: the script writes only to a new folder.`);
  process.exit(2);
}
mkdirSync(resolve(home), { recursive: true });
const dir = realpathSync(resolve(home));

const here = dirname(fileURLToPath(import.meta.url));
const scenDir = resolve(here, "../../../../packages/core/scenarios/consensus");
const env = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: dir };
let checks = 0;
const ok = (s: string) => { checks++; console.log(`ok: ${s}`); };

writeRegistry(ensureDataDir(dir), {
  providers: [{ id: "inert", kind: "openai-http", label: "Не используется", baseUrl: "http://127.0.0.1:9", models: ["m"] }],
  defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 1000, participants: [{ providerId: "inert", model: "m" }, { providerId: "inert", model: "m" }] },
} satisfies Registry);

// Fixtures (out/ is ignored by the project's root .gitignore, so the stand creates them)
const w = (p: string, text: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
const proj = join(dir, "fx", "proj");
w(join(proj, ".gitignore"), "out/\n");
w(join(proj, "README.md"), `# Проект\n${"Описание проекта для проверки исключённого правилами. ".repeat(4)}\n`);
w(join(proj, "src/a.ts"), "export const a = 1;\n");
w(join(proj, "out/main.js"), `// OUT_MAIN\n${"export const big = 1234567890;\n".repeat(150)}`); // above the materials limit of 1000
w(join(proj, "out/lib/util.js"), "// OUT_UTIL\nexport const util = 1;\n");
const pa = join(dir, "fx", "a", "proj"), pb = join(dir, "fx", "b", "proj");
for (const [p, mark] of [[pa, "FROM_A"], [pb, "FROM_B"]] as const) {
  w(join(p, ".gitignore"), "out/\n");
  w(join(p, "README.md"), `# ${mark}\n`);
  w(join(p, "out/x.js"), `// ${mark}\n`);
}
if (seedOnly) {
  console.log(`Data folder ${dir} prepared; fixture for the window: ${proj} (two with the same name: ${pa} and ${pb})`);
  process.exit(0);
}

// Real app modules
const logger = createLogger(dir, "desktop", env);
const draft = createMaterialsDraft({ limits: () => { const { materialsChars, materialsIgnore } = readRegistry(dir).defaults; return { materialsChars, materialsIgnore }; }, logger });
const runs: Promise<unknown>[] = [];
const run: typeof runStoredSession = (o) => { const r = runStoredSession(o); runs.push(r); return r; };
const catalog = () => loadTemplates({ builtinDir: BUILTIN_TEMPLATES_DIR, userDir: join(dir, "templates") });
const launcher = createLauncher({ dataDir: dir, env, logger, materials: draft, registry: () => readRegistry(dir), catalog, scenarioPath: (m) => (m === "p1" || m === "p2" ? join(scenDir, `${m}.json`) : null), run });
const settings = createSettings({ dataDir: dir, env, reloadEnv: () => {}, logger, inspect: async (p) => ({ status: { id: p.id, kind: p.kind, label: p.label, available: false, reason: "не осматривается", models: [], modelsConfirmed: false } }) });
const stub = <T>(v: T) => () => v;
const bridge = createBridge({
  listSessions: stub([]), sessionExists: stub(false), watchSession: () => () => {}, notices: stub([]), listTemplates: stub({ templates: [], errors: [] }),
  registry: async () => ({}) as never, startSession: (input) => launcher.start(input), lastParticipants: stub(null), resumeOptions: async () => ({}) as never,
  resumeSession: async () => ({ droppedOwnerRequests: [] }), stopSession: () => {}, acceptVersion: () => ({}) as never, sendOwnerMessage: () => ({ requestId: "r" }), continueWait: () => ({ requestId: "r" }),
  previewMaterials: (refresh) => previewMaterials({ dataDir: dir, logger, materials: draft }, refresh), prepareRerun: (id, withDecision) => prepareRerun({ dataDir: dir, catalog, materials: draft }, id, withDecision), copyText: () => {},
  exportSession: async () => null, setPinned: () => {}, settings, templates: { open: stub(null), create: stub(null), save: stub(null), remove: () => {} } as never,
  materials: draft, pickMaterials: async () => null, send: () => {}, logger,
});

async function good<T>(a: string, ...args: unknown[]): Promise<T> {
  const r = await bridge.call(a, args);
  assert.ok(r.ok, `${a}: expected success, got: ${r.ok ? "" : r.error}`);
  return r.value as T;
}
const attach = async (...paths: string[]) => { await good("clearMaterials"); return good<MaterialsView>("attachMaterials", paths); };
const names = (v: MaterialsView) => v.ignored.map((r) => r.name);
const hasOut = (xs: { name: string }[]) => xs.some((x) => /(^|\/)out(\/|$)/.test(x.name));
const sessionsDir = join(dir, "sessions");
const two = [{ providerId: "scripted", model: "p1", role: null }, { providerId: "scripted", model: "p2", role: null }];
const files = (d: string): string[] => (existsSync(d) ? readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)) : []);
const newSession = async (extra: object = {}) => {
  const before = new Set(existsSync(sessionsDir) ? readdirSync(sessionsDir) : []);
  const r = await good<{ id: string | null; error?: string }>("startSession", { templateId: null, topic: "Как назвать кота", participants: two, maxRounds: 3, useMaterials: true, ...extra });
  assert.ok(r.id !== null && !before.has(r.id), `start: ${r.error}`);
  await Promise.allSettled(runs);
  return r.id!;
};
const snapshotFiles = (id: string) => files(join(sessionsDir, id, "workspace")).map((f) => ({ rel: f.slice(join(sessionsDir, id, "workspace").length + 1), text: readFileSync(f, "utf8") }));

// Step 1. Draft view
const V0 = await attach(proj);
assert.equal(V0.ignored.length, 1, "one excluded row");
assert.deepEqual({ ...V0.ignored[0], id: "x1" }, { id: "x1", name: "proj/out/", rule: "out/", returned: false }, `row: ${JSON.stringify(V0.ignored[0])}`);
assert.equal(V0.ignored[0]!.id, "x1");
const ws0 = draft.workspace();
assert.ok(ws0.length > 0 && !hasOut(ws0), "no out in the snapshot");
assert.ok(!hasOut(V0.items) && !hasOut(V0.skipped) && !hasOut(V0.left), "no out in materials, skipped and \"Not included\"");
assert.equal(V0.folder?.files, ws0.length);
ok(`ignored = [proj/out/, rule out/, returned false]; no out in the snapshot (${ws0.length} files) and in the lists`);

// Step 2. Return
const V1 = await good<MaterialsView>("returnIgnored", "x1");
assert.deepEqual(V1.ignored.map((r) => r.returned), [true]);
const ws1 = draft.workspace().map((f) => f.name);
assert.ok(ws1.some((n) => n.endsWith("out/main.js")) && ws1.some((n) => n.endsWith("out/lib/util.js")), `out/main.js and out/lib/util.js in the snapshot: ${ws1}`);
assert.ok(V1.folder!.files > V0.folder!.files, "folder.files grew");
assert.notEqual(V1.stamp, V0.stamp);
ok(`returnIgnored(x1): returned true, out/main.js and out/lib/util.js in the snapshot, folder.files ${V0.folder!.files} -> ${V1.folder!.files}, stamp changed`);
assert.deepEqual(await good<MaterialsView>("returnIgnored", "x1"), V1, "repeating the return does not change the view");
assert.deepEqual(await good<MaterialsView>("returnIgnored", "x99"), V1, "an unknown id changes nothing");
ok("repeating returnIgnored and an unknown id do not change the view, including the stamp");

const V2 = await good<MaterialsView>("excludeIgnored", "x1");
assert.deepEqual({ ...V2, stamp: "" }, { ...V0, stamp: "" }, "excluding again restores the original view");
assert.ok(!hasOut(draft.workspace()));
ok("excludeIgnored(x1) restores the original ignored and folder, out left the snapshot");

await good<MaterialsView>("returnIgnored", "x1");
const cleared = await good<MaterialsView>("clearMaterials");
assert.deepEqual(cleared.ignored, []);
assert.equal((await good<MaterialsView>("attachMaterials", [proj])).ignored[0]!.returned, false);
ok("clearMaterials resets the return: a repeated attach gives returned false");

// Step 3. Preview
await attach(proj);
const P0 = await good<MaterialsPreviewView>("previewMaterials", false);
assert.deepEqual(P0.materials.ignored.map((r) => [r.name, r.rule, r.returned]), [["proj/out/", "out/", false]]);
assert.ok(![P0.manifest ?? "", ...P0.available.map((a) => a.name)].some((t) => t.includes("out/main.js")) && !hasOut(P0.available) && !hasOut(P0.skipped) && !hasOut(P0.left), "without the return there is no out in manifest, available, skipped and left");
ok("preview without the return: ignored in materials, no out in manifest, available, skipped, left");
const retStamp = (await good<MaterialsView>("returnIgnored", "x1")).stamp;
assert.notEqual(retStamp, P0.stamp, "the stamp after the return differs from the set stamp");
const P1 = await good<MaterialsPreviewView>("previewMaterials", true);
const om = P1.available.find((a) => a.name.endsWith("out/main.js"));
assert.ok(om && om.initial === false && om.reason, `out/main.js is available on request: ${JSON.stringify(om)}`);
assert.ok(P1.manifest!.includes("out/main.js"));
assert.equal(P1.materials.ignored[0]!.returned, true);
assert.notEqual(P1.handle, P0.handle);
assert.ok(!hasOut(P1.skipped));
ok("after the return and previewMaterials(true): out/main.js in available (initial false) and manifest; the stamp was stale before the refresh; the handle is new");

// Step 4. Two folders with the same name
const D0 = await attach(pa, pb);
// the names are distinguishable: the second folder is "proj (2)"; rows by name, "proj (2)/" before "proj/"
assert.deepEqual(D0.ignored.map((r) => [r.id, r.name, r.returned]), [["x1", "proj (2)/out/", false], ["x2", "proj/out/", false]]);
const D1 = await good<MaterialsView>("returnIgnored", "x1");
assert.deepEqual(D1.ignored.map((r) => r.returned), [true, false]);
const outFiles = draft.workspace().filter((f) => f.name.includes("out/"));
const texts = outFiles.map((f) => f.text).join("\n");
assert.ok(texts.includes("FROM_B") && !texts.includes("FROM_A") && outFiles.every((f) => f.name.startsWith("proj (2)/")), `only the second folder was returned: ${outFiles.map((f) => f.name)}`);
ok("two proj folders: rows proj (2)/out/ and proj/out/; returning x1 puts proj (2)/out/x.js from b into the snapshot and nothing from a; x2 returned false");

// Step 5. Start without and with the return
await attach(proj);
const idPlain = await newSession();
const sPlain = snapshotFiles(idPlain);
assert.ok(sPlain.length > 0 && !sPlain.some((f) => f.text.includes("OUT_MAIN") || /(^|\/)out\//.test(f.rel)), "without the return there is no out in the session snapshot");
assert.ok(sPlain.some((f) => f.rel.endsWith("src/a.ts")));
await attach(proj); // the start takes the draft
await good("returnIgnored", "x1");
const idRet = await newSession();
const sRet = snapshotFiles(idRet);
assert.ok(sRet.some((f) => f.rel.endsWith("out/main.js") && f.text.includes("OUT_MAIN")) && sRet.some((f) => f.rel.endsWith("out/lib/util.js")), `with the return, out in the snapshot: ${sRet.map((f) => f.rel)}`);
ok(`start through the launcher: without the return the session snapshot has ${sPlain.length} files without out; with the return ${sRet.length} files, out/main.js and out/lib/util.js present`);

// Step 6. A session rerun does not carry the return over
const rr = await good<RerunView>("prepareRerun", idRet, false);
assert.ok(rr.materials.ignored.every((r) => !r.returned), "no returned in the rerun");
assert.deepEqual(rr.materials.ignored, []);
assert.ok(!hasOut(draft.workspace()));
const again = await good<MaterialsView>("attachMaterials", [proj]);
assert.deepEqual(again.ignored.map((r) => r.returned), [false]);
ok("prepareRerun of a session started with the return: no returned; a new attach gives returned false (the real prepareRerun from main/rerun.ts)");

// Step 7. English
setProcessLanguage("en");
const E = await attach(proj);
assert.deepEqual(E.ignored.map((r) => [r.name, r.rule, r.returned]), [["proj/out/", "out/", false]]);
assert.match(sessionSetup("en").excludedByRules(1), /Excluded by rules/);
assert.match(sessionSetup("ru").excludedByRules(1), /Исключено правилами/);
assert.equal((await good<MaterialsView>("returnIgnored", "x1")).folder!.files, V1.folder!.files);
setProcessLanguage("ru");
ok("en: same name and rule, labels \"Excluded by rules: 1\" / \"Исключено правилами: 1\"; the return works");

console.log(`Result: ${checks} checks, all passed; real model calls 0; data folder ${dir}`);
