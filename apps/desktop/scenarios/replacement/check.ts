// Check of participant replacement on the resume path in the app, on the real main-process modules (bridge, launch, resume, markup) and the core, without an Electron window.
//   COUNCIL_DEV=1 COUNCIL_HOME="<new empty folder inside the project>" node apps/desktop/scenarios/replacement/check.ts
//   COUNCIL_DEV=1 COUNCIL_HOME="<new empty folder inside the project>" node apps/desktop/scenarios/replacement/check.ts --seed-only   (only prepare the folder for the app window)
// Writes only to COUNCIL_HOME and does not delete it. Participants are scripted: real models are not called.
// Steps with terminal sessions (F2, F6) launch a real council process (packages/core/src/council.ts) and stop it in the middle of the p2 turn.
import "../../../../packages/core/scenarios/language-ru.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { writeFile } from "node:fs/promises";
import { setProcessLanguage } from "../../../../packages/core/src/i18n/index.ts";
import { exportSession } from "../../src/main/export.ts";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_TEMPLATES_DIR, createLogger, ensureDataDir, envFilePath, inspectProviders, loadTemplates, readRegistry, readSession, runStoredSession, userTemplatesDir, writeRegistry } from "../../../../packages/core/src/index.ts";
import type { Registry } from "../../../../packages/core/src/index.ts";
import { createBridge } from "../../src/main/bridge.ts";
import { createLauncher } from "../../src/main/launcher.ts";
import { sessionMarkdown } from "../../src/main/markdown.ts";
import { resumeScenarioPath, resumeView } from "../../src/main/resume.ts";
import { listScenarios, registryView, scenarioPath } from "../../src/main/setup-data.ts";
import { timeline } from "../../src/shared/timeline.ts";
import type { ResumeReplacement, ResumeView } from "../../src/shared/bridge.ts";

const home = process.env.COUNCIL_HOME;
const seedOnly = process.argv.includes("--seed-only");
if (process.env.COUNCIL_DEV !== "1" || !home) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME (a new empty folder) are required. Run: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node apps/desktop/scenarios/replacement/check.ts");
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
const councilTs = join(root, "packages/core/src/council.ts");
const DROP = ["dropout/p1.json", "dropout/p2.json"];
const NEW = "dropout/p3.json";
const CONS = ["consensus/p1.json", "consensus/p2.json"];
const NOCONS = ["no-consensus/p1.json", "no-consensus/p3.json"]; // p3 objects in both rounds: outcome no_consensus
const known = listScenarios(scenariosDir);
for (const m of [...DROP, NEW, ...CONS, ...NOCONS]) assert.ok(known.includes(m), `scenario ${m} found`);
const MARK = `stand-secret-${Date.now()}`; // planted value for checking secret leaks
const env = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: dir, COUNCIL_STAND_API_KEY: MARK };
const EXPECTED = 17;
let checks = 0;
const ok = (s: string) => { checks++; console.log(`ok: ${s}`); };

writeRegistry(ensureDataDir(dir), {
  providers: [],
  defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 1000, participants: [] },
} satisfies Registry);

type R = { ok: true; value: unknown } | { ok: false; error: string };
type Ev = Record<string, any> & { seq: number; type: string };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => T | undefined | false | null, ms = 60000): Promise<T> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) {
    let r: T | undefined | false | null;
    try { r = fn(); } catch { r = undefined; }
    if (r) return r;
  }
  throw new Error(`timed out waiting for: ${what}`);
}
const journal = (id: string) => join(dir, "sessions", id, "events.jsonl");
const jbytes = (id: string) => readFileSync(journal(id));
const evs = (id: string): Ev[] => jbytes(id).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ofType = (id: string, t: string) => evs(id).filter((e) => e.type === t);
const lockOf = (id: string) => join(dir, "sessions", id, "resume.lock");
const finished = (id: string) => existsSync(journal(id)) && evs(id).some((e) => e.type === "session_finished");
const statusOf = (id: string) => readSession(dir, id)!.status;
const stateOf = (id: string) => readSession(dir, id)!.state;

