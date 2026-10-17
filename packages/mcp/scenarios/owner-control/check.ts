// Live check of owner-side control through MCP: the server is a child process over stdio, like a real agent's,
// the discussion executor is a separate `council` process. Participants are scripted only, 0 real model calls.
//   COUNCIL_DEV=1 COUNCIL_HOME=.council-data/acceptance-36-<label> node packages/mcp/scenarios/owner-control/check.ts
// Writes only to COUNCIL_HOME and does not delete it (this is the evidence of the check).
import "../../../core/scenarios/language-ru.ts";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ownerMessagesDir, readEvents, readSession, selectOwnerVersion } from "@model-council/core";

if (process.env.COUNCIL_DEV !== "1" || !process.env.COUNCIL_HOME?.trim()) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME are required. Run: COUNCIL_DEV=1 COUNCIL_HOME=.council-data/acceptance-36-<label> node packages/mcp/scenarios/owner-control/check.ts");
  process.exit(2);
}
const home = resolve(process.env.COUNCIL_HOME);
mkdirSync(home, { recursive: true });

const here = import.meta.dirname;
const root = join(here, "../../../..");
const mainTs = join(root, "packages/mcp/src/main.ts");
const councilTs = join(root, "packages/core/src/council.ts");
const coreScen = join(root, "packages/core/scenarios");

const L_SAY = "МЕТКА-РЕПЛИКА-36a", L_ANS = "МЕТКА-ОТВЕТ-36b", L_KEY = "МЕТКА-КЛЮЧ-36c";
const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_HOME: home, COUNCIL_DEV: "1", COUNCIL_FAKE_KEY: L_KEY };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sessionIds = () => (existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")) : []);

// ---- processes ----
const kids = new Set<ChildProcess>();
function executor(args: string[]) {
  const child = spawn(process.execPath, [councilTs, ...args], { env: baseEnv, cwd: root });
  kids.add(child);
  const r = { child, out: "", err: "", exited: false };
  child.stdout.on("data", (d) => { r.out += d; });
  child.stderr.on("data", (d) => { r.err += d; });
  child.on("close", () => { r.exited = true; kids.delete(child); });
  return r;
}
type Exec = ReturnType<typeof executor>;
const scripted = (p: string) => `scripted:${p}`;
async function startExec(topic: string, p1: string, p2: string, flags: string[]): Promise<{ id: string; exec: Exec }> {
  const exec = executor(["--topic", topic, "--participant", scripted(p1), "--participant", scripted(p2), ...flags]);
  const id = await until("session id in the executor output", () => /^Сессия (\S+) ·/m.exec(exec.out)?.[1]);
  return { id, exec };
}

async function until<T>(what: string, fn: () => T | undefined | false | null, ms = 15000): Promise<T> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(60)) {
    let r: T | undefined | false | null;
    try { r = fn(); } catch { r = undefined; }
    if (r) return r;
  }
  throw new Error(`timed out waiting for: ${what}`);
}

// ---- MCP ----
type Res = { isError?: boolean; content: { type: string; text: string }[] };
interface Srv { client: Client; transport: StdioClientTransport; pid: number; errors: string[] }
const servers: Srv[] = [];
async function connect(extraEnv: Record<string, string> = {}): Promise<Srv> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mainTs], cwd: root, stderr: "ignore", env: { ...baseEnv, ...extraEnv } });
  const client = new Client({ name: "owner-control-check", version: "0" });
  const errors: string[] = [];
  client.onerror = (e) => errors.push(`client: ${e.message}`);
  transport.onerror = (e) => errors.push(`transport: ${e.message}`);
  await client.connect(transport);
  const s = { client, transport, pid: transport.pid!, errors };
  servers.push(s);
  return s;
}
const call = async (s: Srv, name: string, args: Record<string, unknown> = {}) => (await s.client.callTool({ name, arguments: args })) as Res;
const body = (r: Res) => r.content[0]?.text ?? "";
const json = (r: Res, what: string) => { if (r.isError) throw new Error(`${what}: tool error: ${body(r)}`); return JSON.parse(body(r)); };
const status = async (s: Srv, sessionId: string, waitSec?: number) => json(await call(s, "council_status", { sessionId, ...(waitSec === undefined ? {} : { waitSec }) }), "council_status");

