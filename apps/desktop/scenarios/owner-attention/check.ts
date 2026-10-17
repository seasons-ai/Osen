// Check of the "owner attention" notifications with real `council` processes and a fake display (no Electron, no system notifications).
//   COUNCIL_DEV=1 COUNCIL_HOME="<new folder inside the repository>" node apps/desktop/scenarios/owner-attention/check.ts
// Writes only to a new COUNCIL_HOME and does not delete it. No models or network are used (scripted participants).
import "../../../../packages/core/scenarios/language-ru.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEvents, readSession, resolveLanguage } from "../../../../packages/core/src/index.ts";
import { setProcessLanguage } from "../../../../packages/core/src/i18n/index.ts";
import { attentionEvent, attentionText, createAttentionNotifier } from "../../src/main/attention-notify.ts";
import { createFinishNotifier, finishTitle } from "../../src/main/finish-notify.ts";
import type { FinishNotifierDeps } from "../../src/main/finish-notify.ts";
import { historyRead } from "../../src/main/history.ts";

const home = process.env.COUNCIL_HOME;
if (process.env.COUNCIL_DEV !== "1" || !home) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME (a new folder) are required. Usage: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node apps/desktop/scenarios/owner-attention/check.ts");
  process.exit(2);
}
const dir = resolve(home);
if (existsSync(dir) && (!statSync(dir).isDirectory() || readdirSync(dir).length > 0)) {
  console.error(`COUNCIL_HOME ${dir} already exists and is not empty: the script writes only to a new folder.`);
  process.exit(2);
}
mkdirSync(dir, { recursive: true });

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../../../../packages/core/src/council.ts");
const env = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: dir };
const sc = (n: string) => `scripted:${join(here, n)}.json`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (s: string) => console.log(`✓ ${s}`);
const kids = new Set<ChildProcess>();
let step = "";
const TOPIC = "Какой отчёт готовить TOPIC-MARK-35";
const SECRET = "SECRET-MARK-35";
const WAIT = ["--owner-wait-sec", "60"];

type Ev = Record<string, any> & { seq: number; ts: string; type: string };
const evs = (id: string): Ev[] => readEvents(dir, id)!.events as unknown as Ev[];
const of = (id: string, type: string) => evs(id).filter((e) => e.type === type);
const tail = (id: string) => evs(id).slice(-14).map((e) => `${e.seq}:${e.type}${e.reason ? `(${e.reason})` : ""}`).join(" ");
const stateOf = (id: string) => readSession(dir, id)!;

async function until<T>(what: string, fn: () => T | undefined | false | null, id?: string, ms = 15000): Promise<T> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(40)) {
    let r: T | undefined | false | null;
    try { r = fn(); } catch { r = undefined; }
    if (r) return r;
  }
  throw new Error(`timed out waiting for: ${what}${id ? `; journal tail: ${tail(id)}` : ""}`);
}

function proc(args: string[]) {
  const child = spawn(process.execPath, [entry, ...args], { env });
  kids.add(child);
  const r = { out: "", err: "" };
  child.stdout.on("data", (d) => { r.out += d; });
  child.stderr.on("data", (d) => { r.err += d; });
  const exited = new Promise<number | null>((res) => child.on("close", (c) => { kids.delete(child); res(c); }));
  return { child, exited, get out() { return r.out; }, get err() { return r.err; } };
}
type Proc = ReturnType<typeof proc>;
async function council(args: string[]) { const p = proc(args); const code = await p.exited; return { code, out: p.out, err: p.err }; }

type Sess = { id: string; exec: Proc };
const sessions: { purpose: string; s: Sess }[] = [];
async function start(purpose: string, p1: string, p2: string, rounds: number, flags: string[]): Promise<Sess> {
  step = purpose;
  const exec = proc(["--topic", TOPIC, "--participant", sc(p1), "--participant", sc(p2), "--max-rounds", String(rounds), ...flags]);
  const id = await until("session id in the start output", () => /^Сессия (\S+) ·/m.exec(exec.out)?.[1]);
  const s = { id, exec };
  sessions.push({ purpose, s });
  return s;
}
const waitStarted = (id: string, n: number) => until(`owner_wait_started №${n}`, () => of(id, "owner_wait_started")[n - 1], id);
const waitFinished = (id: string, waitId: string) => until(`owner_wait_finished ${waitId}`, () => of(id, "owner_wait_finished").find((e) => e.waitId === waitId), id);
const finished = (s: Sess) => until("session finish", () => stateOf(s.id).status !== "running", s.id, 20000);