// Real app modules; the bindings repeat apps/desktop/src/main/index.ts. The scenarios directory is a parameter: step 6 takes its own.
const logger = createLogger(dir, "desktop", env);
const runs: Promise<unknown>[] = [];
const run: typeof runStoredSession = (o) => { const r = runStoredSession(o); runs.push(r); return r; };
const terminalIds = new Set<string>(); // sessions launched by the council command: scenario paths in their journal are normal behavior
const answers: { action: string; json: string; terminal: boolean }[] = [];
function stack(catalogDir: string) {
  const scenPath = (m: string) => scenarioPath(catalogDir, m);
  const launcher = createLauncher({ dataDir: dir, env, logger, materials: null as never, registry: () => readRegistry(dir), catalog: () => loadTemplates({ builtinDir: BUILTIN_TEMPLATES_DIR, userDir: userTemplatesDir(dir) }), scenarioPath: scenPath, run });
  const stub = <T>(v: T) => () => v;
  const bridge = createBridge({
    listSessions: stub([]), sessionExists: (id: string) => readSession(dir, id) !== null, sessionDrafts: () => [], watchSession: () => () => {}, notices: stub([]), listTemplates: stub({ templates: [], errors: [] }),
    registry: async () => ({}) as never, startSession: (input: never) => launcher.start(input),
    lineups: async () => ({}) as never, saveLineup: async () => ({}) as never,
    lastParticipants: stub(null),
    resumeOptions: async (id: string, replacements?: ResumeReplacement[]) => {
      const reg = readRegistry(dir);
      const found = await inspectProviders(reg, { env, keyFile: envFilePath(dir) });
      const view = registryView(reg, found.map((f) => f.status), listScenarios(catalogDir));
      return resumeView(dir, id, view, resumeScenarioPath(scenPath), replacements);
    },
    resumeSession: (id: string, rounds: number, cap?: number | null, replacements?: ResumeReplacement[]) => launcher.resume(id, rounds, cap, replacements),
    stopSession: () => {}, acceptVersion: () => ({}) as never, sendOwnerMessage: () => ({ requestId: "r" }), continueWait: () => ({ requestId: "r" }),
    previewMaterials: async () => ({}) as never, prepareRerun: () => ({}) as never, copyText: () => {},
    exportSession: async () => null, setPinned: () => {}, settings: {} as never, templates: { open: stub(null), create: stub(null), save: stub(null), remove: () => {} } as never,
    materials: { snapshot: stub(null) } as never, pickMaterials: async () => null, send: () => {}, logger,
  } as never);
  const call = async (a: string, ...args: unknown[]): Promise<R> => {
    const r = (await bridge.call(a, args)) as R;
    answers.push({ action: a, json: JSON.stringify(r), terminal: typeof args[0] === "string" && terminalIds.has(args[0]) });
    return r;
  };
  async function good<T>(a: string, ...args: unknown[]): Promise<T> {
    const r = await call(a, ...args);
    assert.ok(r.ok, `${a}: success expected, got: ${r.ok ? "" : r.error}`);
    return r.value as T;
  }
  /** Refusal: { ok: false } with a message, the journal is byte-for-byte unchanged, no resume.lock. Returns the refusal text. */
  async function refused(id: string, a: string, ...args: unknown[]): Promise<string> {
    const before = jbytes(id);
    const r = await call(a, ...args);
    assert.equal(r.ok, false, `${a}(${JSON.stringify(args.slice(1))}): refusal expected, got success`);
    const msg = (r as { error: string }).error;
    assert.ok(typeof msg === "string" && msg.length > 0, `${a}: empty refusal message`);
    assert.ok(jbytes(id).equals(before), `${a}: journal ${id} changed on refusal`);
    assert.ok(!existsSync(lockOf(id)), `${a}: resume.lock left behind for ${id}`);
    return msg;
  }
  return { launcher, call, good, refused };
}
const main = stack(scenariosDir);
const { good, refused, call } = main;

const sc = (model: string) => ({ providerId: "scripted", model, role: null });
const input = (models: string[], maxRounds = 2) => ({ templateId: null, topic: "Как назвать кота", participants: models.map(sc), maxRounds });
const MAP: ResumeReplacement[] = [{ participantId: "p2", providerId: "scripted", model: NEW }];
const NEWNAME = "Сценарный (dropout/p3.json)";
async function startVia(s: ReturnType<typeof stack>, models: string[], maxRounds = 2): Promise<string> {
  const { id } = await s.good<{ id: string }>("startSession", input(models, maxRounds));
  await until(`end of session ${id}`, () => finished(id) && !s.launcher.running().includes(id));
  return id;
}
const idle = (s: ReturnType<typeof stack>, id: string) => until(`end of resume ${id}`, () => finished(id) && !s.launcher.running().includes(id) && !existsSync(lockOf(id)));

