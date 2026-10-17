// Live check of "independent drafts": real council processes and an MCP server over stdio, scripted participants only (0 model calls).
//   COUNCIL_DEV=1 node packages/core/scenarios/independent-drafts/check.ts [--keep] [--out <file.json>]
// Writes only to .council-data/independent-drafts-check-* inside the project (each part has its own data folder);
// without --keep it deletes it. The owner's data folder and the COUNCIL_HOME environment variable are not used.
import "../language-ru.ts";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  INITIAL_MATERIALS, collectSessionMaterials, createScriptedDriver, createSession, ensureDataDir, foldEvents, runStoredSession,
  selectOwnerVersion, tokenUsage,
} from "../../src/index.ts";
import type { ParticipantDriver, Scenario } from "../../src/index.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Scripted participants are available only with COUNCIL_DEV=1. Run: COUNCIL_DEV=1 node packages/core/scenarios/independent-drafts/check.ts");
  process.exit(1);
}
const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const outFile = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : undefined;
const repo = resolve(import.meta.dirname, "../../../..");
const councilTs = join(repo, "packages/core/src/council.ts");
const mainTs = join(repo, "packages/mcp/src/main.ts");
const fixtures = "independent-drafts"; // relative to packages/core/scenarios (this is how the MCP server sees them)
const sampleDir = join(repo, "packages/core/scenarios/folder/sample");

mkdirSync(join(repo, ".council-data"), { recursive: true });
const workPath = join(repo, ".council-data", `independent-drafts-check-${Date.now()}-${randomBytes(3).toString("hex")}`);
mkdirSync(workPath, { recursive: true });
const work = realpathSync(workPath);
const homeOf = (n: string) => { const d = join(work, `home-${n}`); mkdirSync(d, { recursive: true }); return d; };
const scenDir = (n: string) => { const d = join(work, `scen-${n}`); mkdirSync(d, { recursive: true }); return d; };
const rnd = () => randomBytes(3).toString("hex");

// ---------- steps and report ----------
interface Rec { name: string; ok: boolean; note?: string; error?: string; obs: Record<string, unknown> }
const recs: Rec[] = [];
const runs: { label: string; args: string[]; code: number | null; out: string; err: string }[] = [];
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
async function until<T>(what: string, fn: () => T | Promise<T>, ms = 20000): Promise<NonNullable<T>> {
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
function spawnNode(file: string, args: string[], home: string): Proc {
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_DEV: "1", COUNCIL_HOME: home };
  const child = spawn(process.execPath, [file, ...args], { env, cwd: repo });
  kids.add(child);
  const p: Proc = { child, out: "", err: "", exited: new Promise((res) => child.on("close", (c) => { kids.delete(child); res(c); })) };
  child.stdout!.on("data", (d) => { p.out += d; });
  child.stderr!.on("data", (d) => { p.err += d; });
  return p;
}
const cli = (home: string, args: string[]) => spawnNode(councilTs, args, home);
async function runCli(label: string, home: string, args: string[]) {
  const p = cli(home, args);
  const code = await p.exited;
  runs.push({ label, args, code, out: p.out, err: p.err });
  return { code, out: p.out, err: p.err, id: /^Сессия (\S+) ·/m.exec(p.out)?.[1] ?? "" };
}
const dump = (r: { out: string; err: string }) => `\n--- stdout ---\n${r.out}\n--- stderr ---\n${r.err}`;

