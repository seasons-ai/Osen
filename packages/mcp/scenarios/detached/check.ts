// Live check of change 138: council_start runs the session in a detached executor that outlives the MCP server.
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
  const lp = lockPid(B);
  check(lp === s3.pid, "B: resumed in the server-3 process (by design, council_resume is in-process)", `lock ${lp}, server ${s3.pid}`);
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