// Session F2/F6 is launched by a real council process with absolute scenario paths; the stop in the middle of the p2 turn is SIGINT; the p2 scenario is then deleted.
const scenDir = join(dir, "scen");
mkdirSync(scenDir, { recursive: true });
const agreeStep = { response: { stance: "agree", reasoning: "Согласен", solution: null, answers: [], questions: [] } };
const agrees = (n: number) => Array.from({ length: n }, () => agreeStep);
async function stoppedSession(tag: string): Promise<{ id: string; turn: number; round: number }> {
  const p1 = join(scenDir, `${tag}-p1.json`), p2 = join(scenDir, `${tag}-p2.json`);
  writeFileSync(p1, JSON.stringify({ steps: [{ response: { stance: "amend", reasoning: "Довод версии 1", solution: "Версия 1 кота", answers: [], questions: [{ to: "p2", text: "Какого цвета кот?" }] } }, ...agrees(8)] }));
  writeFileSync(p2, JSON.stringify({ steps: [{ ...agreeStep, delayMs: 120000 }, ...agrees(8)] }));
  let out = "";
  const child = spawn(process.execPath, [councilTs, "--topic", "Как назвать кота", "--participant", `scripted:${p1}`, "--participant", `scripted:${p2}`, "--max-rounds", "2"],
    { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_DEV: "1", COUNCIL_HOME: dir } });
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const closed = new Promise<void>((r) => child.on("close", () => r()));
  try {
    const id = await until(`${tag}: council session id`, () => /^Сессия (\S+) ·/m.exec(out)?.[1]);
    const t = await until(`${tag}: p2 turn started`, () => ofType(id, "turn_started").find((e) => e.participantId === "p2"));
    child.kill("SIGINT");
    await Promise.race([closed, sleep(30000).then(() => { throw new Error(`${tag}: council did not stop within 30 s\n${out}`); })]);
    await until(`${tag}: status stopped`, () => statusOf(id) === "stopped");
    rmSync(p2);
    terminalIds.add(id);
    return { id, turn: t.turn, round: t.round };
  } finally {
    child.kill("SIGKILL");
  }
}

// Fixtures. F1/F3/F4/F5 via the bridge, F2/F6 via a real council.
const F1 = await startVia(main, DROP);
const F3 = await startVia(main, CONS);
const F4 = await startVia(main, DROP);
const F5 = await startVia(main, NOCONS, 2);
const [F2, F6] = [await stoppedSession("f2"), await stoppedSession("f6")];
assert.equal(statusOf(F1), "failed", "F1 failed");
assert.equal(stateOf(F1).finish?.reasonCode, "insufficient_active_participants", "F1: reasonCode");
{ // F4: remove reasonCode from the session_finished line
  const lines = jbytes(F4).toString("utf8").split("\n").filter(Boolean);
  const i = lines.map((l) => JSON.parse(l).type).lastIndexOf("session_finished");
  const e = JSON.parse(lines[i]!);
  assert.ok(e.reasonCode, "F4 has reasonCode before the edit");
  delete e.reasonCode;
  lines[i] = JSON.stringify(e);
  writeFileSync(journal(F4), `${lines.join("\n")}\n`);
  assert.equal(statusOf(F4), "failed", "F4 is still failed");
}
const f1Done = jbytes(F1);
let f6Resumed: ResumeView | null = null;
if (seedOnly) {
  // F6 is already resumed with a replacement and finished: the app window has something to show without a launch
  await good("resumeSession", F6.id, 2, undefined, MAP);
  await idle(main, F6.id);
  console.log(`Data folder prepared: ${dir}`);
  const row = (n: string, id: string, what: string) => console.log(`${n}  ${id}  ${statusOf(id)}  — ${what}`);
  row("F1", F1, "failed, recoverable: «Continue» → the panel offers to replace p2 (dropped), choose «Scripted» / dropout/p3.json");
  row("F2", F2.id, "stopped, the scenario of the active p2 is deleted, question q1 to p2 is open: resume is impossible without a replacement (p2 is required)");
  row("F3", F3, "consensus: resume is unavailable, nothing to replace");
  row("F4", F4, "failed without a shortage-of-participants reason: resume is unavailable");
  row("F5", F5, "no_consensus: ordinary resume without replacements; replacing an available participant is refused");
  row("F6", F6.id, "copy of F2, already resumed with p2 → p3 replacement and finished: label in the feed, participants panel, question q1 closed by the replacement");
  console.log(`Open the app on this folder: cd "${root}" && COUNCIL_DEV=1 COUNCIL_HOME="${dir}" npm run desktop`);
  process.exit(0);
}

