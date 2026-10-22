// Live check of council_resume: the server is a child process over stdio, like a real agent's, the source sessions are
// created by a separate `council` process. Participants are scripted only, 0 real model calls.
//   COUNCIL_DEV=1 COUNCIL_HOME=<folder> node packages/mcp/scenarios/resume/check.ts
// Writes only to COUNCIL_HOME (including scenario files in scen/) and does not delete it (this is the evidence of the check).
import "../../../core/scenarios/language-ru.ts";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { eventsPath, materialPath, ownerMessagesDir, readEvents, readSession, resumeLockPath } from "@model-council/core";

if (process.env.COUNCIL_DEV !== "1" || !process.env.COUNCIL_HOME?.trim()) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME are required. Run: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node packages/mcp/scenarios/resume/check.ts");
  process.exit(2);
}
const home = resolve(process.env.COUNCIL_HOME);
mkdirSync(join(home, "scen"), { recursive: true });
mkdirSync(join(home, "inputs"), { recursive: true });

const here = import.meta.dirname;
const root = join(here, "../../../..");
const mainTs = join(root, "packages/mcp/src/main.ts");
const councilTs = join(root, "packages/core/src/council.ts");

const L_SAY = "МЕТКА-РЕПЛИКА-37a", L_KEY = "МЕТКА-КЛЮЧ-37c", L_MSG = "МЕТКА-ДОВОД-171";
const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_HOME: home, COUNCIL_DEV: "1", COUNCIL_FAKE_KEY: L_KEY };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const TOPIC = "Как назвать кота";

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

async function until<T>(what: string, fn: () => T | undefined | false | null, ms = 15000): Promise<T> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(60)) {
    let r: T | undefined | false | null;
    try { r = fn(); } catch { r = undefined; }
    if (r) return r;
  }
  throw new Error(`timed out waiting for: ${what}`);
}

// ---- scenarios: one file per participant and session, paths are absolute ----
const resp = (stance: string, solution: string | null) => ({ stance, reasoning: "Довод.", solution, answers: [], questions: [] });
interface ScenOpts { agreeFrom?: number; delays?: Record<number, number>; tokens?: boolean; error0?: boolean }
// Steps before agreeFrom are amend with their own version (no agreement), then agree: for the first participant this gives agreement in round 3.
function scenFile(tag: string, who: "p1" | "p2", o: ScenOpts): string {
  const steps = Array.from({ length: 10 }, (_, i) => ({
    ...(o.error0 && i === 0 ? { error: "Сценарный сбой участника", retryable: false } : { response: i < (o.agreeFrom ?? 2) ? resp("amend", `Версия ${who}-${i}`) : resp("agree", null) }),
    ...(o.tokens ? { inputTokens: 100, outputTokens: 50 } : {}),
    ...(o.delays?.[i] ? { delayMs: o.delays[i] } : {}),
  }));
  const p = join(home, "scen", `${tag}-${who}.json`);
  writeFileSync(p, JSON.stringify({ steps }));
  return p;
}
interface Spec { flags?: string[]; p1?: ScenOpts; p2?: ScenOpts; rounds?: number }
async function startExec(tag: string, spec: Spec = {}): Promise<{ id: string; exec: Exec; p1: string; p2: string }> {
  const p1 = scenFile(tag, "p1", spec.p1 ?? {}), p2 = scenFile(tag, "p2", spec.p2 ?? spec.p1 ?? {});
  const exec = executor(["--topic", TOPIC, "--participant", `scripted:${p1}`, "--participant", `scripted:${p2}`, "--max-rounds", String(spec.rounds ?? 1), ...(spec.flags ?? [])]);
  const id = await until(`${tag}: session id in the executor output`, () => /^Сессия (\S+) ·/m.exec(exec.out)?.[1]);
  return { id, exec, p1, p2 };
}
/** A source session brought to the end by the executor. */
async function finished(tag: string, spec: Spec = {}) {
  const s = await startExec(tag, spec);
  await until(`${tag}: executor finished`, () => s.exec.exited, 30000);
  return s;
}

