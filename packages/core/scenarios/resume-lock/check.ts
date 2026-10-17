// Live check of the "single resume executor": N concurrent `council resume` runs of one session (real processes),
// including with a planted lock of a dead process. Participants are scripted only, 0 real model calls.
//   COUNCIL_DEV=1 COUNCIL_HOME=<folder> node packages/core/scenarios/resume-lock/check.ts
// Legitimate rejections of the loser (code 2) are exactly two: «Сессию уже продолжает другой процесс.» (busy: the lock is taken) and
// «идёт: исполнитель ещё работает.» (running: the winner has already written session_resumed, and planning sees a running session).
// Any other reason (first of all «журнал сессии повреждён») and any other code is FAIL.
// Writes only to COUNCIL_HOME (including scenarios in scen/) and does not delete it. LOCK_CHECK_PROCS (3..16, default 8), LOCK_CHECK_ROUNDS (default 5).
import "../language-ru.ts";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readEvents, resumeLockPath, sessionDir } from "../../src/index.ts";

if (process.env.COUNCIL_DEV !== "1" || !process.env.COUNCIL_HOME?.trim()) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME are required. Usage: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node packages/core/scenarios/resume-lock/check.ts");
  process.exit(2);
}
const home = resolve(process.env.COUNCIL_HOME);
mkdirSync(join(home, "scen"), { recursive: true });
const root = join(import.meta.dirname, "../../../..");
const councilTs = join(root, "packages/core/src/council.ts");
const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_HOME: home, COUNCIL_DEV: "1" };
const intIn = (name: string, def: number, lo: number, hi: number) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < lo || n > hi) { console.error(`${name}: an integer from ${lo} to ${hi}.`); process.exit(2); }
  return n;
};
const N = intIn("LOCK_CHECK_PROCS", 8, 3, 16), R = intIn("LOCK_CHECK_ROUNDS", 5, 1, 100);
const DELAY_MS = 4000; // the resume turn is slow: the winner holds the lock while the others start
const FAST_MS = DELAY_MS; // ponytail: p2 does not take a turn in the resume (agreement comes after p1's turn), so p1's turn is the one that must be slow; the journal grows in the start window (session_resumed and turn_started are written at the beginning)
const BUSY = "Сессию уже продолжает другой процесс.", RUNNING = "идёт: исполнитель ещё работает.";

const kids = new Set<ChildProcess>();
interface Proc { out: string; err: string; code: number | null; done: Promise<void> }
function council(args: string[]): Proc {
  const child = spawn(process.execPath, [councilTs, ...args], { env, cwd: root });
  kids.add(child);
  const p: Proc = { out: "", err: "", code: null, done: undefined as never };
  child.stdout.on("data", (d) => { p.out += d; });
  child.stderr.on("data", (d) => { p.err += d; });
  p.done = new Promise<void>((res) => child.on("close", (c) => { p.code = c; kids.delete(child); res(); }));
  return p;
}
const killAll = () => { for (const k of kids) k.kill("SIGKILL"); };
process.on("exit", killAll);
for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => { killAll(); process.exit(1); });

const resp = (stance: string, solution: string | null) => ({ stance, reasoning: "Довод.", solution, answers: [], questions: [] });
// Step 0 is the first round without agreement; step 1 is the resume turn: short for p1, slow for p2; agreement after that.
function scen(tag: string, who: string): string {
  const steps = Array.from({ length: 6 }, (_, i) => ({
    response: i === 0 ? resp("amend", `Версия ${who}`) : resp("agree", null),
    ...(i === 1 ? { delayMs: who === "p1" ? FAST_MS : DELAY_MS } : {}),
  }));
  const p = join(home, "scen", `${tag}-${who}.json`);
  writeFileSync(p, JSON.stringify({ steps }));
  return p;
}
async function createSession(tag: string): Promise<string> {
  const c = council(["--topic", "Как назвать кота", "--participant", `scripted:${scen(tag, "p1")}`, "--participant", `scripted:${scen(tag, "p2")}`, "--max-rounds", "1"]);
  await c.done;
  const id = /^Сессия (\S+) ·/m.exec(c.out)?.[1];
  if (!id || c.code !== 3) throw new Error(`${tag}: initial session: code ${c.code} (expected 3), id ${id}\n${c.out}\n${c.err}`);
  return id;
}