// 1
{
  const v = await good<ResumeView>("resumeOptions", F1);
  assert.equal(v.allowed, true);
  assert.ok(v.blocked?.includes("p2"), `blocked does not name p2: ${v.blocked}`);
  assert.deepEqual(v.replaceable.map((r) => [r.id, r.why, r.required]), [["p2", "dropped", false]]);
  assert.deepEqual(v.participants.map((p) => p.id), ["p1"]);
  const sp = v.providers.find((p) => p.id === "scripted");
  assert.ok(sp && sp.models.includes(NEW), `providers has no scripted with ${NEW}`);
  assert.deepEqual(v.replacements, []);
  assert.equal(v.agreementReset, false);
  ok(`F1 without a map: allowed, blocked «${v.blocked}», replaceable [p2 dropped, required=false], participants [p1], scripted with ${NEW}, replacements [], agreementReset false`);
}

// 2
{
  const before = jbytes(F1);
  const v = await good<ResumeView>("resumeOptions", F1, MAP);
  assert.equal(v.blocked, null);
  assert.deepEqual(v.participants.map((p) => [p.id, p.replaces ?? null, p.available]), [["p1", null, true], ["p3", "p2", true]]);
  const r = v.replacements[0]!;
  assert.deepEqual([r.participantId, r.newId, r.name, r.providerId, r.model], ["p2", "p3", NEWNAME, "scripted", NEW]);
  assert.equal(v.agreementReset, true);
  assert.ok(jbytes(F1).equals(before), "preview changed the journal");
  ok(`F1 with map p2→${NEW}: blocked null, participants p1 + p3 (replaces p2, available), replacements[0] p2→p3 «${r.name}», agreementReset true, journal untouched`);
}

// 3
{
  const bad: [string, unknown][] = [
    ["not an array", { participantId: "p2" }],
    ["participantId x2", [{ participantId: "x2", providerId: "scripted", model: NEW }]],
    ["empty model", [{ participantId: "p2", providerId: "scripted", model: "" }]],
    ["absolute path of an existing file", [{ participantId: "p2", providerId: "scripted", model: join(scenariosDir, NEW) }]],
    ["unknown providerId", [{ participantId: "p2", providerId: "nowhere", model: "m" }]],
  ];
  assert.ok(existsSync(join(scenariosDir, NEW)));
  const msgs: string[] = [];
  for (const [what, m] of bad) {
    msgs.push(`${what}: «${await refused(F1, "resumeOptions", F1, m)}»`);
    await refused(F1, "resumeSession", F1, 2, undefined, m);
  }
  ok(`malformed maps are refused via resumeOptions and resumeSession, the F1 journal did not change. ${msgs.join("; ")}`);
}

// 4
assert.ok(jbytes(F1).equals(f1Done), "the F1 journal changed after previews and refusals");
assert.ok(!existsSync(lockOf(F1)));
ok(`"Cancel" sent nothing: the F1 journal (${f1Done.length} bytes) equals the snapshot taken right after completion, no resume.lock`);

// 5
{
  const v = await good<ResumeView>("resumeOptions", F2.id);
  assert.equal(v.allowed, true, `F2 is not allowed: ${v.reason}`);
  assert.deepEqual(v.participants.filter((p) => p.id === "p2").map((p) => p.available), [false]);
  assert.deepEqual(v.replaceable.filter((r) => r.id === "p2").map((r) => [r.why, r.required]), [["unavailable", true]]);
  const msg = await refused(F2.id, "resumeSession", F2.id, 2);
  assert.ok(msg.includes("p2"), `refusal does not name p2: ${msg}`);
  const w = await good<ResumeView>("resumeOptions", F2.id, MAP);
  assert.ok(!w.participants.some((p) => p.id === "p2"), "p2 remained in the lineup");
  assert.ok(w.participants.some((p) => p.replaces === "p2"), "no new participant");
  assert.equal(w.blocked, null);
  ok(`F2: p2 is unavailable (required), resumeSession without a map is refused («${msg}»); with a map p2 is not in the lineup, new ${w.participants.map((p) => p.id).join("+")}, blocked null`);
}