// ---- MCP ----
type Res = { isError?: boolean; content: { type: string; text: string }[] };
interface Srv { client: Client; transport: StdioClientTransport; pid: number; errors: string[] }
const servers: Srv[] = [];
async function connect(extraEnv: Record<string, string> = {}): Promise<Srv> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mainTs], cwd: root, stderr: "ignore", env: { ...baseEnv, ...extraEnv } });
  const client = new Client({ name: "resume-check", version: "0" });
  const errors: string[] = [];
  client.onerror = (e) => errors.push(`client: ${e.message}`);
  transport.onerror = (e) => errors.push(`transport: ${e.message}`);
  await client.connect(transport);
  const s = { client, transport, pid: transport.pid!, errors };
  servers.push(s);
  return s;
}
const tokens = new Set<string>();
const call = async (s: Srv, name: string, args: Record<string, unknown> = {}) => {
  const r = (await s.client.callTool({ name, arguments: args })) as Res;
  const m = /"planToken":\s*"([0-9a-f]{64})"/.exec(r.content[0]?.text ?? "");
  if (m) tokens.add(m[1]!);
  return r;
};
const body = (r: Res) => r.content[0]?.text ?? "";
const json = (r: Res, what: string) => { if (r.isError) throw new Error(`${what}: tool error: ${body(r)}`); return JSON.parse(body(r)); };
const status = async (s: Srv, sessionId: string, waitSec?: number) => json(await call(s, "council_status", { sessionId, ...(waitSec === undefined ? {} : { waitSec }) }), "council_status");
const plan = async (s: Srv, sessionId: string, extra: Record<string, unknown> = {}) => json(await call(s, "council_resume", { sessionId, ...extra }), "council_resume (plan)");
/** Waits until council_status stops being "running"; returns the last response. */
async function statusUntilDone(s: Srv, id: string, ms = 40000) {
  let st: any;
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) { st = await status(s, id, 5); if (st.status !== "running") return st; }
  throw new Error(`timed out waiting for the result of session ${id}: ${st?.status}`);
}