// ---------- journal ----------
type Ev = Record<string, any> & { seq: number; type: string };
const journalPath = (home: string, id: string) => join(home, "sessions", id, "events.jsonl");
const evs = (home: string, id: string): Ev[] => readFileSync(journalPath(home, id), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ofType = (home: string, id: string, t: string) => evs(home, id).filter((e) => e.type === t);
const types = (home: string, id: string) => evs(home, id).map((e) => e.type);
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const nSessions = (home: string) => (existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")).length : 0);
const draftFile = (home: string, id: string, d: string) => join(home, "sessions", id, "drafts", `${d}.txt`);
const started = (es: Ev[], d: string) => es.filter((e) => e.type === "draft_attempt_started" && e.draftId === d).map((e) => e.attempt as number);

// ---------- scenarios ----------
type S = Record<string, unknown>;
const R = (stance: string, reasoning: string, solution: string | null = null, extra: S = {}) => ({ stance, reasoning, solution, answers: [], questions: [], files: [], ...extra });
const draft = (label: string, extra: S = {}) => ({ response: R("amend", `Довод ${label}`, `Решение ${label}`), ...extra });
const amend = (text: string, extra: S = {}) => ({ response: R("amend", `Довод ${text}`, text), ...extra });
const agree = (extra: S = {}) => ({ response: R("agree", "Согласен"), ...extra });
const agrees = (n: number) => Array.from({ length: n }, () => agree());
function scen(dir: string, name: string, steps: S[]): string {
  const p = join(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify({ steps }));
  return p;
}
const parts = (...ps: string[]) => ps.flatMap((p) => ["--participant", `scripted:${p}`]);
const stdDrafts = (dir: string, tag: string, regular: (S[])[], lbl: string[]) =>
  regular.map((r, i) => scen(dir, `${tag}-p${i + 1}`, [draft(lbl[i]!), ...r]));
const cycle = ["p2", "p3", "p1"];

// =====================================================================
// Part A. Real CLI, launch
// =====================================================================
async function partA() {
  const home = homeOf("A"), dir = scenDir("A");
  const L = [`МЕТКА-P1-${rnd()}`, `МЕТКА-P2-${rnd()}`, `МЕТКА-P3-${rnd()}`];
  const [s1, s2, s3] = stdDrafts(dir, "a", [
    [agree({ expectPrompt: L[2] }), ...agrees(3)],
    [amend("Версия p2 по плану", { expectPrompt: L[0] }), ...agrees(3)],
    [amend("Версия p3 по плану", { expectPrompt: L[1] }), ...agrees(3)],
  ], L) as [string, string, string];
  const args = ["--topic", "Выберите план", "--drafts", "--synthesizer", "p2", "--max-rounds", "2", ...parts(s1, s2, s3)];
  const run = lazy(() => runCli("A: --drafts --synthesizer p2", home, args));
  const idx = (out: string, re: RegExp) => { const m = re.exec(out); return m ? m.index : -1; };

  await step("A1 experiment line before the first draft", async (o) => {
    const r = await run();
    const line = /^Эксперимент[^\n]*$/m.exec(r.out)?.[0] ?? "";
    must(r.code === 0, `code ${r.code}${dump(r)}`);
    must(/p2/.test(line) && line.includes("не более 27 вызовов"), `experiment line: ${show(line)}`);
    must(idx(r.out, /^Эксперимент/m) < idx(r.out, /^── Черновик p\d/m), "experiment line comes after the first «── Черновик»");
    o.line = line; o.stdout = r.out;
    return `code 0, session ${r.id}; ${line}`;
  });
  await step("A2 three drafts before the first turn", async () => {
    const r = await run();
    const at = [1, 2, 3].map((n) => idx(r.out, new RegExp(`^── Черновик p${n} `, "m")));
    const turn = idx(r.out, /^── Ход /m);
    must(at.every((i) => i >= 0) && at.every((i) => i < turn) && at[0]! < at[1]! && at[1]! < at[2]!, `draft positions ${at}, first turn ${turn}`);
    const ready = /^── Черновики готовы: 3 из 3[^\n]*/m.exec(r.out)?.[0];
    must(ready && idx(r.out, /^── Черновики готовы/m) < turn, "no «Черновики готовы: 3 из 3» before the turn");
    return `positions ${at.join("<")}<${turn}; ${ready}`;
  });
  await step("A3 first turn p2 amend → version 1; order p2, p3, p1", async (o) => {
    const r = await run();
    const first = /^── Ход 1 · круг 1 · p2 [^\n]*amend → версия 1/m.exec(r.out)?.[0];
    must(first, `no first turn p2 amend → version 1${dump(r)}`);
    const order = ofType(home, r.id, "turn_started").map((e) => e.participantId as string);
    must(order.length >= 3, `turns ${order.length}`);
    order.forEach((p, i) => must(p === cycle[i % 3], `turn ${i + 1}: ${p}, expected ${cycle[i % 3]} (order ${order})`));
    o.order = order;
    return `${first.slice(0, 60)}…; turn order ${order.join(",")}`;
  });
  await step("A4 phase events in order; no turns in the phase; no versions or agreed", async () => {
    const r = await run();
    const es = evs(home, r.id);
    const fin = es.findIndex((e) => e.type === "drafts_finished");
    must(fin > 0, "no drafts_finished");
    const before = es.slice(0, fin).map((e) => e.type).filter((t) => t.startsWith("draft_") || t === "turn_started");
    eq(before, ["draft_attempt_started", "draft_completed", "draft_attempt_started", "draft_completed", "draft_attempt_started", "draft_completed"], "phase events");
    const st = foldEvents(es.slice(0, fin + 1) as never);
    must(st.versions.length === 0 && st.agreed.length === 0, `versions ${st.versions.length}, agreed ${st.agreed.length}`);
    return `phase: 3×(started, completed), drafts_finished at seq ${es[fin]!.seq}; versions 0, agreed 0`;
  });
  await step("A5 snapshots d1..d3.txt match sha256 and length", async (o) => {
    const r = await run();
    const done = ofType(home, r.id, "draft_completed");
    eq(done.map((e) => e.draftId), ["d1", "d2", "d3"], "draftId");
    const hs: string[] = [];
    for (const e of done) {
      const text = readFileSync(draftFile(home, r.id, e.draftId), "utf8");
      eq([sha(Buffer.from(text, "utf8")), text.length], [e.sha256, e.chars], `${e.draftId} sha256/length`);
      hs.push(`${e.draftId}:${e.sha256.slice(0, 12)}/${e.chars}`);
    }
    o.hashes = hs;
    return hs.join(" ");
  });
  await step("A6 regular requests contained the others' drafts (expectPrompt)", async () => {
    const r = await run();
    const es = evs(home, r.id);
    must(!es.some((e) => e.type === "participant_dropped" || e.type === "turn_failed"), `dropout or turn failure: ${JSON.stringify(es.filter((e) => e.type === "participant_dropped" || e.type === "turn_failed"))}`);
    const fin = es.find((e) => e.type === "session_finished")!;
    must(fin.status === "consensus", `result ${fin.status}`);
    return `result ${fin.status}, no dropouts or turn failures (labels ${L.join(", ")})`;
  });
  await step("A7 without --drafts: no «Эксперимент», «Черновик», draft_* events", async () => {
    const h = homeOf("A7"), d = scenDir("A7");
    const x = [1, 2, 3].map((i) => scen(d, `x${i}`, [amend(`Вариант ${i} плана`), ...agrees(4)]));
    const r = await runCli("A7: без --drafts", h, ["--topic", "Выберите план", "--max-rounds", "2", ...parts(...x)]);
    must(r.code === 0 || r.code === 3, `code ${r.code}${dump(r)}`);
    must(!r.out.includes("Эксперимент") && !r.out.includes("Черновик"), `experiment words in the output${dump(r)}`);
    const dr = types(h, r.id).filter((t) => t.startsWith("draft"));
    eq(dr, [], "draft* events");
    return `session ${r.id}, code ${r.code}, no «Эксперимент»/«Черновик» in the output, draft events 0`;
  });
  await step("A8 invalid flags: code 2 and no sessions", async () => {
    const h = homeOf("A8");
    const a = await runCli("A8: --drafts --synthesizer p9", h, ["--topic", "t", "--drafts", "--synthesizer", "p9", "--max-rounds", "2", ...parts(s1, s2, s3)]);
    const b = await runCli("A8: --synthesizer p2 without --drafts", h, ["--topic", "t", "--synthesizer", "p2", "--max-rounds", "2", ...parts(s1, s2, s3)]);
    eq([a.code, b.code], [2, 2], "codes");
    eq(nSessions(h), 0, "sessions in the data folder");
    return `codes ${a.code}/${b.code}; «${a.err.trim().split("\n")[0]}» / «${b.err.trim().split("\n")[0]}»; sessions 0`;
  });
}

// =====================================================================
// Part B. Request isolation (real engine and storage in the stand's process)
// =====================================================================
async function partB() {
  const home = homeOf("B");
  ensureDataDir(home);
  const M = [`МЕТКА-B1-${rnd()}`, `МЕТКА-B2-${rnd()}`, `МЕТКА-B3-${rnd()}`];
  const set = collectSessionMaterials([sampleDir], { materialsChars: INITIAL_MATERIALS.materialsChars, materialsIgnore: INITIAL_MATERIALS.materialsIgnore });
  const { workspace, materials } = set;
  const scripts: Record<string, S[]> = {
    p1: [draft(M[0]!), ...agrees(3)],
    p2: [{ response: R("object", "Нужен файл движка", null, { files: ["sample/src/engine.ts"] }) }, { raw: "это не JSON" }, draft(M[1]!), amend("Версия 1 стенда"), ...agrees(3)],
    p3: [{ error: "Сценарный сбой", retryable: true }, draft(M[2]!), ...agrees(3)],
  };
  const calls: { who: string; prompt: string; drafting: boolean }[] = [];
  let drafting = true;
  const drivers: Record<string, ParticipantDriver> = {};
  for (const [who, steps] of Object.entries(scripts)) {
    const real = createScriptedDriver({ steps } as unknown as Scenario, process.env);
    drivers[who] = { async call(request) { calls.push({ who, prompt: request.prompt, drafting }); return real.call(request); } };
  }
  const run = lazy(async () => {
    must(workspace.some((f) => f.name === "sample/src/engine.ts"), `sample/src/engine.ts is not in the snapshot: ${workspace.map((f) => f.name)}`);
    const session = createSession({
      topic: "Выберите план", framing: "", origin: "cli", materials, workspace, drafts: { synthesizerId: "p2" },
      participants: [1, 2, 3].map((i) => ({ name: `Участник ${i}`, providerId: "scripted", model: "check", role: null })),
      limits: { maxRounds: 2, turnTimeoutSec: 30, contextChars: 24000, materialsChars: INITIAL_MATERIALS.materialsChars },
    }, { maxParticipants: 8 });
    const result = await runStoredSession({
      session, drivers, dataDir: home, materials, workspace,
      onEvent: (e) => { if (e.type === "drafts_finished") drafting = false; },
    });
    return { session, result };
  });

  await step("B1 phase requests contain no foreign labels", async (o) => {
    const { session, result } = await run();
    const phase = calls.filter((c) => c.drafting);
    const by = (w: string) => phase.filter((c) => c.who === w);
    eq(["p1", "p2", "p3"].map((w) => by(w).length), [1, 3, 2], "phase requests p1/p2/p3");
    const own: Record<string, string> = { p1: M[0]!, p2: M[1]!, p3: M[2]! };
    for (const c of phase) for (const [w, m] of Object.entries(own)) if (w !== c.who) must(!c.prompt.includes(m), `phase request ${c.who} contains label ${w}`);
    must(by("p2")[1]!.prompt.includes("# Запрошенные файлы"), "second p2 request without the file that was read");
    must(by("p2")[2]!.prompt.includes("Исправь предыдущий ответ"), "third p2 request is not a correction request");
    must(by("p3")[1]!.prompt.length > 0, "no p3 retry");
    o.session = session.id; o.status = result.state.finish?.status;
    return `session ${session.id}: requests checked p1 ${by("p1").length} (initial), p2 ${by("p2").length} (initial, after reading, correction), p3 ${by("p3").length} (initial, retry); foreign labels 0`;
  });
  await step("B2 calls per phase ≤ 3, exactly 3 for p2", async () => {
    await run();
    const n = (w: string) => calls.filter((c) => c.drafting && c.who === w).length;
    must(n("p1") <= 3 && n("p2") <= 3 && n("p3") <= 3, `p1 ${n("p1")}, p2 ${n("p2")}, p3 ${n("p3")}`);
    eq(n("p2"), 3, "p2 calls per phase");
    return `p1 ${n("p1")}, p2 ${n("p2")}, p3 ${n("p3")}`;
  });
  await step("B3 first regular p2 request contains all three drafts", async () => {
    const { result } = await run();
    const first = calls.find((c) => !c.drafting)!;
    eq(first.who, "p2", "participant of the first regular request");
    must(first.prompt.includes("# Независимые черновики"), "no «# Независимые черновики» section");
    for (const m of M) must(first.prompt.includes(m), `no label ${m}`);
    return `section and labels ${M.join(", ")} in place; session result ${result.state.finish?.status}`;
  });
}

// =====================================================================
// Part C. Refusals (real CLI)
// =====================================================================
async function partC() {
  const dir = scenDir("C");
  const lab = (t: string) => [`МЕТКА-${t}1-${rnd()}`, `МЕТКА-${t}2-${rnd()}`, `МЕТКА-${t}3-${rnd()}`];
  const base = ["--topic", "Выберите план", "--drafts", "--max-rounds", "1"];
  const noTurns = (h: string, id: string) => eq(ofType(h, id, "turn_started").length, 0, "turn_started");

  await step("C1 owner question in a draft → invalid_response and retry", async () => {
    const h = homeOf("C1"), l = lab("C1");
    const q = { response: R("amend", "С вопросом", `Решение ${l[0]}`, { questions: [{ to: "owner", text: "Какой бюджет?" }] }) };
    const p1 = scen(dir, "c1-p1", [q, draft(l[0]!), amend("Версия 1 стенда"), ...agrees(2)]);
    const p2 = scen(dir, "c1-p2", [draft(l[1]!), ...agrees(3)]);
    const p3 = scen(dir, "c1-p3", [draft(l[2]!), ...agrees(3)]);
    const r = await runCli("C1", h, [...base, ...parts(p1, p2, p3)]);
    const fail = /^✗ Черновик p1 [^\n]*invalid_response[^\n]*/m.exec(r.out), ok = /^── Черновик p1 [^\n]*попыток 2/m.exec(r.out);
    must(fail && ok && fail.index < ok.index, `no ✗ … invalid_response before «── Черновик p1 … попыток 2»${dump(r)}`);
    const st = foldEvents(evs(h, r.id) as never);
    eq(st.questions.length, 0, "questions in the journal");
    must(!r.out.includes("Вопрос владельцу") && !r.out.includes("Ожидание владельца"), "question or owner wait in the output");
    return `session ${r.id}: «${fail[0].slice(0, 70)}…» then «${ok[0].slice(0, 50)}…»; questions 0`;
  });
  await step("C2 third slot error → participant_dropped, session continues", async () => {
    const h = homeOf("C2"), l = lab("C2");
    const p1 = scen(dir, "c2-p1", [draft(l[0]!), amend("Версия 1 стенда"), ...agrees(3)]);
    const p2 = scen(dir, "c2-p2", [draft(l[1]!), ...agrees(3)]);
    const p3 = scen(dir, "c2-p3", [{ error: "Сценарный сбой", retryable: true }, { raw: "не JSON раз" }, { raw: "не JSON два" }, ...agrees(3)]);
    const r = await runCli("C2", h, [...base, ...parts(p1, p2, p3)]);
    const es = evs(h, r.id);
    eq(started(es, "d3"), [1, 2, 3], "attempts of slot d3");
    must(es.some((e) => e.type === "participant_dropped" && e.participantId === "p3"), "no participant_dropped p3");
    must(es.some((e) => e.type === "turn_started"), "session did not continue (no turn_started)");
    must(r.code === 0 || r.code === 3, `code ${r.code}${dump(r)}`);
    return `session ${r.id}: d3 has attempts 1,2,3, no fourth; p3 dropped; turns ${ofType(h, r.id, "turn_started").length}; code ${r.code}`;
  });
  await step("C3 token cap in the phase → stopped, code 4", async () => {
    const h = homeOf("C3"), l = lab("C3");
    const p1 = scen(dir, "c3-p1", [draft(l[0]!, { inputTokens: 1000, outputTokens: 500 }), ...agrees(3)]);
    const p2 = scen(dir, "c3-p2", [draft(l[1]!), ...agrees(3)]);
    const p3 = scen(dir, "c3-p3", [draft(l[2]!), ...agrees(3)]);
    const r = await runCli("C3", h, [...base, "--max-tokens", "1200", ...parts(p1, p2, p3)]);
    eq(r.code, 4, "code");
    const fin = ofType(h, r.id, "session_finished")[0]!;
    must(fin.status === "stopped" && fin.reason === "token_cap", `result ${fin.status}/${fin.reason}`);
    must(/потолок/i.test(r.out), "no cap reason in the output");
    eq(started(evs(h, r.id), "d2"), [], "attempts of d2");
    noTurns(h, r.id);
    return `session ${r.id}: code 4, stopped/${fin.reason}; d2 attempts 0; turns 0`;
  });
  await step("C4 drafts do not fit into contextChars → failed, code 5", async () => {
    const h = homeOf("C4"), l = lab("C4");
    const long = (t: string) => ({ response: R("amend", `Довод ${t}`, `Решение ${t} ${"x".repeat(400)}`) });
    const p1 = scen(dir, "c4-p1", [long(l[0]!), ...agrees(3)]);
    const p2 = scen(dir, "c4-p2", [long(l[1]!), ...agrees(3)]);
    const p3 = scen(dir, "c4-p3", [long(l[2]!), ...agrees(3)]);
    const r = await runCli("C4", h, [...base, "--context-chars", "300", ...parts(p1, p2, p3)]);
    eq(r.code, 5, "code");
    const fin = ofType(h, r.id, "session_finished")[0]!;
    eq([fin.status, fin.reason], ["failed", "draft_context_limit"], "result");
    must(/лимит контекста/.test(r.out), "no context-limit reason in the output");
    noTurns(h, r.id);
    const es = evs(h, r.id);
    eq(started(es, "d2"), [], "attempts of d2 after the overflow");
    eq(started(es, "d3"), [], "attempts of d3 after the overflow");
    return `session ${r.id}: code 5, ${fin.reason}; turns 0; no new attempts after the first draft`;
  });
  await step("C5 synthesizer dropped → synthesizer_unavailable, code 5", async () => {
    const h = homeOf("C5"), l = lab("C5");
    const p1 = scen(dir, "c5-p1", [draft(l[0]!), ...agrees(3)]);
    const p2 = scen(dir, "c5-p2", [{ error: "Сценарный сбой синтезатора", retryable: false }, ...agrees(3)]);
    const p3 = scen(dir, "c5-p3", [draft(l[2]!), ...agrees(3)]);
    const r = await runCli("C5", h, [...base, "--synthesizer", "p2", ...parts(p1, p2, p3)]);
    eq(r.code, 5, "code");
    const fin = ofType(h, r.id, "session_finished")[0]!;
    eq([fin.status, fin.reason], ["failed", "synthesizer_unavailable"], "result");
    eq(started(evs(h, r.id), "d3"), [], "attempts of d3");
    must(existsSync(draftFile(h, r.id, "d1")), "no d1.txt");
    return `session ${r.id}: code 5, ${fin.reason}; d3 attempts 0; d1.txt in place`;
  });
  await step("C6 interrupted after the synthesizer dropped → resume refused (synthesizer)", async (o) => {
    const h = homeOf("C6"), l = lab("C6");
    const p1 = scen(dir, "c6-p1", [draft(l[0]!), ...agrees(3)]);
    const p2 = scen(dir, "c6-p2", [{ error: "Сценарный сбой синтезатора", retryable: false }, ...agrees(3)]);
    const p3 = scen(dir, "c6-p3", [draft(l[2]!), ...agrees(3)]);
    const r = await runCli("C6: launch", h, [...base, "--synthesizer", "p2", ...parts(p1, p2, p3)]);
    eq(r.code, 5, "launch code");
    // Journal of a process that died before the result was written: without the last session_finished line.
    const lines = readFileSync(journalPath(h, r.id), "utf8").split("\n").filter(Boolean);
    eq(JSON.parse(lines.at(-1)!).type, "session_finished", "last journal event");
    writeFileSync(journalPath(h, r.id), `${lines.slice(0, -1).join("\n")}\n`);
    const before = readFileSync(journalPath(h, r.id));
    const res = await runCli("C6: council resume", h, ["resume", r.id]);
    eq(res.code, 2, "resume code");
    must(res.err.includes("синтезатор p2") && res.err.includes("не создав версию 1"), `message: ${show(res.err)}`);
    const m = new Mcp(h);
    try {
      await m.connect();
      const t = await m.call("council_resume", { sessionId: r.id });
      must(t.isError === true && text(t).startsWith("synthesizer:"), `council_resume: isError ${t.isError}, ${text(t).slice(0, 150)}`);
      o.mcp = text(t);
    } finally {
      await m.close();
    }
    must(readFileSync(journalPath(h, r.id)).equals(before), "journal changed");
    o.err = res.err;
    return `session ${r.id}: resume code 2, «${res.err.trim().split("\n")[0]}»; council_resume: synthesizer error; journal ${before.length} bytes unchanged`;
  });
}

// =====================================================================
// Part D. Interruption and resume (real CLI)
// =====================================================================
async function partD() {
  const home = homeOf("D"), dir = scenDir("D");
  const L = [`МЕТКА-D1-${rnd()}`, `МЕТКА-D2-${rnd()}`, `МЕТКА-D3-${rnd()}`];
  const s1 = scen(dir, "d-p1", [draft(L[0]!, { inputTokens: 100, outputTokens: 50 }), ...agrees(4)]);
  const s2 = scen(dir, "d-p2", [draft(L[1]!, { delayMs: 15000 }), { raw: "не JSON" }, draft(L[1]!), amend("Версия 1 стенда"), ...agrees(3)]);
  const s3 = scen(dir, "d-p3", [draft(L[2]!), ...agrees(4)]);
  const args = ["--topic", "Выберите план", "--drafts", "--synthesizer", "p2", "--max-rounds", "2", ...parts(s1, s2, s3)];
  async function interrupted(label: string) {
    const p = cli(home, args);
    const id = await until(`${label}: session id`, () => /^Сессия (\S+) ·/m.exec(p.out)?.[1]);
    await until(`${label}: draft_attempt_started d2`, () => started(evs(home, id), "d2").length >= 1);
    p.child.kill("SIGKILL");
    await p.exited;
    runs.push({ label, args, code: null, out: p.out, err: p.err });
    return id;
  }
  const first = lazy(async () => {
    const id = await interrupted("D1: interrupted launch");
    const bytes = readFileSync(journalPath(home, id));
    return { id, bytes, d1: sha(readFileSync(draftFile(home, id, "d1"))) };
  });
  await step("D1 SIGKILL after the p1 draft and the p2 reservation", async (o) => {
    const { id } = await first();
    const es = evs(home, id);
    must(!es.some((e) => e.type === "session_finished"), "session_finished is in the journal");
    must(es.some((e) => e.type === "draft_completed" && e.draftId === "d1"), "no draft_completed d1");
    eq(started(es, "d2"), [1], "attempts of d2");
    const shown = await runCli("D1: council show", home, ["show", id]);
    must(/^Статус: interrupted/m.test(shown.out), `show did not show interrupted${dump(shown)}`);
    o.show = shown.out;
    return `session ${id}: no session_finished, d1 accepted, d2 attempt 1 started; show: «Статус: interrupted»`;
  });
  await step("D2 resume: remaining 5, 23 calls, d1 not called, d2 from attempt 2, prefix, usage", async (o) => {
    const { id, bytes, d1 } = await first();
    const tokBefore = tokenUsage(foldEvents(evs(home, id) as never));
    const r = await runCli("D2: council resume", home, ["resume", id]);
    must(r.code === 0 || r.code === 3, `code ${r.code}${dump(r)}`);
    const line = /^Продолжение сессии [^\n]*/m.exec(r.out)?.[0] ?? "";
    must(line.includes("остаток вызовов черновиков 5") && line.includes("3 × 2 × 3") && line.includes("не более 23 вызовов"), `resume line: ${show(line)}`);
    const after = readFileSync(journalPath(home, id));
    must(after.length > bytes.length && after.subarray(0, bytes.length).equals(bytes), "previous journal bytes are not a prefix of the new one");
    const added = after.subarray(bytes.length).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Ev);
    eq(started(added, "d1"), [], "new attempts of d1");
    eq(started(added, "d2"), [2, 3], "new attempts of d2");
    eq(started(added, "d3"), [1], "new attempts of d3");
    eq(sha(readFileSync(draftFile(home, id, "d1"))), d1, "sha256 d1.txt");
    const total = tokenUsage(foldEvents(evs(home, id) as never));
    eq([tokBefore.total, total.total], [150, 150], "total tokens before and after (150 = usage of the accepted d1)");
    o.line = line; o.tokensBefore = tokBefore; o.tokensAfter = total;
    return `${line.slice(0, 40)}… [${line.slice(line.indexOf("(") )}]; new attempts of d1: none, d2 ${started(added, "d2")}; prefix ${bytes.length} bytes; tokens ${tokBefore.total}→${total.total}`;
  });
  await step("D3 corrupted snapshot → resume refused, code 2", async (o) => {
    const id = await interrupted("D3: interrupted launch");
    appendFileSync(draftFile(home, id, "d1"), "x");
    const before = readFileSync(journalPath(home, id));
    const r = await runCli("D3: council resume", home, ["resume", id]);
    eq(r.code, 2, "code");
    must(/d1|p1|черновик/i.test(r.err), `message does not name the draft: ${show(r.err)}`);
    must(readFileSync(journalPath(home, id)).equals(before), "journal changed");
    o.err = r.err;
    return `session ${id}: code 2, «${r.err.trim().split("\n")[0]}»; journal ${before.length} bytes unchanged`;
  });
}

// =====================================================================
// MCP client over stdio (JSON-RPC, one line per message)
// =====================================================================
interface Res { isError?: boolean; content: { type: string; text: string }[] }
class Mcp {
  readonly proc: Proc;
  private buf = ""; private nextId = 0;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  constructor(home: string) {
    this.proc = spawnNode(mainTs, [], home);
    this.proc.child.stdout!.on("data", (d) => {
      this.buf += d;
      for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        const p = typeof m.id === "number" ? this.pending.get(m.id) : undefined;
        if (!p) continue;
        this.pending.delete(m.id);
        if (m.error) p.rej(new Error(`JSON-RPC: ${JSON.stringify(m.error)}`)); else p.res(m.result);
      }
    });
    void this.proc.exited.then(() => { for (const p of this.pending.values()) p.rej(new Error("server exited")); this.pending.clear(); });
  }
  private request(method: string, params: unknown, ms = 90000): Promise<any> {
    const id = ++this.nextId;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`timeout ${method}`)); }, ms);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.proc.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  async connect() {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "independent-drafts-check", version: "0" } });
    this.proc.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<Res> { return (await this.request("tools/call", { name, arguments: args })) as Res; }
  async close() { this.proc.child.kill("SIGKILL"); await this.proc.exited; }
}
const text = (r: Res) => r.content[0]?.text ?? "";
const js = (r: Res, what: string) => { if (r.isError) throw new Error(`${what}: tool error: ${text(r).slice(0, 300)}`); return JSON.parse(text(r)); };
const status = async (m: Mcp, sessionId: string, waitSec?: number) => js(await m.call("council_status", { sessionId, ...(waitSec === undefined ? {} : { waitSec }) }), "council_status");
async function statusUntilDone(m: Mcp, id: string, ms = 60000) {
  let st: any;
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) { st = await status(m, id, 3); if (st.status !== "running") return st; }
  throw new Error(`timed out waiting for the result of ${id}: ${st?.status}`);
}
const scenArg = (n: string) => ({ providerId: "scripted", model: `${fixtures}/${n}` });