// 6: its own scenarios directory, to delete the chosen scenario without touching the shared one
{
  const cat = join(dir, "catalog");
  for (const m of [...DROP, NEW]) { mkdirSync(dirname(join(cat, m)), { recursive: true }); cpSync(join(scenariosDir, m), join(cat, m)); }
  const own = stack(cat);
  const id = await startVia(own, DROP);
  assert.equal(statusOf(id), "failed");
  const v = await own.good<ResumeView>("resumeOptions", id, MAP);
  assert.equal(v.blocked, null);
  rmSync(join(cat, NEW));
  const msg = await own.refused(id, "resumeSession", id, 2, undefined, MAP);
  const msg2 = await own.refused(id, "resumeOptions", id, MAP);
  ok(`scenario vanished after the preview (session ${id}): resumeSession refused («${msg}»), a new resumeOptions too («${msg2}»), journal unchanged`);
}

// 7
{
  const ver = (id: string) => stateOf(id).versions.length;
  const verBefore = ver(F1);
  const nBefore = evs(F1).length;
  const [a, b] = await Promise.all([main.call("resumeSession", F1, 2, undefined, MAP), main.call("resumeSession", F1, 2, undefined, MAP)]);
  assert.ok(a.ok && b.ok, `both calls must succeed: ${JSON.stringify([a, b])}`);
  await idle(main, F1);
  const es = evs(F1);
  const res = es.filter((e) => e.type === "session_resumed");
  assert.equal(res.length, 1, `session_resumed in the journal: ${res.length}`);
  assert.deepEqual(res[0]!.replacements.map((r: any) => [r.oldParticipantId, r.participant.id]), [["p2", "p3"]]);
  assert.equal(res[0]!.replacements[0].participant.name, NEWNAME);
  assert.equal(statusOf(F1), "consensus");
  assert.equal(ver(F1), verBefore, "version number changed");
  const post = es.slice(es.findIndex((e) => e.type === "session_resumed"));
  for (const p of ["p1", "p3"]) assert.ok(post.some((e) => e.type === "turn_completed" && e.participantId === p && e.stance === "agree"), `${p}: no completed agree turn after resume`);
  assert.ok(es.length > nBefore);
  ok(`two concurrent resumeSession with a map: both succeed, one session_resumed (p2→p3, «${NEWNAME}»), result consensus, version ${ver(F1)} as before resume, p1 and p3 agreed`);
}

// 8
{
  const msg = await refused(F5, "resumeSession", F5, 2, undefined, [{ participantId: "p1", providerId: "scripted", model: NEW }]);
  assert.ok(msg.includes("доступен"), `core message without «доступен»: ${msg}`);
  ok(`replacing the available p1 in F5: refused («${msg}»), journal unchanged`);
}

// 9
{
  const out: string[] = [];
  for (const [n, id] of [["F3", F3], ["F4", F4]] as const) {
    const v = await good<ResumeView>("resumeOptions", id);
    assert.equal(v.allowed, false, `${n}: allowed`);
    assert.ok(v.reason && v.reason.length > 0, `${n}: no reason`);
    assert.deepEqual(v.replaceable, [], `${n}: replaceable`);
    out.push(`${n} «${v.reason}»`);
  }
  const v5 = await good<ResumeView>("resumeOptions", F5);
  assert.equal(v5.allowed, true, `F5: allowed (reason ${v5.reason})`);
  assert.equal(v5.blocked, null);
  assert.deepEqual(v5.replaceable, []);
  assert.deepEqual(v5.replacements, []);
  ok(`F3 and F4 cannot be resumed (${out.join("; ")}), replaceable []; F5 (${statusOf(F5)}) without a map: allowed, blocked null, replaceable [], replacements []`);
}