const failed: string[] = [];
let total = 0;
async function round(kind: "A" | "B", n: number) {
  const tag = `${kind === "A" ? "a" : "b"}${n}`, label = `${kind}${n}`;
  total++;
  const id = await createSession(tag);
  if (kind === "B") {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(resumeLockPath(home, id), String(dead));
  }
  const procs = Array.from({ length: N }, () => council(["resume", id, "--rounds", "1"]));
  await Promise.all(procs.map((p) => p.done));

  const exec = procs.filter((p) => p.code !== 2);
  const busy = procs.filter((p) => p.code === 2 && p.err.includes(BUSY));
  const running = procs.filter((p) => p.code === 2 && !p.err.includes(BUSY) && p.err.includes(RUNNING));
  const others = procs.filter((p) => p !== exec[0] && !busy.includes(p) && !running.includes(p));
  const events = readEvents(home, id)?.events as unknown as { type: string; turn?: number }[] | undefined ?? [];
  const resumed = events.filter((e) => e.type === "session_resumed").length;
  const problems: string[] = [];
  const check = (ok: boolean, what: string, want: unknown, got: unknown) => { if (!ok) problems.push(`${what}: expected ${want}, got ${got}`); };
  check(exec.length === 1, "executors", 1, exec.length);
  check(busy.length + running.length === N - 1, "busy+running rejections", N - 1, busy.length + running.length);
  const why = new Map<string, number>();
  for (const p of others) { const k = `code ${p.code}: ` + p.err.trim().replaceAll(id, "<id>").replace(/№\d+/, "№N"); why.set(k, (why.get(k) ?? 0) + 1); }
  check(others.length === 0, "other rejections/codes", 0, `${others.length} [${[...why].map(([k, v]) => `${v}× ${k}`).join("; ")}]`);
  check(exec.every((p) => p.code === 0 && /Продолжение сессии /.test(p.out)), "executor: code 0 and the line \"Продолжение сессии\"", "yes", exec.map((p) => p.code).join(","));
  check(resumed === 1, "session_resumed events", 1, resumed);
  // after session_resumed and until the finish there is no second session_resumed; turns do not repeat
  const idx = events.findIndex((e) => e.type === "session_resumed");
  const fin = events.findIndex((e, i) => i > idx && e.type === "session_finished");
  check(idx < 0 || events.slice(idx + 1, fin < 0 ? undefined : fin).every((e) => e.type !== "session_resumed"), "second session_resumed before the finish", "none", "present");
  const turns = events.filter((e) => e.type === "turn_started").map((e) => e.turn);
  check(new Set(turns).size === turns.length, "turn numbers without repeats", "unique", turns.join(","));
  const left = readdirSync(sessionDir(home, id)).filter((f) => f === "resume.lock" || f.startsWith("resume.lock."));
  check(left.length === 0 && !existsSync(resumeLockPath(home, id)), "locks after the finish", 0, left.join(",") || "none");

  console.log(`${problems.length ? "FAIL" : "OK  "} round ${label} session ${id}: executors ${exec.length}, busy ${busy.length}, running ${running.length}, others ${others.length}, session_resumed ${resumed}${problems.length ? "\n      " + problems.join("\n      ") : ""}`);
  if (problems.length) failed.push(label);
}

try {
  console.log(`council resume processes per round: ${N}, repeats of each kind: ${R}, COUNCIL_HOME=${home}`);
  for (const kind of ["A", "B"] as const) for (let n = 1; n <= R; n++) await round(kind, n);
} catch (e) {
  console.error(`Stand aborted: ${(e as Error).message}`);
  killAll();
  process.exit(1);
}
console.log("Real model calls: 0");
console.log(`Result: ${total - failed.length} of ${total} rounds`);
console.log(failed.length ? `FAIL: ${failed.join(", ")}` : "PASS");
process.exit(failed.length ? 1 : 0);