// =====================================================================
// Part E. Real MCP over stdio
// =====================================================================
async function partE() {
  const home = homeOf("E");
  const A = new Mcp(home);
  const trio = [scenArg("p1.json"), scenArg("p2.json"), scenArg("p3.json")];
  try {
    await step("E1 council_options responds", async (o) => {
      await A.connect();
      const opt = js(await A.call("council_options"), "council_options");
      o.keys = Object.keys(opt);
      return `response received, fields: ${Object.keys(opt).join(", ")}`;
    });
    let id = "";
    await step("E2 council_start with drafts: bound 27", async (o) => {
      const r = js(await A.call("council_start", { topic: "Выберите план", participants: trio, maxRounds: 2, drafts: true, synthesizerId: "p2" }), "council_start");
      id = r.sessionId;
      eq(r.maxCalls, 27, "maxCalls");
      eq([r.drafts?.synthesizerId, r.drafts?.byDefault], ["p2", false], "drafts.synthesizerId/byDefault");
      o.start = r;
      return `session ${id}, maxCalls ${r.maxCalls}, drafts ${JSON.stringify(r.drafts)}`;
    });
    await step("E3 council_status: drafting phase, then the result", async (o) => {
      must(id, "no session from E2");
      let sawDrafting = 0, st: any;
      for (const t0 = Date.now(); Date.now() - t0 < 60000; ) {
        st = await status(A, id, 1);
        if (st.drafts?.phase === "drafting" && st.solution === null) sawDrafting++;
        if (st.status !== "running") break;
      }
      must(sawDrafting >= 1, "no response with drafts.phase=drafting and solution=null");
      eq(st.drafts?.phase, "finished", "final phase");
      eq(st.drafts.items.length, 3, "number of drafts");
      must(st.drafts.items.every((i: any) => typeof i.text === "string" && i.text.length > 0), "empty draft text");
      must(st.solution !== null, "no solution");
      const v1 = ofType(home, id, "turn_completed").find((e) => e.version === 1);
      eq(v1?.participantId, "p2", "author of version 1");
      o.final = st;
      return `responses in the drafting phase ${sawDrafting}; result ${st.status}, drafts ${st.drafts.items.length}, solution of version ${st.solution.version} (author ${st.solution.authorId}), version 1 — ${v1?.participantId}`;
    });
    await step("E4 without opt-in: bound 18, drafts null, no draft_*", async (o) => {
      const r = js(await A.call("council_start", { topic: "Выберите план", participants: trio, maxRounds: 2 }), "council_start");
      eq([r.maxCalls, r.drafts], [18, null], "maxCalls/drafts");
      const st = await statusUntilDone(A, r.sessionId);
      eq(st.drafts, null, "drafts in the status");
      eq(types(home, r.sessionId).filter((t) => t.startsWith("draft")), [], "draft events");
      o.status = st.status;
      return `session ${r.sessionId}: maxCalls ${r.maxCalls}, drafts null, result ${st.status}, draft events 0`;
    });
    await step("E5 refusals: synthesizerId without drafts and an unknown synthesizer", async () => {
      const before = nSessions(home);
      const a = await A.call("council_start", { topic: "t", participants: trio, maxRounds: 2, synthesizerId: "p2" });
      const b = await A.call("council_start", { topic: "t", participants: trio, maxRounds: 2, drafts: true, synthesizerId: "p9" });
      must(a.isError === true && b.isError === true, `isError: ${a.isError}/${b.isError}`);
      eq(nSessions(home), before, "number of sessions");
      return `isError on both; «${text(a).slice(0, 70)}» / «${text(b).slice(0, 70)}»; sessions ${before}`;
    });
  } finally {
    await A.close();
  }
}