// 10
{
  const state = stateOf(F1);
  const items = timeline(state);
  const mark = items.flatMap((i) => (i.kind === "resumed" ? [i.mark] : []))[0];
  assert.ok(mark, "no resumed element in the timeline");
  assert.deepEqual(mark.replacements, [{ oldParticipantId: "p2", newParticipantId: "p3" }]);
  const byId = (id: string) => state.session!.participants.find((p) => p.id === id)!;
  const st = (id: string) => state.participants.find((p) => p.id === id)!;
  assert.equal(st("p2").replacedBy, "p3");
  assert.equal(st("p3").replaces, "p2");
  assert.ok(byId("p3"));
  const md = sessionMarkdown(state, statusOf(F1));
  assert.ok(md.includes("заменён участником p3"), "Markdown lacks «заменён участником p3»");
  ok("F1 after resume: timeline resumed with replacements [p2→p3], p2 has replacedBy p3, p3 has replaces p2, Markdown contains «заменён участником p3»");
}

// 11
{
  const before = jbytes(F6.id).length;
  await good("resumeSession", F6.id, 2, undefined, MAP);
  await idle(main, F6.id);
  const es = evs(F6.id);
  const st = stateOf(F6.id);
  const q = st.questions.find((x) => x.to === "p2");
  assert.equal(q?.status, "replaced", `status of the question to p2: ${q?.status}`);
  assert.ok(!es.some((e) => e.type === "question_closed" && e.questionId === q!.id), "the journal has question_closed for the question to p2");
  const first = es.slice(es.findIndex((e) => e.type === "session_resumed")).find((e) => e.type === "turn_started")!;
  assert.deepEqual([first.participantId, first.turn, first.round], ["p3", F6.turn + 1, F6.round]);
  assert.ok(jbytes(F6.id).length > before);
  ok(`F2-like session ${F6.id} resumed with a map: question ${q!.id} to p2 has status replaced without question_closed; p3 goes first, turn ${first.turn} (the interrupted one was ${F6.turn}), round ${first.round}`);
}

// 12
{
  const forbidden: [string, string][] = [
    ["data folder path", dir], ["COUNCIL_HOME path as given", resolve(home)], ["home folder", homedir()],
    ...Object.entries(env).filter(([k, v]) => /KEY|TOKEN|SECRET/.test(k) && (v?.length ?? 0) > 0).map(([k, v]): [string, string] => [`value ${k}`, v as string]),
  ];
  const secretsOnly = forbidden.filter(([w]) => w.startsWith("value"));
  let n = 0;
  for (const { action, json, terminal } of answers) {
    for (const [what, v] of terminal ? secretsOnly : forbidden) {
      n++;
      assert.ok(!json.includes(JSON.stringify(v).slice(1, -1)) && !json.includes(v), `bridge answer ${action} contains ${what}`);
    }
  }
  const nt = answers.filter((a) => a.terminal).length;
  ok(`bridge answers checked: ${answers.length}, none contains the data folder path, the home folder or KEY/TOKEN/SECRET values (substring checks ${n}). Note: for sessions launched by council (F2, F6; answers ${nt}) only environment values were checked: scenario paths in their journal are normal behavior`);
}

