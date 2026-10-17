// Live check of "a session from a journal of a newer version" (change 68): real council processes and the MCP server over stdio,
// scripted participants only (0 model calls, 0 cost).
//   COUNCIL_DEV=1 node packages/core/scenarios/newer-version/check.ts
// Writes only to .council-data/newer-version-check-* inside the project; the owner's data folder and global settings are not used.
// Does not delete the folder, prints its path at the end.
import "../language-ru.ts";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Scripted participants are available only with COUNCIL_DEV=1. Run: COUNCIL_DEV=1 node packages/core/scenarios/newer-version/check.ts");
  process.exit(1);
}
const repo = resolve(import.meta.dirname, "../../../..");
const councilTs = join(repo, "packages/core/src/council.ts");
const mainTs = join(repo, "packages/mcp/src/main.ts");
mkdirSync(join(repo, ".council-data"), { recursive: true });
const workPath = join(repo, ".council-data", `newer-version-check-${Date.now()}-${randomBytes(3).toString("hex")}`);
mkdirSync(workPath, { recursive: true });
const work = realpathSync(workPath);
const home = join(work, "home");
mkdirSync(home, { recursive: true });

// ---------- checks ----------
let checks = 0;
let failed = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function must(cond: unknown, msg: string): asserts cond { checks++; if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}…` : v);
const eq = (a: unknown, e: unknown, what: string) => must(JSON.stringify(a) === JSON.stringify(e), `${what}: expected ${show(e)} / got ${show(a)}`);
async function step(n: number, fn: () => Promise<string> | string) {
  try { console.log(`step ${n} - ok: ${await fn()}`); }
  catch (e) { failed++; console.log(`FAIL: step ${n}: ${(e instanceof Error ? e.message : String(e)).replace(/\s*\n\s*/g, " | ")}`); }
}
async function until<T>(what: string, fn: () => T | Promise<T>, ms = 40000): Promise<NonNullable<T>> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) {
    let r: T | undefined;
    try { r = await fn(); } catch { r = undefined; }
    if (r) return r as NonNullable<T>;
  }
  throw new Error(`timed out waiting for: ${what}`);
}

// ---------- processes ----------
const kids = new Set<ChildProcess>();
interface Proc { child: ChildProcess; out: string; err: string; exited: Promise<number | null> }
const childEnv = () => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_DEV: "1", COUNCIL_HOME: home });
function cli(args: string[]): Proc {
  const child = spawn(process.execPath, [councilTs, ...args], { env: childEnv(), cwd: repo });
  kids.add(child);
  const p: Proc = { child, out: "", err: "", exited: new Promise((res) => child.on("close", (c) => { kids.delete(child); res(c); })) };
  child.stdout!.on("data", (d) => { p.out += d; });
  child.stderr!.on("data", (d) => { p.err += d; });
  return p;
}
const dump = (r: { out: string; err: string }) => `\n--- stdout ---\n${r.out}\n--- stderr ---\n${r.err}`;
async function finish(p: Proc, what: string, ms = 90000): Promise<number | null> {
  const t = await Promise.race([p.exited, sleep(ms).then(() => "timeout" as const)]);
  if (t === "timeout") { p.child.kill("SIGKILL"); throw new Error(`${what}: process did not exit within ${ms / 1000} s${dump(p)}`); }
  return t;
}
async function run(what: string, args: string[]) {
  const p = cli(args);
  const code = await finish(p, what);
  return { code, out: p.out, err: p.err, all: p.out + p.err };
}
const idOf = (out: string) => /^Сессия (\S+) ·/m.exec(out)?.[1] ?? "";

// ---------- journal ----------
const sdir = (id: string) => join(home, "sessions", id);
const jpath = (id: string) => join(sdir(id), "events.jsonl");
const jbytes = (id: string) => readFileSync(jpath(id));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 12);
const lines = (id: string) => jbytes(id).toString("utf8").split("\n").filter(Boolean);
const files = (id: string) => readdirSync(sdir(id)).sort();
const futureLine = (seq: number) => JSON.stringify({ seq, ts: "2099-01-01T00:00:00.000Z", type: "future_event" });

// ---------- scenarios ----------
type S = Record<string, unknown>;
const tok = { inputTokens: 100, outputTokens: 50 };
const amend = (text: string, x: S = {}) => ({ response: { stance: "amend", reasoning: `Довод ${text}`, solution: text, answers: [], questions: [] }, ...tok, ...x });
const agree = (x: S = {}) => ({ response: { stance: "agree", reasoning: "Согласен", solution: null, answers: [], questions: [] }, ...tok, ...x });
function scen(name: string, steps: S[]): string {
  const dir = join(work, "scen");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify({ steps }));
  return p;
}
const parts = (...ps: string[]) => ps.flatMap((p) => ["--participant", `scripted:${p}`]);
const TOPIC = "Как назвать кота";
const consensusArgs = () => [...parts(scen("a-p1", [amend("Версия 1 кота"), agree(), agree()]), scen("a-p2", [agree(), agree(), agree()]))];
// two rounds without agreement: both participants submit a new version every turn
const noConsArgs = (tag: string) => [...parts(scen(`${tag}-p1`, Array.from({ length: 4 }, (_, i) => amend(`Кот ${tag} p1-${i}`))), scen(`${tag}-p2`, Array.from({ length: 4 }, (_, i) => amend(`Кот ${tag} p2-${i}`))))];

// ---------- MCP ----------
type Res = { isError?: boolean; content: { type: string; text: string }[] };
const servers: { client: Client; pid: number }[] = [];
async function connect() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mainTs], cwd: repo, stderr: "ignore", env: childEnv() });
  const client = new Client({ name: "newer-version-check", version: "0" });
  await client.connect(transport);
  const s = { client, pid: transport.pid! };
  servers.push(s);
  return s;
}
type Srv = Awaited<ReturnType<typeof connect>>;
const call = async (s: Srv, name: string, args: Record<string, unknown>) => (await s.client.callTool({ name, arguments: args })) as Res;
const body = (r: Res) => r.content[0]?.text ?? "";
const noLeaks = (text: string, what: string) => {
  must(!text.includes(work) && !text.includes(home), `${what}: the response contains the data folder path`);
  must(!/sk-[A-Za-z0-9]{8}|API_KEY|api[_-]?key/i.test(text), `${what}: the response looks like it contains a key`);
};
async function mcpStatus(s: Srv, id: string) {
  const r = await call(s, "council_status", { sessionId: id });
  must(!r.isError, `council_status ${id}: tool error: ${body(r).slice(0, 200)}`);
  noLeaks(body(r), `council_status ${id}`);
  return JSON.parse(body(r));
}
async function mcpRefused(s: Srv, id: string, name: string, args: Record<string, unknown>) {
  const before = jbytes(id), dir = files(id);
  const r = await call(s, name, { sessionId: id, ...args });
  must(r.isError === true, `${name}: no isError, response: ${body(r).slice(0, 200)}`);
  must(body(r).startsWith("newer_version"), `${name}: text does not start with newer_version: ${body(r).slice(0, 200)}`);
  noLeaks(body(r), name);
  must(jbytes(id).equals(before), `${name}: journal bytes changed`);
  eq(files(id), dir, `${name}: session folder files`);
  return body(r).slice(0, 60);
}

const NOTE = (n: number) => `журнал записан более новой версией, прочитан до события №${n}`;
let A = "", B = "", countA = 0, shaB = "";

async function main() {
  const init = await run("initialization", ["list"]);
  must(init.code === 0, `council list: code ${init.code}${dump(init)}`);

  await step(1, async () => {
    const ra = await run("session A", ["--topic", TOPIC, ...consensusArgs(), "--max-rounds", "3"]);
    must(ra.code === 0, `A: code ${ra.code}, expected 0 (consensus)${dump(ra)}`);
    A = idOf(ra.out);
    const rb = await run("session B", ["--topic", TOPIC, ...noConsArgs("b"), "--max-rounds", "2"]);
    must(rb.code === 3, `B: code ${rb.code}, expected 3 (no_consensus)${dump(rb)}`);
    B = idOf(rb.out);
    must(A && B, "no session ids");
    const la = lines(A), lb = lines(B);
    eq([JSON.parse(la.at(-1)!).type, JSON.parse(la.at(-1)!).status], ["session_finished", "consensus"], "last event of A");
    eq([JSON.parse(lb.at(-1)!).type, JSON.parse(lb.at(-1)!).status], ["session_finished", "no_consensus"], "last event of B");
    must(lb.length > 3, `the B journal has ${lb.length} events, more than three needed`);
    countA = la.length;
    writeFileSync(jpath(B), `${[...lb.slice(0, 3), futureLine(4), ...lb.slice(3)].join("\n")}\n`);
    appendFileSync(jpath(A), `${futureLine(countA + 1)}\n`);
    shaB = sha(jbytes(B));
    eq(lines(B).slice(0, 4).map((l) => JSON.parse(l).type).slice(3), ["future_event"], "the future_event line is fourth in B");
    eq(JSON.parse(lines(A).at(-1)!).type, "future_event", "future_event at the end of A");
    return `A ${A}: ${countA} events, consensus, future_event appended after session_finished; B ${B}: ${lb.length} events, no_consensus, future_event inserted after the third (now ${lb.length + 1}); sha256(B)=${shaB}…`;
  });

  await step(2, async () => {
    const stB = await run("status B", ["status", B]);
    must(stB.code === 0, `status B: code ${stB.code}${dump(stB)}`);
    const lineB = stB.out.split("\n").find((l) => l.startsWith(`Сессия ${B}`)) ?? "";
    must(lineB.includes(`состояние не определено · ${NOTE(3)}`), `status B: status line ${show(lineB)}`);
    must(!/прервана|повреждён/.test(stB.out), `status B: contains "interrupted"/"corrupted"${dump(stB)}`);
    must(stB.out.includes("Обновите приложение"), `status B: no advice to update the app${dump(stB)}`);
    const list = await run("list", ["list"]);
    must(list.code === 0, `list: code ${list.code}${dump(list)}`);
    const listB = list.out.split("\n").find((l) => l.startsWith(B)) ?? "";
    const listA = list.out.split("\n").find((l) => l.startsWith(A)) ?? "";
    must(listB.includes(`состояние не определено · ${NOTE(3)}`), `list B: ${show(listB)}`);
    must(!/прервана|повреждён/.test(listB), `list B: contains "interrupted"/"corrupted": ${show(listB)}`);
    must(list.out.includes("Обновите приложение"), `list: no advice to update the app${dump(list)}`);
    must(listA.includes("consensus") && listA.includes(NOTE(countA)), `list A: ${show(listA)}`);
    const stA = await run("status A", ["status", A]);
    const lineA = stA.out.split("\n").find((l) => l.startsWith(`Сессия ${A}`)) ?? "";
    must(lineA.includes("consensus") && lineA.includes(NOTE(countA)), `status A: ${show(lineA)}`);
    const shB = await run("show B", ["show", B]);
    must(shB.out.split("\n").some((l) => l.startsWith("Статус:") && l.includes(NOTE(3))), `show B: no note in "Статус:"${dump(shB)}`);
    return `B: «${lineB}»; list B: «${listB.slice(0, 120)}»; advice to update printed; A: «${lineA}»; show B: «Статус: … ${NOTE(3)}»`;
  });

  await step(3, async () => {
    const dir = files(B);
    const msgs: string[] = [];
    for (const args of [["resume", B], ["say", B, "текст"], ["continue", B]]) {
      const r = await run(args[0]!, args);
      must(r.code === 2, `${args[0]}: code ${r.code}, expected 2${dump(r)}`);
      if (args[0] === "resume") {
        must(/более нов/.test(r.err) && r.err.includes("№3"), `resume: the message does not name the newer version and event №3${dump(r)}`);
        must(!r.err.includes("журнал сессии повреждён"), `resume: contains "session journal is corrupted"${dump(r)}`);
      } else must(/newer_version|более нов/.test(r.err), `${args[0]}: the message does not name the newer version${dump(r)}`);
      eq(sha(jbytes(B)), shaB, `sha256 of journal B after ${args[0]}`);
      eq(files(B), dir, `session folder files after ${args[0]}`);
      must(!existsSync(join(sdir(B), "resume.lock")), `${args[0]}: resume.lock appeared`);
      msgs.push(`${args[0]}: code 2 "${r.err.trim().split("\n")[0]!.slice(0, 80)}"`);
    }
    return `${msgs.join("; ")}; sha256(B) unchanged ${shaB}…, session folder files the same (${dir.join(", ")})`;
  });

  await step(4, async () => {
    const s = await connect();
    const stB = await mcpStatus(s, B);
    eq(stB.journal, { reason: "newer_version", lastEvent: 3 }, "council_status B journal");
    must(stB.statusText.includes("состояние не определено") && stB.statusText.includes(NOTE(3)), `statusText B: ${show(stB.statusText)}`);
    const refused = [
      await mcpRefused(s, B, "council_resume", {}),
      await mcpRefused(s, B, "council_say", { text: "текст" }),
      await mcpRefused(s, B, "council_continue", { waitId: "w1" }),
    ];
    const stA = await mcpStatus(s, A);
    eq(stA.status, "consensus", "council_status A status");
    must(typeof stA.solution?.text === "string" && stA.solution.text.length > 0, `A has no solution: ${show(stA.solution)}`);
    eq(stA.journal?.reason, "newer_version", "council_status A journal.reason");
    eq(sha(jbytes(B)), shaB, "sha256 of journal B after MCP");
    return `B journal ${JSON.stringify(stB.journal)}, statusText «${stB.statusText}»; refusals: ${refused.map((x) => `«${x}»`).join(", ")}; A status consensus, solution «${stA.solution.text}», journal.reason newer_version; no paths or keys in the responses`;
  });

  await step(5, async () => {
    const slow = (tag: string) => parts(scen(`${tag}-p1`, [amend("Версия медленная", { delayMs: 20000 }), agree(), agree()]), scen(`${tag}-p2`, [agree(), agree(), agree()]));
    const startSlow = async (tag: string) => {
      const p = cli(["--topic", TOPIC, ...slow(tag), "--max-rounds", "3"]);
      const id = await until(`${tag}: session id`, () => idOf(p.out));
      await until(`${tag}: p1 turn started`, () => lines(id).some((l) => JSON.parse(l).type === "turn_started"));
      appendFileSync(jpath(id), `${futureLine(lines(id).length + 1)}\n`);
      return { p, id };
    };
    const C = await startSlow("c"), D = await startSlow("d");
    try {
      const preC = jbytes(C.id);
      const st = await run("stop C", ["stop", C.id]);
      must(st.code === 0, `stop C: code ${st.code}${dump(st)}`);
      must(st.out.includes(`Остановка сессии ${C.id} запрошена`), `stop C: output ${show(st.out)}`);
      must(existsSync(join(sdir(C.id), "stop-requested")), "stop C: no stop request file");
      const postC = jbytes(C.id);
      must(postC.subarray(0, preC.length).equals(preC), "stop C: journal prefix changed");
      const s = await connect();
      const preD = jbytes(D.id);
      const r = await call(s, "council_stop", { sessionId: D.id });
      must(!r.isError, `council_stop D: tool error: ${body(r).slice(0, 200)}`);
      const v = JSON.parse(body(r));
      must(!/newer_version/.test(body(r)) || v.journal?.reason === "newer_version", "council_stop D: newer_version refusal");
      must(!String(v.message).startsWith("Остановка не выполнена"), `council_stop D: ${show(v.message)}`);
      noLeaks(body(r), "council_stop D");
      must(existsSync(join(sdir(D.id), "stop-requested")), "council_stop D: no stop request file");
      must(jbytes(D.id).subarray(0, preD.length).equals(preD), "council_stop D: journal prefix changed");
      const cc = await finish(C.p, "process C", 60000), cd = await finish(D.p, "process D", 60000);
      return `stop C: code 0 "${st.out.trim()}", stop-requested created, journal prefix (${preC.length} B) untouched; council_stop D: no error, message "${v.message}"; processes exited by themselves (C code ${cc}, D code ${cd})`;
    } finally {
      for (const x of [C, D]) if (x.p.child.exitCode === null) x.p.child.kill("SIGKILL");
    }
  });

  await step(6, async () => {
    const rf = await run("session F", ["--topic", TOPIC, ...noConsArgs("f"), "--max-rounds", "2"]);
    must(rf.code === 3, `F: code ${rf.code}, expected 3${dump(rf)}`);
    const F = idOf(rf.out), n = lines(F).length;
    appendFileSync(jpath(F), '{"seq":99,"ts":"2026-');
    const before = sha(jbytes(F));
    const rs = await run("resume F", ["resume", F]);
    must(rs.code === 2 && rs.err.includes("журнал сессии повреждён"), `resume F: code ${rs.code}${dump(rs)}`);
    const st = await run("status F", ["status", F]);
    const line = st.out.split("\n").find((l) => l.startsWith(`Сессия ${F}`)) ?? "";
    must(line.includes("no_consensus") && line.includes(`журнал повреждён, прочитан до события №${n}`), `status F: ${show(line)}`);
    must(!st.out.includes("более нов"), `status F: mentions a newer version${dump(st)}`);
    const s = await connect();
    const j = (await mcpStatus(s, F)).journal;
    eq(j, { reason: "corrupted", lastEvent: n }, "council_status F journal");
    eq(sha(jbytes(F)), before, "sha256 of journal F");
    return `F ${F}: resume code 2 "session journal is corrupted"; status «${line}»; council_status journal ${JSON.stringify(j)}`;
  });
}

try {
  await main();
} finally {
  for (const c of kids) c.kill("SIGKILL");
  for (const s of servers) { try { await s.client.close(); } catch { /* already closed */ } try { process.kill(s.pid, "SIGKILL"); } catch { /* already exited */ } }
}
console.log(failed === 0 ? `Result: ${checks} checks, all passed; real model calls 0` : `Result: FAIL, steps with errors ${failed}, checks run ${checks}; real model calls 0`);
console.log(`Stand data folder: ${work}`);
process.exit(failed === 0 ? 0 : 1);