// ---- the "app": two notifiers with shared fake dependencies and polling, as in main/index.ts ----
type Shown = { title: string; body: string; on: { shown(): void; click(): void; failed(error: unknown): void } };
const ATT_TITLES = new Set<string>((["question", "pause"] as const).flatMap((k) => [attentionText(k, "ru").title, attentionText(k, "en").title]));
function makeApp() {
  const shows: Shown[] = [];
  const log: { level: string; line: string }[] = [];
  const events: { who: "attention" | "finish"; ev: { type: string; id: string } }[] = [];
  const mode = { focused: false, openId: null as string | null, supported: true, show: "ok" as "ok" | "throw" };
  let who: "attention" | "finish" = "finish";
  const deps: FinishNotifierDeps = {
    isSupported: () => mode.supported,
    show(text, on) {
      if (mode.show === "throw") throw new Error("fake display failure");
      shows.push({ ...text, on });
      on.shown();
    },
    focused: () => mode.focused,
    openId: () => mode.openId,
    activate: (id) => events.push({ who, ev: who === "attention" ? attentionEvent(id, readSession(dir, id)?.status) : { type: "open-result", id } }),
    logger: {
      info: (m) => void log.push({ level: "info", line: m }),
      error: (m, cause) => void log.push({ level: "error", line: cause === undefined ? m : `${m} ${cause instanceof Error ? cause.message : String(cause)}` }),
    },
  };
  // activate tells the notifier by whose display was clicked: the wrapper sets who before the click call
  const finishDeps: FinishNotifierDeps = { ...deps, activate: (id) => { who = "finish"; deps.activate(id); } };
  const attnDeps: FinishNotifierDeps = { ...deps, activate: (id) => { who = "attention"; deps.activate(id); } };
  const finish = createFinishNotifier(finishDeps);
  const attn = createAttentionNotifier(attnDeps);
  const poll = () => {
    const { items, attention } = historyRead(dir, new Map(), new Set());
    finish.observe(items);
    attn.observe(attention);
  };
  const count = () => ({ att: shows.filter((s) => ATT_TITLES.has(s.title)).length, fin: shows.filter((s) => !ATT_TITLES.has(s.title)).length, errs: log.filter((l) => l.level === "error").length, calls: shows.length });
  return { shows, log, events, mode, poll, count };
}
type App = ReturnType<typeof makeApp>;
const attShows = (a: App) => a.shows.filter((s) => ATT_TITLES.has(s.title));
const polls = (a: App, n: number) => { for (let i = 0; i < n; i++) a.poll(); };
const sessionCount = () => historyRead(dir, new Map(), new Set()).items.length;

