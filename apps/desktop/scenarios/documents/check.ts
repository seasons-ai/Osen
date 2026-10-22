// App part of the local document check (DOCX, XLSX, PPTX): real main-process modules without an Electron window, scripted participants only (0 model calls).
// Launched from packages/core/scenarios/documents/check.ts, which prepares the fixtures folder; separately:
//   COUNCIL_DEV=1 COUNCIL_HOME=<new empty folder inside the project> node apps/desktop/scenarios/documents/check.ts <fixtures folder> <ru|en> <reason text for a damaged document> [<document file name> <expected text file name>]
// The document defaults to report.docx with expected.txt; the damaged-document refusal runs only for that default document.
// Writes only to COUNCIL_HOME, does not delete it. The last output line is RESULT {json}.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUILTIN_TEMPLATES_DIR, createLogger, setProcessLanguage, ensureDataDir, loadTemplates, readRegistry, readSession, runStoredSession, sha256Of, writeRegistry } from "../../../../packages/core/src/index.ts";
import type { Registry } from "../../../../packages/core/src/index.ts";
import { createBridge } from "../../src/main/bridge.ts";
import { createLauncher } from "../../src/main/launcher.ts";
import { createMaterialsDraft } from "../../src/main/materials.ts";
import { previewMaterials } from "../../src/main/materials-preview.ts";
import { createSettings } from "../../src/main/settings.ts";
import type { MaterialsPreviewView, MaterialsView } from "../../src/shared/setup.ts";

const home = process.env.COUNCIL_HOME, [fxArg, lang, damaged, docName = "report.docx", expName = "expected.txt"] = process.argv.slice(2);
const usage = "Run: COUNCIL_DEV=1 COUNCIL_HOME=<new empty folder inside the project> node apps/desktop/scenarios/documents/check.ts <fixtures folder> <ru|en> <damaged reason> [<document file name> <expected text file name>]";
if (process.env.COUNCIL_DEV !== "1" || !home || !fxArg || !lang || !damaged) { console.error(usage); process.exit(2); }
if (!existsSync(resolve(home)) || !statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0) {
  console.error(`COUNCIL_HOME ${resolve(home)} must exist and be empty. ${usage}`);
  process.exit(2);
}
const dir = realpathSync(resolve(home)), fx = realpathSync(resolve(fxArg)); // the collector rejects paths through symlinks
const scenDir = resolve(import.meta.dirname, "../../../../packages/core/scenarios/consensus");
const EXPECTED = readFileSync(join(fx, expName), "utf8");
setProcessLanguage(lang as "ru" | "en");
const env = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: dir, COUNCIL_LANG: lang };
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

let result: object | undefined;
async function main() {
  const before = tree(fx);
  const views: unknown[] = [];

  // ---- 3. A good document ----
  await good("clearMaterials");
  const v = await good<MaterialsView>("attachMaterials", [join(fx, docName)]);
  views.push(v);
  assert.equal(v.error, null);
  assert.equal(v.items.length, 1);
  assert.ok(v.items[0]!.name.endsWith(docName));
  assert.equal(v.items[0]!.chars, EXPECTED.length);
  ok(`app: attachMaterials(${docName}) - one material in the list, chars ${EXPECTED.length}`);
  const pv = await good<MaterialsPreviewView>("previewMaterials", false);
  views.push(pv);
  assert.ok(pv.initial?.includes(EXPECTED), "no document text in \"Owner's materials\"");
  assert.ok(!pv.initial.includes("PK\x03\x04") && !pv.initial.includes("word/document.xml"));
  ok("app: the \"Owner's materials\" preview contains the document text and no document bytes");
  const r = await call("startSession", { templateId: null, topic: "Что в документе?", participants: two, maxRounds: 3, useMaterials: true, preparedHandle: pv.handle });
  assert.ok(r.ok && (r.value as { id: string | null }).id !== null, `start: ${r.ok ? (r.value as { error?: string }).error : r.error}`);
  const id = (r.value as { id: string }).id;
  await Promise.allSettled(runs);
  const session = readSession(dir, id);
  assert.ok(session, "session created");
  assert.ok(prompts.length > 0 && prompts.every((p) => p.includes(EXPECTED)), "not every request to a participant contains the document text");
  const created = readFileSync(join(sessionsDir, id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "session_created").session;
  const m = created.materials[0];
  assert.deepEqual([m.chars, m.sha256], [EXPECTED.length, sha256Of(EXPECTED)]);
  const snapshot = join(sessionsDir, id, "materials", "m1.txt");
  assert.equal(readFileSync(snapshot, "utf8"), EXPECTED);
  ok(`app: startSession by the accepted set - all ${prompts.length} requests to participants contain the document text, the journal has the text sha256, m1.txt equals the text`);

  // ---- Refusal ----
  if (docName === "report.docx") {
    await good("clearMaterials");
    const bad = await good<MaterialsView>("attachMaterials", [join(fx, "broken.docx")]);
    views.push(bad);
    assert.ok(bad.error?.includes(damaged), `broken.docx: error «${bad.error}»`);
    assert.equal(bad.items.length, 0);
    ok(`app: a damaged .docx gives view.error with "${damaged}", the list stays empty`);
  }

  // ---- sources ----
  assert.deepEqual(tree(fx), before, "the source files changed");
  ok("the source files are byte-for-byte unchanged");
  result = { checks: n, sha256: m.sha256, chars: m.chars, snapshot };
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
