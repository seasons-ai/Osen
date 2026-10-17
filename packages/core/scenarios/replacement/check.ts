// Live check of "participant replacement on resume": real council processes and the MCP server over stdio,
// participants are scripted only (0 model calls, 0 cost).
//   COUNCIL_DEV=1 node packages/core/scenarios/replacement/check.ts [--keep] [--out <file.json>] [--prepare-only]
// Writes only to .council-data/replacement-check-* inside the project (each part has its own data folder home-<n>, scenarios in scen-<n>);
// without --keep it removes the folder on success, on failure it keeps it and prints the path. The owner's data folder and the environment's COUNCIL_HOME are not used.
// --prepare-only: only builds the fixtures (a recoverable failed and a stopped session with an unavailable active p2) and prints ready-made resume commands.
import "../language-ru.ts";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { currentVersion, foldEvents, readSession, tokenUsage } from "../../src/index.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Scripted participants are available only with COUNCIL_DEV=1. Run: COUNCIL_DEV=1 node packages/core/scenarios/replacement/check.ts");
  process.exit(1);
}
const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const prepareOnly = argv.includes("--prepare-only");
const outFile = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : undefined;
const repo = resolve(import.meta.dirname, "../../../..");
const councilTs = join(repo, "packages/core/src/council.ts");
const mainTs = join(repo, "packages/mcp/src/main.ts");
const EXPECTED = 21;

mkdirSync(join(repo, ".council-data"), { recursive: true });
const workPath = join(repo, ".council-data", `replacement-check-${Date.now()}-${randomBytes(3).toString("hex")}`);
mkdirSync(workPath, { recursive: true });
const work = realpathSync(workPath);
const homeOf = (n: string) => { const d = join(work, `home-${n}`); mkdirSync(d, { recursive: true }); return d; };
const scenDir = (n: string) => { const d = join(work, `scen-${n}`); mkdirSync(d, { recursive: true }); return d; };

// ---------- steps and report ----------
interface Rec { name: string; ok: boolean; note?: string; error?: string; obs: Record<string, unknown> }
const recs: Rec[] = [];
type Obs = Record<string, unknown>;
async function step(name: string, fn: (obs: Obs) => Promise<string> | string) {
  const obs: Obs = {};
  try {
    const note = await fn(obs);
    recs.push({ name, ok: true, note, obs });
    console.log(`ok  ${name} — ${note}`);
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).replace(/\s*\n\s*/g, " | ");
    recs.push({ name, ok: false, error: msg, obs });
    console.log(`FAIL ${name}: ${msg}`);
  }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v.length > 300 ? `${v.slice(0, 300)}…` : v) : JSON.stringify(v));