async function main() {
  // ---- 1. Start with an already waiting session ----
  const s0 = await start("S0 round pause (before the app)", "pa-p1", "pa-p2", 3, ["--pause-after-round", ...WAIT]);
  const w01 = await waitStarted(s0.id, 1);
  assert.deepEqual(w01.reasons, ["round_boundary"]);
  const A = makeApp();
  step = "1. start with a waiting session";
  polls(A, 3);
  assert.equal(A.count().att, 0, "attention displays with an already waiting session");
  ok("start with waiting session S0: 3 polls of \"app A\" → 0 attention displays");

  // ---- 2. A new round pause ----
  step = "2. new round pause";
  assert.equal((await council(["continue", s0.id])).code, 0);
  const w02 = await waitStarted(s0.id, 2);
  assert.deepEqual(w02.reasons, ["round_boundary"]);
  assert.equal(w02.waitId, "w2");
  let c = A.count();
  A.poll();
  assert.equal(A.count().att, c.att + 1, "exactly one new pause expected");
  const sh2 = attShows(A).at(-1)!;
  assert.equal(sh2.title, attentionText("pause").title);
  assert.equal(sh2.body, attentionText("pause").body);
  polls(A, 3);
  assert.equal(A.count().att, c.att + 1, "repeated polls produced new displays");
  ok("new pause of S0 (w2): one \"The discussion is waiting for the owner\" display, call-to-action text from the catalog; 3 repeated polls without new ones");
  assert.equal((await council(["continue", s0.id])).code, 0);
  await finished(s0);
  A.poll();
  assert.equal(A.count().att, c.att + 1, "S0 finish produced an attention display");
  ok(`S0 finished (${stateOf(s0.id).status}), no attention display added`);

  // ---- 3. Question and waiting for an answer ----
  const s1 = await start("S1 question and waiting for an answer", "ask-p1", "answer-p2", 3, ["--wait-for-owner", ...WAIT]);
  const w1 = await waitStarted(s1.id, 1);
  assert.deepEqual(w1.reasons, ["owner_question"]);
  c = A.count();
  polls(A, 4);
  assert.equal(A.count().att, c.att + 1, "exactly one display for S1 expected");
  const sh1 = attShows(A).at(-1)!;
  assert.equal(sh1.title, attentionText("question").title);
  assert.equal(sh1.body, attentionText("question").body);
  assert.ok(!JSON.stringify(A.shows.map(({ title, body }) => ({ title, body }))).includes(SECRET), "question marker in the display");
  assert.ok(!A.log.some((l) => l.line.includes(SECRET)), "question marker in the log");
  assert.ok(!attShows(A).some((s) => `${s.title}${s.body}`.includes("TOPIC-MARK-35")), "topic in the attention display");
  assert.ok(!A.log.some((l) => l.line.includes("TOPIC-MARK-35")), "topic in a log line");
  ok("S1 question with waiting: 4 polls → one \"Question for the owner\" display; SECRET-MARK-35 is in neither displays nor the log; TOPIC-MARK-35 is in neither attention displays nor the log");

  // ---- 4. Click on a live session ----
  step = "4. click on a live session";
  const n0 = A.events.length;
  sh1.on.click();
  assert.equal(A.events.length, n0 + 1);
  assert.deepEqual(A.events.at(-1), { who: "attention", ev: { type: "open-session", id: s1.id } });
  ok("click on the S1 display while the session runs → open-session");

  // ---- 5. An answer creates no new display ----
  step = "5. answer creates no new display";
  const sessionsBefore = sessionCount();
  c = A.count();
  assert.equal((await council(["say", s1.id, "--answer", "q1", "Таблицей"])).code, 0);
  await waitFinished(s1.id, "w1");
  A.poll();
  await finished(s1);
  A.poll();
  A.poll();
  const c5 = A.count();
  assert.equal(c5.att, c.att, "the answer created a new attention display");
  assert.equal(c5.fin, c.fin + 1, "exactly one finish display for S1 expected");
  const fin1 = A.shows.filter((s) => !ATT_TITLES.has(s.title)).at(-1)!;
  const st1 = stateOf(s1.id).status as Parameters<typeof finishTitle>[0];
  assert.equal(fin1.title, finishTitle(st1));
  assert.ok(fin1.body.includes("кругов:"), fin1.body);
  ok(`answer to the S1 question: no new attention displays; exactly one finish display "${fin1.title}" with «кругов:»`);

  // ---- 6. Click on a stale question ----
  step = "6. click on a stale question";
  sh1.on.click();
  assert.deepEqual(A.events.at(-1), { who: "attention", ev: { type: "open-result", id: s1.id } });
  assert.equal(sessionCount(), sessionsBefore, "the number of sessions changed");
  ok("click on the stale S1 display → open-result for the same session, no new one created");

  // ---- 7. Question without wait mode ----
  const s2 = await start("S2 question without wait mode", "ask-p1", "slow-p2", 3, []);
  await until("owner question in the S2 state", () => stateOf(s2.id).state.questions.length > 0 && stateOf(s2.id).status === "running", s2.id);
  c = A.count();
  A.poll();
  assert.equal(stateOf(s2.id).status, "running", "S2 is no longer running — the turn delay is too short");
  assert.equal(A.count().att, c.att + 1, "one display for S2 expected");
  assert.equal(attShows(A).at(-1)!.title, attentionText("question").title);
  polls(A, 3);
  assert.equal(A.count().att, c.att + 1);
  ok("S2 question without waiting (p2 turn delayed by 5 s): one \"Question for the owner\" display, repeated polls without new ones");
  await finished(s2);
  assert.equal(stateOf(s2.id).status, "consensus", "S2 did not reach consensus");
  A.poll();
  assert.equal(A.count().att, c.att + 1);

  // ---- 8. Question and pause on the same boundary ----
  const s3 = await start("S3 question and pause on the same boundary", "twoq-p1", "twoq-p2", 3, ["--pause-after-round", "--wait-for-owner", "--owner-wait-sec", "120"]);
  const w3 = await waitStarted(s3.id, 1);
  assert.deepEqual(w3.reasons, ["round_boundary", "owner_question"]);
  c = A.count();
  polls(A, 4);
  assert.equal(A.count().att, c.att + 1, "exactly one display for S3 expected");
  ok(`S3 question and pause on the same boundary: one display "${attShows(A).at(-1)!.title}"`);

  // ---- 9. Suppression in focus ----
  const s4 = await start("S4 round pause (focus)", "pa-p1", "pa-p2", 3, ["--pause-after-round", "--owner-wait-sec", "120"]);
  A.mode.focused = true;
  A.mode.openId = s4.id;
  await waitStarted(s4.id, 1);
  c = A.count();
  A.poll();
  assert.equal(A.count().calls, c.calls, "display while the session is open in focus");
  A.mode.focused = false;
  A.mode.openId = null;
  polls(A, 3);
  assert.equal(A.count().calls, c.calls, "a suppressed display appeared after focus was removed");
  ok("S4 suppression: no display in focus; 3 polls after focus is removed — still none");

  // ---- 10. Display failure ----
  const s5 = await start("S5 round pause (display failure)", "pa-p1", "pa-p2", 3, ["--pause-after-round", "--owner-wait-sec", "120"]);
  await waitStarted(s5.id, 1);
  A.mode.show = "throw";
  c = A.count();
  const logN = A.log.length;
  A.poll();
  const newLines = A.log.slice(logN);
  assert.equal(newLines.length, 1, `new log lines: ${JSON.stringify(newLines)}`);
  assert.equal(newLines[0]!.level, "error");
  assert.ok(!newLines[0]!.line.includes(SECRET) && !newLines[0]!.line.includes("TOPIC-MARK-35"), newLines[0]!.line);
  polls(A, 3);
  assert.equal(A.log.length, logN + 1, "log lines were added");
  A.mode.show = "ok";
  assert.equal(A.count().calls, c.calls, "the display was called again after the failure");
  ok("S5 display failure: one error line without markers, the next 3 polls do not repeat the display");
  const turnsBefore = of(s5.id, "turn_started").length;
  assert.equal((await council(["continue", s5.id])).code, 0);
  await until("next S5 turn after the display failure", () => of(s5.id, "turn_started").length > turnsBefore || stateOf(s5.id).status !== "running", s5.id);
  ok("after the display failure continue S5 → code 0, the discussion goes on");

  // ---- 11. Restart ----
  step = "11. restart";
  assert.ok([s3, s4].some((s) => stateOf(s.id).state.waiting !== null), "no waiting session");
  const B = makeApp();
  polls(B, 3);
  assert.equal(B.count().att, 0, "attention displays after restart");
  ok("restart: \"app B\" on the same folder, waiting sessions exist → 3 polls, 0 attention displays");

  // ---- 12. Finish ----
  step = "12. finish";
  for (const s of [s3, s4, s5]) {
    if (stateOf(s.id).status === "running") await council(["stop", s.id]);
  }
  for (const { s } of sessions) await Promise.race([s.exec.exited, sleep(15000)]);
  for (const { s } of sessions) assert.notEqual(stateOf(s.id).status, "running", `session ${s.id} is still running`);
  ok("all sessions finished, executor processes closed");
  // ---- 13. English: default language and a language change after a display ----
  step = "13. English by default";
  const defDir = join(dir, "lang-default");
  mkdirSync(defDir);
  const envNoLang = { ...process.env };
  delete envNoLang["COUNCIL_LANG"];
  const resolved = resolveLanguage(envNoLang, defDir);
  assert.deepEqual({ language: resolved.language, source: resolved.source }, { language: "en", source: "default" });
  setProcessLanguage(resolved.language);
  const E = makeApp();
  E.poll(); // baseline: everything before this moment is not displayed
  const s6 = await start("S6 round pause (English)", "pa-p1", "pa-p2", 3, ["--pause-after-round", "--owner-wait-sec", "120"]);
  await waitStarted(s6.id, 1);
  E.poll();
  assert.equal(E.count().att, 1, "one pause display expected");
  const enPause = { ...attShows(E).at(-1)! };
  assert.equal(enPause.title, "The discussion is waiting for the owner");
  assert.equal(enPause.body, "Open the discussion in the app.");
  const s7 = await start("S7 owner question (English)", "ask-p1", "answer-p2", 3, ["--wait-for-owner", ...WAIT]);
  await waitStarted(s7.id, 1);
  polls(E, 3);
  assert.equal(E.count().att, 2, "one question display expected");
  const enQuestion = attShows(E).at(-1)!;
  assert.equal(enQuestion.title, "Question for the owner");
  assert.equal(enQuestion.body, "Open the discussion in the app.");
  assert.equal((await council(["stop", s6.id])).code, 0);
  await finished(s6);
  E.poll();
  const enFinish = E.shows.filter((x) => !ATT_TITLES.has(x.title)).at(-1)!;
  assert.equal(stateOf(s6.id).status, "stopped");
  assert.equal(enFinish.title, "Discussion stopped");
  assert.equal(enFinish.body, `${TOPIC}\nrounds: ${stateOf(s6.id).state.round}`);
  ok("default language en (no COUNCIL_LANG, folder without preferences.json): pause, question and finish in English, topic as recorded");

  step = "13b. language change after a display";
  const firstBefore = JSON.stringify({ title: enPause.title, body: enPause.body });
  setProcessLanguage("ru");
  assert.equal((await council(["stop", s7.id])).code, 0);
  await finished(s7);
  E.poll();
  const ruFinish = E.shows.filter((x) => !ATT_TITLES.has(x.title)).at(-1)!;
  assert.equal(ruFinish.title, "Обсуждение остановлено");
  assert.equal(ruFinish.body, `${TOPIC}\nкругов: ${stateOf(s7.id).state.round}`);
  assert.equal(JSON.stringify({ title: E.shows[0]!.title, body: E.shows[0]!.body }), firstBefore, "the display before the language change changed");
  assert.equal(E.shows.length, 4, "the language change recreated displays");
  ok("language change after a display: the next notification is in ru, earlier display records unchanged");
  setProcessLanguage("ru");
  for (const s of [s6, s7]) await Promise.race([s.exec.exited, sleep(15000)]);

  console.log(`Attention displays: A=${A.count().att}, B=${B.count().att}; finish displays: A=${A.count().fin}, B=${B.count().fin}`);
}

const t0 = Date.now();
let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error(`✗ FAILED at step "${step}": ${e instanceof Error ? e.message : String(e)}`);
  const last = sessions.at(-1);
  if (last) console.error(`  session ${last.s.id}; journal tail: ${tail(last.s.id)}`);
} finally {
  for (const k of kids) k.kill("SIGKILL");
  console.log(`\nStand: ${dir} (${Math.round((Date.now() - t0) / 1000)} s)`);
  for (const { purpose, s } of sessions) {
    let st = "?";
    try { st = readSession(dir, s.id)!.status; } catch { /* no journal */ }
    console.log(`  ${purpose} · ${s.id} · ${st}`);
  }
}
process.exit(failed ? 1 : 0);
