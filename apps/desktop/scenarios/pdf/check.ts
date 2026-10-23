// App part of the local PDF check: real main-process modules without an Electron window, scripted participants only (0 model calls).
// Launched from packages/core/scenarios/pdf/check.ts; separately:
//   COUNCIL_DEV=1 node packages/core/scenarios/pdf/check.ts --fixtures <folder>
//   COUNCIL_DEV=1 COUNCIL_HOME=<new empty folder inside the project> node apps/desktop/scenarios/pdf/check.ts <folder with fixtures>
// Writes only to COUNCIL_HOME, does not delete it. The last output line is RESULT {json}.
import "../../../../packages/core/scenarios/language-ru.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { copyFileSync, existsSync, mkdirSync, utimesSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUILTIN_TEMPLATES_DIR, createLogger, ensureDataDir, loadTemplates, readRegistry, readSession, runStoredSession, sha256Of, writeRegistry } from "../../../../packages/core/src/index.ts";
import type { Registry } from "../../../../packages/core/src/index.ts";
import { createBridge } from "../../src/main/bridge.ts";
import { createLauncher } from "../../src/main/launcher.ts";
import { createMaterialsDraft } from "../../src/main/materials.ts";
import { previewMaterials } from "../../src/main/materials-preview.ts";
import { createSettings } from "../../src/main/settings.ts";
import type { MaterialsPreviewView, MaterialsView } from "../../src/shared/setup.ts";

const home = process.env.COUNCIL_HOME, fxArg = process.argv[2];
const usage = "Run: COUNCIL_DEV=1 COUNCIL_HOME=<new empty folder inside the project> node apps/desktop/scenarios/pdf/check.ts <folder with fixtures>";
if (process.env.COUNCIL_DEV !== "1" || !home || !fxArg) { console.error(usage); process.exit(2); }
if (!existsSync(resolve(home)) || !statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0) {
  console.error(`COUNCIL_HOME ${resolve(home)} must exist and be empty. ${usage}`);
  process.exit(2);
}
const dir = realpathSync(resolve(home)), fx = realpathSync(resolve(fxArg)); // the collector rejects paths through symlinks
const scenDir = resolve(import.meta.dirname, "../../../../packages/core/scenarios/consensus");
const EXPECTED = "Первая страница\n\nВторая страница";
const SECRET = "stand-secret-value";
const REASON = {
  locked: "PDF зашифрован — пароль не запрашивается",
  scan: "в PDF не найден текст",
  broken: "PDF повреждён",
  blank201: "в PDF больше 200 страниц без текстового слоя",
};
const env = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: dir };
let n = 0;
const ok = (s: string) => { n++; console.log(`ok: ${s}`); };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function allFiles(d: string): string[] {
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(d, e.name)) : [join(d, e.name)]));
}
const tree = (d: string) => Object.fromEntries(allFiles(d).map((f) => [f, sha(readFileSync(f))]));

// A registry without real providers: one inert HTTP provider that nobody calls.
writeRegistry(ensureDataDir(dir), {
  providers: [{ id: "inert", kind: "openai-http", label: "Не используется", baseUrl: "http://127.0.0.1:9", models: ["m"] }],
  defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 60000, participants: [{ providerId: "inert", model: "m" }, { providerId: "inert", model: "m" }] },
} satisfies Registry);

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
const two = [{ providerId: "scripted", model: "p1", role: null }, { providerId: "scripted", model: "p2", role: null }];
const sessionsDir = join(dir, "sessions");

// Count helper launches: core starts it with spawnSync("/usr/bin/sandbox-exec", ...) through a live ESM binding of node:child_process.
let launches = 0;
{
  const cp = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
  const real = cp.spawnSync;
  cp.spawnSync = ((command: string, ...rest: unknown[]) => { if (command === "/usr/bin/sandbox-exec") launches++; return (real as (...a: unknown[]) => unknown)(command, ...rest); }) as typeof cp.spawnSync;
  syncBuiltinESMExports();
}

