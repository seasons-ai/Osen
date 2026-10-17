// Check of the owner wait with real processes: the executor and the control commands are separate `council` processes.
//   COUNCIL_DEV=1 COUNCIL_HOME="<new folder inside the repository>" node packages/core/scenarios/owner-wait/check.ts
// Writes only to a new COUNCIL_HOME and does not remove it. No models or network are used (participants are scripted).
import "../language-ru.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eventsPath, ownerMessagesDir, readEvents, readSession } from "../../src/index.ts";

const home = process.env.COUNCIL_HOME;
if (process.env.COUNCIL_DEV !== "1" || !home) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME (a new folder) are required. Run: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node packages/core/scenarios/owner-wait/check.ts");
  process.exit(2);
}
const dir = resolve(home);
if (existsSync(dir) && (!statSync(dir).isDirectory() || readdirSync(dir).length > 0)) {
  console.error(`COUNCIL_HOME ${dir} already exists and is not empty: the script writes only to a new folder.`);
  process.exit(2);
}
mkdirSync(dir, { recursive: true });

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../../src/council.ts");
const indexUrl = pathToFileURL(resolve(here, "../../src/index.ts")).href;
const env = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: dir };
const sc = (n: string) => `scripted:${join(here, n)}.json`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (s: string) => console.log(`✓ ${s}`);
const kids = new Set<ChildProcess>();
const summary: string[] = [];
let step = "";

type Ev = Record<string, any> & { seq: number; ts: string; type: string };
const evs = (id: string): Ev[] => readEvents(dir, id)!.events as unknown as Ev[];
const of = (id: string, type: string) => evs(id).filter((e) => e.type === type);
const turns = (id: string) => of(id, "turn_started").length;
const bytes = (id: string) => readFileSync(eventsPath(dir, id));
const tail = (id: string) => evs(id).slice(-14).map((e) => `${e.seq}:${e.type}${e.reason ? `(${e.reason})` : ""}`).join(" ");

async function until<T>(what: string, fn: () => T | undefined | false | null, id?: string, ms = 12000): Promise<T> {
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
  const r = { child, out: "", err: "", done: false, code: null as number | null };
  child.stdout.on("data", (d) => { r.out += d; });
  child.stderr.on("data", (d) => { r.err += d; });
  const exited = new Promise<number | null>((res) => child.on("close", (c) => { r.done = true; r.code = c; kids.delete(child); res(c); }));
  return { ...r, get out() { return r.out; }, get err() { return r.err; }, get done() { return r.done; }, get code() { return r.code; }, child, exited };
}
type Proc = ReturnType<typeof proc>;
async function council(args: string[]) { const p = proc(args); const code = await p.exited; return { code, out: p.out, err: p.err }; }

type Sess = { id: string; exec: Proc };
async function start(purpose: string, p1: string, p2: string, rounds: number, flags: string[]): Promise<Sess> {
  step = purpose;
  const exec = proc(["--topic", "Какой отчёт готовить к пятнице", "--participant", sc(p1), "--participant", sc(p2), "--max-rounds", String(rounds), ...flags]);
  const id = await until("session id in the start output", () => /^Сессия (\S+) ·/m.exec(exec.out)?.[1]);
  const s = { id, exec };
  sessions.push({ purpose, s });
  return s;
}
const sessions: { purpose: string; s: Sess }[] = [];

/** A control action: the journal before it is an exact prefix of the journal after it. */
async function acting<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const before = bytes(id);
  const r = await fn();
  const after = bytes(id);
  assert.ok(after.length >= before.length && after.subarray(0, before.length).equals(before), "journal: old bytes are not preserved as a prefix");
  return r;
}
const waitStarted = (id: string, n: number) => until(`owner_wait_started №${n}`, () => of(id, "owner_wait_started")[n - 1], id);
const waitFinished = (id: string, waitId: string) => until(`owner_wait_finished ${waitId}`, () => of(id, "owner_wait_finished").find((e) => e.waitId === waitId), id);
const finish = async (s: Sess, status: string, code: number) => {
  assert.equal(await Promise.race([s.exec.exited, sleep(15000).then(() => "timeout")]), code, `executor exit code; tail: ${tail(s.id)}`);
  assert.equal(readSession(dir, s.id)!.status, status, "final status");
};
const noNewTurns = async (id: string, ms: number, what: string) => {
  const n = turns(id);
  await sleep(ms);
  assert.equal(turns(id), n, `${what}: new turn_started events appeared`);
};
const status = (id: string) => council(["status", id]);

