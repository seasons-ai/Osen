// Live check of the usage of all attempts (change 96): real council processes and an MCP server over stdio,
// scripted participants only (0 model calls, no network).
//   COUNCIL_DEV=1 node packages/core/scenarios/usage-attempts/check.ts
// Writes only to .council-data/usage-attempts-* inside the project; deletes the folder on success, keeps it and prints the path on failure.
// The scenario files p1/p2 are next to it; the stand copies them into its own folder (p2 is replaced with the copy f1-p2-resume.json before resume).
// Core copy from before 96: a git worktree at HEAD in a temporary folder (the changes of 96 are not in HEAD), deleted in finally.
// `council status` does not print tokens: the total is shown by `council show` (the «Всего» line), the «Расход» line after a turn, and MCP council_status.
import "../language-ru.ts";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { eventsPath, foldEvents, moscowDay, readEvents, readUsageSummary, sessionUsage, sessionsDir, tokenUsage } from "../../src/index.ts";
import type { SessionEvent } from "../../src/index.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Scripted participants are available only with COUNCIL_DEV=1. Run: COUNCIL_DEV=1 node packages/core/scenarios/usage-attempts/check.ts");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
const councilTs = join(repo, "packages/core/src/council.ts");
const mainTs = join(repo, "packages/mcp/src/main.ts");
mkdirSync(join(repo, ".council-data"), { recursive: true });
const workPath = join(repo, ".council-data", `usage-attempts-${Date.now()}-${randomBytes(3).toString("hex")}`);
mkdirSync(workPath, { recursive: true });
const work = realpathSync(workPath);
const scen = join(work, "scen");
cpSync(import.meta.dirname, scen, { recursive: true, filter: (s) => !s.endsWith(".ts") });
const material = join(work, "material");
mkdirSync(material);
writeFileSync(join(material, "notes.txt"), "Заметки владельца: выбрать одно имя из одного слова.\n");
const homeOf = (name: string) => { const d = join(work, name); mkdirSync(d, { recursive: true }); return d; };

