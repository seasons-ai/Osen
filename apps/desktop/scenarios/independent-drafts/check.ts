// Check of independent drafts in the app on the real main-process modules (bridge, start, resume, drafts) and the core, without an Electron window.
//   COUNCIL_DEV=1 COUNCIL_HOME="<new empty folder inside the project>" node apps/desktop/scenarios/independent-drafts/check.ts
// Writes only to COUNCIL_HOME and does not delete it. Participants are scripted: no real models are called.
// Step 6 starts the real council process (packages/core/src/council.ts) and stops it in the middle of the phase, like the core stand.
import "../../../../packages/core/scenarios/language-ru.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_TEMPLATES_DIR, createLogger, ensureDataDir, envFilePath, inspectProviders, listSessions, loadTemplates, readRegistry, readSession, resolveLanguage, runStoredSession, userTemplatesDir, writeRegistry } from "../../../../packages/core/src/index.ts";
import { setProcessLanguage } from "../../../../packages/core/src/i18n/index.ts";
import { createFinishNotifier, finishText } from "../../src/main/finish-notify.ts";
import { historyRead } from "../../src/main/history.ts";
import { failureLabel, timeline } from "../../src/shared/timeline.ts";
import type { Registry } from "../../../../packages/core/src/index.ts";
import { createBridge } from "../../src/main/bridge.ts";
import { createLauncher } from "../../src/main/launcher.ts";
import { sessionDrafts } from "../../src/main/drafts.ts";
import { resumeScenarioPath, resumeView } from "../../src/main/resume.ts";
import { listScenarios, registryView, scenarioPath } from "../../src/main/setup-data.ts";
import type { DraftView, ResumeView } from "../../src/shared/bridge.ts";

const home = process.env.COUNCIL_HOME;
if (process.env.COUNCIL_DEV !== "1" || !home) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME (a new empty folder) are required. Run: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node apps/desktop/scenarios/independent-drafts/check.ts");
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
const scenariosDir = join(root, "packages/core/scenarios");
const D = ["independent-drafts/p1.json", "independent-drafts/p2.json", "independent-drafts/p3.json"];
const C = ["consensus/p1.json", "consensus/p2.json"];
const known = listScenarios(scenariosDir);
for (const m of [...D, ...C]) assert.ok(known.includes(m), `scenario ${m} found`);
const env = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: dir };
let checks = 0;
const ok = (s: string) => { checks++; console.log(`ok: ${s}`); };

writeRegistry(ensureDataDir(dir), {
  providers: [],
  defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 1000, participants: [] },
} satisfies Registry);

// Real application modules; the bindings repeat apps/desktop/src/main/index.ts.
const logger = createLogger(dir, "desktop", env);
const runs: Promise<unknown>[] = [];
const run: typeof runStoredSession = (o) => { const r = runStoredSession(o); runs.push(r); return r; };
const scenPath = (m: string) => scenarioPath(scenariosDir, m);
const launcher = createLauncher({ dataDir: dir, env, logger, materials: null as never, registry: () => readRegistry(dir), catalog: () => loadTemplates({ builtinDir: BUILTIN_TEMPLATES_DIR, userDir: userTemplatesDir(dir) }), scenarioPath: scenPath, run });
const stub = <T>(v: T) => () => v;
const bridge = createBridge({
  listSessions: stub([]), sessionExists: (id: string) => readSession(dir, id) !== null, sessionDrafts: (id: string) => sessionDrafts(dir, id), watchSession: () => () => {}, notices: stub([]), listTemplates: stub({ templates: [], errors: [] }),
  registry: async () => ({}) as never, startSession: (input: never) => launcher.start(input),
  lineups: async () => ({}) as never, saveLineup: async () => ({}) as never,
  lastParticipants: stub(null),
  resumeOptions: async (id: string) => {
    const reg = readRegistry(dir);
    const found = await inspectProviders(reg, { env, keyFile: envFilePath(dir) });
    const view = registryView(reg, found.map((f) => f.status), listScenarios(scenariosDir));
    return resumeView(dir, id, view, resumeScenarioPath(scenPath));
  },
  resumeSession: (id: string, rounds: number, cap?: number | null) => launcher.resume(id, rounds, cap),
  stopSession: () => {}, acceptVersion: () => ({}) as never, sendOwnerMessage: () => ({ requestId: "r" }), continueWait: () => ({ requestId: "r" }),
  previewMaterials: async () => ({}) as never, prepareRerun: () => ({}) as never, copyText: () => {},
  exportSession: async () => null, setPinned: () => {}, settings: {} as never, templates: { open: stub(null), create: stub(null), save: stub(null), remove: () => {} } as never,
  materials: { snapshot: stub(null) } as never, pickMaterials: async () => null, send: () => {}, logger,
} as never);