async function partE2() {
  const home = homeOf("E2");
  const A = new Mcp(home);
  let B: Mcp | undefined;
  const trio = [scenArg("p1.json"), scenArg("p2-slow.json"), scenArg("p3.json")];
  const startArgs = { topic: "Выберите план", participants: trio, maxRounds: 2, drafts: true, synthesizerId: "p2" };
  let id = "";
  try {
    await step("E6 SIGKILL of the server mid-phase → interrupted", async () => {
      await A.connect();
      id = js(await A.call("council_start", startArgs), "council_start").sessionId;
      await until("draft_attempt_started d2", () => started(evs(home, id), "d2").length >= 1);
      await A.close();
      B = new Mcp(home);
      await B.connect();
      const st = await status(B, id);
      eq(st.status, "interrupted", "status");
      return `session ${id}: server killed after attempt 1 of slot d2; new server: status ${st.status}`;
    });
    if (!B) return;
    const jBytes = () => readFileSync(journalPath(home, id));
    let plan: any;
    await step("E7 council_resume without execute: plan", async (o) => {
      const before = jBytes();
      plan = js(await B!.call("council_resume", { sessionId: id }), "council_resume");
      eq([plan.mode, plan.draftCalls, plan.maxCalls], ["plan", 5, 23], "mode/draftCalls/maxCalls");
      must(typeof plan.planToken === "string" && plan.planToken.length > 0, "no planToken");
      must(jBytes().equals(before), "journal changed");
      o.plan = plan;
      return `mode plan, draftCalls ${plan.draftCalls}, maxCalls ${plan.maxCalls}, planToken ${plan.planToken.slice(0, 12)}…; journal ${before.length} bytes unchanged`;
    });
    await step("E8 stale plan (different rounds) → stale_plan", async () => {
      must(plan, "no plan from E7");
      const before = jBytes();
      const r = await B!.call("council_resume", { sessionId: id, rounds: 1, execute: true, planToken: plan.planToken });
      must(r.isError === true && text(r).includes("stale_plan"), `response: isError ${r.isError}, ${text(r).slice(0, 150)}`);
      must(jBytes().equals(before), "journal changed");
      return `isError, «${text(r).slice(0, 60)}…»; journal unchanged`;
    });
    await step("E9 execute with the same token: d1 not called, d2 from attempt 2, result", async (o) => {
      must(plan, "no plan from E7");
      const before = jBytes();
      const r = js(await B!.call("council_resume", { sessionId: id, execute: true, planToken: plan.planToken }), "council_resume execute");
      eq(r.accepted, true, "accepted");
      const st = await statusUntilDone(B!, id);
      const added = jBytes().subarray(before.length).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Ev);
      eq(started(added, "d1"), [], "new attempts of d1");
      eq(started(added, "d2"), [2, 3], "new attempts of d2");
      must(st.solution !== null, "no result solution");
      o.final = st;
      return `accepted, result ${st.status}; new attempts of d1: none, d2 ${started(added, "d2")}, d3 ${started(added, "d3")}; solution of version ${st.solution.version}`;
    });
  } finally {
    await A.close();
    if (B) await B.close();
  }
}

