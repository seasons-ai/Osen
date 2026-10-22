// App part of the image text check: real main-process modules without an Electron window, scripted participants only (0 model calls).
// Launched from packages/core/scenarios/ocr/check.ts, which writes the manifest of cases; separately:
//   COUNCIL_DEV=1 COUNCIL_HOME=<new empty folder inside the project> node apps/desktop/scenarios/ocr/check.ts <manifest.json> <ru|en>
// Writes only to COUNCIL_HOME, does not delete it. The last output line is RESULT {json}.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { BUILTIN_TEMPLATES_DIR, createLogger, setProcessLanguage, ensureDataDir, loadTemplates, readRegistry, readSession, runStoredSession, setOcrRuntime, sha256Of, writeRegistry } from "../../../../packages/core/src/index.ts";
import type { Registry } from "../../../../packages/core/src/index.ts";
import { createBridge } from "../../src/main/bridge.ts";
import { createLauncher } from "../../src/main/launcher.ts";
import { createMaterialsDraft } from "../../src/main/materials.ts";
import { previewMaterials } from "../../src/main/materials-preview.ts";
import { createSettings } from "../../src/main/settings.ts";
import type { MaterialsPreviewView, MaterialsView } from "../../src/shared/setup.ts";

const home = process.env.COUNCIL_HOME, [manifestArg, lang] = process.argv.slice(2);
const usage = "Run: COUNCIL_DEV=1 COUNCIL_HOME=<new empty folder inside the project> node apps/desktop/scenarios/ocr/check.ts <manifest.json> <ru|en>";
if (process.env.COUNCIL_DEV !== "1" || !home || !manifestArg || !lang) { console.error(usage); process.exit(2); }
if (!existsSync(resolve(home)) || !statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0) {
  console.error(`COUNCIL_HOME ${resolve(home)} must exist and be empty. ${usage}`);
  process.exit(2);
}
const dir = realpathSync(resolve(home)); // the collector rejects paths through symlinks
const { cases } = JSON.parse(readFileSync(resolve(manifestArg), "utf8")) as { cases: { id: string; kind: "ok" | "refuse" | "folder"; path: string; helper?: string }[] };
const scenDir = resolve(import.meta.dirname, "../../../../packages/core/scenarios/consensus");
setProcessLanguage(lang as "ru" | "en");
const env = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: dir, COUNCIL_LANG: lang };
let n = 0;
const ok = (s: string) => { n++; console.log(`ok: ${s}`); };
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

const out: Record<string, unknown> = {};
async function main() {
  for (const c of cases) {
    setOcrRuntime(c.helper ? { helper: c.helper } : undefined);
    await good("clearMaterials");
    const v = await good<MaterialsView>("attachMaterials", [c.path]);
    if (c.kind === "refuse") {
      assert.ok(v.error, `${c.id}: no error in the view`);
      assert.equal(v.items.length, 0, `${c.id}: the list is not empty`);
      out[c.id] = { error: v.error };
      continue;
    }
    assert.equal(v.error, null, `${c.id}: ${v.error}`);
    const pv = await good<MaterialsPreviewView>("previewMaterials", false);
    const before = prompts.length;
    const r = await call("startSession", { templateId: null, topic: "Что на изображении?", participants: two, maxRounds: 3, useMaterials: true, preparedHandle: pv.handle });
    assert.ok(r.ok && (r.value as { id: string | null }).id !== null, `${c.id} start: ${r.ok ? (r.value as { error?: string }).error : r.error}`);
    const id = (r.value as { id: string }).id;
    await Promise.allSettled(runs);
    const mats = readFileSync(join(sessionsDir, id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "session_created").session.materials as { id: string; name: string; chars: number; sha256: string }[];
    const m1 = readFileSync(join(sessionsDir, id, "materials", `${mats[0]!.id}.txt`), "utf8");
    assert.ok(pv.initial?.includes(m1), `${c.id}: the preview does not contain the first material`);
    const fresh = prompts.slice(before);
    assert.ok(fresh.length >= 2 && fresh.every((p) => p.includes(m1)), `${c.id}: not every request to a participant carries the snapshot text`);
    const skipped = v.skipped.map((x) => ({ name: basename(x.name), reason: x.reason })).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(v.items.map((i) => basename(i.name)), mats.map((m) => basename(m.name)), `${c.id}: the list and the journal differ`);
    out[c.id] = { items: mats.map((m) => ({ name: basename(m.name), sha: m.sha256, chars: m.chars })), m1, skipped };
  }
  setOcrRuntime();
  ok(`app: ${cases.filter((c) => c.kind !== "refuse").length} cases (attach, preview, start: text in the preview and in every turn request), ${cases.filter((c) => c.kind === "refuse").length} refusals as view.error with an empty list`);
}

let failed = false;
const guard = setTimeout(() => { console.error("FAIL: the app part did not finish within 600 seconds"); process.exit(1); }, 600000);
try {
  await main();
  console.log(`App part result: ${n} checks; real model calls 0`);
  console.log(`RESULT ${JSON.stringify({ checks: n, cases: out, dataDir: dir })}`);
} catch (e) {
  failed = true;
  console.error(`FAIL: ${e instanceof Error ? e.message : String(e)}\nData folder kept: ${dir}`);
} finally {
  clearTimeout(guard);
}
process.exit(failed ? 1 : 0);