/** Common journal invariants. */
function invariants(id: string) {
  const e = evs(id);
  e.forEach((x, i) => assert.equal(x.seq, i + 1, `seq: event #${i + 1} has seq ${x.seq}`));
  assert.equal(readEvents(dir, id)!.offset, statSync(eventsPath(dir, id)).size, "journal was not read to the end");
  const starts = e.filter((x) => x.type === "owner_wait_started");
  starts.forEach((st, i) => {
    assert.equal(st.waitId, `w${i + 1}`, "waitIds are in order");
    const fin = e.filter((x) => x.type === "owner_wait_finished" && x.waitId === st.waitId);
    assert.equal(fin.length, 1, `owner_wait_finished for ${st.waitId}: ${fin.length}`);
    const between = e.filter((x) => x.seq > st.seq && x.seq < fin[0]!.seq && x.type === "turn_started");
    assert.equal(between.length, 0, `there is a turn_started between the start and the end of ${st.waitId}`);
  });
  return starts;
}

const stateOf = (id: string) => readSession(dir, id)!;
const unfinishedWaits = (id: string) => of(id, "owner_wait_started").filter((st) => !of(id, "owner_wait_finished").some((f) => f.waitId === st.waitId));

async function main() {
  // ---- 1. Pause after a round ----
  let s = await start("pause after a round", "pause-p1", "plain-p2", 3, ["--pause-after-round", "--owner-wait-sec", "60"]);
  let id = s.id;
  const w1 = await waitStarted(id, 1);
  assert.deepEqual(w1.reasons, ["round_boundary"]);
  assert.equal(w1.afterTurn, 2);
  let st = await status(id);
  assert.equal(st.code, 0);
  for (const t of ["идёт", "Ожидание владельца w1", "пауза после круга", "Срок:", `council continue ${id}`]) assert.ok(st.out.includes(t), `status lacks "${t}": ${st.out}`);
  ok("pause: owner_wait_started [round_boundary] after turn 2; status: running, w1, pause after the round, deadline, continue hint");
  await noNewTurns(id, 2000, "pause");
  ok("pause: no new turn_started in 2 s");
  const deadline1 = /Срок: (\S+),/.exec(st.out)![1];
  await acting(id, async () => assert.equal((await council(["say", id, "Реплика: уложимся в неделю"])).code, 0));
  await until("owner_message", () => of(id, "owner_message")[0], id);
  st = await status(id);
  assert.ok(st.out.includes("Ожидание владельца w1") && st.out.includes(`Срок: ${deadline1},`), `the wait changed after say: ${st.out}`);
  assert.equal(of(id, "owner_wait_finished").length, 0);
  ok("pause: say recorded (owner_message), wait w1 and deadline unchanged, the pause was not released");
  assert.equal((await council(["resume", id])).code, 2);
  ok("pause: resume of a running session refused (code 2)");
  await acting(id, async () => assert.equal((await council(["continue", id])).code, 0));
  assert.equal((await waitFinished(id, "w1")).reason, "continued");
  await finish(s, "consensus", 0);
  const t3 = of(id, "turn_started")[2]!;
  const done3 = evs(id).find((e) => e.seq > t3.seq && (e.type === "turn_completed" || e.type === "turn_failed"))!;
  assert.equal(done3.type, "turn_completed", "the turn after the message did not finish with turn_completed (expectPrompt for the message)");
  ok("pause: continue → continued; turn 3 with the message-prompt check finished with turn_completed; outcome consensus, code 0");
  assert.ok((await status(id)).out.includes("Ожидания владельца нет."));
  assert.equal((await council(["continue", id])).code, 2);
  ok("pause: after the outcome \"Ожидания владельца нет.\", continue → code 2");
  invariants(id);

  // ---- 2. Waiting for an answer ----
  s = await start("waiting for an answer to a question", "ask-p1", "answer-p2", 3, ["--wait-for-owner", "--owner-wait-sec", "60"]);
  id = s.id;
  const w2 = await waitStarted(id, 1);
  assert.deepEqual(w2.reasons, ["owner_question"]);
  assert.deepEqual(w2.questionIds, ["q1"]);
  assert.equal(turns(id), 1, "the wait did not start before p2's turn");
  st = await status(id);
  assert.match(st.out, /q1 · p1 «[^»]*»: Нужен ли отчёт в виде таблицы или текстом\?/);
  ok("answer: owner_wait_started [owner_question] q1 before p2's turn; status shows the question line with its text");
  await acting(id, async () => assert.equal((await council(["say", id, "--answer", "q1", "Таблицей, пожалуйста"])).code, 0));
  const fin2 = await waitFinished(id, "w1");
  assert.equal(fin2.reason, "answered");
  assert.equal(of(id, "owner_message").length, 1);
  assert.equal(of(id, "question_closed").length, 1);
  assert.ok(JSON.stringify(of(id, "question_closed")[0]).includes("answered"));
  await finish(s, "consensus", 0);
  const t2 = of(id, "turn_started")[1]!;
  assert.equal(evs(id).find((e) => e.seq > t2.seq && (e.type === "turn_completed" || e.type === "turn_failed"))!.type, "turn_completed");
  ok("answer: say --answer → owner_message, question_closed answered, owner_wait_finished answered; p2's turn with \"Ответ владельца:\" completed");
  invariants(id);

  // ---- 3. Two reasons ----
  s = await start("two reasons", "twoq-p1", "twoq-p2", 3, ["--pause-after-round", "--wait-for-owner", "--owner-wait-sec", "60"]);
  id = s.id;
  const w3 = await waitStarted(id, 1);
  assert.deepEqual(w3.reasons, ["round_boundary", "owner_question"]);
  assert.equal(of(id, "owner_wait_started").length, 1);
  ok("two reasons: one wait [round_boundary, owner_question]");
  await acting(id, async () => assert.equal((await council(["say", id, "--answer", "q1", "Текстом"])).code, 0));
  const upd = await until("owner_wait_updated", () => of(id, "owner_wait_updated")[0], id);
  assert.deepEqual(upd.reasons, ["round_boundary"]);
  assert.deepEqual(upd.questionIds, []);
  assert.equal(of(id, "owner_wait_finished").length, 0);
  await noNewTurns(id, 1500, "after the answer");
  st = await status(id);
  assert.ok(st.out.includes("пауза после круга") && !/q1 ·/.test(st.out), st.out);
  ok("two reasons: answer → owner_wait_updated [round_boundary], no questions; the wait is not released, no turns, status without a question");
  await acting(id, async () => assert.equal((await council(["continue", id])).code, 0));
  assert.equal((await waitFinished(id, "w1")).reason, "continued");
  await finish(s, "consensus", 0);
  ok("two reasons: continue → continued, the session reached the outcome");
  invariants(id);

  // ---- 4. Deadline ----
  s = await start("wait deadline 2 s", "ask-p1", "unanswered-p2", 3, ["--wait-for-owner", "--owner-wait-sec", "2"]);
  id = s.id;
  const w4 = await waitStarted(id, 1);
  const fin4 = await waitFinished(id, "w1");
  assert.equal(fin4.reason, "expired");
  const qc = evs(id).find((e) => e.type === "question_closed")!;
  assert.ok(JSON.stringify(qc).includes("unanswered") && JSON.stringify(qc).includes("q1"));
  assert.equal(fin4.seq, qc.seq + 1, "expired must come right after question_closed");
  const dt = Date.parse(fin4.ts) - Date.parse(w4.ts);
  assert.ok(dt >= 1800, `deadline passed after ${dt} ms`);
  await finish(s, "consensus", 0);
  const t4 = of(id, "turn_started")[1]!;
  assert.equal(evs(id).find((e) => e.seq > t4.seq && (e.type === "turn_completed" || e.type === "turn_failed"))!.type, "turn_completed");
  ok(`deadline: question_closed unanswered q1 → owner_wait_finished expired right after, in ${dt} ms; p2's turn with "остался без ответа" completed`);
  invariants(id);

  // ---- 5. The last round does not wait ----
  s = await start("last round without a wait", "last-p1", "last-p2", 1, ["--pause-after-round", "--wait-for-owner"]);
  id = s.id;
  await finish(s, "no_consensus", 3);
  assert.equal(evs(id).filter((e) => e.type.startsWith("owner_wait_")).length, 0);
  ok("last round: outcome no_consensus (code 3), no owner_wait_* events, the process finished by itself");
  invariants(id);

  // ---- 6. Modes off ----
  s = await start("modes off", "off-p1", "off-p2", 3, []);
  id = s.id;
  await finish(s, "consensus", 0);
  assert.equal(evs(id).filter((e) => e.type.startsWith("owner_wait_")).length, 0);
  assert.ok(!("ownerWait" in evs(id)[0]!.session));
  assert.ok(JSON.stringify(of(id, "question_closed")[0]).includes("unanswered"));
  ok("off: no owner_wait_*, no ownerWait in session_created, the question is closed by the old rule (unanswered)");
  invariants(id);

  // ---- 7. Crash during a pause, resume before the deadline ----
  s = await start("crash during a pause, resume before the deadline", "plain-p1", "plain-p2", 3, ["--pause-after-round", "--owner-wait-sec", "40"]);
  id = s.id;
  await waitStarted(id, 1);
  s.exec.child.kill("SIGKILL");
  await s.exec.exited;
  await until("status interrupted", () => stateOf(id).status === "interrupted", id);
  const j7 = bytes(id);
  st = await status(id);
  const deadline7 = /Срок: (\S+),/.exec(st.out)?.[1];
  assert.ok(st.out.includes("interrupted") && st.out.includes("Ожидание владельца w1") && deadline7 && st.out.includes(`council resume ${id}`), st.out);
  assert.equal(deadline7, of(id, "owner_wait_started")[0]!.deadline);
  assert.ok(bytes(id).equals(j7), "status changed the journal");
  assert.equal((await council(["continue", id])).code, 2);
  ok("crash during a pause: status is interrupted, w1 with the same deadline, resume hint; journal unchanged; continue → code 2");
  const res = proc(["resume", id]);
  sessions.at(-1)!.s = { id, exec: res };
  await until("session_resumed", () => of(id, "session_resumed")[0], id);
  await until("resume output", () => res.out.includes("продолжается до"), id);
  assert.ok(res.out.includes(`продолжается до ${deadline7}`), res.out);
  assert.equal(of(id, "owner_wait_started").length, 1);
  await noNewTurns(id, 1500, "after resume");
  await acting(id, async () => assert.equal((await council(["continue", id])).code, 0));
  assert.equal((await waitFinished(id, "w1")).reason, "continued");
  await finish(sessions.at(-1)!.s, "consensus", 0);
  ok("crash during a pause: resume → session_resumed without a new owner_wait_started, \"продолжается до <deadline>\", no turns; continue → outcome");
  invariants(id);

  // ---- 8. Crash while waiting for an answer, resume after the deadline ----
  s = await start("crash while waiting for an answer, deadline passed", "ask-p1", "unanswered-p2", 3, ["--wait-for-owner", "--owner-wait-sec", "3"]);
  id = s.id;
  const w8 = await waitStarted(id, 1);
  s.exec.child.kill("SIGKILL");
  await s.exec.exited;
  await until("deadline passed", () => Date.now() > Date.parse(w8.deadline) + 200);
  assert.equal(of(id, "owner_wait_finished").length, 0, "without an executor the wait must not finish");
  st = await status(id);
  assert.ok(st.out.includes("interrupted") && st.out.includes("истёк"), st.out);
  ok("crash while waiting for an answer: after the deadline status is interrupted, \"истёк\", the journal has no owner_wait_finished");
  const res8 = proc(["resume", id]);
  sessions.at(-1)!.s = { id, exec: res8 };
  const f8 = await waitFinished(id, "w1");
  assert.equal(f8.reason, "expired");
  const resumedAt = of(id, "session_resumed")[0]!.seq;
  const qc8 = evs(id).find((e) => e.type === "question_closed")!;
  const firstTurn = evs(id).find((e) => e.seq > resumedAt && e.type === "turn_started")!;
  assert.ok(JSON.stringify(qc8).includes("unanswered") && qc8.seq > resumedAt && qc8.seq < f8.seq && f8.seq < firstTurn.seq, "order: session_resumed, question_closed, expired, turn_started");
  assert.equal(of(id, "owner_wait_started").length, 1);
  await finish(sessions.at(-1)!.s, "consensus", 0);
  ok("crash while waiting for an answer: resume → question_closed unanswered and expired before the first turn_started; no new owner_wait_started");
  invariants(id);

  // ---- 9. Stop during a wait ----
  s = await start("stop during a wait", "plain-p1", "plain-p2", 3, ["--pause-after-round", "--owner-wait-sec", "60"]);
  id = s.id;
  await waitStarted(id, 1);
  await acting(id, async () => assert.equal((await council(["stop", id])).code, 0));
  assert.equal((await waitFinished(id, "w1")).reason, "stopped");
  await finish(s, "stopped", 4);
  assert.equal(of(id, "session_finished")[0]!.status, "stopped");
  ok("stop: stop → owner_wait_finished stopped, session_finished stopped, executor code 4, no turns after the wait");
  invariants(id);

  // ---- 10. Races and a late request ----
  s = await start("continue/answer race and a late request", "race-p1", "race-p2", 3, ["--pause-after-round", "--wait-for-owner", "--owner-wait-sec", "60"]);
  id = s.id;
  await waitStarted(id, 1);
  await acting(id, async () => {
    const r = await Promise.all([council(["continue", id]), council(["continue", id]), council(["say", id, "--answer", "q1", "Таблицей"])]);
    assert.ok(r.some((x) => x.code === 0), "none of the three requests was accepted");
  });
  await waitFinished(id, "w1");
  await waitStarted(id, 2);
  await sleep(2000);
  assert.equal(of(id, "owner_wait_finished").filter((e) => e.waitId === "w1").length, 1);
  assert.equal(of(id, "question_closed").length, 1);
  const qdir = ownerMessagesDir(dir, id);
  const pending = () => readdirSync(qdir).filter((f) => f.endsWith(".json"));
  assert.deepEqual(pending(), [], "unprocessed w1 requests remain");
  ok("race: two continue and say --answer at once → one owner_wait_finished w1, one question_closed, the request queue is empty");
  const code = `import { requestOwnerRelease } from ${JSON.stringify(indexUrl)}; try { requestOwnerRelease(${JSON.stringify(dir)}, ${JSON.stringify(id)}, { waitId: "w1" }); console.log("ACCEPTED"); } catch (e) { console.log("REFUSED " + e.reason); }`;
  const lateOut = await new Promise<string>((res) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", code]); kids.add(c);
    let o = ""; c.stdout.on("data", (d) => { o += d; }); c.on("close", () => { kids.delete(c); res(o); });
  });
  assert.ok(lateOut.includes("REFUSED stale_wait"), lateOut);
  assert.deepEqual(pending(), []);
  ok("late request: requestOwnerRelease(waitId w1) while w2 is active → stale_wait refusal, no file appeared");
  const reqId = `${String(Date.now()).padStart(15, "0")}-${String(process.hrtime.bigint()).padStart(20, "0")}-${randomUUID()}`;
  const tmpf = join(qdir, `.tmp-${randomUUID()}`);
  writeFileSync(tmpf, JSON.stringify({ releaseWaitId: "w1", createdAt: new Date().toISOString() }));
  renameSync(tmpf, join(qdir, `${reqId}.json`));
  await until("late request file removed", () => pending().length === 0, id, 1500 + 3000);
  assert.equal(of(id, "owner_wait_finished").filter((e) => e.waitId === "w2").length, 0);
  assert.equal(stateOf(id).state.waiting?.waitId, "w2");
  ok("late request: the file with releaseWaitId w1 was removed by the executor, w2 is still active");
  await acting(id, async () => assert.equal((await council(["continue", id])).code, 0));
  assert.equal((await waitFinished(id, "w2")).reason, "continued");
  await finish(s, "consensus", 0);
  ok("races: continue released w2, the session reached the outcome");
  invariants(id);

  // ---- 11. Spend ----
  let waits = 0;
  for (const { purpose, s: x } of sessions) {
    const e = evs(x.id);
    for (const w of e.filter((y) => y.type === "owner_wait_started")) {
      const f = e.find((y) => y.type === "owner_wait_finished" && y.waitId === w.waitId)!;
      assert.equal(e.filter((y) => y.type === "turn_started" && y.seq > w.seq && y.seq < f.seq).length, 0, `${purpose}: a turn inside ${w.waitId}`);
      waits++;
    }
  }
  ok(`spend: in all ${waits} waits of ${sessions.length} sessions there are 0 turn_started between the start and the end`);
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
    summary.push(`  ${purpose} · ${s.id} · ${st}`);
  }
  console.log(summary.join("\n"));
}
process.exit(failed ? 1 : 0);