type R = { ok: true; value: unknown } | { ok: false; error: string };
const answers: { action: string; json: string }[] = []; // every bridge response of the stand, success and rejection
const call = async (a: string, ...args: unknown[]): Promise<R> => {
  const r = (await bridge.call(a, args)) as R;
  answers.push({ action: a, json: JSON.stringify(r) });
  return r;
};
async function good<T>(a: string, ...args: unknown[]): Promise<T> {
  const r = await call(a, ...args);
  assert.ok(r.ok, `${a}: expected success, got: ${r.ok ? "" : r.error}`);
  return r.value as T;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => T | undefined | false | null, ms = 30000): Promise<T> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) {
    let r: T | undefined | false | null;
    try { r = fn(); } catch { r = undefined; }
    if (r) return r;
  }
  throw new Error(`timed out waiting for: ${what}`);
}

type Ev = Record<string, any> & { seq: number; type: string };
const journal = (id: string) => join(dir, "sessions", id, "events.jsonl");
const evs = (id: string): Ev[] => readFileSync(journal(id), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ofType = (id: string, t: string) => evs(id).filter((e) => e.type === t);
const finished = (id: string) => existsSync(journal(id)) && evs(id).some((e) => e.type === "session_finished");
const draftFile = (id: string, d: string) => join(dir, "sessions", id, "drafts", `${d}.txt`);
const sc = (model: string) => ({ providerId: "scripted", model, role: null });
const input = (models: string[], extra: Record<string, unknown> = {}) => ({ templateId: null, topic: "Выберите план", participants: models.map(sc), maxRounds: 2, ...extra });
const firstTurn = (id: string) => ofType(id, "turn_started")[0]?.participantId;
const v1Author = (id: string) => ofType(id, "turn_completed").find((e) => e.version === 1)?.participantId;

// 1
const s1 = await good<{ id: string }>("startSession", input(D, { drafts: { synthesizerId: "p2" } }));
await Promise.allSettled(runs);
assert.ok(finished(s1.id), "step 1 session finished");
const created = ofType(s1.id, "session_created")[0]!;
assert.deepEqual(created.session.drafts, { enabled: true, synthesizerId: "p2" });
assert.equal(ofType(s1.id, "draft_completed").length, 3);
assert.equal(firstTurn(s1.id), "p2");
assert.equal(v1Author(s1.id), "p2");
const logText = readFileSync(join(dir, "logs", "app.log"), "utf8");
assert.ok(logText.split("\n").some((l) => l.includes(`independent drafts: synthesizer p2`)), "the start log has no “independent drafts: synthesizer p2”");
ok(`startSession with drafts p2: session.drafts {enabled, p2}, 3 draft_completed, first turn and version 1 are p2, the start log line is present (session ${s1.id})`);

// 2
const dr = await good<DraftView[]>("sessionDrafts", s1.id);
assert.deepEqual(dr.map((d) => d.draftId), ["d1", "d2", "d3"]);
assert.deepEqual(dr.map((d) => d.participantId), ["p1", "p2", "p3"]);
for (const d of dr) {
  assert.equal(d.error, null, `${d.draftId}: error`);
  assert.ok(d.text && d.text.length > 0, `${d.draftId}: text is empty`);
  assert.equal(d.text, readFileSync(draftFile(s1.id, d.draftId), "utf8"), `${d.draftId}: text differs from the file`);
}
ok("sessionDrafts: d1–d3 in participant order, text equals drafts/dN.txt, error null");

// 4
const n4 = listSessions(dir).length;
const r4 = await call("startSession", input(D, { drafts: { synthesizerId: "p4" } }));
assert.equal(r4.ok, false);
assert.ok(!r4.ok && r4.error.includes("synthesizerId"), `the error does not name synthesizerId: ${!r4.ok ? r4.error : ""}`);
assert.equal(listSessions(dir).length, n4);
ok(`drafts p4 with three participants: rejection (“${(r4 as { error: string }).error}”), session count unchanged (${n4})`);

// 5
const s5 = await good<{ id: string }>("startSession", input(C));
await Promise.allSettled(runs);
assert.ok(finished(s5.id));
assert.equal(ofType(s5.id, "session_created")[0]!.session.drafts, undefined);
assert.deepEqual(evs(s5.id).map((e) => e.type).filter((t) => t.startsWith("draft")), []);
assert.deepEqual(await good<DraftView[]>("sessionDrafts", s5.id), []);
ok("start without drafts: the session has no drafts, no draft_* in the journal, sessionDrafts []");

// 6
const abs = (n: string) => join(scenariosDir, "independent-drafts", n);
const args = ["packages/core/src/council.ts", "--topic", "Выберите план", "--drafts", "--synthesizer", "p2", "--max-rounds", "2",
  ...[abs("p1.json"), abs("p2-slow.json"), abs("p3.json")].flatMap((p) => ["--participant", `scripted:${p}`])];
let out = "";
const child = spawn(process.execPath, args, { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_DEV: "1", COUNCIL_HOME: dir } });
child.stdout.on("data", (d) => { out += d; });
child.stderr.on("data", (d) => { out += d; });
const closed = new Promise<void>((r) => child.on("close", () => r()));
let s6: string;
try {
  s6 = await until("council session id", () => /^Сессия (\S+) ·/m.exec(out)?.[1]);
  await until("draft_attempt_started of slot d2", () => evs(s6).some((e) => e.type === "draft_attempt_started" && e.draftId === "d2"));
} finally {
  child.kill("SIGKILL");
  await closed;
}
const pre = evs(s6);
assert.ok(!pre.some((e) => e.type === "session_finished"), "the interrupted session is already finished");
assert.ok(pre.some((e) => e.type === "draft_completed" && e.draftId === "d1"), "no draft_completed d1 before the interruption");
const opt = await good<ResumeView>("resumeOptions", s6);
assert.equal(opt.allowed, true, `resume is not allowed: ${opt.reason}`);
assert.equal(opt.draftCalls, 5);
const d1Event = JSON.stringify(pre.find((e) => e.type === "draft_completed" && e.draftId === "d1"));
const d1Text = (await good<DraftView[]>("sessionDrafts", s6)).find((d) => d.draftId === "d1")?.text;
assert.ok(d1Text, "d1 has no text before resume");
const nBefore = evs(s6).length;
await good("resumeSession", s6, 2);
await until("end of the resumed session", () => finished(s6), 60000);
const post = evs(s6);
assert.equal(post.filter((e) => e.type === "draft_completed" && e.draftId === "d1").length, 1);
assert.equal(JSON.stringify(post.find((e) => e.type === "draft_completed" && e.draftId === "d1")), d1Event);
assert.deepEqual(post.slice(nBefore).filter((e) => e.type === "draft_attempt_started" && e.draftId === "d1"), []);
assert.equal(post.find((e) => e.type === "session_created")!.session.drafts.synthesizerId, "p2");
const after = await good<DraftView[]>("sessionDrafts", s6);
assert.equal(after.find((d) => d.draftId === "d1")?.text, d1Text);
for (const id of ["d2", "d3"]) assert.ok((after.find((d) => d.draftId === id)?.text ?? "").length > 0, `${id}: no text after resume`);
assert.equal(post.filter((e) => e.type === "turn_started")[0]?.participantId, "p2");
ok(`interrupted phase (SIGKILL council, session ${s6}): resumeOptions allowed, draftCalls 5; after resumeSession d1 was not called and unchanged, synthesizer p2, d2 and d3 have text, first turn p2`);

