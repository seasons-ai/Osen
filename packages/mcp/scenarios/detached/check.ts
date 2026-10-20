// Live check of changes 138 and 184: council_start and council_resume run the session in a detached executor that outlives the MCP server.
// The server is a real child process over stdio; control goes through the `council` CLI. Scripted participants only, 0 model calls.
//   COUNCIL_DEV=1 COUNCIL_HOME=<new folder inside the project> node packages/mcp/scenarios/detached/check.ts
// Writes only to COUNCIL_HOME and does not delete it (this is the evidence of the check).
import "../../../core/scenarios/language-ru.ts";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLogger, eventsPath, launchDir, listSessions, readEvents, readSession, requestStop, resumeLockPath, writeLaunchFile } from "@model-council/core";
import { createServer } from "../../src/server.ts";
import type { ToolContext } from "../../src/context.ts";

if (process.env.COUNCIL_DEV !== "1" || !process.env.COUNCIL_HOME?.trim()) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME are required. Run: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node packages/mcp/scenarios/detached/check.ts");
  process.exit(2);
}
const home = resolve(process.env.COUNCIL_HOME);
mkdirSync(join(home, "scen"), { recursive: true });

const root = join(import.meta.dirname, "../../../..");
const mainTs = join(root, "packages/mcp/src/main.ts");
const councilTs = join(root, "packages/core/src/council.ts");
const scenariosDir = join(root, "packages/core/scenarios");
const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_HOME: home, COUNCIL_DEV: "1" };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let failed = 0;
const ok = (text: string) => console.log(`OK ${text}`);
const fail = (text: string) => { failed++; console.log(`FAIL ${text}`); };
const check = (cond: unknown, text: string, detail = "") => (cond ? ok(text) : fail(`${text}${detail ? ` (${detail})` : ""}`));

async function until<T>(what: string, fn: () => T | undefined | false | null, ms = 15000): Promise<T> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(80)) {
    let r: T | undefined | false | null;
    try { r = fn(); } catch { r = undefined; }
    if (r) return r;
  }
  throw new Error(`timed out waiting for: ${what}`);
}

// ---- processes ----
const kids = new Set<ChildProcess>();
/** Synchronous `council` CLI call (stdin closed). */
function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [councilTs, ...args], { env: baseEnv, cwd: root, encoding: "utf8", input: "", timeout: 30000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr };
}
interface Srv { client: Client; transport: StdioClientTransport; pid: number }
const servers: Srv[] = [];
async function connect(): Promise<Srv> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mainTs], cwd: root, stderr: "ignore", env: baseEnv });
  const client = new Client({ name: "detached-check", version: "0" });
  await client.connect(transport);
  const pid = transport.pid!;
  const s: Srv = { client, transport, pid };
  servers.push(s);
  return s;
}
type Res = { isError?: boolean; content: { type: string; text: string }[] };
const call = async (s: { callTool: Client["callTool"] }, name: string, args: Record<string, unknown> = {}) => (await s.callTool({ name, arguments: args })) as Res;
const body = (r: Res) => r.content[0]?.text ?? "";
const startArgs = (a: string, b: string) => ({ topic: "Как назвать кота", participants: [{ providerId: "scripted", model: a }, { providerId: "scripted", model: b }], maxRounds: 3 });

// ---- journal ----
const stat = (id: string) => readSession(home, id)?.status;
const bytes = (id: string) => readFileSync(eventsPath(home, id));
const lockPid = (id: string) => Number(readFileSync(resumeLockPath(home, id), "utf8").trim());
const executorPids = new Set<number>();
const noteLock = (id: string) => { const p = lockPid(id); executorPids.add(p); return p; };