// =====================================================================
// Part F. Old sessions without a phase
// =====================================================================
async function partF() {
  const home = homeOf("F"), dir = scenDir("F");
  let M: Mcp | undefined;
  const server = lazy(async () => { M = new Mcp(home); await M.connect(); return M; });
  try {
    await step("F1 session without drafts, owner's choice is readable", async (o) => {
      const g1 = scen(dir, "f1-p1", [amend("Вариант один"), amend("Вариант три")]);
      const g2 = scen(dir, "f1-p2", [amend("Вариант два"), amend("Вариант четыре")]);
      const r = await runCli("F1", home, ["--topic", "Выберите план", "--max-rounds", "2", ...parts(g1, g2)]);
      eq(r.code, 3, "code (no_consensus)");
      const sel = selectOwnerVersion(home, r.id, { version: 1 }); // neither CLI nor MCP has a selection command: the same core call as in owner-control/check.ts
      eq(ofType(home, r.id, "owner_selected_version").length, 1, "owner_selected_version events");
      const shown = await runCli("F1: council show", home, ["show", r.id]);
      must(/Владелец выбрал версию 1/.test(shown.out), `show without the choice${dump(shown)}`);
      eq(types(home, r.id).filter((t) => t.startsWith("draft")), [], "draft events");
      const st = await status(await server(), r.id);
      eq(st.drafts, null, "drafts");
      eq(st.ownerSelection?.version, 1, "ownerSelection.version");
      o.selection = sel;
      return `session ${r.id}: no_consensus (code 3), choice of version 1 (${sel.ts}); show: «Владелец выбрал версию 1»; status: drafts null, ownerSelection.version 1`;
    });
    await step("F2 owner wait: resume spends no calls, continue brings it to the result", async (o) => {
      const f1 = scen(dir, "f2-p1", [amend("Первая версия ожидания"), ...agrees(5)]);
      const f2 = scen(dir, "f2-p2", [amend("Вторая версия ожидания"), ...agrees(5)]);
      const args = ["--topic", "Выберите план", "--max-rounds", "3", "--pause-after-round", "--owner-wait-sec", "300", ...parts(f1, f2)];
      const p = cli(home, args);
      const id = await until("F2: session id", () => /^Сессия (\S+) ·/m.exec(p.out)?.[1]);
      const w0 = await until("F2: owner_wait_started", () => ofType(home, id, "owner_wait_started")[0]);
      p.child.kill("SIGKILL");
      await p.exited;
      runs.push({ label: "F2: interrupted launch", args, code: null, out: p.out, err: p.err });
      const m = await server();
      eq((await status(m, id)).status, "interrupted", "status after SIGKILL");
      const plan = js(await m.call("council_resume", { sessionId: id }), "council_resume");
      eq(plan.draftCalls, 0, "draftCalls");
      eq(plan.maxCalls, plan.participants.length * plan.addedRounds * 3, "maxCalls = active × rounds × 3");
      const turns0 = ofType(home, id, "turn_started").length;
      const ex = js(await m.call("council_resume", { sessionId: id, execute: true, planToken: plan.planToken }), "council_resume execute");
      eq(ex.accepted, true, "accepted");
      const st = await until("F2: waiting after resume", async () => { const s = await status(m, id); return s.waiting ? s : null; });
      for (const t0 = Date.now(); Date.now() - t0 < 1500; await sleep(100)) eq(ofType(home, id, "turn_started").length, turns0, "turn_started during the wait");
      const done = js(await m.call("council_continue", { sessionId: id, waitId: st.waiting.waitId }), "council_continue");
      const fin = await statusUntilDone(m, id);
      must(ofType(home, id, "turn_started").length > turns0, "no turns after continue");
      eq(types(home, id).filter((t) => t.startsWith("draft")), [], "draft events");
      o.plan = plan; o.continue = done; o.final = fin;
      return `session ${id}: wait ${w0.waitId}; plan draftCalls ${plan.draftCalls}, maxCalls ${plan.maxCalls} (${plan.participants.length}×${plan.addedRounds}×3); after resume it waits again, turn_started within 1.5 s unchanged (${turns0}); continue → result ${fin.status}`;
    });
  } finally {
    await M?.close();
  }
}

// =====================================================================
let failed = false;
try {
  await partA();
  await partB();
  await partC();
  await partD();
  await partE();
  await partE2();
  await partF();
} catch (e) {
  failed = true;
  console.error(`STAND CRASH: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  for (const k of kids) k.kill("SIGKILL");
  const passed = recs.filter((r) => r.ok).length;
  console.log(`Passed ${passed} of ${recs.length}`);
  if (outFile) writeFileSync(resolve(outFile), JSON.stringify({ work: keep ? work : null, passed, total: recs.length, steps: recs, runs }, null, 1));
  if (keep) console.log(`Stand kept: ${work}`); else rmSync(work, { recursive: true, force: true });
  process.exitCode = failed || passed !== recs.length || recs.length === 0 ? 1 : 0;
}