// 7
appendFileSync(draftFile(s1.id, "d1"), "x");
const dr7 = await good<DraftView[]>("sessionDrafts", s1.id);
const d1 = dr7.find((d) => d.draftId === "d1")!;
assert.equal(d1.text, null);
assert.ok(d1.error?.includes("изменён"), `error without “изменён”: ${d1.error}`);
for (const id of ["d2", "d3"]) assert.ok((dr7.find((d) => d.draftId === id)?.text ?? "").length > 0, `${id}: no text`);
ok(`modified d1.txt: text null, error “${d1.error}”, d2 and d3 have text`);

// Summary: no bridge response reveals the data folder path, home folder path or environment secrets.
const forbidden: [string, string][] = [
  ["data folder path", dir], ["COUNCIL_HOME path as given", resolve(home)], ["home folder", homedir()],
  ...Object.entries(process.env).filter(([k, v]) => /KEY|TOKEN|SECRET/.test(k) && (v?.length ?? 0) > 0).map(([k, v]): [string, string] => [`value of ${k}`, v as string]),
];
for (const { action, json } of answers) for (const [what, v] of forbidden) assert.ok(!json.includes(JSON.stringify(v).slice(1, -1)) && !json.includes(v), `bridge response ${action} contains ${what}`);
ok(`bridge responses checked: ${answers.length} (successes and a rejection), none contains the data folder path, home folder path or KEY/TOKEN/SECRET values (forbidden values: ${forbidden.length})`);