async function main() {
  const init = cli("list"); // creates config.json once
  check(init.code === 0, "data folder initialised by `council list`", init.out);

  // ---- step 1: session A survives as a separate executor ----
  console.log("-- step 1: council_start A (owner-message)");
  const s1 = await connect();
  const rA = await call(s1.client, "council_start", startArgs("owner-message/p1.json", "owner-message/p2.json"));
  if (rA.isError) throw new Error(`council_start A: ${body(rA)}`);
  const A = JSON.parse(body(rA)).sessionId as string;
  check(existsSync(eventsPath(home, A)) && readEvents(home, A)!.events.length > 0, `A ${A}: events.jsonl is non-empty when council_start returns`);
  const pidA = noteLock(A);
  check(pidA !== s1.pid && alive(pidA), "A: resume.lock holds an alive executor pid different from the server pid", `lock ${pidA}, server ${s1.pid}`);
  check(stat(A) === "running", "A: status is running");

  // ---- step 2: owner message, then the server dies mid-turn ----
  console.log("-- step 2: say, close stdin, SIGTERM the server");
  const say = cli("say", A, "Пять букв");
  check(say.code === 0, "A: `council say` exits 0", say.out.trim());
  const t0 = Date.now();
  await s1.client.close(); // closes stdin of the server
  try { process.kill(s1.pid, "SIGTERM"); } catch { /* already gone */ }
  await until("server 1 exit", () => !alive(s1.pid), 5500).then(() => ok(`server exited within 5.5 s (${Date.now() - t0} ms)`), () => fail("server did not exit within 5.5 s"));
  check(alive(pidA), "A: executor is still alive after the server exit");
  const stA = cli("status", A);
  check(stA.code !== null && !/interrupted|прерван/i.test(stA.out), "A: `council status` does not say interrupted", stA.out.trim().split("\n")[0]);
  const finA = await until("A finished", () => { const s = readSession(home, A); return s?.state.finish ? s : null; }, 45000).catch(() => null);
  check(finA?.status === "consensus", "A: status consensus after the server is gone", `status ${finA?.status ?? stat(A)}`);
  const applied = readEvents(home, A)!.events.filter((e) => (e as { type: string }).type === "owner_message");
  check(applied.length >= 1, "A: owner_message event applied in the journal", `count ${applied.length}`);
  await until("A executor exit", () => !alive(pidA), 5000).then(() => ok("A: executor process gone"), () => fail("A: executor still alive"));
  check(!existsSync(resumeLockPath(home, A)), "A: resume.lock removed");

  // ---- step 3: session B, uniqueness ----
  console.log("-- step 3: session B (slow), uniqueness");
  const s2 = await connect();
  const rB = await call(s2.client, "council_start", startArgs("slow/p1.json", "slow/p2.json"));
  if (rB.isError) throw new Error(`council_start B: ${body(rB)}`);
  const B = JSON.parse(body(rB)).sessionId as string;
  const pidB = noteLock(B);
  await s2.client.close();
  try { process.kill(s2.pid, "SIGTERM"); } catch { /* already gone */ }
  await until("server 2 exit", () => !alive(s2.pid), 5500).catch(() => fail("server 2 did not exit"));
  check(alive(pidB) && stat(B) === "running", "B: executor alive and running after its server is closed");

  const evBefore = bytes(B);
  const lockBefore = readFileSync(resumeLockPath(home, B), "utf8");
  const res = cli("resume", B);
  check(res.code === 2 && /busy|идёт|занят|выполня/i.test(res.out), "B: `council resume` refused with exit 2", `exit ${res.code}: ${res.out.trim().slice(0, 120)}`);
  check(bytes(B).equals(evBefore), "B: journal bytes unchanged after the CLI resume refusal");

  const s3 = await connect();
  const rr = await call(s3.client, "council_resume", { sessionId: B });
  check(rr.isError === true && /^(busy|running):/.test(body(rr)), "B: council_resume plan from a second MCP client is refused (busy/running)", body(rr).slice(0, 120));
  check(bytes(B).equals(evBefore), "B: journal bytes unchanged after the MCP resume refusal");

  // 3b: repeated start with the same id
  const sessionB = readSession(home, B)!.state.session!;
  const scen: Record<string, string> = {};
  sessionB.participants.forEach((p, i) => { scen[p.id] = join(scenariosDir, i === 0 ? "slow/p1.json" : "slow/p2.json"); });
  const lf = writeLaunchFile(home, { session: sessionB, scenarios: scen, deadline: new Date(Date.now() + 15000).toISOString() });
  const rp = cli("run-prepared", lf);
  check(rp.code === 2 && /уже|already|exist/i.test(rp.out), "B: `run-prepared` with the same id refused (session already exists)", `exit ${rp.code}: ${rp.out.trim().slice(0, 120)}`);
  check(bytes(B).equals(evBefore) && readFileSync(resumeLockPath(home, B), "utf8") === lockBefore, "B: events.jsonl and resume.lock unchanged after the repeated start");
  check(alive(pidB), "B: original executor still alive after the repeated start");

  // 3c: forced end, then council_resume continues the same session
  process.kill(pidB, "SIGKILL");
  await until("B interrupted", () => stat(B) === "interrupted", 8000).then(() => ok("B: status interrupted after the executor is killed"), () => fail(`B: status ${stat(B)} after the kill`));
  const plan = await call(s3.client, "council_resume", { sessionId: B });
  const planJson = plan.isError ? null : JSON.parse(body(plan));
  check(planJson?.mode === "plan" && /^[0-9a-f]{64}$/.test(planJson?.planToken ?? ""), "B: council_resume plan after the kill", body(plan).slice(0, 120));
  const exec = await call(s3.client, "council_resume", { sessionId: B, execute: true, planToken: planJson?.planToken });
  check(!exec.isError && JSON.parse(body(exec)).accepted === true, "B: council_resume execute accepted", body(exec).slice(0, 120));
  check(stat(B) === "running" && existsSync(resumeLockPath(home, B)), "B: running again, new resume.lock");
  const lp = noteLock(B);
  check(lp !== s3.pid && alive(lp), "B: resumed in a detached executor, not in the server-3 process (change 184)", `lock ${lp}, server ${s3.pid}`);
  const stopB = cli("stop", B);
  check(stopB.code === 0 || stopB.code === 3, "B: `council stop` accepted", `exit ${stopB.code}: ${stopB.out.trim().slice(0, 100)}`);
  await until("B stopped", () => stat(B) === "stopped", 20000).then(() => ok("B: status stopped"), () => fail(`B: status ${stat(B)} after stop`));
  check(!existsSync(resumeLockPath(home, B)), "B: resume.lock removed after stop");

  // ---- step 4: session C, stop from the CLI ----
  console.log("-- step 4: session C, council stop");
  const rC = await call(s3.client, "council_start", startArgs("slow/p1.json", "slow/p2.json"));
  if (rC.isError) throw new Error(`council_start C: ${body(rC)}`);
  const C = JSON.parse(body(rC)).sessionId as string;
  const pidC = noteLock(C);
  check(pidC !== s3.pid && alive(pidC), "C: detached executor alive, pid differs from the server");
  const stopC = cli("stop", C);
  check(stopC.code === 0 || stopC.code === 3, "C: `council stop` accepted", `exit ${stopC.code}: ${stopC.out.trim().slice(0, 100)}`);
  await until("C stopped", () => stat(C) === "stopped", 15000).then(() => ok("C: status stopped within 15 s"), () => fail(`C: status ${stat(C)} after stop`));
  await until("C executor exit", () => !alive(pidC), 5000).then(() => ok("C: executor process gone"), () => fail("C: executor still alive"));
  check(!existsSync(resumeLockPath(home, C)), "C: resume.lock removed");

  // ---- step 5: start errors, in-process server ----
  console.log("-- step 5: start errors");
  const known = new Set(listSessions(home).map((s) => s.id));
  const inProc = async (councilLaunch: ToolContext["councilLaunch"]) => {
    const ctx: ToolContext = {
      dataDir: home, env: baseEnv, logger: createLogger(home, "mcp", baseEnv), builtinTemplatesDir: join(root, "templates"), scenariosDir,
      shutdown: new AbortController().signal, councilLaunch,
    };
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createServer(ctx);
    await server.connect(st);
    const client = new Client({ name: "detached-inproc", version: "0" });
    await client.connect(ct);
    return { client, close: async () => { await client.close(); await server.close(); } };
  };
  const newSessions = () => listSessions(home).filter((s) => !known.has(s.id));
  const launchLeft = () => (existsSync(launchDir(home)) ? readdirSync(launchDir(home)) : []);

  const a = await inProc({ command: join(home, "no-such-council"), args: [], env: {} });
  const ra = await call(a.client, "council_start", startArgs("consensus/p1.json", "consensus/p2.json"));
  await a.close();
  check(ra.isError === true && body(ra).length > 0, "5a: missing executable -> council_start isError with a reason", body(ra).slice(0, 140));
  await sleep(500);
  check(newSessions().length === 0, "5a: no new session appeared");
  check(launchLeft().length === 0, "5a: no files left in launch/", launchLeft().join(","));

  const slowScript = join(home, "scen", "sleep20.mjs");
  writeFileSync(slowScript, "setTimeout(() => {}, 20000);\n");
  const b = await inProc({ command: process.execPath, args: [slowScript], env: {} });
  const tb = Date.now();
  const rb = await call(b.client, "council_start", startArgs("consensus/p1.json", "consensus/p2.json"));
  await b.close();
  check(rb.isError === true && /15/.test(body(rb)), "5b: executor slower than 15 s -> isError mentioning 15", `${Date.now() - tb} ms: ${body(rb).slice(0, 140)}`);
  await sleep(7000);
  check(newSessions().length === 0, "5b: still no new session 7 s later");
  check(launchLeft().length === 0, "5b: no files left in launch/", launchLeft().join(","));

  // ---- change 184: council_resume runs in a detached executor too ----
  const stepOf = (stance: string, solution: string | null, delayMs?: number) => ({
    response: { stance, reasoning: "Довод.", solution, answers: [], questions: [] }, ...(delayMs ? { delayMs } : {}),
  });
  const scenFile = (name: string, steps: unknown[]) => { const p = join(home, "scen", `${name}.json`); writeFileSync(p, JSON.stringify({ steps })); return p; };
  /** A no_consensus session after one round (CLI run, scripted). Round 2 of the resume: the second participant's turn lasts delayMs; round 3 reaches consensus. */
  const noConsensus = (tag: string, delayMs: number, flags: string[] = []) => {
    const p1 = scenFile(`${tag}-p1`, [stepOf("amend", "Версия 1."), stepOf("object", null), stepOf("agree", null)]);
    const p2 = scenFile(`${tag}-p2`, [stepOf("object", null), stepOf("object", null, delayMs || undefined), stepOf("agree", null)]);
    const r = cli("--topic", "Как назвать кота", "--participant", `scripted:${p1}`, "--participant", `scripted:${p2}`, "--max-rounds", "1", ...flags);
    const id = /^Сессия (\S+) ·/m.exec(r.out)?.[1];
    if (!id) throw new Error(`${tag}: no session id in the start output: ${r.out.slice(0, 200)}`);
    return id;
  };
  const evCount = (id: string, type: string) => readEvents(home, id)!.events.filter((e) => (e as { type: string }).type === type).length;
  const planAndExec = async (s: Srv, id: string, rounds = 2) => {
    const pl = await call(s.client, "council_resume", { sessionId: id, rounds });
    if (pl.isError) throw new Error(`${id} plan: ${body(pl)}`);
    const token = JSON.parse(body(pl)).planToken as string;
    return call(s.client, "council_resume", { sessionId: id, rounds, execute: true, planToken: token });
  };
  const accepted = (r: Res) => !r.isError && JSON.parse(body(r)).accepted === true;
  const serverGone = async (s: Srv, label: string) => {
    await until(`${label} exit`, () => !alive(s.pid), 5500).then(() => ok(`${label}: server exited`), () => fail(`${label}: server did not exit within 5.5 s`));
  };
  const finishesAs = async (id: string, label: string, status: string) => {
    const f = await until(`${label} finished`, () => { const s = readSession(home, id); return s?.state.finish && s.state.finish.status === status ? s : null; }, 60000).catch(() => null);
    check(f !== null, `${label}: final status ${status} arrives after the server is gone`, `status ${stat(id)}`);
  };

  console.log("-- 184.1: council_resume plan/execute, executor pid differs from the server; close stdin mid-turn");
  const R1 = noConsensus("r1", 8000);
  check(stat(R1) === "no_consensus", "R1: no_consensus before the resume", `status ${stat(R1)}`);
  const turnsBefore = evCount(R1, "turn_started");
  const sr1 = await connect();
  check(accepted(await planAndExec(sr1, R1)), "R1: council_resume execute -> accepted: true");
  check(evCount(R1, "session_resumed") === 1, "R1: exactly one session_resumed in the journal", `count ${evCount(R1, "session_resumed")}`);
  const pidR1 = noteLock(R1);
  check(pidR1 !== sr1.pid && alive(pidR1), "R1: resume.lock holds an alive executor pid different from the server pid", `lock ${pidR1}, server ${sr1.pid}`);
  const busy = await call(sr1.client, "council_resume", { sessionId: R1, rounds: 1 });
  check(busy.isError === true && /^(busy|running):/.test(body(busy)), "R1: a second council_resume while the executor runs is refused (busy/running)", body(busy).slice(0, 120));
  check(evCount(R1, "session_resumed") === 1, "R1: no second session_resumed after the busy refusal");
  check(stat(R1) === "running", "R1: status running in the middle of the second participant's turn");
  await sr1.client.close();
  await serverGone(sr1, "R1");
  check(alive(pidR1), "R1: executor still alive after the client is closed");
  check(stat(R1) !== "interrupted", "R1: status is not interrupted", `status ${stat(R1)}`);
  await finishesAs(R1, "R1", "consensus");
  const stR1 = cli("status", R1);
  check(stR1.code === 0 && !/interrupted|прерван/i.test(stR1.out), "R1: `council status` works and does not say interrupted", stR1.out.trim().split("\n")[0]);
  check(evCount(R1, "turn_started") > turnsBefore, "R1: the journal has new turns from the resumed segment", `${turnsBefore} -> ${evCount(R1, "turn_started")}`);
  await until("R1 executor exit", () => !alive(pidR1), 5000).then(() => ok("R1: executor process gone"), () => fail("R1: executor still alive"));
  check(!existsSync(resumeLockPath(home, R1)), "R1: resume.lock removed");

  console.log("-- 184.2: SIGTERM of the server mid-turn");
  const R2 = noConsensus("r2", 8000);
  const sr2 = await connect();
  check(accepted(await planAndExec(sr2, R2)), "R2: council_resume execute -> accepted: true");
  const pidR2 = noteLock(R2);
  check(pidR2 !== sr2.pid && alive(pidR2), "R2: executor pid differs from the server pid and is alive", `lock ${pidR2}, server ${sr2.pid}`);
  await sleep(1500);
  check(stat(R2) === "running", "R2: still running when the server gets SIGTERM");
  try { process.kill(sr2.pid, "SIGTERM"); } catch { /* already gone */ }
  await serverGone(sr2, "R2");
  check(alive(pidR2) && stat(R2) !== "interrupted", "R2: executor alive, status not interrupted", `status ${stat(R2)}`);
  await finishesAs(R2, "R2", "consensus");
  const stR2 = cli("status", R2);
  check(stR2.code === 0 && !/interrupted|прерван/i.test(stR2.out), "R2: `council status` works and does not say interrupted", stR2.out.trim().split("\n")[0]);
  check(evCount(R2, "turn_started") >= 6, "R2: the journal has the turns of all three rounds", `turn_started ${evCount(R2, "turn_started")}`);
  await until("R2 executor exit", () => !alive(pidR2), 5000).then(() => ok("R2: executor process gone"), () => fail("R2: executor still alive"));

  console.log("-- 184.3: owner wait survives the server, `council continue` lifts it");
  const R3 = noConsensus("r3", 0, ["--pause-after-round", "--owner-wait-sec", "120"]);
  check(stat(R3) === "no_consensus", "R3: no_consensus before the resume (no pause in the last round)", `status ${stat(R3)}`);
  const sr3 = await connect();
  check(accepted(await planAndExec(sr3, R3)), "R3: council_resume execute -> accepted: true");
  const pidR3 = noteLock(R3);
  check(pidR3 !== sr3.pid && alive(pidR3), "R3: executor pid differs from the server pid", `lock ${pidR3}, server ${sr3.pid}`);
  const w1 = await until("R3 owner wait", () => readSession(home, R3)?.state.waiting, 20000).catch(() => null);
  check(w1 !== null, "R3: the resumed session reaches an owner wait");
  await sr3.client.close();
  try { process.kill(sr3.pid, "SIGTERM"); } catch { /* already gone */ }
  await serverGone(sr3, "R3");
  await sleep(1500);
  const w2 = readSession(home, R3)?.state.waiting;
  check(w1 !== null && w2?.waitId === w1.waitId && w2.deadline === w1.deadline, "R3: the wait keeps the same waitId and deadline after the server is closed", `${w1?.waitId} -> ${w2?.waitId}`);
  check(alive(pidR3) && stat(R3) === "running", "R3: executor alive and running during the wait", `status ${stat(R3)}`);
  const turnsWait = evCount(R3, "turn_started");
  const cont = cli("continue", R3);
  check(cont.code === 0, "R3: `council continue` exits 0", `exit ${cont.code}: ${cont.out.trim().slice(0, 120)}`);
  await finishesAs(R3, "R3", "consensus");
  check(evCount(R3, "turn_started") > turnsWait && !readSession(home, R3)?.state.waiting, "R3: the session went on after `continue` (new turns, no wait left)", `${turnsWait} -> ${evCount(R3, "turn_started")}`);
  await until("R3 executor exit", () => !alive(pidR3), 5000).then(() => ok("R3: executor process gone"), () => fail("R3: executor still alive"));

  console.log("-- 184.4: refusals");
  const R4 = noConsensus("r4", 0);
  const sr4 = await connect();
  const pl4 = await call(sr4.client, "council_resume", { sessionId: R4, rounds: 2 });
  const tok4 = JSON.parse(body(pl4)).planToken as string;
  const evFile = eventsPath(home, R4);
  const lines = readFileSync(evFile, "utf8").split("\n");
  const first = lines[0]!.replace(/"pid":\d+/, '"pid":1');
  if (first === lines[0]) throw new Error("R4: no pid field in the first event");
  lines[0] = first;
  writeFileSync(evFile, lines.join("\n"));
  const stale = await call(sr4.client, "council_resume", { sessionId: R4, rounds: 2, execute: true, planToken: tok4 });
  check(stale.isError === true && /^stale_plan:/.test(body(stale)), "R4: journal changed between plan and execute -> stale_plan", body(stale).slice(0, 120));
  check(evCount(R4, "session_resumed") === 0, "R4: no session_resumed after stale_plan");
  check(!existsSync(resumeLockPath(home, R4)), "R4: no resume.lock after stale_plan");
  await sr4.client.close();
  await serverGone(sr4, "R4");

  const R6 = noConsensus("r6", 0);
  const before6 = bytes(R6);
  const bogus = await inProc({ command: process.execPath, args: ["/nonexistent/council.ts"], env: {} });
  const r6 = await planAndExec({ client: bogus.client } as unknown as Srv, R6);
  await bogus.close();
  check(r6.isError === true && body(r6).length > 0, "R6: bogus `council` launch path -> council_resume isError with a reason", body(r6).slice(0, 140));
  await sleep(500);
  check(bytes(R6).equals(before6) && evCount(R6, "session_resumed") === 0, "R6: journal unchanged, no session_resumed");
  check(launchLeft().length === 0, "R6: no files left in launch/", launchLeft().join(","));
  check(!existsSync(resumeLockPath(home, R6)), "R6: no resume.lock");

  console.log("-- 184.5: council stop after the client is closed");
  const R7 = noConsensus("r7", 20000);
  const sr7 = await connect();
  check(accepted(await planAndExec(sr7, R7)), "R7: council_resume execute -> accepted: true");
  const pidR7 = noteLock(R7);
  await sr7.client.close();
  await serverGone(sr7, "R7");
  check(alive(pidR7) && stat(R7) === "running", "R7: executor alive and running after the client is closed", `status ${stat(R7)}`);
  const stopR7 = cli("stop", R7);
  check(stopR7.code === 0 || stopR7.code === 3, "R7: `council stop` accepted", `exit ${stopR7.code}: ${stopR7.out.trim().slice(0, 100)}`);
  await until("R7 stopped", () => stat(R7) === "stopped", 15000).then(() => ok("R7: status stopped within 15 s"), () => fail(`R7: status ${stat(R7)} after stop`));
  await until("R7 executor exit", () => !alive(pidR7), 5000).then(() => ok("R7: executor process gone"), () => fail("R7: executor still alive"));
  check(!existsSync(resumeLockPath(home, R7)), "R7: resume.lock removed");

  // ---- step 6 (stand numbering: orphans) ----
  console.log("-- orphans");
  console.log(`executor pids: ${[...executorPids].join(", ")}`);
  for (const pid of executorPids) {
    await until(`pid ${pid} exit`, () => !alive(pid), 5000).then(() => ok(`pid ${pid} is not alive`), () => fail(`pid ${pid} is still alive`));
  }
}

try {
  await main();
} catch (e) {
  fail(`unexpected: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
} finally {
  for (const s of servers) {
    try { await s.client.close(); } catch { /* ignore */ }
    try { process.kill(s.pid, "SIGTERM"); } catch { /* ignore */ }
  }
  for (const k of kids) k.kill("SIGTERM");
  for (const s of listSessions(home)) if (s.status === "running") { try { requestStop(home, s.id); } catch { /* ignore */ } }
}
console.log(failed === 0 ? "ALL CHECKS PASSED" : "CHECK FAILED");
process.exit(failed === 0 ? 0 : 1);
