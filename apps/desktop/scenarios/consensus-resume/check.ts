// Live check (change 173): resume of a consensus session with an owner message, on the real main modules (bridge, launcher, resume) and the core, without a window.
//   COUNCIL_DEV=1 node apps/desktop/scenarios/consensus-resume/check.ts          (data folder: COUNCIL_HOME if given, else .council-data/consensus-resume-check-*, removed on success)
// Participants are scripted: no model calls. Language: pinned to ru by the first import, as in the other stands.
import "../../../../packages/core/scenarios/language-ru.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_TEMPLATES_DIR, createLogger, ensureDataDir, envFilePath, inspectProviders, loadTemplates, readRegistry, readSession, runStoredSession, userTemplatesDir, writeRegistry } from "../../../../packages/core/src/index.ts";
import type { Registry } from "../../../../packages/core/src/index.ts";
import { createBridge } from "../../src/main/bridge.ts";
import { createLauncher } from "../../src/main/launcher.ts";
import { resumeScenarioPath, resumeView } from "../../src/main/resume.ts";
import { listScenarios, registryView, scenarioPath } from "../../src/main/setup-data.ts";
import type { ResumeView } from "../../src/shared/bridge.ts";

if (process.env.COUNCIL_DEV !== "1") { console.error("COUNCIL_DEV=1 is required"); process.exit(2); }
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const own = !process.env.COUNCIL_HOME;
const home = process.env.COUNCIL_HOME ? resolve(process.env.COUNCIL_HOME) : join(root, ".council-data", `consensus-resume-check-${randomBytes(4).toString("hex")}`);
if (existsSync(home) && readdirSync(home).length > 0) { console.error(`${home} is not empty: use a new folder`); process.exit(2); }
mkdirSync(home, { recursive: true });
const dir = realpathSync(home);
const env = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: dir };
const MSG = "Consider the budget too";
let failed = 0;
const check = (name: string, cond: boolean, detail = "") => { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : detail ? ` (${detail})` : ""}`); if (!cond) failed++; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(what: string, fn: () => boolean, ms = 60000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) { try { if (fn()) return; } catch { /* journal not yet readable */ } }
  throw new Error(`timed out waiting for: ${what}`);
}

writeRegistry(ensureDataDir(dir), { providers: [], defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 1000, participants: [] } } satisfies Registry);
const catalogDir = here; // p1.json and p2.json next to this file
const journal = () => join(dir, "sessions", id, "events.jsonl");
const evs = (): { type: string; [k: string]: unknown }[] => readFileSync(journal(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const finishes = () => evs().filter((e) => e.type === "session_finished").length;
let id = "";

// The bindings repeat apps/desktop/src/main/index.ts.
const logger = createLogger(dir, "desktop", env);
const scenPath = (m: string) => scenarioPath(catalogDir, m);
const launcher = createLauncher({ dataDir: dir, env, logger, materials: null as never, registry: () => readRegistry(dir), catalog: () => loadTemplates({ builtinDir: BUILTIN_TEMPLATES_DIR, userDir: userTemplatesDir(dir) }), scenarioPath: scenPath, run: runStoredSession });
const stub = <T>(v: T) => () => v;
const view = async (replacements?: never, message?: string): Promise<ResumeView> => {
  const reg = readRegistry(dir);
  const found = await inspectProviders(reg, { env, keyFile: envFilePath(dir) });
  return resumeView(dir, id, registryView(reg, found.map((f) => f.status), listScenarios(catalogDir)), resumeScenarioPath(scenPath), replacements, message);
};
const bridge = createBridge({
  listSessions: stub([]), sessionExists: (s: string) => readSession(dir, s) !== null, sessionDrafts: () => [], watchSession: () => () => {}, notices: stub([]), listTemplates: stub({ templates: [], errors: [] }),
  registry: async () => ({}) as never, startSession: (input: never) => launcher.start(input),
  lineups: async () => ({}) as never, saveLineup: async () => ({}) as never, lastParticipants: stub(null),
  resumeOptions: (s: string, r?: never, m?: string) => view(r, m),
  resumeSession: (s: string, rounds: number, cap?: number | null, r?: never, m?: string) => launcher.resume(s, rounds, cap, r, m),
  stopSession: () => {}, acceptVersion: () => ({}) as never, sendOwnerMessage: () => ({ requestId: "r" }), continueWait: () => ({ requestId: "r" }),
  previewMaterials: async () => ({}) as never, prepareRerun: () => ({}) as never, copyText: () => {},
  exportSession: async () => null, setPinned: () => {}, settings: {} as never, templates: { open: stub(null), create: stub(null), save: stub(null), remove: () => {} } as never,
  materials: { snapshot: stub(null) } as never, pickMaterials: async () => null, send: () => {}, logger,
} as never);
type R = { ok: true; value: unknown } | { ok: false; error: string };
const call = (a: string, ...args: unknown[]) => bridge.call(a, args) as Promise<R>;

try {
  const sc = (model: string) => ({ providerId: "scripted", model, role: null });
  const started = await call("startSession", { templateId: null, topic: "How to name the cat", participants: [sc("p1.json"), sc("p2.json")], maxRounds: 3 });
  check("startSession succeeds", started.ok, started.ok ? "" : started.error);
  if (!started.ok) throw new Error("cannot continue");
  id = (started.value as { id: string }).id;
  await until("first segment finished", () => finishes() === 1 && !launcher.running().includes(id));
  check("first segment ends with consensus", readSession(dir, id)!.status === "consensus", readSession(dir, id)!.status);

  const without = await view();
  check("resumeView without message: not allowed, message required, engine reason", !without.allowed && without.messageRequired === true && typeof without.reason === "string" && without.reason.length > 0, JSON.stringify({ a: without.allowed, m: without.messageRequired, r: without.reason }));
  const withMsg = await view(undefined, MSG);
  check("resumeView with message: allowed, no message required, non-empty roster", withMsg.allowed && withMsg.messageRequired === false && withMsg.participants.length > 0, JSON.stringify({ a: withMsg.allowed, m: withMsg.messageRequired, n: withMsg.participants.length }));

  const before = readFileSync(journal());
  const refusal = await call("resumeSession", id, 1);
  const engineText = without.reason ?? "";
  check("bridge refuses resume without message with the engine consensus text", !refusal.ok && engineText.length > 0 && refusal.error.includes(engineText), refusal.ok ? "success" : refusal.error);
  check("journal unchanged after the refusal", readFileSync(journal()).equals(before));

  const n = evs().length;
  const res = await call("resumeSession", id, 1, undefined, undefined, MSG);
  check("bridge resumeSession with message succeeds", res.ok, res.ok ? "" : res.error);
  await until("resumed segment finished", () => finishes() === 2 && !launcher.running().includes(id));
  const e = evs().slice(n);
  check("segment starts with session_resumed", e[0]?.type === "session_resumed", e[0]?.type);
  check("owner_message right after session_resumed with equal text", e[1]?.type === "owner_message" && e[1].text === MSG, JSON.stringify(e[1]));
  check("new turns follow", e.slice(2).some((x) => x.type === "turn_completed"), e.map((x) => x.type).join(","));
  check("new session_finished at the end", e[e.length - 1]?.type === "session_finished");
} catch (err) {
  check("stand ran without exceptions", false, (err as Error).message);
}
if (failed) { console.log(`FAILED: ${failed} check(s); data folder kept: ${dir}`); process.exit(1); }
console.log("ALL PASS");
if (own) rmSync(dir, { recursive: true, force: true });
process.exit(0);