const eq = (actual: unknown, expected: unknown, what: string) =>
  must(JSON.stringify(actual) === JSON.stringify(expected), `${what}: expected ${show(expected)} / got ${show(actual)}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => T | Promise<T>, ms = 40000): Promise<NonNullable<T>> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) {
    let r: T | undefined;
    try { r = await fn(); } catch { r = undefined; }
    if (r) return r as NonNullable<T>;
  }
  throw new Error(`timed out waiting for: ${what}`);
}
const lazy = <T>(fn: () => Promise<T>) => { let p: Promise<T> | undefined; return () => (p ??= fn()); };

// ---------- processes ----------
const kids = new Set<ChildProcess>();
interface Proc { child: ChildProcess; out: string; err: string; exited: Promise<number | null> }
function cli(home: string, args: string[]): Proc {
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_DEV: "1", COUNCIL_HOME: home };
  const child = spawn(process.execPath, [councilTs, ...args], { env, cwd: repo });
  kids.add(child);
  const p: Proc = { child, out: "", err: "", exited: new Promise((res) => child.on("close", (c) => { kids.delete(child); res(c); })) };
  child.stdout!.on("data", (d) => { p.out += d; });
  child.stderr!.on("data", (d) => { p.err += d; });
  return p;
}
const dump = (r: { out: string; err: string }) => `\n--- stdout ---\n${r.out}\n--- stderr ---\n${r.err}`;
/** Waits for the process for at most ms; on timeout terminates it and fails with a clear reason. */
async function finish(p: Proc, what: string, ms = 90000): Promise<number | null> {
  const t = await Promise.race([p.exited, sleep(ms).then(() => "timeout" as const)]);
  if (t === "timeout") { p.child.kill("SIGKILL"); throw new Error(`${what}: process did not finish within ${ms / 1000} s${dump(p)}`); }
  return t;
}
async function runCli(what: string, home: string, args: string[]) {
  const p = cli(home, args);
  const code = await finish(p, what);
  return { code, out: p.out, err: p.err, id: /^Сессия (\S+) ·/m.exec(p.out)?.[1] ?? "" };
}

// ---------- journal ----------
type Ev = Record<string, any> & { seq: number; type: string };
const sdir = (home: string, id: string) => join(home, "sessions", id);
const journalPath = (home: string, id: string) => join(sdir(home, id), "events.jsonl");
const lockPath = (home: string, id: string) => join(sdir(home, id), "resume.lock");
const jbytes = (home: string, id: string) => readFileSync(journalPath(home, id));
const evs = (home: string, id: string): Ev[] => jbytes(home, id).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ofType = (es: Ev[], t: string) => es.filter((e) => e.type === t);
const foldOf = (es: Ev[]) => foldEvents(es as never);
const statusOf = (home: string, id: string) => readSession(home, id)!.status;
const sessionsIn = (home: string) => (existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")).sort() : []);
const resumedIdx = (es: Ev[]) => es.findIndex((e) => e.type === "session_resumed");
const noLock = (home: string, id: string) => must(!existsSync(lockPath(home, id)), "resume.lock was left behind");

// ---------- scenarios ----------
type S = Record<string, unknown>;
const tok = { inputTokens: 100, outputTokens: 50 };
const amend = (text: string, x: S = {}, questions: S[] = []) => ({ response: { stance: "amend", reasoning: `Довод ${text}`, solution: text, answers: [], questions }, ...tok, ...x });
const agree = (x: S = {}) => ({ response: { stance: "agree", reasoning: "Согласен", solution: null, answers: [], questions: [] }, ...tok, ...x });
const agrees = (n: number, x: S = {}) => Array.from({ length: n }, () => agree(x));
const badRaw = () => ({ raw: "это не JSON", ...tok });
const crash = () => ({ error: "Сценарный сбой", retryable: false });
function scen(dir: string, name: string, steps: S[]): string {
  const p = join(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify({ steps }));
  return p;
}
const parts = (...ps: string[]) => ps.flatMap((p) => ["--participant", `scripted:${p}`]);
const TOPIC = "Как назвать кота";

interface Fixture { id: string; home: string; p1: string; p2: string; out: string; code: number | null }
/** A two-participant session: p1 submits version 1 and then agrees, p2 fails with a non-retryable error (by default) — a recoverable failed. */
async function failedSession(home: string, dir: string, tag: string, o: { p2?: S[]; flags?: string[]; rounds?: number } = {}): Promise<Fixture> {
  const p1 = scen(dir, `${tag}-p1`, [amend("Версия 1 кота"), ...agrees(8)]);
  const p2 = scen(dir, `${tag}-p2`, o.p2 ?? [crash()]);
  const r = await runCli(`${tag}: initial run`, home, ["--topic", TOPIC, ...parts(p1, p2), "--max-rounds", String(o.rounds ?? 2), ...(o.flags ?? [])]);
  must(r.id, `${tag}: no session id${dump(r)}`);
  return { id: r.id, home, p1, p2, out: r.out, code: r.code };
}
/** A stopped session: p1 creates version 1 and asks p2, p2's turn is long; SIGINT during p2's turn. */
async function stoppedSession(home: string, dir: string, tag: string): Promise<Fixture & { turn: number; round: number }> {
  const p1 = scen(dir, `${tag}-p1`, [amend("Версия 1 кота", {}, [{ to: "p2", text: "Какого цвета кот?" }]), ...agrees(8)]);
  const p2 = scen(dir, `${tag}-p2`, [agree({ delayMs: 120000 }), ...agrees(8)]);
  const p = cli(home, ["--topic", TOPIC, ...parts(p1, p2), "--max-rounds", "2"]);
  const id = await until(`${tag}: session id`, () => /^Сессия (\S+) ·/m.exec(p.out)?.[1]);
  const t = await until(`${tag}: p2 turn started`, () => ofType(evs(home, id), "turn_started").find((e) => e.participantId === "p2"));
  p.child.kill("SIGINT");
  const code = await finish(p, `${tag}: stop`);
  return { id, home, p1, p2, out: p.out, code, turn: t.turn, round: t.round };
}
const newFile = (dir: string, name: string, extra: S[] = []) => scen(dir, name, [...extra, ...agrees(8)]);

// ---------- resume refusals ----------
/** CLI refusal: code 2, "Ошибка:" with the expected text, journal byte-for-byte unchanged, no lock. */
async function refusedCli(home: string, id: string, args: string[], re: RegExp, what: string): Promise<string> {
  const before = jbytes(home, id);
  const r = await runCli(what, home, ["resume", id, ...args]);
  must(r.code === 2, `${what}: code ${r.code}, expected 2${dump(r)}`);
  must(/^Ошибка:/m.test(r.err), `${what}: no "Ошибка:" in stderr${dump(r)}`);
  must(re.test(r.err), `${what}: refusal text did not match ${re}${dump(r)}`);
  must(jbytes(home, id).equals(before), `${what}: journal bytes changed`);
  noLock(home, id);
  return r.err.trim().split("\n")[0]!.slice(0, 130);
}

// ---------- MCP ----------
type Res = { isError?: boolean; content: { type: string; text: string }[] };
interface Srv { client: Client; pid: number }
const servers: Srv[] = [];
async function connect(home: string): Promise<Srv> {
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_DEV: "1", COUNCIL_HOME: home };
  const transport = new StdioClientTransport({ command: process.execPath, args: [mainTs], cwd: repo, stderr: "ignore", env });
  const client = new Client({ name: "replacement-check", version: "0" });
  await client.connect(transport);
  const s = { client, pid: transport.pid! };
  servers.push(s);
  return s;
}
const call = async (s: Srv, name: string, args: Record<string, unknown> = {}) => (await s.client.callTool({ name, arguments: args })) as Res;
const body = (r: Res) => r.content[0]?.text ?? "";
const json = (r: Res, what: string) => { if (r.isError) throw new Error(`${what}: tool error: ${body(r).slice(0, 300)}`); return JSON.parse(body(r)); };
const status = async (s: Srv, sessionId: string, waitSec?: number) => json(await call(s, "council_status", { sessionId, ...(waitSec === undefined ? {} : { waitSec }) }), "council_status");
async function statusUntilDone(s: Srv, id: string, ms = 60000) {
  let st: any;
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) { st = await status(s, id, 3); if (st.status !== "running") return st; }
  throw new Error(`timed out waiting for session ${id} to finish: ${st?.status}`);
}
const rep = (participantId: string, model: string) => ({ participantId, providerId: "scripted", model });
/** council_resume refusal: isError, text starts with "<code>:", journal unchanged, no lock. */
async function refusedMcp(s: Srv, home: string, id: string, args: Record<string, unknown>, code: string): Promise<string> {
  const before = jbytes(home, id);
  const r = await call(s, "council_resume", { sessionId: id, ...args });
  must(r.isError === true, `no isError, response: ${body(r).slice(0, 200)}`);
  must(body(r).startsWith(`${code}:`), `expected code ${code}:, got: ${body(r).slice(0, 200)}`);
  must(jbytes(home, id).equals(before), "journal bytes changed");
  noLock(home, id);
  return body(r).slice(0, 90);
}

// =====================================================================
// Part A. CLI, recoverable failed
// =====================================================================
async function partA() {
  const home = homeOf("A"), dir = scenDir("A");
  const init = await runCli("A: data folder initialization", home, ["list"]); // config.json is created once
  must(init.code === 0, `council list: code ${init.code}${dump(init)}`);
  const S1 = lazy(() => failedSession(home, dir, "a1"));
  const pre = lazy(async () => { const f = await S1(); const b = jbytes(home, f.id); return { b, es: evs(home, f.id) }; });
  const newA = newFile(dir, "a-new");

  await step("A1 failed: p2 crashes, the journal ends with session_finished failed with a reasonCode, the output hints at --replace", async (o) => {
    const f = await S1();
    must(f.code === 5, `code ${f.code}, expected 5${f.out}`);
    const last = evs(home, f.id).at(-1)!;
    must(last.type === "session_finished" && last.status === "failed", `last event ${last.type}/${last.status}`);
    eq(last.reasonCode, "insufficient_active_participants", "reasonCode");
    must(f.out.includes("--replace"), `no --replace hint in the output${f.out}`);
    o.sessionId = f.id;
    return `session ${f.id}, code 5, last event session_finished failed (${last.reasonCode}), output contains "--replace"`;
  });
  await step("A2 resume without replacement: refusal, p2 is named", async () => {
    const f = await S1();
    const msg = await refusedCli(home, f.id, ["--rounds", "2"], /p2/, "A2");
    return `code 2, "${msg}"; journal unchanged, no resume.lock`;
  });
  await step("A3 replacement errors: repeated pN, unknown p9, available p1 (alone and together with p2), missing file, entry without \"=\"", async () => {
    const f = await S1();
    const r = ["--rounds", "2"];
    const m: string[] = [];
    m.push(await refusedCli(home, f.id, [...r, "--replace", `p2=scripted:${newA}`, "--replace", `p2=scripted:${newA}`], /p2|повтор/i, "A3 repeated p2"));
    m.push(await refusedCli(home, f.id, [...r, "--replace", `p9=scripted:${newA}`], /p9/, "A3 p9"));
    m.push(await refusedCli(home, f.id, [...r, "--replace", `p1=scripted:${newA}`], /активных участников меньше двух/, "A3 p1 only"));
    m.push(await refusedCli(home, f.id, [...r, "--replace", `p2=scripted:${newA}`, "--replace", `p1=scripted:${newA}`], /Участник p1 [^\n]*доступен/, "A3 p1 available"));
    m.push(await refusedCli(home, f.id, [...r, "--replace", `p2=scripted:${join(dir, "нет-такого.json")}`], /нет-такого|не найден|не удалось|недоступ/i, "A3 missing file"));
    m.push(await refusedCli(home, f.id, [...r, "--replace", "p2"], /--replace/, "A3 entry without \"=\""));
    return `six refusals with code 2 and an unchanged journal: ${m.map((x) => `«${x.slice(0, 60)}»`).join(" | ")}`;
  });
  await step("A4 resume --replace p2=…: output, journal prefix, one session_resumed, both agreed, version unchanged", async (o) => {
    const f = await S1(), { b: before, es: preEs } = await pre();
    const ids = sessionsIn(home);
    const r = await runCli("A4", home, ["resume", f.id, "--rounds", "2", "--replace", `p2=scripted:${newA}`]);
    must(r.code === 0, `code ${r.code}, expected 0${dump(r)}`);
    const rl = /^Замена: p2 [^\n]*→ p3 [^\n]*причина: выбыл:[^\n]*$/m.exec(r.out)?.[0];
    must(rl, `no line "Замена: p2 … → p3 … причина: выбыл:"${dump(r)}`);
    must(/^Согласия сброшены/m.test(r.out), `no line "Согласия сброшены"${dump(r)}`);
    const act = /^Активный состав:[^\n]*$/m.exec(r.out)?.[0] ?? "";
    must(/p1/.test(act) && /p3/.test(act) && !/p2/.test(act), `"Активный состав" lacks p1 and p3 or contains p2: ${show(act)}`);
    must(r.out.includes("не более 12 вызовов") && r.out.includes("2 × 2 × 3"), `call bound is not 12 (2 × 2 × 3)${dump(r)}`);
    eq(sessionsIn(home), ids, "session list (id unchanged, no new sessions)");
    const after = jbytes(home, f.id);
    must(after.length > before.length && after.subarray(0, before.length).equals(before), "old journal bytes are not a prefix of the new journal");
    const es = evs(home, f.id), ri = resumedIdx(es);
    eq(ofType(es, "session_resumed").length, 1, "session_resumed events");
    eq(es[ri]!.replacements.map((x: any) => [x.oldParticipantId, x.participant.id]), [["p2", "p3"]], "replacements");
    const post = es.slice(ri + 1);
    must(!post.some((e) => e.type === "turn_started" && e.participantId === "p2"), "p2 started a turn after the replacement");
    const agreed = new Set(post.filter((e) => e.type === "turn_completed" && e.stance === "agree").map((e) => e.participantId));
    must(agreed.has("p1") && agreed.has("p3"), `completed agree after replacement: ${[...agreed]} (p1 and p3 required)`);
    const st = foldOf(es), preSt = foldOf(preEs);
    eq(foldOf(es.slice(0, ri + 1)).agreed, [], "agreed right after session_resumed");
    eq(st.status, "consensus", "outcome");
    eq([currentVersion(st)?.number, currentVersion(st)?.authorId], [currentVersion(preSt)?.number, currentVersion(preSt)?.authorId], "version number and author before/after");
    eq(st.turns.slice(0, preSt.turns.length).map((t) => [t.turn, t.participantId]), preSt.turns.map((t) => [t.turn, t.participantId]), "authors of earlier turns");
    const p = (id: string) => st.participants.find((x) => x.id === id);
    eq([p("p2")?.status, p("p2")?.replacedBy, p("p3")?.status, p("p3")?.replaces], ["dropped", "p3", "active", "p2"], "p2/p3 in the fold");
    o.replaceLine = rl;
    return `code 0; "${rl.slice(0, 70)}…"; ${act}; bound 12; id ${f.id} unchanged; prefix ${before.length} B of ${after.length}; one session_resumed p2→p3; agree after replacement: p1, p3; version ${currentVersion(st)?.number} author ${currentVersion(st)?.authorId} same as before`;
  });
  await step("A5 show: earlier turns, \"замена: p2 → p3\", outcome", async () => {
    const f = await S1();
    const r = await runCli("A5", home, ["show", f.id]);
    must(r.code === 0, `show: code ${r.code}${dump(r)}`);
    must(/Ход 1 · круг 1 · p1/.test(r.out), `no early turn 1${r.out}`);
    must(/замена: p2 → p3/.test(r.out), `no line "замена: p2 → p3"${r.out}`);
    must(/Статус: consensus/.test(r.out) && /══ Итог: consensus/.test(r.out), `no consensus outcome${r.out}`);
    return "early turn 1, \"замена: p2 → p3\", \"Статус: consensus\", \"══ Итог: consensus\"";
  });
  await step("A6 tokens: total = usage before resume + new turns, nothing reset", async (o) => {
    const f = await S1(), { es: preEs } = await pre();
    const st = foldOf(evs(home, f.id)), preSt = foldOf(preEs);
    const pre0 = tokenUsage(preSt).total, post0 = tokenUsage(st).total;
    const maxPre = Math.max(0, ...preSt.turns.map((t) => t.turn));
    const added = st.turns.filter((t) => t.turn > maxPre).reduce((n, t) => n + (t.usage.inputTokens ?? 0) + (t.usage.outputTokens ?? 0), 0);
    must(pre0 > 0 && added > 0, `usage before ${pre0}, new turns ${added}`);
    eq(post0, pre0 + added, "usage after = before + new turns");
    o.tokens = { pre: pre0, added, post: post0 };
    return `before ${pre0}, new turns ${added}, after ${post0}`;
  });
  await step("A7 failed without reasonCode: refusal with \"сбоем\" even with a valid replacement", async () => {
    const f = await failedSession(home, dir, "a7");
    const lines = jbytes(home, f.id).toString("utf8").split("\n").filter(Boolean);
    const last = JSON.parse(lines.at(-1)!);
    must(last.type === "session_finished" && last.reasonCode, `last line is not session_finished with a reasonCode: ${lines.at(-1)}`);
    delete last.reasonCode;
    lines[lines.length - 1] = JSON.stringify(last);
    writeFileSync(journalPath(home, f.id), `${lines.join("\n")}\n`);
    const msg = await refusedCli(home, f.id, ["--rounds", "2", "--replace", `p2=scripted:${newFile(dir, "a7-new")}`], /сбоем/, "A7");
    return `code 2, "${msg}"`;
  });
  await step("A8 corrupted journal and missing material snapshot: refusal with a valid replacement", async () => {
    const c = await failedSession(home, dir, "a8c");
    appendFileSync(journalPath(home, c.id), '{"seq":99,"ts":"2026-');
    const m1 = await refusedCli(home, c.id, ["--rounds", "2", "--replace", `p2=scripted:${newFile(dir, "a8c-new")}`], /повреждён/, "A8 journal");
    const note = join(work, "note.txt");
    writeFileSync(note, "Заметка: кот рыжий.");
    const m = await failedSession(home, dir, "a8m", { flags: ["--attach", note] });
    must(m.code === 5, `a8m: code ${m.code}${m.out}`);
    const mdir = join(sdir(home, m.id), "materials");
    const snaps = readdirSync(mdir);
    must(snaps.length > 0, "the session has no material snapshots");
    for (const s of snaps) rmSync(join(mdir, s), { recursive: true, force: true });
    const m2 = await refusedCli(home, m.id, ["--rounds", "2", "--replace", `p2=scripted:${newFile(dir, "a8m-new")}`], /Материал «/, "A8 material");
    return `journal: "${m1}"; material: "${m2}"; in both the bytes are unchanged, no lock, the map is not written`;
  });
  await step("A9 token ceiling not reset: refusal with the ceiling and usage numbers", async (o) => {
    const f = await failedSession(home, dir, "a9", { p2: [badRaw(), crash()], flags: ["--max-tokens", "300"] });
    must(f.code === 5, `a9: code ${f.code}, expected 5${f.out}`);
    const spent = tokenUsage(foldOf(evs(home, f.id))).total;
    must(spent >= 300, `spent ${spent}, expected at least the ceiling 300`);
    const msg = await refusedCli(home, f.id, ["--rounds", "2", "--replace", `p2=scripted:${newFile(dir, "a9-new")}`], new RegExp(`потолок токенов 300[^\\n]*${spent}`), "A9");
    o.spent = spent;
    return `ceiling 300, spent ${spent}; "${msg}"`;
  });
}

// =====================================================================
// Part B. CLI, stopped with an unavailable active p2
// =====================================================================
async function partB() {
  const home = homeOf("B"), dir = scenDir("B");
  await runCli("B: initialization", home, ["list"]);
  const S = lazy(() => stoppedSession(home, dir, "b"));
  const newB = newFile(dir, "b-new");

  await step("B1 stop during p2 turn: code 4, stopped, p2 turn started and not completed, q1 open to p2", async (o) => {
    const f = await S();
    eq(f.code, 4, "code");
    eq(statusOf(home, f.id), "stopped", "status");
    const es = evs(home, f.id), st = foldOf(es);
    must(ofType(es, "turn_started").some((e) => e.turn === f.turn && e.participantId === "p2"), "no turn_started for p2");
    must(!ofType(es, "turn_completed").some((e) => e.turn === f.turn), `turn ${f.turn} completed`);
    const q = st.questions.find((x) => x.id === "q1");
    eq([q?.to, q?.status], ["p2", "open"], "q1: addressee/status");
    o.turn = f.turn; o.round = f.round;
    return `session ${f.id}: code 4, stopped, turn ${f.turn} (round ${f.round}) p2 started and not completed, q1 open to p2`;
  });
  await step("B2 p2 scenario removed: resume without replacement is refused, p2 is named", async () => {
    const f = await S();
    rmSync(f.p2);
    const msg = await refusedCli(home, f.id, ["--rounds", "2"], /p2/, "B2");
    return `code 2, "${msg}"`;
  });
  await step("B3 resume --replace p2=Новый=…: \"недоступен:\", p3 takes turn N+1 in the same round, q1 replaced, p2 no longer takes turns", async (o) => {
    const f = await S();
    const before = jbytes(home, f.id), qText = foldOf(evs(home, f.id)).questions.find((x) => x.id === "q1")!.text;
    const r = await runCli("B3", home, ["resume", f.id, "--rounds", "2", "--replace", `p2=Новый=scripted:${newB}`]);
    must(r.code === 0, `code ${r.code}, expected 0${dump(r)}`);
    const rl = /^Замена: p2 [^\n]*$/m.exec(r.out)?.[0] ?? "";
    must(rl.includes("причина: недоступен:") && rl.includes("«Новый»"), `replacement line: ${show(rl)}`);
    const es = evs(home, f.id), ri = resumedIdx(es), post = es.slice(ri + 1);
    must(jbytes(home, f.id).subarray(0, before.length).equals(before), "old bytes are not a prefix");
    const first = post.find((e) => e.type === "turn_started")!;
    eq([first.participantId, first.turn, first.round], ["p3", f.turn + 1, f.round], "first turn_started after resume (participant/turn/round)");
    must(!post.some((e) => e.type === "turn_started" && e.turn === f.turn), `turn ${f.turn} was started again`);
    must(!post.some((e) => e.type === "turn_started" && e.participantId === "p2"), "p2 started a turn after the replacement");
    const q = foldOf(es).questions.find((x) => x.id === "q1");
    eq([q?.status, q?.text], ["replaced", qText], "q1: status/text");
    must(!ofType(es, "question_closed").some((e) => e.questionId === "q1"), "the journal has question_closed for q1");
    o.line = rl;
    return `code 0; "${rl.slice(0, 60)}… ${rl.slice(rl.indexOf("причина"))}"; p3 goes first, turn ${first.turn} round ${first.round} (the interrupted one was ${f.turn}); q1 replaced with the old text, no question_closed; outcome ${foldOf(es).status}`;
  });
}

// =====================================================================
// Part C. MCP over stdio
// =====================================================================
async function partC() {
  const home = homeOf("C"), dir = scenDir("C");
  await runCli("C: initialization", home, ["list"]);
  const f = await failedSession(home, dir, "c");
  const fileA = newFile(dir, "c-newA"), fileB = newFile(dir, "c-newB");
  const srv = await connect(home);
  const mapA = [rep("p2", fileA)];
  let plan: any;
  try {
    await step("C1 plan with replacements: replacements, agreementReset, lineup, maxCalls, planToken, journal unchanged", async (o) => {
      const before = jbytes(home, f.id);
      plan = json(await call(srv, "council_resume", { sessionId: f.id, rounds: 2, replacements: mapA }), "council_resume (plan)");
      eq(plan.accepted, false, "accepted");
      eq(plan.replacements.length, 1, "number of replacements");
      const r = plan.replacements[0];
      eq([r.oldParticipantId, r.reason.startsWith("выбыл:")], ["p2", true], "replacement: old/reason \"выбыл:\"");
      must(typeof r.newParticipantId === "string" && r.newParticipantId && typeof r.name === "string" && r.name, `new participant: ${JSON.stringify(r)}`);
      eq(plan.agreementReset, true, "agreementReset");
      eq(plan.participants.map((p: any) => p.id), ["p1", r.newParticipantId], "participants of the future lineup");
      must(Number.isInteger(plan.maxCalls) && plan.maxCalls > 0, `maxCalls ${plan.maxCalls}`);
      must(/^[0-9a-f]{64}$/.test(plan.planToken), `planToken ${plan.planToken}`);
      must(jbytes(home, f.id).equals(before), "journal changed after the plan");
      noLock(home, f.id);
      o.plan = plan;
      return `p2 → ${r.newParticipantId} "${r.name}", reason "${r.reason.slice(0, 40)}…", agreementReset true, participants ${plan.participants.map((p: any) => p.id)}, maxCalls ${plan.maxCalls}, token ${plan.planToken.slice(0, 8)}…`;
    });
    await step("C2 execute with the old token but a different model: stale_plan", async () => {
      must(plan, "no plan from C1");
      const msg = await refusedMcp(srv, home, f.id, { rounds: 2, execute: true, planToken: plan.planToken, replacements: [rep("p2", fileB)] }, "stale_plan");
      return `"${msg}"; journal unchanged, no lock`;
    });
    await step("C3 the same pN twice: replacement:, council_status answers after the refusal", async () => {
      const msg = await refusedMcp(srv, home, f.id, { rounds: 2, replacements: [rep("p2", fileA), rep("p2", fileB)] }, "replacement");
      const st = await status(srv, f.id);
      eq(st.status, "failed", "council_status after the refusal");
      return `"${msg}"; council_status: ${st.status}`;
    });
    await step("C4 execute with the same map and token: accepted, consensus outcome, replaces/replacedBy, one session_resumed", async (o) => {
      must(plan, "no plan from C1");
      const before = jbytes(home, f.id);
      const ex = json(await call(srv, "council_resume", { sessionId: f.id, rounds: 2, execute: true, planToken: plan.planToken, replacements: mapA }), "council_resume execute");
      eq(ex.accepted, true, "accepted");
      const st = await statusUntilDone(srv, f.id);
      eq(st.status, "consensus", "outcome");
      const nid = plan.replacements[0].newParticipantId;
      const byId = (id: string) => st.participants.find((p: any) => p.id === id);
      eq([byId("p2")?.replacedBy, byId(nid)?.replaces], [nid, "p2"], "replacedBy / replaces");
      const es = evs(home, f.id);
      eq(ofType(es, "session_resumed").length, 1, "session_resumed events");
      eq(es[resumedIdx(es)]!.replacements.map((x: any) => [x.oldParticipantId, x.participant.id]), [["p2", nid]], "replacements in the journal");
      must(jbytes(home, f.id).subarray(0, before.length).equals(before), "old bytes are not a prefix");
      noLock(home, f.id);
      o.final = st;
      return `accepted, outcome ${st.status}; p2.replacedBy ${nid}, ${nid}.replaces p2; session_resumed 1 with replacements; reasonCode ${JSON.stringify(st.reasonCode)}`;
    });
  } finally {
    srv.client.close().catch(() => {});
  }
}

// =====================================================================
// Part D. Adapter race: CLI --replace vs MCP execute
// =====================================================================
async function partD() {
  const home = homeOf("D"), dir = scenDir("D");
  await runCli("D: initialization", home, ["list"]);
  const srv = await connect(home);
  const slowNew = (name: string) => scen(dir, name, [agree({ delayMs: 2500 }), ...agrees(8)]); // the new participant is slow: the winner holds the lock and the journal stays "running"
  try {
    for (const n of [1, 2, 3]) {
      await step(`D${n} race: CLI resume --replace and MCP execute at the same time — one executor`, async (o) => {
        const f = await failedSession(home, dir, `d${n}`);
        const fa = slowNew(`d${n}-A`), fb = slowNew(`d${n}-B`);
        const plan = json(await call(srv, "council_resume", { sessionId: f.id, rounds: 2, replacements: [rep("p2", fb)] }), "plan D");
        const proc = cli(home, ["resume", f.id, "--rounds", "2", "--replace", `p2=scripted:${fa}`]);
        await sleep((n - 1) * 600); // offset of the MCP start relative to the CLI: either may win, what matters is that there is exactly one
        const mcpRes = await call(srv, "council_resume", { sessionId: f.id, rounds: 2, execute: true, planToken: plan.planToken, replacements: [rep("p2", fb)] });
        const code = await finish(proc, `D${n}: CLI`);
        const cliWon = code !== 2 && /Продолжение сессии/.test(proc.out);
        const mcpWon = !mcpRes.isError && JSON.parse(body(mcpRes)).accepted === true;
        must(cliWon !== mcpWon, `not exactly one executor: CLI code ${code} (${cliWon}), MCP accepted ${mcpWon}${dump(proc)}MCP: ${body(mcpRes).slice(0, 200)}`);
        if (cliWon) {
          must(mcpRes.isError && /^(busy|running|stale_plan):/.test(body(mcpRes)), `losing MCP: ${body(mcpRes).slice(0, 200)}`);
          eq(code, 0, "exit code of the winning CLI");
        } else {
          must(code === 2 && /Ошибка:[^\n]*(уже продолжает|идёт: исполнитель|busy|running)/.test(proc.err), `losing CLI: code ${code}${dump(proc)}`);
        }
        await until(`D${n}: session finished`, () => evs(home, f.id).at(-1)?.type === "session_finished" && resumedIdx(evs(home, f.id)) >= 0 && evs(home, f.id).slice(resumedIdx(evs(home, f.id))).some((e) => e.type === "session_finished"), 60000);
        const es = evs(home, f.id);
        eq(ofType(es, "session_resumed").length, 1, "session_resumed events");
        const turns = ofType(es, "turn_started").map((e) => e.turn);
        eq(new Set(turns).size, turns.length, `turn numbers are unique (${turns})`);
        await until(`D${n}: resume.lock removed`, () => !existsSync(lockPath(home, f.id)), 10000);
        o.winner = cliWon ? "cli" : "mcp";
        return `winner ${cliWon ? "CLI" : "MCP"}, loser: ${cliWon ? `MCP "${body(mcpRes).slice(0, 50)}"` : `CLI code 2 "${proc.err.trim().split("\n")[0]!.slice(0, 60)}"`}; session_resumed 1, turns ${turns.join(",")} unique, no resume.lock`;
      });
    }
  } finally {
    srv.client.close().catch(() => {});
  }
}

// =====================================================================
// Part E. Drafts and owner wait
// =====================================================================
async function partE() {
  const home = homeOf("E"), dir = scenDir("E");
  await runCli("E: initialization", home, ["list"]);
  await step("E1 --drafts: the new participant inherits the draft slot (same draftId, attempt 2, at most 3), the accepted draft is not repeated", async (o) => {
    const draft = (l: string, x: S = {}) => amend(`Черновик ${l}`, x);
    const p1 = scen(dir, "e1-p1", [draft("p1"), amend("Версия 1 синтезатора"), ...agrees(8)]);
    const p2 = scen(dir, "e1-p2", [draft("p2", { delayMs: 120000 }), ...agrees(8)]);
    const p3 = scen(dir, "e1-p3", [draft("p3"), ...agrees(8)]);
    const p = cli(home, ["--topic", TOPIC, "--drafts", "--synthesizer", "p1", ...parts(p1, p2, p3), "--max-rounds", "2"]);
    const id = await until("E1: session id", () => /^Сессия (\S+) ·/m.exec(p.out)?.[1]);
    await until("E1: first draft attempt of p2 started", () => ofType(evs(home, id), "draft_attempt_started").find((e) => e.participantId === "p2"));
    p.child.kill("SIGINT");
    eq(await finish(p, "E1: stop"), 4, "stop code");
    const preEs = evs(home, id);
    const slot = ofType(preEs, "draft_attempt_started").find((e) => e.participantId === "p2")!.draftId as string;
    const d1 = ofType(preEs, "draft_completed").find((e) => e.participantId === "p1");
    must(d1, "p1 draft was not accepted before the stop");
    rmSync(p2);
    const nf = scen(dir, "e1-new", [draft("новый"), ...agrees(8)]);
    const r = await runCli("E1: resume", home, ["resume", id, "--rounds", "2", "--replace", `p2=scripted:${nf}`]);
    must(r.code === 0, `code ${r.code}, expected 0${dump(r)}`);
    const es = evs(home, id), post = es.slice(resumedIdx(es) + 1);
    const mine = post.filter((e) => e.type === "draft_attempt_started" && e.participantId === "p4");
    must(mine.length > 0, "the new participant did not start a draft");
    eq([mine[0]!.draftId, mine[0]!.attempt], [slot, 2], "first attempt of the new one: draftId/attempt");
    const inSlot = ofType(es, "draft_attempt_started").filter((e) => e.draftId === slot);
    must(inSlot.length <= 3, `slot ${slot} has ${inSlot.length} attempts`);
    const d1Again = post.filter((e) => e.type === "draft_attempt_started" && e.draftId === d1.draftId);
    eq(d1Again.length, 0, "repeat attempts of the accepted p1 draft");
    must(post.some((e) => e.type === "turn_started"), "no regular turns after the drafts");
    return `slot ${slot}: p2 attempt #1 (interrupted), new p4 from attempt ${mine[0]!.attempt}, ${inSlot.length} in the slot in total; draft ${d1.draftId} of p1 was not requested again; regular turns present, outcome ${foldOf(es).status}`;
  });

  await step("E2 owner wait: the same deadline after resume --replace, no turns before continue, continue releases it", async (o) => {
    const p1 = scen(dir, "e2-p1", [amend("Версия 1 кота"), ...agrees(8)]);
    const p2 = scen(dir, "e2-p2", [amend("Версия 2 кота"), ...agrees(8)]);
    const p = cli(home, ["--topic", TOPIC, ...parts(p1, p2), "--max-rounds", "3", "--pause-after-round", "--owner-wait-sec", "600"]);
    const id = await until("E2: session id", () => /^Сессия (\S+) ·/m.exec(p.out)?.[1]);
    const w = await until("E2: owner_wait_started", () => ofType(evs(home, id), "owner_wait_started")[0]);
    const st = await runCli("E2: status", home, ["status", id]);
    const deadline = /Срок: (\S+),/.exec(st.out)?.[1];
    must(deadline, `status without a deadline${dump(st)}`);
    eq(deadline, w.deadline, "deadline in status and in the journal");
    p.child.kill("SIGKILL");
    await finish(p, "E2: executor terminated");
    await until("E2: status interrupted", () => statusOf(home, id) === "interrupted");
    rmSync(p2);
    const nf = scen(dir, "e2-new", agrees(8));
    const turns0 = ofType(evs(home, id), "turn_started").length;
    const q = cli(home, ["resume", id, "--rounds", "2", "--replace", `p2=scripted:${nf}`]);
    const line = await until("E2: line \"Ожидание владельца … продолжается\"", () => /^Ожидание владельца \S+ продолжается до (\S+):/m.exec(q.out));
    eq(line[1], deadline, "deadline after resume");
    for (const t0 = Date.now(); Date.now() - t0 < 1500; await sleep(100)) eq(ofType(evs(home, id), "turn_started").length, turns0, "turn_started during the wait");
    eq(q.child.exitCode, null, "resume is alive while waiting");
    const c = await runCli("E2: continue", home, ["continue", id]);
    eq(c.code, 0, "continue exit code");
    eq(await finish(q, "E2: resume to the end"), 0, "resume exit code after continue");
    const es = evs(home, id);
    must(ofType(es, "turn_started").length > turns0, "no turns after continue");
    eq(statusOf(home, id), "consensus", "outcome");
    return `deadline ${deadline} is the same in status before termination and in resume; turns during 1.5 s of waiting 0 (was ${turns0}); continue → code 0, outcome consensus`;
  });
}