// 8. English: default language, finish notification, drafts phase failure; the same data in ru
const defDir = join(dir, "lang-default");
mkdirSync(defDir);
const envNoLang = { ...process.env };
delete envNoLang["COUNCIL_LANG"];
const resolved = resolveLanguage(envNoLang, defDir);
assert.deepEqual({ language: resolved.language, source: resolved.source }, { language: "en", source: "default" });
ok("default language: without COUNCIL_LANG and preferences.json resolveLanguage gives en (source default)");

const TOPIC8 = "Выберите план TOPIC-MARK-U5";
const shows: { title: string; body: string }[] = [];
const finish = createFinishNotifier({
  isSupported: () => true,
  show: (text, on) => { shows.push({ ...text }); on.shown(); },
  focused: () => false, openId: () => null, activate: () => {}, logger,
});
const items = () => historyRead(dir, new Map(), new Set()).items;
const itemOf = (id: string) => items().find((i) => i.id === id)!;
setProcessLanguage("en");
finish.observe(items()); // baseline: earlier sessions are not shown

const s8 = await good<{ id: string }>("startSession", input(D, { topic: TOPIC8, drafts: { synthesizerId: "p2" } }));
finish.markRunning(s8.id);
await Promise.allSettled(runs);
await until("end of the step 8 session", () => finished(s8.id));
const n0 = shows.length;
finish.observe(items());
assert.equal(shows.length - n0, 1, "exactly one notification expected");
const st8 = readSession(dir, s8.id)!.status;
const enTitles: Record<string, string> = { consensus: "Consensus reached", no_consensus: "No consensus", stopped: "Discussion stopped", failed: "Discussion failed", interrupted: "Discussion interrupted" };
assert.equal(shows.at(-1)!.title, enTitles[st8], `title does not match status ${st8}`);
assert.equal(shows.at(-1)!.body, `${TOPIC8}\nrounds: ${itemOf(s8.id).round}`);
ok(`finish notification of a session with drafts on en (${s8.id}, ${st8}): one notification “${shows.at(-1)!.title}”, body is the topic as recorded and rounds: ${itemOf(s8.id).round}`);