let result: object | undefined;
async function main() {
  const before = tree(fx);
  const views: unknown[] = [];

  // ---- 4. A good PDF ----
  await good("clearMaterials");
  const v = await good<MaterialsView>("attachMaterials", [join(fx, "text.pdf")]);
  views.push(v);
  assert.equal(v.error, null);
  assert.equal(v.items.length, 1);
  assert.ok(v.items[0]!.name.endsWith("text.pdf"));
  assert.equal(v.items[0]!.chars, EXPECTED.length);
  ok(`app: attachMaterials(text.pdf) - one material in the list, chars ${EXPECTED.length}`);
  const pv = await good<MaterialsPreviewView>("previewMaterials", false);
  views.push(pv);
  assert.ok(pv.initial?.includes(EXPECTED), "no PDF text in \"Owner's materials\"");
  assert.ok(!pv.initial.includes("%PDF"));
  ok("app: the \"Owner's materials\" preview contains the PDF text and does not contain \"%PDF\"");
  const r = await call("startSession", { templateId: null, topic: "Что в PDF?", participants: two, maxRounds: 3, useMaterials: true, preparedHandle: pv.handle });
  assert.ok(r.ok && (r.value as { id: string | null }).id !== null, `start: ${r.ok ? (r.value as { error?: string }).error : r.error}`);
  const id = (r.value as { id: string }).id;
  await Promise.allSettled(runs);
  const session = readSession(dir, id);
  assert.ok(session, "session created");
  assert.ok(prompts.length > 0 && prompts[0]!.includes(EXPECTED), "the first request to a participant does not contain the PDF text");
  assert.ok(prompts.every((p) => p.includes(EXPECTED) && !p.includes("%PDF")), "not every request contains the PDF text, or \"%PDF\" is present");
  const created = readFileSync(join(sessionsDir, id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "session_created").session;
  const m = created.materials[0];
  assert.deepEqual([m.chars, m.sha256], [EXPECTED.length, sha256Of(EXPECTED)]);
  const snapshot = join(sessionsDir, id, "materials", "m1.txt");
  assert.equal(readFileSync(snapshot, "utf8"), EXPECTED);
  ok(`app: startSession by the accepted set - all ${prompts.length} requests to participants contain the PDF text without "%PDF", the journal has the text sha256, m1.txt equals the text`);

  // ---- 6. Refusals ----
  await good("clearMaterials");
  const base = await good<MaterialsView>("attachMaterials", [join(fx, "proj/README.md")]);
  assert.equal(base.items.length, 1);
  for (const [f, reason] of Object.entries(REASON)) {
    const bad = await good<MaterialsView>("attachMaterials", [join(fx, `${f}.pdf`)]);
    views.push(bad);
    assert.ok(bad.error?.includes(reason), `${f}.pdf: error «${bad.error}»`);
    assert.deepEqual(bad.items, base.items, `${f}.pdf: the list changed`);
  }
  ok("app: after a text file, locked/scan/broken/blank201 give view.error with a reason, the earlier material stays in the list");
  await good("clearMaterials");
  const fv = await good<MaterialsView>("attachMaterials", [join(fx, "proj")]);
  views.push(fv);
  assert.equal(fv.error, null);
  assert.equal(fv.skipped.length, 5, JSON.stringify(fv.skipped));
  for (const [f, reason] of Object.entries(REASON)) assert.ok(fv.skipped.some((x) => x.name.endsWith(`proj/${f}.pdf`) && x.reason.includes(reason)), `no ${f}.pdf: ${JSON.stringify(fv.skipped)}`);
  const envSk = fv.skipped.find((x) => x.name.endsWith("proj/.env"));
  assert.ok(envSk?.reason);
  const names = fv.items.map((i) => i.name);
  assert.ok(fv.items.length === 2 && names.some((x) => x.endsWith("README.md")) && names.some((x) => x.endsWith("good.pdf")), `collected: ${names}`);
  ok(`app, folder: view.skipped has four PDFs with reasons and .env ("${envSk.reason}"), the list has README.md and good.pdf`);

  // ---- 8. A scan: one helper launch per unchanged file ----
  await good("clearMaterials");
  const l0 = launches;
  const sv = await good<MaterialsView>("attachMaterials", [join(fx, "ocr.pdf")]);
  views.push(sv);
  assert.equal(sv.error, null);
  assert.equal(sv.items.length, 1);
  assert.equal(launches - l0, 1, `helper launches on the first collection: ${launches - l0}`);
  const spv = await good<MaterialsPreviewView>("previewMaterials", false);
  views.push(spv);
  await good("clearMaterials");
  await good<MaterialsView>("attachMaterials", [join(fx, "ocr.pdf")]);
  assert.equal(launches - l0, 1, `helper launches after collecting the unchanged scan again: ${launches - l0}`);
  ok("app: attachMaterials(ocr.pdf), the preview and a second collection of the unchanged scan start the helper exactly once");
  const copy = join(dir, "ocr-copy.pdf");
  copyFileSync(join(fx, "ocr.pdf"), copy);
  await good("clearMaterials");
  await good<MaterialsView>("attachMaterials", [copy]);
  assert.equal(launches - l0, 2, `a new file must start the helper: ${launches - l0}`);
  await good("clearMaterials");
  await good<MaterialsView>("attachMaterials", [copy]);
  assert.equal(launches - l0, 2);
  utimesSync(copy, new Date(), new Date(Date.now() + 60_000));
  await good("clearMaterials");
  await good<MaterialsView>("attachMaterials", [copy]);
  assert.equal(launches - l0, 3, `a changed file must start the helper again: ${launches - l0}`);
  ok("app: a new file launches the helper once more, a repeat does not, a changed modification time launches it again (3 launches in total)");
  await good("clearMaterials");
  const sp = await good<MaterialsView>("attachMaterials", [join(fx, "ocr.pdf")]);
  views.push(sp);
  const spp = await good<MaterialsPreviewView>("previewMaterials", false);
  prompts.length = 0;
  const rsn = await call("startSession", { templateId: null, topic: "Что в скане?", participants: two, maxRounds: 3, useMaterials: true, preparedHandle: spp.handle });
  assert.ok(rsn.ok && (rsn.value as { id: string | null }).id !== null, `start: ${rsn.ok ? (rsn.value as { error?: string }).error : rsn.error}`);
  const sid = (rsn.value as { id: string }).id;
  await Promise.allSettled(runs);
  const sj = readFileSync(join(sessionsDir, sid, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "session_created").session.materials[0];
  const scanSnapshot = join(sessionsDir, sid, "materials", "m1.txt");
  const scanText = readFileSync(scanSnapshot, "utf8");
  assert.equal(scanText.split("\n\n").length, 2, JSON.stringify(scanText));
  assert.deepEqual([sj.chars, sj.sha256], [scanText.length, sha256Of(scanText)]);
  assert.ok(prompts.length > 0 && prompts.every((p) => p.includes(scanText)), "requests to participants do not contain the recognized text");
  assert.equal(sp.items[0]!.chars, scanText.length, "attached material chars ≠ snapshot");
  assert.equal(sj.chars, scanText.length);
  assert.equal(sj.sha256, sha256Of(scanText));
  for (const [what, pv2] of [["first preview", spv], ["launch preview", spp]] as const) {
    assert.ok(pv2.initial?.includes(scanText), `${what}: the recognized text is not in "Owner's materials" exactly`);
    assert.equal(pv2.materials.items[0]!.chars, scanText.length, `${what}: materials chars`);
  }
  ok("app: the preview of ocr.pdf (text, chars) equals the attached material, the session snapshot and the journal chars/sha256 exactly");
  ok(`app: startSession by the accepted scan - ${prompts.length} requests contain the recognized text, the journal sha256 equals m1.txt`);

  // ---- leaks and sources ----
  const log = readFileSync(join(dir, "logs", "app.log"), "utf8");
  const zones = [JSON.stringify(views), log, ...allFiles(sessionsDir).map((f) => readFileSync(f, "utf8"))];
  assert.ok(!zones.some((t) => t.includes(SECRET)), "the .env control string was found");
  ok("the .env control string is neither in the bridge responses, nor in app.log, nor in the session files");
  assert.deepEqual(tree(fx), before, "the source files changed");
  ok("the source files (PDFs, the proj folder) are byte-for-byte unchanged");
  result = { checks: n, sha256: m.sha256, chars: m.chars, snapshot, scanSha256: sj.sha256, scanChars: sj.chars, scanSnapshot };
}

let failed = false;
const guard = setTimeout(() => { console.error("FAIL: the app part did not finish within 120 seconds"); process.exit(1); }, 120000);
try {
  await main();
  console.log(`App part result: ${n} checks; real model calls 0`);
  console.log(`RESULT ${JSON.stringify(result)}`);
} catch (e) {
  failed = true;
  console.error(`FAIL: ${e instanceof Error ? e.message : String(e)}\nData folder kept: ${dir}`);
} finally {
  clearTimeout(guard);
}
process.exit(failed ? 1 : 0);