// ---------- checks ----------
let total = 0, failed = 0;
function check(name: string, cond: boolean, detail = ""): boolean {
  total++;
  if (!cond) failed++;
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${!cond && detail ? `\n       ${detail.slice(0, 900).replace(/\n/g, "\n       ")}` : ""}`);
  return cond;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
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
function cli(entry: string, home: string, args: string[]): Proc {
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_DEV: "1", COUNCIL_HOME: home };
  const child = spawn(process.execPath, [entry, ...args], { env, cwd: repo });
  kids.add(child);
  const p: Proc = { child, out: "", err: "", exited: new Promise((res) => child.on("close", (c) => { kids.delete(child); res(c); })) };
  child.stdout!.on("data", (d) => { p.out += d; });
  child.stderr!.on("data", (d) => { p.err += d; });
  return p;
}
async function run(entry: string, home: string, args: string[], ms = 60000): Promise<{ code: number | null; out: string; err: string }> {
  const p = cli(entry, home, args);
  const t = setTimeout(() => p.child.kill("SIGKILL"), ms);
  const code = await p.exited;
  clearTimeout(t);
  return { code, out: p.out, err: p.err };
}
const dump = (r: { code: number | null; out: string; err: string }) => `code ${r.code}\nstdout: ${r.out.slice(-700)}\nstderr: ${r.err.slice(-300)}`;
const part = (f: string) => ["--participant", `scripted:${join(scen, f)}`];
const ids = (home: string) => (existsSync(sessionsDir(home)) ? readdirSync(sessionsDir(home)) : []);
const events = (home: string, id: string): SessionEvent[] => readEvents(home, id)?.events ?? [];
const sessionId = (home: string) => until("session id", () => ids(home)[0]);
const spent = (es: SessionEvent[]) => { const u = tokenUsage(foldEvents(es)); return { total: u.total, incomplete: u.incomplete }; };
const recordsSum = (es: SessionEvent[]) => sessionUsage(es).records.reduce((n, r) => n + (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0), 0);
/** Total from the «Всего: … токены I / O …» line of the `council show` output. */
function showTotal(out: string): { total: number; incomplete: boolean } | null {
  const m = /токены (\d+|\?) \/ (\d+|\?)/.exec(out);
  if (!m) return null;
  return { total: (m[1] === "?" ? 0 : Number(m[1])) + (m[2] === "?" ? 0 : Number(m[2])), incomplete: out.includes("учёт расхода неполный") };
}
const TOPIC = "Выберите имя для сервиса";

// ---------- MCP ----------
async function mcpStatus(home: string, sessionId: string): Promise<{ tokens: { total: number; incomplete: boolean }; status: string }> {
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_DEV: "1", COUNCIL_HOME: home };
  const transport = new StdioClientTransport({ command: process.execPath, args: [mainTs], cwd: repo, stderr: "ignore", env });
  const client = new Client({ name: "usage-attempts-check", version: "0" });
  await client.connect(transport);
  try {
    const r = (await client.callTool({ name: "council_status", arguments: { sessionId } })) as { isError?: boolean; content: { text: string }[] };
    if (r.isError) throw new Error(r.content[0]?.text);
    return JSON.parse(r.content[0]!.text);
  } finally {
    await client.close();
  }
}

// ---------- core copy from before 96 ----------
function oldCheckout(): { entry: string; cleanup: () => void } | null {
  try {
    const dir = join(mkdtempSync(join(tmpdir(), "usage-attempts-old-")), "repo");
    execFileSync("git", ["worktree", "add", "--detach", dir, "HEAD"], { cwd: repo, stdio: "ignore" });
    symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"));
    return {
      entry: join(dir, "packages/core/src/council.ts"),
      cleanup: () => {
        execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: repo, stdio: "ignore" });
        rmSync(join(dir, ".."), { recursive: true, force: true });
      },
    };
  } catch (e) {
    console.log(`Core copy from before 96 was not built: ${(e as Error).message}`);
    return null;
  }
}

async function main(): Promise<void> {
  // ===== F1: turn failure, stop, resume =====
  const h1 = homeOf("f1");
  const first = cli(councilTs, h1, ["--topic", TOPIC, ...part("f1-p1.json"), ...part("f1-p2.json"), "--max-rounds", "3", "--max-tokens", "300"]);
  const id1 = await sessionId(h1);
  // the p2 failure (250) is recorded; the retry call hit the long step
  await until("F1: p2 turn failure recorded", () => events(h1, id1).some((e) => e.type === "turn_failed"));
  await sleep(500);
  const stop = await run(councilTs, h1, ["stop", id1]);
  const code1 = await Promise.race([first.exited, sleep(15000).then(() => "timeout" as const)]);
  const es1 = events(h1, id1);
  check("1. F1: council stop accepted, process exited with code 4, status stopped",
    stop.code === 0 && code1 === 4 && foldEvents(es1).finish?.status === "stopped", `${dump(stop)}\nexecutor: ${String(code1)}\n${first.out.slice(-500)}`);
  check("1. F1: the turn failure with usage 250 is recorded before the stop", es1.some((e) => e.type === "turn_failed" && (e.usage?.inputTokens ?? 0) + (e.usage?.outputTokens ?? 0) === 250));

  const show1 = await run(councilTs, h1, ["show", id1]);
  const t1 = showTotal(show1.out);
  check("2. F1: council show after the stop — at least 250 tokens and the incomplete-accounting mark",
    show1.code === 0 && !!t1 && t1.total >= 250 && t1.incomplete, dump(show1));
  const st1 = await run(councilTs, h1, ["status", id1]);
  check("2. F1: council status reads the session without errors", st1.code === 0 && st1.out.includes(id1), dump(st1));

  // p2 on resume: turn 2 completes with 20 tokens; p1 delays on turn 3 so that the journal can be read in time
  cpSync(join(scen, "f1-p2-resume.json"), join(scen, "f1-p2.json"));
  const p1 = JSON.parse(readFileSync(join(scen, "f1-p1.json"), "utf8")) as { steps: Record<string, unknown>[] };
  p1.steps[1] = { ...p1.steps[1], delayMs: 8000 }; // step 1 = turn 3 (turn 1 is step 0)
  writeFileSync(join(scen, "f1-p1.json"), JSON.stringify(p1));
  const res = cli(councilTs, h1, ["resume", id1]);
  await until("F1: turn 2 completed after resume", () => events(h1, id1).some((e, i, a) => e.type === "turn_completed" && e.turn === 2 && a.slice(0, i).some((x) => x.type === "session_resumed")), 30000);
  const mid = spent(events(h1, id1));
  check("3. F1: after resume the total is 270 (failure 250 + turn 2 with 20), not 20; accounting is incomplete (turn 1 without tokens)",
    mid.total === 270 && mid.incomplete, JSON.stringify(mid));
  await until("F1: «Расход» line after turn 2 in the resume output", () => /Расход: израсходовано 270 из 300/.test(res.out), 10000)
    .then(() => check("3. F1: the usage line after turn 2 names 270 of 300", true), () => check("3. F1: the usage line after turn 2 names 270 of 300", false, res.out.slice(-600)));
  const code2 = await Promise.race([res.exited, sleep(30000).then(() => "timeout" as const)]);
  const es2 = events(h1, id1);
  const fin = foldEvents(es2).finish;
  const completed = es2.filter((e) => e.type === "turn_completed").length;
  check("4. F1: session stopped/token_cap right after turn 3 (310 tokens), code 4, no further turns",
    code2 === 4 && fin?.status === "stopped" && /token_cap|потол/i.test(`${fin.reasonCode ?? ""}${fin.reason ?? ""}`) && completed === 3 && spent(es2).total === 310,
    `code ${String(code2)}, finish ${JSON.stringify(fin)}, turns ${completed}, total ${JSON.stringify(spent(es2))}\n${res.out.slice(-500)}`);

  const mcp = await mcpStatus(h1, id1);
  const show2 = showTotal((await run(councilTs, h1, ["show", id1])).out);
  check("5. F1: MCP council_status — the same token count as in council show, the journal and the cap",
    mcp.tokens.total === 310 && show2?.total === 310 && mcp.tokens.incomplete === spent(es2).incomplete, JSON.stringify({ mcp: mcp.tokens, show: show2 }));

  const day = Date.now();
  const sum = readUsageSummary(h1, moscowDay(new Date(day - 86400000)), moscowDay(new Date(day + 86400000)));
  const sumTotal = (sum.total.inputTokens ?? 0) + (sum.total.outputTokens ?? 0);
  check("6. F1: readUsageSummary (the «Истории» summary) = sessionUsage = tokenUsage = 310",
    sumTotal === 310 && recordsSum(es2) === 310 && spent(es2).total === 310, JSON.stringify({ sumTotal, records: recordsSum(es2), fold: spent(es2), unreadable: sum.unreadable, truncated: sum.truncated }));

  // ===== F2: file request in an unfinished turn =====
  const h2 = homeOf("f2");
  const r2 = await run(councilTs, h2, ["--topic", TOPIC, ...part("f2-p1.json"), ...part("f2-p2.json"), ...part("f2-p3.json"), "--attach", material, "--max-rounds", "1"]);
  const id2 = ids(h2)[0] ?? "";
  const es2f = events(h2, id2);
  const served = es2f.find((e) => e.type === "turn_files_served");
  const show2f = showTotal((await run(councilTs, h2, ["show", id2])).out);
  check("7. F2: p2 dropped, the journal has turn_files_served with usage 1000", es2f.some((e) => e.type === "participant_dropped" && e.participantId === "p2") && !!served && served.type === "turn_files_served" && (served.usage.inputTokens ?? 0) + (served.usage.outputTokens ?? 0) === 1000, dump(r2));
  check("7. F2: total 1000 and incomplete accounting (council show, journal, sessionUsage)",
    show2f?.total === 1000 && show2f.incomplete && spent(es2f).total === 1000 && spent(es2f).incomplete && recordsSum(es2f) === 1000, JSON.stringify({ show: show2f, fold: spent(es2f) }));
  const spendLines = r2.out.split("\n").filter((l) => l.startsWith("Расход"));
  check("7. F2: the «Расход» line after a turn names 1000, not «токены не сообщены»",
    /Расход: 1000 токенов/.test(spendLines.at(-1) ?? ""), spendLines.join("\n"));
  const mcp2 = await mcpStatus(h2, id2);
  check("7. F2: MCP council_status — 1000 and incomplete accounting", mcp2.tokens.total === 1000 && mcp2.tokens.incomplete, JSON.stringify(mcp2.tokens));

  // ===== F3: file request in a draft, cap 900 =====
  const h3 = homeOf("f3");
  const r3 = await run(councilTs, h3, ["--topic", TOPIC, "--drafts", "--synthesizer", "p1", ...part("f3-p1.json"), ...part("f3-p2.json"), ...part("f3-p3.json"), "--attach", material, "--max-rounds", "2", "--max-tokens", "900"]);
  const id3 = ids(h3)[0] ?? "";
  const es3 = events(h3, id3);
  const fin3 = foldEvents(es3).finish;
  check("8. F3: p2 dropped on a draft, session stopped/token_cap (code 4), usage 1000, the journal has draft_files_served",
    r3.code === 4 && fin3?.status === "stopped" && /token_cap|потол/i.test(`${fin3.reasonCode ?? ""}${fin3.reason ?? ""}`) && spent(es3).total === 1000 &&
      es3.some((e) => e.type === "draft_files_served") && es3.some((e) => e.type === "participant_dropped" && e.participantId === "p2"), `${dump(r3)}\nfinish ${JSON.stringify(fin3)}`);
  const drafted = es3.filter((e) => e.type === "draft_attempt_started").map((e) => (e as { participantId: string }).participantId);
  check("8. F3: turns and synthesis not called (no turn_started, no versions); drafts started for: " + drafted.join(","),
    !es3.some((e) => e.type === "turn_started" || e.type === "turn_completed" || e.type === "version_proposed") && !es3.some((e) => e.type === "drafts_finished"),
    es3.map((e) => e.type).join(","));
  check("8. F3: p3 is not called after the cap is exceeded", !drafted.includes("p3"), drafted.join(","));

  // ===== 9. compatibility =====
  const old = oldCheckout();
  if (!old) { check("9. core copy from before 96 built", false, "see the output above"); return; }
  try {
    const copy = join(work, "f2-for-old");
    cpSync(h2, copy, { recursive: true });
    const lines = readFileSync(eventsPath(copy, id2), "utf8").split("\n").filter(Boolean);
    const n = lines.findIndex((l) => (JSON.parse(l) as { type: string }).type === "turn_files_served");
    const oldShow = await run(old.entry, copy, ["status", id2]);
    check(`9b. copy from before 96: council status of the F2 journal — «журнал записан более новой версией, прочитан до события №${n}», not «повреждён»`,
      n > 0 && oldShow.out.includes(`журнал записан более новой версией, прочитан до события №${n}`) && !oldShow.out.includes("повреждён"), `n=${n}\n${dump(oldShow)}`);
    // 9a: a journal written by the old version (it does not write file-request events) is read by the new one
    const ho = homeOf("f2-old-written");
    const ro = await run(old.entry, ho, ["--topic", TOPIC, ...part("f2-p1.json"), ...part("f2-p2.json"), ...part("f2-p3.json"), "--attach", material, "--max-rounds", "1"]);
    const ido = ids(ho)[0] ?? "";
    const eso = events(ho, ido);
    const st = await run(councilTs, ho, ["status", ido]);
    const sh = await run(councilTs, ho, ["show", ido]);
    check("9a. the old version's journal (without the new events) is read by the new council status and show without errors, a call with a file request remains a call without an outcome",
      ro.code !== null && eso.length > 0 && !eso.some((e) => e.type === "turn_files_served") && st.code === 0 && sh.code === 0 &&
        !/более новой версией|повреждён/.test(st.out + sh.out) && sessionUsage(eso).open.length > 0,
      `${dump(ro)}\n${dump(st)}\nopen=${sessionUsage(eso).open.length}`);
  } finally {
    old.cleanup();
  }
}

try {
  await main();
} catch (e) {
  failed++;
  console.log(`FAIL stand aborted: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  for (const k of kids) k.kill("SIGKILL");
}
console.log(`\nResult: ${total - failed} of ${total}; model calls: 0 (scripted participants)`);
if (failed === 0) rmSync(work, { recursive: true, force: true });
else console.log(`Data folder kept: ${work}`);
process.exit(failed === 0 ? 0 : 1);