// ---- journal ----
type Ev = Record<string, any> & { seq: number; type: string };
const evs = (id: string): Ev[] => readEvents(home, id)!.events as unknown as Ev[];
const of = (id: string, type: string) => evs(id).filter((e) => e.type === type);
const bytes = (id: string) => readFileSync(eventsPath(home, id));
const same = (a: Buffer, b: Buffer) => a.length === b.length && a.equals(b);
const sessionIds = () => (existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")) : []);
const stat = (id: string) => readSession(home, id)!.status;
// Resume executors are detached (change 184): they outlive the server. Pids are only read from this stand's resume.lock files.
const executorPids = new Set<number>();
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lockPid = async (id: string) => {
  const pid = await until(`${id}: executor pid in resume.lock`, () => Number(readFileSync(resumeLockPath(home, id), "utf8").trim()) || false);
  executorPids.add(pid);
  return pid;
};
async function stopAndWait(srv: Srv, id: string, pid: number) {
  await call(srv, "council_stop", { sessionId: id });
  await until(`${id}: stopped`, () => stat(id) === "stopped", 20000);
  await until(`${id}: executor ${pid} gone`, () => !alive(pid), 20000);
}

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

/** A council_resume refusal with the given code: the journal and the lock state did not change. */
async function refused(srv: Srv, id: string, args: Record<string, unknown>, code: string): Promise<string> {
  const before = bytes(id);
  const lockBefore = existsSync(resumeLockPath(home, id)); // a running session holds its own executor lock
  const r = await call(srv, "council_resume", { sessionId: id, ...args });
  must(r.isError, `no isError, response: ${body(r).slice(0, 150)}`);
  must(body(r).startsWith(`${code}:`), `expected code ${code}:, got: ${body(r).slice(0, 150)}`);
  must(same(before, bytes(id)), "journal bytes changed");
  must(existsSync(resumeLockPath(home, id)) === lockBefore, lockBefore ? "resume.lock disappeared" : "resume.lock remained");
  return body(r);
}

async function main() {
  const A = await connect();

  // ---- preparing source sessions (`council` executors are separate processes, in parallel) ----
  // The first launch in a new folder creates config.json: we do it once so that parallel executors do not race.
  const init = executor(["list"]);
  await until("data folder initialization", () => init.exited, 30000);
  const slow = { p1: { delays: { 1: 800, 2: 800 } } } satisfies Spec;
  const [C, E, X, CONS, FAIL, COR, MAT, PART, CAP, G, K1, K2] = await Promise.all([
    finished("c", slow), finished("e", { p1: { delays: { 1: 1500, 2: 1500 } } }), finished("x"), finished("cons", { p1: {}, p2: { agreeFrom: 0 }, rounds: 3 }),
    finished("fail", { p2: { error0: true }, p1: {}, rounds: 3 }), finished("cor"),
    (() => { writeFileSync(join(home, "inputs/note.txt"), "Заметка: кот рыжий."); return finished("mat", { flags: ["--attach", join(home, "inputs/note.txt")] }); })(),
    finished("part"), finished("cap", { p1: { tokens: true }, rounds: 3, flags: ["--max-tokens", "250"] }),
    finished("g", { p1: { agreeFrom: 9 } }), finished("k1", { p1: { delays: { 1: 6000 } }, rounds: 1 }), finished("k2", { p1: {}, p2: { delays: { 1: 6000 } } }),
  ]);
  const R = await startExec("run", { flags: ["--pause-after-round", "--owner-wait-sec", "600"], rounds: 3 });
  await until("R: owner wait (session is running)", () => of(R.id, "owner_wait_started")[0]);

  // 1
  await check(1, "A. list: exactly seven tools, including council_resume", async () => {
    const names = (await A.client.listTools()).tools.map((t) => t.name).sort();
    eq(names, ["council_continue", "council_options", "council_resume", "council_say", "council_start", "council_status", "council_stop"], "tools/list");
  });

  // 2
  await check(2, "B. the source session of two scripted participants reaches no_consensus", async () => {
    eq(stat(C.id), "no_consensus", "status of C");
    const created = of(C.id, "session_created")[0]!;
    eq(created.session.participants.map((p: any) => p.model), [C.p1, C.p2], "participants' model (absolute paths)");
    must(C.p1.startsWith("/"), "the scenario path is not absolute");
    return `session ${C.id}`;
  });

  // 3
  let planC: any;
  await check(3, "C. plan rounds=2: maxCalls 12, token, roster, journal untouched, no lock", async () => {
    const before = bytes(C.id);
    planC = await plan(A, C.id, { rounds: 2 });
    eq([planC.mode, planC.accepted, planC.sessionId, planC.status, planC.source], ["plan", false, C.id, "no_consensus", "cli"], "mode/accepted/sessionId/status/source");
    eq([planC.maxCalls, planC.addedRounds, planC.maxRounds], [12, 2, 3], "maxCalls/addedRounds/maxRounds");
    must(/^[0-9a-f]{64}$/.test(planC.planToken), `planToken: ${planC.planToken}`);
    const orig = of(C.id, "session_created")[0]!.session.participants;
    eq(planC.participants.map((p: any) => [p.id, p.model, p.billing, p.providerId]), orig.map((p: any) => [p.id, p.model, "free", "scripted"]), "participants");
    eq(planC.requiresConsent, false, "requiresConsent");
    eq(planC.waiting, null, "waiting");
    must(same(before, bytes(C.id)), "the journal changed after the plan");
    must(!existsSync(resumeLockPath(home, C.id)), "resume.lock appeared");
    return `token ${planC.planToken.slice(0, 8)}…`;
  });

  // 4
  await check(4, "D. execute: accepted before the result, the result through council_status, one session_resumed, the previous journal is a prefix", async () => {
    const before = bytes(C.id);
    const r = json(await call(A, "council_resume", { sessionId: C.id, rounds: 2, execute: true, planToken: planC.planToken }), "execute");
    eq([r.mode, r.accepted, r.sessionId, r.source], ["execute", true, C.id, "cli"], "mode/accepted/sessionId/source");
    eq(r.droppedOwnerRequests, [], "droppedOwnerRequests");
    eq(of(C.id, "session_finished").length, 1, "session_finished at the moment of the response");
    const st = await statusUntilDone(A, C.id);
    eq(st.status, "consensus", "result by the scenario");
    eq(st.turns, 5, "turns");
    eq(of(C.id, "session_resumed").length, 1, "session_resumed");
    const after = bytes(C.id);
    must(after.length > before.length && after.subarray(0, before.length).equals(before), "the previous journal bytes are not a prefix of the new file");
    must(!existsSync(resumeLockPath(home, C.id)), "resume.lock remained after the result");
    return `result ${st.status}, turns ${st.turns}`;
  });

  // 5
  await check(5, "E. two servers on one folder, one token: one accepted, the second busy/running", async () => {
    const B2 = await connect();
    const pl = await plan(A, E.id, { rounds: 2 });
    const rs = await Promise.all([call(A, "council_resume", { sessionId: E.id, rounds: 2, execute: true, planToken: pl.planToken }), call(B2, "council_resume", { sessionId: E.id, rounds: 2, execute: true, planToken: pl.planToken })]);
    const ok = rs.filter((r) => !r.isError && JSON.parse(body(r)).accepted === true);
    const bad = rs.filter((r) => r.isError);
    must(ok.length === 1 && bad.length === 1, `accepted ${ok.length}, refusals ${bad.length}: ${rs.map((r) => body(r).slice(0, 80))}`);
    must(/^(busy|running):/.test(body(bad[0]!)), `refusal code: ${body(bad[0]!).slice(0, 100)}`);
    eq(of(E.id, "session_resumed").length, 1, "session_resumed");
    await statusUntilDone(A, E.id);
    return `refusal: ${body(bad[0]!).split(":")[0]}`;
  });

  // 6
  await check(6, "F. unknown session: \"не найдена\", no sessions added", async () => {
    const n = sessionIds().length;
    const r = await call(A, "council_resume", { sessionId: "нет-такой-сессии", rounds: 1 });
    must(r.isError && body(r).includes("не найдена"), `response: ${body(r).slice(0, 120)}`);
    eq(sessionIds().length, n, "number of sessions");
  });

  // 7
  await check(7, "F. running session: running:", async () => {
    await refused(A, R.id, { rounds: 1 }, "running");
  });

  // 8
  await check(8, "F. session with agreement: consensus:", async () => {
    eq(stat(CONS.id), "consensus", "status");
    await refused(A, CONS.id, { rounds: 1 }, "consensus");
  });

  // 9
  await check(9, "F. failure \"fewer than two active\" without replacement: too_few_active: with the name of the dropped one", async () => {
    eq(stat(FAIL.id), "failed", "status");
    const t = await refused(A, FAIL.id, { rounds: 1 }, "too_few_active");
    must(t.includes("p2"), `no dropped p2: ${t}`);
  });

  // 10
  await check(10, "F. corrupted journal (a cut-off line): corrupted:", async () => {
    appendFileSync(eventsPath(home, COR.id), '{"seq":99,"type":"turn_sta');
    await refused(A, COR.id, { rounds: 1 }, "corrupted");
  });

  // 11
  await check(11, "F. replaced material snapshot: material:", async () => {
    const m = of(MAT.id, "session_created")[0]!.session.materials[0].id as string;
    writeFileSync(materialPath(home, MAT.id, m), "подмена");
    await refused(A, MAT.id, { rounds: 1 }, "material");
  });

  // 12
  await check(12, "F. the participant's scenario file is renamed: participant: with the identifier", async () => {
    renameSync(PART.p1, `${PART.p1}.moved`);
    const t = await refused(A, PART.id, { rounds: 1 }, "participant");
    must(t.includes("p1"), `no identifier p1: ${t}`);
    await refused(A, PART.id, { rounds: 1, execute: true, planToken: "0".repeat(64) }, "stale_plan");
  });

  // 13
  await check(13, "F. server without COUNCIL_DEV: participant:", async () => {
    const N = await connect({ COUNCIL_DEV: "" });
    await refused(N, X.id, { rounds: 1 }, "participant");
  });

  // 14
  await check(14, "F. exhausted token cap: token_cap:, then maxTotalTokens=null is accepted", async () => {
    eq(stat(CAP.id), "stopped", "initial status");
    await refused(A, CAP.id, {}, "token_cap");
    await refused(A, CAP.id, { maxTotalTokens: 100 }, "token_cap");
    const pl = await plan(A, CAP.id, { maxTotalTokens: null });
    eq(pl.maxTotalTokens, null, "maxTotalTokens in the plan");
    const r = json(await call(A, "council_resume", { sessionId: CAP.id, maxTotalTokens: null, execute: true, planToken: pl.planToken }), "execute");
    eq(r.accepted, true, "accepted");
    const st = await statusUntilDone(A, CAP.id);
    eq(st.maxTotalTokens, null, "maxTotalTokens in council_status");
    return `result ${st.status}`;
  });

  // 15
  await check(15, "F. execute without planToken: plan_required:", async () => {
    await refused(A, X.id, { rounds: 1, execute: true }, "plan_required");
  });

  // 16
  await check(16, "F. rounds 0 and 21: bad_rounds:", async () => {
    await refused(A, X.id, { rounds: 0 }, "bad_rounds");
    await refused(A, X.id, { rounds: 21 }, "bad_rounds");
  });

  // 17
  await check(17, "F. participant's server (COUNCIL_PARTICIPANT=1): refusal of both the plan and the launch", async () => {
    const P = await connect({ COUNCIL_PARTICIPANT: "1" });
    for (const args of [{ rounds: 1 }, { rounds: 1, execute: true, planToken: "0".repeat(64) }]) {
      const before = bytes(X.id);
      const r = await call(P, "council_resume", { sessionId: X.id, ...args });
      must(r.isError && body(r) === "Участник обсуждения не может продолжать обсуждение.", `response: ${body(r).slice(0, 120)}`);
      must(same(before, bytes(X.id)) && !existsSync(resumeLockPath(home, X.id)), "the journal or the lock changed");
    }
  });

  // 18
  await check(18, "G. stale plan: stale_plan:, journal untouched, the new plan has a different token", async () => {
    const pl = await plan(A, G.id, { rounds: 1 });
    const x = executor(["resume", G.id, "--rounds", "1"]);
    await until("G: resume executor finished", () => x.exited, 30000);
    eq(stat(G.id), "no_consensus", "status after resume");
    const t = await refused(A, G.id, { rounds: 1, execute: true, planToken: pl.planToken }, "stale_plan");
    const pl2 = await plan(A, G.id, { rounds: 1 });
    must(pl2.planToken !== pl.planToken, "the new plan returned the same token");
    return t.slice(0, 40);
  });

  // 19
  await check(19, "H. the wait did not expire: expired=false, no turns until council_continue, then the result", async () => {
    const H = await startExec("h", { flags: ["--pause-after-round", "--owner-wait-sec", "600"], rounds: 3 });
    await until("H: wait", () => of(H.id, "owner_wait_started")[0]);
    H.exec.child.kill("SIGKILL");
    await until("H: interrupted", () => stat(H.id) === "interrupted");
    eq(readSession(home, H.id)!.state.waiting !== null, true, "waiting preserved");
    const pl = await plan(A, H.id, { rounds: 1 });
    eq(pl.waiting?.expired, false, "waiting.expired");
    const r = json(await call(A, "council_resume", { sessionId: H.id, rounds: 1, execute: true, planToken: pl.planToken }), "execute");
    eq(r.accepted, true, "accepted");
    const turns = of(H.id, "turn_started").length;
    await sleep(2500);
    eq(of(H.id, "turn_started").length, turns, "new turns during 2.5 s of waiting");
    const st = await status(A, H.id);
    must(st.waiting, "waiting disappeared without continue");
    json(await call(A, "council_continue", { sessionId: H.id, waitId: st.waiting.waitId }), "council_continue");
    const fin = await statusUntilDone(A, H.id);
    must(fin.status === "consensus" || fin.status === "no_consensus", `result: ${fin.status}`);
    must(of(H.id, "turn_started").length > turns, "no new turns");
    return `waitId ${st.waiting.waitId}, result ${fin.status}`;
  });

  // 20
  await check(20, "I. the deadline expired: expired=true, owner_wait_finished(expired) before the first new turn", async () => {
    const I = await startExec("i", { flags: ["--pause-after-round", "--owner-wait-sec", "2"], rounds: 3 });
    await until("I: wait", () => of(I.id, "owner_wait_started")[0]);
    I.exec.child.kill("SIGKILL");
    await until("I: interrupted", () => stat(I.id) === "interrupted");
    let planI: any;
    for (const t0 = Date.now(); Date.now() - t0 < 15000; await sleep(300)) { planI = await plan(A, I.id, { rounds: 1 }); if (planI.waiting?.expired === true) break; }
    eq(planI.waiting?.expired, true, "waiting.expired");
    json(await call(A, "council_resume", { sessionId: I.id, rounds: 1, execute: true, planToken: planI.planToken }), "execute");
    await statusUntilDone(A, I.id);
    const e = evs(I.id);
    const resumed = e.find((x) => x.type === "session_resumed")!;
    const fin = e.find((x) => x.type === "owner_wait_finished" && x.reason === "expired" && x.seq > resumed.seq);
    const firstTurn = e.find((x) => x.type === "turn_started" && x.seq > resumed.seq);
    must(fin, "no owner_wait_finished with reason expired after session_resumed");
    must(firstTurn && fin.seq < firstTurn.seq, `order: end of the wait seq ${fin.seq}, first turn seq ${firstTurn?.seq}`);
    return `seq ${fin.seq} < ${firstTurn.seq}`;
  });

  // 21
  await check(21, "J. an unapplied owner message is returned in droppedOwnerRequests with its text", async () => {
    const J = await startExec("j", { p1: { delays: { 1: 3000 } }, rounds: 3 });
    await until("J: the third turn started", () => of(J.id, "turn_started").length >= 3);
    process.kill(J.exec.child.pid!, "SIGSTOP");
    let say: Exec;
    try {
      say = executor(["say", J.id, `Реплика ${L_SAY}`]);
      await until("J: say finished", () => say.exited);
      must(say.out.includes("запрошена"), `say output: ${say.out}${say.err}`);
      await until("J: message in the queue", () => (readdirSync(ownerMessagesDir(home, J.id)).length > 0));
    } finally {
      J.exec.child.kill("SIGKILL");
    }
    await until("J: interrupted", () => stat(J.id) === "interrupted");
    eq(of(J.id, "owner_message").length, 0, "the message was not applied");
    const pl = await plan(A, J.id);
    const r = json(await call(A, "council_resume", { sessionId: J.id, execute: true, planToken: pl.planToken }), "execute");
    eq(r.droppedOwnerRequests.length, 1, "number of returned messages");
    const d = r.droppedOwnerRequests[0];
    must(d.text.includes(L_SAY) && typeof d.requestId === "string" && d.questionId === null, JSON.stringify(d));
    await call(A, "council_stop", { sessionId: J.id });
    return `requestId ${d.requestId}`;
  });

  // 22
  await check(22, "K. council_stop on a resumed running session: stopped", async () => {
    const pl = await plan(A, K1.id, { rounds: 1 });
    json(await call(A, "council_resume", { sessionId: K1.id, rounds: 1, execute: true, planToken: pl.planToken }), "execute");
    await until("K1: the resumed turn started", () => of(K1.id, "turn_started").length >= 3);
    await call(A, "council_stop", { sessionId: K1.id });
    await until("K1: stopped", () => stat(K1.id) === "stopped", 20000);
    eq((await status(A, K1.id)).status, "stopped", "council_status");
  });

  // 23
  await check(23, "K. the server shut down normally (stdin closed) during a resumed turn: the detached executor survives, running, turns preserved, one session_resumed, then stopped", async () => {
    const S = await connect();
    const pl = await plan(S, K2.id, { rounds: 1 });
    json(await call(S, "council_resume", { sessionId: K2.id, rounds: 1, execute: true, planToken: pl.planToken }), "execute");
    const pid = await lockPid(K2.id);
    try {
      await until("K2: turn 3 completed, turn 4 in progress", () => of(K2.id, "turn_completed").length >= 3 && of(K2.id, "turn_started").length >= 4);
      const completed = of(K2.id, "turn_completed").length;
      await S.client.close();
      await until("K2: server process finished", () => !alive(S.pid), 20000);
      must(pid !== S.pid && alive(pid), `executor ${pid} is not alive or equals the server pid ${S.pid}`);
      eq(stat(K2.id), "running", "status after the server exit");
      must(of(K2.id, "turn_completed").length >= completed, "completed turns disappeared");
      eq(of(K2.id, "session_resumed").length, 1, "session_resumed");
      const st = await status(A, K2.id);
      eq(st.status, "running", "council_status");
      await stopAndWait(A, K2.id, pid);
      return `completed turns ${completed}, executor ${pid}`;
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  // 24
  await check(24, "K. the server shut down normally during a resumed owner wait: the detached executor survives, running, waiting and the deadline preserved, then stopped", async () => {
    const W = await startExec("w", { flags: ["--pause-after-round", "--owner-wait-sec", "600"], rounds: 3 });
    await until("W: wait", () => of(W.id, "owner_wait_started")[0]);
    W.exec.child.kill("SIGKILL");
    await until("W: interrupted", () => stat(W.id) === "interrupted");
    const w0 = readSession(home, W.id)!.state.waiting!;
    const S2 = await connect();
    const pl = await plan(S2, W.id, { rounds: 1 });
    eq(pl.waiting?.expired, false, "waiting.expired");
    const turns = of(W.id, "turn_started").length;
    json(await call(S2, "council_resume", { sessionId: W.id, rounds: 1, execute: true, planToken: pl.planToken }), "execute");
    const pid = await lockPid(W.id);
    try {
      await S2.client.close();
      await until("W: server process finished", () => !alive(S2.pid), 20000);
      must(pid !== S2.pid && alive(pid), `executor ${pid} is not alive or equals the server pid ${S2.pid}`);
      eq(stat(W.id), "running", "status after the server exit");
      const w1 = readSession(home, W.id)!.state.waiting;
      must(w1, "waiting lost");
      eq([w1.waitId, w1.deadline], [w0.waitId, w0.deadline], "waitId and deadline");
      eq(of(W.id, "turn_started").length, turns, "turn_started");
      eq(of(W.id, "session_resumed").length, 1, "session_resumed");
      await stopAndWait(A, W.id, pid);
      return `waitId ${w0.waitId}, executor ${pid}`;
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  // 25
  await check(25, "M. consensus session with the owner's message: refusal without it, plan resets agreements, other text is stale_plan, owner_message right after session_resumed", async () => {
    const msg = `Учти бюджет ${L_MSG}`;
    await refused(A, CONS.id, { rounds: 1 }, "consensus");
    await refused(A, CONS.id, { rounds: 1, message: "   " }, "consensus");
    const lastTurn = of(CONS.id, "turn_completed").length;
    const pl = await plan(A, CONS.id, { rounds: 1, message: msg });
    eq([pl.status, pl.agreementReset, pl.mode], ["consensus", true, "plan"], "plan");
    await refused(A, CONS.id, { rounds: 1, message: "Другой текст", execute: true, planToken: pl.planToken }, "stale_plan");
    const r = json(await call(A, "council_resume", { sessionId: CONS.id, rounds: 1, message: msg, execute: true, planToken: pl.planToken }), "execute");
    eq(r.accepted, true, "accepted");
    const all = evs(CONS.id);
    const i = all.findIndex((e) => e.type === "session_resumed");
    must(i >= 0 && all[i + 1]?.type === "owner_message" && all[i + 1]!.text === msg, `event after session_resumed: ${JSON.stringify(all[i + 1])?.slice(0, 120)}`);
    const st0 = await status(A, CONS.id);
    eq(st0.ownerMessages.at(-1)?.afterTurn, lastTurn, "afterTurn of the new owner message");
    const done = await statusUntilDone(A, CONS.id);
    must(["consensus", "no_consensus", "stopped", "failed", "interrupted"].includes(done.status), `final status: ${done.status}`);
    return `final ${done.status}, afterTurn ${lastTurn}`;
  });

  // 26
  await check(26, "L. logs/: no message text, no planToken, no key", async () => {
    const dir = join(home, "logs");
    const files = readdirSync(dir);
    must(files.length > 0, "logs/ is empty");
    const bad: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      for (const n of [L_SAY, L_KEY, L_MSG, ...tokens]) if (text.includes(n)) bad.push(`${f}: «${n.slice(0, 20)}»`);
    }
    must(bad.length === 0, bad.join("; "));
    return `files ${files.length}, tokens checked ${tokens.size}`;
  });
}

const EXPECTED = 26;
const t0 = Date.now();
try {
  await main();
} catch (e) {
  console.log(`STAND FAILURE: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  for (const s of servers) { try { process.kill(s.pid, "SIGKILL"); } catch { /* already finished */ } }
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* already finished */ } }
  for (const p of executorPids) { try { process.kill(p, "SIGKILL"); } catch { /* already finished */ } }
  console.log(`\nResult: ${passed} of ${total}`);
  console.log(`Stand: ${home} (${Math.round((Date.now() - t0) / 1000)} s)`);
}
process.exit(passed === total && total === EXPECTED ? 0 : 1);