// 13-17: English checks of the resume and export texts; they set the language themselves and restore ru at the end
{
  const cyr = /[А-Яа-яЁё]/;
  const registry = async () => registryView(readRegistry(dir), (await inspectProviders(readRegistry(dir), { env, keyFile: envFilePath(dir) })).map((f) => f.status), listScenarios(scenariosDir));
  const view = async (id: string, map?: ResumeReplacement[]) => resumeView(dir, id, await registry(), resumeScenarioPath((m) => scenarioPath(scenariosDir, m)), map);
  const F7 = await startVia(main, DROP);
  assert.equal(statusOf(F7), "failed");
  const dropReason = stateOf(F7).participants.find((p) => p.id === "p2")!.dropReason!;

  // 13
  setProcessLanguage("ru");
  const ruV = await view(F7);
  const ruBlocked = ruV.blocked!;
  setProcessLanguage("en");
  const enV = await view(F7);
  assert.deepEqual(enV.replaceable.map((r) => [r.id, r.why, r.reason]), [["p2", "dropped", dropReason]]);
  assert.deepEqual(enV.replaceable.map((r) => r.reason), ruV.replaceable.map((r) => r.reason), "the dropout reason depends on the language");
  assert.ok(enV.blocked && enV.blocked !== ruBlocked && !cyr.test(enV.blocked), `blocked is not English: ${enV.blocked}`);
  assert.ok(enV.blocked.includes("p2") && enV.blocked.includes("Replace the dropped participant"), `blocked: ${enV.blocked}`);
  const f2En = await view(F2.id);
  const f2Reason = f2En.replaceable.find((r) => r.id === "p2")!.reason;
  assert.match(f2Reason, /^scenario “.+” is unavailable$/);
  ok(`en: resume panel F7: dropout reason as in the journal («${dropReason}»), blocked «${enV.blocked}», unavailable scenario F2 — «${f2Reason.slice(0, 40)}…»`);

  // 14
  const badMap: ResumeReplacement[] = [{ participantId: "p2", providerId: "scripted", model: "no/such.json" }];
  const e1 = await refused(F7, "resumeOptions", F7, badMap);
  const e2 = await refused(F7, "resumeSession", F7, 2, undefined, badMap);
  for (const e of [e1, e2]) assert.ok(/^Replacement 1 \(p2\): scenario “no\/such\.json” is not in the catalog\.$/.test(e) && !cyr.test(e), `refusal: ${e}`);
  ok(`en: the replacement-map refusal via the bridge is in English: «${e1}»`);

  // 15
  const exp = join(dir, "exports");
  mkdirSync(exp, { recursive: true });
  const exportTo = async (id: string, tag: string) => {
    let name = "";
    const r = await exportSession(id, {
      read: (x) => readSession(dir, x),
      render: (s) => sessionMarkdown(s.state, s.status),
      pickPath: async (n) => { name = n; return join(exp, `${tag}-${n}`); },
      write: (p, t) => writeFile(p, t, "utf8"),
    });
    assert.ok(r, "export cancelled");
    return { text: readFileSync(r.path, "utf8"), name };
  };
  const st1 = stateOf(F1);
  const decision = st1.versions.at(-1)!.text;
  const dropped = st1.participants.find((p) => p.id === "p2")!.dropReason!;
  assert.ok(decision && cyr.test(decision) && dropped, "F1 has no Russian decision and dropout reason");
  const enX = await exportTo(F1, "en");
  for (const s of ["# Osen: discussion", "## Topic", "- Status: ", "## Participants", "## Discussion log", "Как назвать кота", decision, dropped]) assert.ok(enX.text.includes(s), `en export without «${s}»`);
  for (const s of ["Статус", "Участники", "Ход обсуждения"]) assert.ok(!enX.text.includes(s), `en export contains «${s}»`);
  setProcessLanguage("ru");
  const ruX = await exportTo(F1, "ru");
  assert.equal(ruX.text, sessionMarkdown(stateOf(F1), statusOf(F1)));
  for (const s of ["# Osen: обсуждение", "- Статус: "]) assert.ok(ruX.text.includes(s), `ru export without «${s}»`);
  assert.equal(enX.name, ruX.name, "the file name depends on the language with a non-empty topic");
  ok(`export of F1 with the real exportSession: en — English captions, topic, decision and dropout reason verbatim, no Russian captions; ru — the old captions and content equal to sessionMarkdown`);

  // 16
  const j0 = jbytes(F1);
  setProcessLanguage("en");
  const again = await exportTo(F1, "en2");
  assert.ok(again.text.includes("# Osen: discussion") && !again.text.includes("Статус"), "after switching ru→en the captions are not English");
  assert.ok(jbytes(F1).equals(j0), "export changed the journal");
  ok(`language at export time: after ru → en without recreating the modules the captions are English, the F1 journal (${j0.length} bytes) did not change`);

  // 17
  const missing = await exportSession("no-such-session", { read: (x) => readSession(dir, x), render: () => "", pickPath: async () => null, write: async () => {} }).then(() => "", (e: Error) => e.message);
  assert.equal(missing, "Session no-such-session not found");
  ok(`en: export of a nonexistent session — refusal «${missing}»`);

  setProcessLanguage("ru");
}

console.log(`Result: ${checks} of ${EXPECTED}; real model calls 0; data folder ${dir}`);
process.exit(checks === EXPECTED ? 0 : 1);