// phase failure: synthesizer p2 drops out without creating version 1 (dropout/p2.json — errors only)
const F = ["independent-drafts/p1.json", "dropout/p2.json", "independent-drafts/p3.json"];
for (const m of F) assert.ok(known.includes(m), `scenario ${m} found`);
const s9 = await good<{ id: string }>("startSession", input(F, { topic: TOPIC8, drafts: { synthesizerId: "p2" } }));
finish.markRunning(s9.id);
await Promise.allSettled(runs);
await until("end of the step 9 session", () => finished(s9.id));
const st9 = readSession(dir, s9.id)!;
assert.equal(st9.status, "failed");
assert.equal(st9.state.finish?.reason, "synthesizer_unavailable");
const n1 = shows.length;
finish.observe(items());
assert.equal(shows.length - n1, 1, "exactly one failure notification expected");
assert.equal(shows.at(-1)!.title, "Discussion failed");
const fails = ofType(s9.id, "draft_attempt_failed");
assert.ok(fails.length > 0, "no failed draft attempts in the journal");
const dropEv = ofType(s9.id, "participant_dropped").find((e) => e.participantId === "p2");
assert.ok(dropEv?.reason, "no p2 dropout reason in the journal");
const tl = timeline(st9.state);
const tlFails = tl.filter((i) => i.kind === "draft-failure");
assert.equal(tlFails.length, fails.length, "number of failed attempts in the timeline");
const EN_LABELS = ["call error", "timeout", "invalid response"];
tlFails.forEach((i, k) => {
  assert.ok(EN_LABELS.includes(failureLabel(i.failure.kind)), `label ${failureLabel(i.failure.kind)} is not English`);
  const rec = fails.find((e) => e.attempt === i.failure.attempt && e.draftId === i.draftId)!;
  assert.equal(i.failure.message, rec.message, `the message of attempt ${k} differs from the journal`);
});
const dropItem = tl.find((i) => i.kind === "draft-dropped");
assert.ok(dropItem && dropItem.kind === "draft-dropped" && dropItem.reason === dropEv.reason, "the dropout reason in the timeline differs from the recorded one");
ok(`drafts phase failure on en (${s9.id}): failed/synthesizer_unavailable, notification “Discussion failed”, attempt labels in English (${tlFails.length}), messages and dropout reason verbatim from the journal`);

setProcessLanguage("ru");
const ruLabels = ["ошибка вызова", "таймаут", "некорректный ответ"];
const tlRu = timeline(st9.state);
const failsRu = tlRu.filter((i) => i.kind === "draft-failure");
assert.equal(failsRu.length, tlFails.length);
failsRu.forEach((i, k) => {
  assert.ok(ruLabels.includes(failureLabel(i.failure.kind)), `label ${failureLabel(i.failure.kind)} is not Russian`);
  assert.equal(i.failure.message, (tlFails[k] as typeof i).failure.message, "the message changed when the language switched");
});
const dropRu = tlRu.find((i) => i.kind === "draft-dropped");
assert.equal(dropRu && dropRu.kind === "draft-dropped" ? dropRu.reason : null, dropEv.reason);
const ruText = finishText(itemOf(s9.id));
assert.equal(ruText.title, "Обсуждение сорвалось");
assert.equal(ruText.body, `${TOPIC8}\nкругов: ${itemOf(s9.id).round}`);
ok("the same data on ru: attempt labels in Russian, finishText “Обсуждение сорвалось” / кругов: N, messages and dropout reason are the same strings");
setProcessLanguage("ru");

console.log(`Total: ${checks} checks, all passed; real model calls 0; data folder ${dir}`);