// ---- journal and queue ----
type Ev = Record<string, any> & { seq: number; type: string };
const evs = (id: string): Ev[] => readEvents(home, id)!.events as unknown as Ev[];
const of = (id: string, type: string) => evs(id).filter((e) => e.type === type);
const queueFiles = (id: string) => { try { return readdirSync(ownerMessagesDir(home, id)).length; } catch { return 0; } };
const snap = (id: string) => ({ events: evs(id).length, queue: queueFiles(id) });

// ---- result output ----
let total = 0, passed = 0;
async function check(n: number, title: string, fn: () => Promise<string | void>) {
  total++;
  try {
    const note = await fn();
    passed++;
    console.log(`${n}. ${title}: OK${note ? ` — ${note}` : ""}`);
  } catch (e) {
    console.log(`${n}. ${title}: FAIL — ${e instanceof Error ? e.message : String(e)}`);
  }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const eq = (a: unknown, b: unknown, what: string) => must(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/** A call that must be refused without writing to the journal and the queue. */
async function rejected(srv: Srv, id: string, name: string, args: Record<string, unknown>, label: string, problems: string[]) {
  const before = snap(id);
  let r: Res;
  try { r = await call(srv, name, args); } catch (e) { problems.push(`${label}: exception instead of an isError response: ${e}`); return; }
  const after = snap(id);
  if (!r.isError) problems.push(`${label}: no isError, response ${body(r).slice(0, 120)}`);
  if (JSON.stringify(before) !== JSON.stringify(after)) problems.push(`${label}: journal/queue changed ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
}

async function main() {
  const A = await connect();

  // 1
  await check(1, "tool list", async () => {
    const names = (await A.client.listTools()).tools.map((t) => t.name).sort();
    eq(names, ["council_continue", "council_options", "council_resume", "council_say", "council_start", "council_status", "council_stop"], "tools/list");
  });

  // S1
  const topic = "Какой отчёт готовить к пятнице";
  const s1 = await startExec(topic, join(here, "s1-p1.json"), join(here, "s1-p2.json"), ["--max-rounds", "3", "--pause-after-round", "--wait-for-owner", "--owner-wait-sec", "120"]);
  const S1 = s1.id;
  let qText = "";
  let w1 = "";
  let turnsBefore = 0;
  await until("S1: owner wait", () => of(S1, "owner_wait_started")[0]);

  await check(2, "S1: state with a question", async () => {
    const s = await status(A, S1);
    eq(s.status, "running", "status");
    must(s.statusText.includes("ждёт владельца"), `statusText: ${s.statusText}`);
    const q = s.ownerQuestions.find((x: any) => x.id === "q1");
    must(q && q.author && q.authorId && q.text && Number.isInteger(q.turn), `q1 in ownerQuestions: ${JSON.stringify(s.ownerQuestions)}`);
    qText = q.text;
    must(s.waiting !== null, "waiting: null");
    must(s.waiting.reasons.includes("owner_question"), `reasons: ${s.waiting.reasons}`);
    must(s.waiting.questionIds.includes("q1"), `questionIds: ${s.waiting.questionIds}`);
    must(Date.parse(s.waiting.deadline) > Date.now(), `deadline is not in the future: ${s.waiting.deadline}`);
    w1 = s.waiting.waitId;
    turnsBefore = s.turns;
    return `waitId ${w1}, question from ${q.author} (turn ${q.turn})`;
  });

  let reqAns = "";
  await check(3, "S1: answer to the question and early return", async () => {
    const t0 = Date.now();
    const longP = call(A, "council_status", { sessionId: S1, waitSec: 40 });
    await sleep(500);
    const r = json(await call(A, "council_say", { sessionId: S1, text: `Таблицей, пожалуйста ${L_ANS}`, questionId: "q1" }), "council_say");
    must(typeof r.requestId === "string" && r.requestId !== "" && r.queued === true, `say answer: ${JSON.stringify(r)}`);
    reqAns = r.requestId;
    const s = json(await longP, "long status");
    const dt = Date.now() - t0;
    must(dt < 15000, `long request returned in ${dt} ms`);
    must(s.wait.changed === true, `wait.changed: ${s.wait.changed}`);
    must(!s.ownerQuestions.some((q: any) => q.id === "q1"), "q1 remained in ownerQuestions");
    const m = s.ownerMessages.find((x: any) => x.requestId === reqAns);
    must(m, `no ownerMessages entry with ${reqAns}: ${JSON.stringify(s.ownerMessages)}`);
    eq(m.answered, ["q1"], "answered");
    eq(s.turns, turnsBefore, "turns");
    must(of(S1, "owner_message").some((e) => e.requestId === reqAns), "the journal has no owner_message with this requestId");
    return `returned in ${dt} ms`;
  });

  await check(4, "S1: the next turn request sees the answer (expectPrompt in the scenario)", async () => {
    // Scenario s1-p2 requires "${L_ANS}" in the turn request as its first step (ScriptStep.expectPrompt); otherwise the turn ends with turn_failed.
    await until("completion of turn 2", () => of(S1, "turn_completed").length + of(S1, "turn_failed").length >= 2, 20000);
    const t2 = of(S1, "turn_started")[1]!;
    const done = evs(S1).find((e) => e.seq > t2.seq && (e.type === "turn_completed" || e.type === "turn_failed"))!;
    must(done.type === "turn_completed", `turn 2 completed as ${done.type}: ${JSON.stringify(done).slice(0, 200)}`);
  });

  let w2 = "";
  await check(5, "S1: pause after the round is preserved", async () => {
    let last: any = null;
    for (const t0 = Date.now(); Date.now() - t0 < 15000; await sleep(200)) {
      last = await status(A, S1);
      if (last.waiting?.reasons.includes("round_boundary")) break;
    }
    must(last.waiting?.reasons.includes("round_boundary"), `waiting: ${JSON.stringify(last.waiting)}`);
    w2 = last.waiting.waitId;
    must(last.waiting.questionIds.length === 0, `questionIds: ${last.waiting.questionIds}`);
    return `waitId ${w2}, reasons ${last.waiting.reasons}`;
  });

  await check(6, "S1: a regular message does not clear the wait", async () => {
    const r = json(await call(A, "council_say", { sessionId: S1, text: `Реплика ${L_SAY}` }), "council_say");
    must(r.requestId && r.queued === true && r.questionId === null, JSON.stringify(r));
    await until("message in ownerMessages", () => of(S1, "owner_message").some((e) => e.requestId === r.requestId));
    const s = await status(A, S1);
    const m = s.ownerMessages.find((x: any) => x.requestId === r.requestId);
    must(m, "the message is not in ownerMessages");
    eq(m.answered, [], "answered");
    must(s.waiting?.waitId === w2, `waitId changed: ${JSON.stringify(s.waiting)}`);
    must(!of(S1, "owner_wait_finished").some((e) => e.waitId === w2), "there is owner_wait_finished for the current wait");
  });

  // S3: the question is addressed to a participant, not to the owner
  const s3 = await startExec(topic, join(coreScen, "owner-questions/to-participant-p1.json"), join(coreScen, "owner-questions/to-participant-p2.json"), ["--max-rounds", "2"]);
  await until("S3: question q1 to a participant", () => of(s3.id, "turn_completed").length > 0);

  await check(7, "refusals without writing to the journal and the queue", async () => {
    const problems: string[] = [];
    const say = (args: Record<string, unknown>) => ({ sessionId: S1, ...args });
    await rejected(A, S1, "council_say", say({ text: "" }), "empty text", problems);
    await rejected(A, S1, "council_say", say({ text: "   \n\t " }), "whitespace-only text", problems);
    await rejected(A, S1, "council_say", say({ text: "ответ", questionId: "q1" }), "closed question q1", problems);
    await rejected(A, S1, "council_say", say({ text: "ответ", questionId: "q99" }), "unknown question q99", problems);
    await rejected(A, S1, "council_continue", { sessionId: S1, waitId: "w99" }, "stale waitId w99", problems);
    await rejected(A, S1, "council_continue", { sessionId: S1, waitId: "" }, "empty waitId", problems);
    await rejected(A, S1, "council_continue", { sessionId: S1, waitId: "   " }, "whitespace-only waitId", problems);
    const before = sessionIds().length;
    const r = await call(A, "council_say", { sessionId: "нет-такой-сессии", text: "x" });
    if (!r.isError) problems.push("unknown session: no isError");
    const r2 = await call(A, "council_continue", { sessionId: "нет-такой-сессии", waitId: "w1" });
    if (!r2.isError) problems.push("unknown session (continue): no isError");
    if (sessionIds().length !== before) problems.push("unknown session: the number of sessions changed");
    const q = await call(A, "council_say", { sessionId: s3.id, text: "ответ", questionId: "q1" });
    const open = (await status(A, s3.id)).ownerQuestions;
    if (!q.isError) problems.push(`question not to the owner: no isError (ownerQuestions S3: ${JSON.stringify(open)})`);
    if (of(s3.id, "owner_message").length !== 0) problems.push("question not to the owner: owner_message appeared");
    must(problems.length === 0, problems.join("; "));
    return "7 refusals on S1, unknown session, question to a participant on S3";
  });

  let turnsAtRelease = 0;
  await check(8, "S1: two simultaneous council_continue", async () => {
    const s = await status(A, S1);
    const waitId = s.waiting.waitId as string;
    turnsAtRelease = s.turns;
    const rs = await Promise.allSettled([call(A, "council_continue", { sessionId: S1, waitId }), call(A, "council_continue", { sessionId: S1, waitId })]);
    const okAns = rs.flatMap((x) => (x.status === "fulfilled" && !x.value.isError ? [JSON.parse(body(x.value))] : []));
    must(okAns.length >= 1 && okAns.every((a) => a.requestId), `none accepted: ${JSON.stringify(rs.map((x) => (x.status === "fulfilled" ? body(x.value).slice(0, 100) : String(x.reason))))}`);
    const fin = await until("owner_wait_finished", () => of(S1, "owner_wait_finished").find((e) => e.waitId === waitId));
    await sleep(1500);
    const all = of(S1, "owner_wait_finished").filter((e) => e.waitId === waitId);
    must(all.length === 1, `owner_wait_finished for ${waitId}: ${all.length}`);
    eq(fin.reason, "continued", "reason");
    return `accepted ${okAns.length} of 2, waitId ${waitId}`;
  });

  await check(9, "S1: the same executor continued to the result", async () => {
    let guard = 0;
    for (const t0 = Date.now(); Date.now() - t0 < 40000; await sleep(300)) {
      const st = readSession(home, S1)!;
      if (st.status !== "running") break;
      if (st.state.waiting && st.state.waiting.waitId !== w2 && guard++ < 3) await call(A, "council_continue", { sessionId: S1, waitId: st.state.waiting.waitId });
    }
    const st = readSession(home, S1)!;
    must(st.status === "consensus" || st.status === "no_consensus", `result not reached: ${st.status}`);
    must(st.state.turns.length > turnsAtRelease, `no new turns: was ${turnsAtRelease}, now ${st.state.turns.length}`);
    must(st.state.pid === s1.exec.child.pid, `state.pid ${st.state.pid} != executor pid ${s1.exec.child.pid}`);
    eq(of(S1, "session_resumed").length, 0, "session_resumed");
    eq(of(S1, "session_created").length, 1, "session_created");
    return `result ${st.status}, turns ${st.state.turns.length}, pid ${st.state.pid}`;
  });

  await check(10, "S1 finished: say and continue are refused without writing", async () => {
    await until("executor process finished", () => s1.exec.exited, 15000);
    const problems: string[] = [];
    await rejected(A, S1, "council_say", { sessionId: S1, text: "поздно" }, "say after the result", problems);
    await rejected(A, S1, "council_continue", { sessionId: S1, waitId: w2 }, "continue after the result", problems);
    must(problems.length === 0, problems.join("; "));
  });

  // S2: interrupted session
  const s2 = await startExec(topic, join(coreScen, "owner-wait/plain-p1.json"), join(coreScen, "owner-wait/plain-p2.json"), ["--max-rounds", "3", "--pause-after-round", "--owner-wait-sec", "120"]);
  const S2 = s2.id;
  await until("S2: wait", () => of(S2, "owner_wait_started")[0]);
  s2.exec.child.kill("SIGKILL");
  await until("S2: process finished", () => s2.exec.exited);
  await until("S2: interrupted", () => readSession(home, S2)!.status === "interrupted");
  let w2s2 = "";
  await check(11, "S2: an interrupted session returns waiting", async () => {
    const s = await status(A, S2);
    eq(s.status, "interrupted", "status");
    must(s.waiting !== null, "waiting: null");
    w2s2 = s.waiting.waitId;
  });
  await check(12, "S2: say and continue are refused without writing", async () => {
    const problems: string[] = [];
    await rejected(A, S2, "council_say", { sessionId: S2, text: "реплика" }, "say", problems);
    await rejected(A, S2, "council_continue", { sessionId: S2, waitId: w2s2 }, "continue", problems);
    must(problems.length === 0, problems.join("; "));
  });

  // launch through MCP
  const scen = (m: string) => ({ providerId: "scripted", model: m });
  let S13 = "";
  await check(13, "council_start without wait fields", async () => {
    const r = json(await call(A, "council_start", { topic, participants: [scen("consensus/p1.json"), scen("consensus/p2.json")], maxRounds: 3 }), "council_start");
    eq(r.ownerWait, null, "ownerWait");
    S13 = r.sessionId;
    let s: any;
    for (const t0 = Date.now(); Date.now() - t0 < 40000; ) { s = await status(A, S13, 10); if (s.status !== "running") break; }
    must(s.status === "consensus", `result: ${s.status}`);
    eq(evs(S13).filter((e) => e.type.startsWith("owner_wait_")).length, 0, "owner_wait_* events");
    eq([s.waiting, s.ownerQuestions, s.ownerMessages], [null, [], []], "waiting/ownerQuestions/ownerMessages");
  });

  await check(14, "council_start with ownerWaitSec: 0 is refused", async () => {
    const before = sessionIds().length;
    const r = await call(A, "council_start", { topic, participants: [scen("consensus/p1.json"), scen("consensus/p2.json")], pauseAfterRound: true, ownerWaitSec: 0 });
    must(r.isError, `no isError: ${body(r).slice(0, 150)}`);
    eq(sessionIds().length, before, "number of sessions");
  });

  await check(15, "council_start with a short deadline: the wait expires by itself", async () => {
    const r = json(await call(A, "council_start", { topic, participants: [scen("owner-wait/plain-p1.json"), scen("owner-wait/plain-p2.json")], maxRounds: 3, pauseAfterRound: true, ownerWaitSec: 3 }), "council_start");
    eq(r.ownerWait, { pauseAfterRound: true, waitForOwner: false, timeoutSec: 3 }, "ownerWait");
    const id = r.sessionId as string;
    let seen = false;
    for (const t0 = Date.now(); Date.now() - t0 < 20000 && !seen; ) { const s = await status(A, id, 1); seen = s.waiting !== null; if (s.status !== "running") break; }
    must(seen, "waiting did not appear in council_status");
    let s: any;
    for (const t0 = Date.now(); Date.now() - t0 < 40000; ) { s = await status(A, id, 10); if (s.status !== "running") break; }
    must(s.status === "consensus" || s.status === "no_consensus", `result not reached: ${s.status}`);
    const fin = of(id, "owner_wait_finished");
    must(fin.length >= 1 && fin[0]!.reason === "expired", `owner_wait_finished: ${JSON.stringify(fin.map((e) => e.reason))}`);
    return `result ${s.status}, clearing reasons ${fin.map((e) => e.reason)}`;
  });

  await check(16, "the owner's choice does not break council_status", async () => {
    const before = await status(A, S13);
    const sel = selectOwnerVersion(home, S13, { version: 1 });
    const after = await status(A, S13);
    eq(after.ownerSelection?.version, 1, "ownerSelection.version");
    eq([after.status, after.waiting, after.ownerQuestions], [before.status, null, []], "status/waiting/ownerQuestions");
    return `version 1 chosen (${sel.ts})`;
  });

  // 17: participant's server
  const s4 = await startExec(topic, join(coreScen, "owner-wait/plain-p1.json"), join(coreScen, "owner-wait/plain-p2.json"), ["--max-rounds", "3", "--pause-after-round", "--owner-wait-sec", "120"]);
  const S4 = s4.id;
  const w4 = (await until("S4: wait", () => of(S4, "owner_wait_started")[0])).waitId as string;
  const P = await connect({ COUNCIL_PARTICIPANT: "1" });
  await check(17, "participant's server (COUNCIL_PARTICIPANT=1): say, continue, start are forbidden", async () => {
    const problems: string[] = [];
    const sessions0 = sessionIds().length;
    for (const [id, label] of [[S4, "live S4"], [S1, "finished S1"]] as const) {
      await rejected(P, id, "council_say", { sessionId: id, text: "x" }, `say ${label}`, problems);
      await rejected(P, id, "council_continue", { sessionId: id, waitId: id === S4 ? w4 : w2 }, `continue ${label}`, problems);
    }
    const r = await call(P, "council_start", { topic, participants: [scen("consensus/p1.json"), scen("consensus/p2.json")] });
    if (!r.isError) problems.push("start: no isError");
    if (sessionIds().length !== sessions0) problems.push("start: the number of sessions changed");
    must(problems.length === 0, problems.join("; "));
  });

  // 18: secrecy
  await check(18, "logs/app.log without labels, key and question texts", async () => {
    const lines = readFileSync(join(home, "logs/app.log"), "utf8").split("\n").filter(Boolean);
    const bad: string[] = [];
    for (const needle of [L_SAY, L_ANS, L_KEY, qText].filter(Boolean)) {
      for (const l of lines) if (l.includes(needle)) bad.push(`"${needle.slice(0, 30)}" in component ${/\[([^\]]+)\]/.exec(l)?.[1] ?? "?"}`);
    }
    must(bad.length === 0, bad.join("; "));
    return `log lines ${lines.length}, labels checked ${[L_SAY, L_ANS, L_KEY, qText].length}`;
  });

  // 19: stdout and shutdown on input close
  await check(19, "servers' stdout is protocol only, shutdown on input close", async () => {
    const errs = servers.flatMap((s) => s.errors);
    must(errs.length === 0, `SDK client errors: ${errs.join("; ")}`);
    const pids = servers.map((s) => s.pid);
    for (const s of servers) await s.client.close();
    await sleep(500);
    const alive = pids.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
    must(alive.length === 0, `servers alive: ${alive}`);
    const log = readFileSync(join(home, "logs/app.log"), "utf8");
    const byStdin = (log.match(/MCP server is stopping: stdin closed/g) ?? []).length;
    const bySignal = (log.match(/MCP server is stopping: SIG/g) ?? []).length;
    must(byStdin >= servers.length && bySignal === 0, `shutdowns by stdin in the log ${byStdin} (need ${servers.length}), by signal ${bySignal}`);
    return `servers ${servers.length}, shutdowns by stdin ${byStdin}`;
  });
}

const t0 = Date.now();
try {
  await main();
} catch (e) {
  console.log(`STAND FAILURE: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  for (const s of servers) { try { process.kill(s.pid, "SIGKILL"); } catch { /* already finished */ } }
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* already finished */ } }
  console.log(`\nResult: ${passed} of ${total}`);
  console.log(`Stand: ${home} (${Math.round((Date.now() - t0) / 1000)} s)`);
}
process.exit(passed === total && total === 19 ? 0 : 1);