// =====================================================================
// --prepare-only
// =====================================================================
async function prepare() {
  const dir = scenDir("prep");
  const out: { what: string; home: string; id: string; status: string; cmd: string }[] = [];
  const hf = homeOf("prep-failed");
  await runCli("prep: initialization", hf, ["list"]);
  const f = await failedSession(hf, dir, "pf");
  const nf = newFile(dir, "prep-new-failed");
  out.push({ what: "recoverable failed (p2 dropped)", home: hf, id: f.id, status: statusOf(hf, f.id), cmd: `COUNCIL_DEV=1 COUNCIL_HOME=${hf} npx council resume ${f.id} --rounds 2 --replace p2=scripted:${nf}` });
  const hs = homeOf("prep-stopped");
  await runCli("prep: initialization", hs, ["list"]);
  const s = await stoppedSession(hs, dir, "ps");
  rmSync(s.p2);
  const ns = newFile(dir, "prep-new-stopped");
  out.push({ what: "stopped, scenario of the active p2 removed", home: hs, id: s.id, status: statusOf(hs, s.id), cmd: `COUNCIL_DEV=1 COUNCIL_HOME=${hs} npx council resume ${s.id} --rounds 2 --replace p2=scripted:${ns}` });
  for (const o of out) console.log(`${o.what}\n  COUNCIL_HOME: ${o.home}\n  session: ${o.id}\n  status: ${o.status}\n  command: cd ${repo} && ${o.cmd}\n`);
  console.log(`Fixtures in ${work} (not removed). Model calls: 0`);
}

// =====================================================================
let failed = false;
try {
  if (prepareOnly) {
    await prepare();
  } else {
    await partA();
    await partB();
    await partC();
    await partD();
    await partE();
  }
} catch (e) {
  failed = true;
  console.error(`STAND CRASH: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  for (const k of kids) k.kill("SIGKILL");
  for (const s of servers) s.client.close().catch(() => {});
  if (!prepareOnly) {
    const passed = recs.filter((r) => r.ok).length;
    console.log(`Passed ${passed} of ${EXPECTED}`);
    const ok = !failed && passed === EXPECTED && recs.length === EXPECTED;
    if (outFile) writeFileSync(resolve(outFile), JSON.stringify({ work: ok && !keep ? null : work, passed, expected: EXPECTED, steps: recs }, null, 1));
    if (keep || !ok) console.log(`Stand kept: ${work}`); else rmSync(work, { recursive: true, force: true });
    process.exitCode = ok ? 0 : 1;
  }
}
