// Live check of the data folder migration model-council -> osen (change 79, Live Scenario steps 1–9): real processes
// council (new and old version) and an MCP server over stdio, scripted participants only (0 model calls).
//   COUNCIL_DEV=1 node packages/core/scenarios/data-dir-migration/check.ts
// All steps run under a substitute HOME inside .council-data/data-dir-migration-*; the owner's real data folder is not used.
// The stand deletes the folder on success; on failure it keeps it and prints the path.
import { spawn, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Scripted participants are available only with COUNCIL_DEV=1. Run: COUNCIL_DEV=1 node packages/core/scenarios/data-dir-migration/check.ts");
  process.exit(1);
}
if (process.getuid?.() === 0) { console.error("The stand does not run as root: chmod 000 does not lock a file against root."); process.exit(1); }

const repo = resolve(import.meta.dirname, "../../../..");
const realHome = realpathSync(homedir());
mkdirSync(join(repo, ".council-data"), { recursive: true });
const workPath = join(repo, ".council-data", `data-dir-migration-${Date.now()}-${randomBytes(3).toString("hex")}`);
mkdirSync(workPath, { recursive: true });
const work = realpathSync(workPath);
const scen = join(repo, "packages/core/scenarios");
const mainTs = join(repo, "packages/mcp/src/main.ts");
const councilTs = join(repo, "packages/core/src/council.ts");
const oldRepo = join(work, "old");

// ---------- checks ----------
let total = 0;
let ok = 0;
function check(step: number, what: string, cond: unknown, detail = "") {
  total++;
  if (cond) { ok++; console.log(`OK   step ${step}: ${what}`); }
  else console.log(`FAIL step ${step}: ${what}${detail ? ` — ${detail.slice(0, 600).replace(/\s*\n\s*/g, " | ")}` : ""}`);
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

// ---------- environment: substitute HOME ----------
const sandboxes: string[] = [];
const sbHome = (name: string) => { const h = join(work, name); mkdirSync(join(h, "Library", "Application Support"), { recursive: true }); sandboxes.push(h); return h; };
const support = (h: string) => join(h, "Library", "Application Support");
// Every child process launch goes through this check: the owner's real HOME and COUNCIL_HOME are not allowed.
function childEnv(home: string, councilHome?: string): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, COUNCIL_DEV: "1" };
  if (councilHome !== undefined) env.COUNCIL_HOME = councilHome;
  let realH = home;
  try { realH = realpathSync(home); } catch {}
  if (home === realHome || realH === realHome || home === homedir() || !realH.startsWith(work + "/")) { console.error(`CRASH: child process HOME is outside the stand's work folder: ${home}`); process.exit(2); }
  if (councilHome !== undefined && !resolve(councilHome).startsWith(work + "/")) { console.error(`CRASH: COUNCIL_HOME is outside the stand's work folder: ${councilHome}`); process.exit(2); }
  return env;
}

interface Proc { child: ChildProcess; out: string; err: string; exited: Promise<number | null> }
const kids = new Set<ChildProcess>();
function spawnNode(script: string, args: string[], env: Record<string, string>): Proc {
  const child = spawn(process.execPath, [script, ...args], { env, cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  kids.add(child);
  const p: Proc = { child, out: "", err: "", exited: new Promise((res) => child.on("close", (c) => { kids.delete(child); res(c); })) };
  child.stdout!.on("data", (d) => { p.out += d; });
  child.stderr!.on("data", (d) => { p.err += d; });
  return p;
}
async function done(p: Proc, ms = 90000) {
  const t = await Promise.race([p.exited, sleep(ms).then(() => "timeout" as const)]);
  if (t === "timeout") { p.child.kill("SIGKILL"); throw new Error(`process did not exit within ${ms / 1000} s\n${p.out}\n${p.err}`); }
  return { code: t, out: p.out, err: p.err, all: p.out + p.err };
}
const council = (home: string, args: string[], councilHome?: string, script = councilTs) => spawnNode(script, args, childEnv(home, councilHome));
const runCouncil = async (home: string, args: string[], councilHome?: string, script = councilTs) => done(council(home, args, councilHome, script));

// ---------- files ----------
// sha256 of all files in the folder (except logs/: the log is appended to by the migration), path -> hash; unreadable files are marked
function tree(dir: string, skipLogs = true): Record<string, string> {
  const res: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (skipLogs && rel.split("/")[0] === "logs") continue;
      if (e.isDirectory()) walk(p);
      else if (e.isSymbolicLink()) res[rel] = `link:${readlinkSync(p)}`;
      else { try { res[rel] = createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { res[rel] = "unreadable"; } }
    }
  };
  if (existsSync(dir)) walk(dir);
  return res;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const isDir = (p: string) => { try { return lstatSync(p).isDirectory(); } catch { return false; } };
const backups = (h: string) => readdirSync(support(h)).filter((n) => n.startsWith("model-council-backup-")).sort();
const logOf = (dir: string) => { try { return readFileSync(join(dir, "logs", "app.log"), "utf8"); } catch { return ""; } };
const sessionIds = (dir: string) => { try { return readdirSync(join(dir, "sessions")).sort(); } catch { return []; } };
const copy = (from: string, to: string) => cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
const movedCount = (log: string) => (log.match(/перенесена|moved/g) ?? []).length;

// ---------- scripted participants ----------
type S = Record<string, unknown>;
const tok = { inputTokens: 100, outputTokens: 50 };
const amend = (text: string, x: S = {}) => ({ response: { stance: "amend", reasoning: `Довод ${text}`, solution: text, answers: [], questions: [] }, ...tok, ...x });
const agree = () => ({ response: { stance: "agree", reasoning: "Согласен", solution: null, answers: [], questions: [] }, ...tok });
function scenFile(name: string, steps: S[]): string {
  const dir = join(work, "scen");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify({ steps }));
  return p;
}
const fixed = [`scripted:${join(scen, "consensus/p1.json")}`, `scripted:${join(scen, "consensus/p2.json")}`];
const slowArgs = (tag: string) => [`scripted:${scenFile(`${tag}-p1`, [amend("Версия медленная", { delayMs: 8000 }), agree(), agree()])}`, `scripted:${scenFile(`${tag}-p2`, [agree(), agree(), agree()])}`];
const args = (topic: string, parts: string[]) => ["--topic", topic, ...parts.flatMap((p) => ["--participant", p]), "--max-rounds", "3"];

// Sample of the old folder: sessions, config.json, .env with a dummy key, a custom template, preferences.json (ru)
async function seedLegacy(dir: string, topics: string[]): Promise<Record<string, string>> {
  const h = sbHome(`seed-${randomBytes(2).toString("hex")}`);
  for (const t of topics) {
    const r = await runCouncil(h, args(t, fixed), dir);
    if (r.code !== 0) throw new Error(`preparation: session «${t}» code ${r.code}\n${r.all}`);
  }
  writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=sk-fake-data-dir-migration-0000\n");
  writeFileSync(join(dir, "preferences.json"), `${JSON.stringify({ language: "ru" }, null, 2)}\n`);
  mkdirSync(join(dir, "templates"), { recursive: true });
  writeFileSync(join(dir, "templates", "my-plan.json"), JSON.stringify({ id: "my-plan", title: "Мой план", category: "Личное", description: "Свой шаблон стенда.", exampleTopic: "План", framing: ["Цель: план."], roles: [], limits: { maxRounds: 2 } }, null, 2));
  if (!existsSync(join(dir, "config.json"))) throw new Error("preparation: config.json was not created");
  return tree(dir);
}
const legacyFrom = (seed: string, h: string) => { const to = join(support(h), "model-council"); copy(seed, to); return to; };

const RU = /доступен/; // a word from the Russian output of `council providers`

async function main() {
  const seedDir = join(work, "seed", "model-council");
  const seedTree = await seedLegacy(seedDir, ["Как назвать кота", "Куда поехать летом"]);
  const seed2Dir = join(work, "seed2", "model-council");
  const seed2Tree = await seedLegacy(seed2Dir, ["Другая тема для второй папки"]);
  check(1, `model-council sample ready: ${Object.keys(seedTree).length} files with sha256, sessions ${sessionIds(seedDir).length}`, sessionIds(seedDir).length === 2 && !!seedTree["config.json"] && !!seedTree[".env"] && !!seedTree["preferences.json"] && !!seedTree["templates/my-plan.json"]);

  // ----- steps 2 and 3 -----
  const h2 = sbHome("h2");
  const legacy2 = legacyFrom(seedDir, h2);
  const osen2 = join(support(h2), "osen");
  const r2 = await runCouncil(h2, ["providers"]);
  check(2, "council providers: code 0 and Russian output (language from the migrated preferences.json)", r2.code === 0 && RU.test(r2.out), `code ${r2.code}\n${r2.all}`);
  check(2, "osen contains all files with the old sha256", same(tree(osen2), seedTree), JSON.stringify(Object.keys(tree(osen2))));
  check(2, "model-council is a link to osen", isLink(legacy2) && readlinkSync(legacy2) === "osen", isLink(legacy2) ? readlinkSync(legacy2) : "not a link");
  const b2 = backups(h2);
  check(2, "exactly one model-council-backup-* with the same sha256", b2.length === 1 && same(tree(join(support(h2), b2[0]!)), seedTree), String(b2));
  const log2 = logOf(osen2);
  check(2, "osen/logs/app.log has a migration line with three paths", !!b2[0] && log2.includes(legacy2) && log2.includes(osen2) && log2.includes(join(support(h2), b2[0]!)) && movedCount(log2) === 1, log2);
  const r2b = await runCouncil(h2, ["providers"]);
  check(2, "second launch: one backup, osen and the link unchanged, no second migration entry", r2b.code === 0 && backups(h2).length === 1 && same(tree(osen2), seedTree) && movedCount(logOf(osen2)) === 1, r2b.all);

  // step 3: old-version process (git worktree at HEAD inside work: packages are found in the project's node_modules higher up the tree)
  let worktree = false;
  try {
    // old version: the parent of the commit where prepareDataDir first appeared; the change is not committed — HEAD
    const first = execFileSync("git", ["log", "--format=%H", "-S", "prepareDataDir", "--reverse", "--", "packages/core/src/store/data-dir.ts"], { cwd: repo, encoding: "utf8" }).split("\n")[0]!.trim();
    execFileSync("git", ["worktree", "add", "--detach", oldRepo, first ? `${first}^` : "HEAD"], { cwd: repo, stdio: "ignore" });
    worktree = true;
    const oldSrc = readFileSync(join(oldRepo, "packages/core/src/store/data-dir.ts"), "utf8");
    check(3, "working copy of the old version: model-council path, no migration in the code", /"model-council"/.test(oldSrc) && !/prepareDataDir/.test(oldSrc));
    const before = sessionIds(osen2);
    const ro = await runCouncil(h2, args("Сессия прежней версии", fixed), undefined, join(oldRepo, "packages/core/src/council.ts"));
    const after = sessionIds(osen2);
    const fresh = after.filter((i) => !before.includes(i));
    check(3, "old-version council: code 0, one new session", ro.code === 0 && fresh.length === 1, `code ${ro.code}\n${ro.all}`);
    check(3, "the new session is in osen/sessions, model-council remained a link", isLink(legacy2) && existsSync(join(osen2, "sessions", fresh[0] ?? "-", "events.jsonl")) && backups(h2).length === 1);
    const rl = await runCouncil(h2, ["list"]);
    check(3, "the new council's list shows all three sessions", rl.code === 0 && after.length === 3 && after.every((i) => rl.out.includes(i)), rl.all);
  } finally {
    if (worktree) {
      try { execFileSync("git", ["worktree", "remove", "--force", oldRepo], { cwd: repo, stdio: "ignore" }); } catch {}
      try { execFileSync("git", ["worktree", "prune"], { cwd: repo, stdio: "ignore" }); } catch {}
    }
  }

  // ----- step 4: running session -----
  const h4 = sbHome("h4");
  const legacy4 = legacyFrom(seedDir, h4);
  const osen4 = join(support(h4), "osen");
  const runner = council(h4, args("Идущая сессия", slowArgs("s4")), legacy4);
  try {
    const runningId = await until("journal of the running session with pid", () => sessionIds(legacy4).filter((i) => !sessionIds(seedDir).includes(i)).find((i) => /"pid":\d+/.test(readFileSync(join(legacy4, "sessions", i, "events.jsonl"), "utf8"))));
    const r4 = await runCouncil(h4, ["providers"]);
    check(4, "new council with a running session: code 0, folder not migrated", r4.code === 0 && isDir(legacy4) && !isLink(legacy4) && !existsSync(osen4) && backups(h4).length === 0, r4.all);
    check(4, "the model-council log has the postponement reason", /postponed|отложен/.test(logOf(legacy4)), logOf(legacy4));
    check(4, "the running session is in place", existsSync(join(legacy4, "sessions", runningId, "events.jsonl")));
  } finally {
    await done(runner).catch(() => undefined);
  }
  const r4b = await runCouncil(h4, ["providers"]);
  check(4, "after the running session ends, the next launch migrates (three sessions in osen)", r4b.code === 0 && isLink(legacy4) && isDir(osen4) && backups(h4).length === 1 && sessionIds(osen4).length === 3, r4b.all);

  // ----- step 5: both folders -----
  const h5 = sbHome("h5");
  const legacy5 = legacyFrom(seedDir, h5);
  const osen5 = join(support(h5), "osen");
  copy(seed2Dir, osen5);
  const r5 = await runCouncil(h5, ["providers"]);
  const lg5 = logOf(osen5);
  check(5, "both folders: code 0, sha256 of both folders' files unchanged, no backup or link", r5.code === 0 && same(tree(legacy5), seedTree) && same(tree(osen5), seed2Tree) && backups(h5).length === 0 && !isLink(legacy5), r5.all);
  check(5, "the osen log has a warning with both paths", lg5.includes(osen5) && lg5.includes(legacy5) && /Both|Есть и/.test(lg5), lg5);

  // ----- step 6: concurrent launch -----
  const h6 = sbHome("h6");
  const legacy6 = legacyFrom(seedDir, h6);
  const osen6 = join(support(h6), "osen");
  const pa = council(h6, ["providers"]);
  const pb = council(h6, ["providers"]);
  const [ra, rb] = await Promise.all([done(pa), done(pb)]);
  check(6, "two concurrent council providers: both with code 0", ra.code === 0 && rb.code === 0, `${ra.code}/${rb.code}\n${ra.err}\n${rb.err}`);
  check(6, "one backup, osen complete, link in place, no lock", backups(h6).length === 1 && same(tree(osen6), seedTree) && same(tree(join(support(h6), backups(h6)[0] ?? "-")), seedTree) && isLink(legacy6) && !existsSync(join(support(h6), "osen.migrating")));
  check(6, "the log has one migration entry", movedCount(logOf(osen6)) === 1, logOf(osen6));

  // ----- step 7: copy failure -----
  const h7 = sbHome("h7");
  const legacy7 = legacyFrom(seedDir, h7);
  const locked = join(legacy7, "unreadable.txt");
  writeFileSync(locked, "нельзя прочитать");
  chmodSync(locked, 0o000);
  const treeBefore7 = tree(legacy7);
  try {
    const r7 = await runCouncil(h7, ["providers"]);
    check(7, "unreadable file: exit code is not 0", r7.code !== 0 && r7.code !== null, `code ${r7.code}\n${r7.all}`);
    check(7, "the message names the model-council path", r7.all.includes(legacy7), r7.all);
    check(7, "model-council unchanged, no osen, backup or lock", isDir(legacy7) && !isLink(legacy7) && same(tree(legacy7), treeBefore7) && same(readdirSync(support(h7)), ["model-council"]), String(readdirSync(support(h7))));
  } finally { chmodSync(locked, 0o644); }
  const h7b = sbHome("h7b");
  const legacy7b = legacyFrom(seedDir, h7b);
  chmodSync(support(h7b), 0o555);
  try {
    const r7b = await runCouncil(h7b, ["providers"]);
    check(7, "parent without write access: exit code is not 0, the message names the lock path, no Node stack", r7b.code !== 0 && r7b.code !== null && r7b.all.includes(join(support(h7b), "osen.migrating")) && !/^\s+at /m.test(r7b.all), `code ${r7b.code}\n${r7b.all}`);
    check(7, "parent without write access: model-council unchanged, no osen", isDir(legacy7b) && !isLink(legacy7b) && same(tree(legacy7b), seedTree) && !existsSync(join(support(h7b), "osen")));
  } finally { chmodSync(support(h7b), 0o755); }

  // ----- step 8: link to another location -----
  const h8 = sbHome("h8");
  const elsewhere = join(h8, "elsewhere");
  copy(seedDir, elsewhere);
  const legacy8 = join(support(h8), "model-council");
  symlinkSync(elsewhere, legacy8);
  const osen8 = join(support(h8), "osen");
  const r8 = await runCouncil(h8, ["providers"]);
  const lg8 = logOf(osen8);
  check(8, "link to another location: code 0, link and target unchanged", r8.code === 0 && isLink(legacy8) && readlinkSync(legacy8) === elsewhere && same(tree(elsewhere), seedTree) && backups(h8).length === 0, r8.all);
  check(8, "osen is empty: the old folder's sessions and .env are not in it", isDir(osen8) && sessionIds(osen8).length === 0 && !existsSync(join(osen8, ".env")));
  check(8, "the osen log has a warning with the link path and the target", lg8.includes(legacy8) && lg8.includes(elsewhere), lg8);
  rmSync(osen8, { recursive: true, force: true });
  const r8b = await runCouncil(h8, ["providers"], join(h8, "custom-home"));
  check(8, "COUNCIL_HOME is set: model-council untouched, osen not created", r8b.code === 0 && isLink(legacy8) && readlinkSync(legacy8) === elsewhere && same(tree(elsewhere), seedTree) && !existsSync(osen8) && backups(h8).length === 0, r8b.all);

  // ----- step 9: MCP server -----
  const h9 = sbHome("h9");
  const legacy9 = legacyFrom(seedDir, h9);
  const osen9 = join(support(h9), "osen");
  const transport = new StdioClientTransport({ command: process.execPath, args: [mainTs], cwd: repo, stderr: "ignore", env: childEnv(h9) });
  const client = new Client({ name: "data-dir-migration-check", version: "0" });
  try {
    await client.connect(transport);
    const res = (await client.callTool({ name: "council_options", arguments: {} })) as { isError?: boolean; content: { text: string }[] };
    check(9, "MCP council_options responds without error", !res.isError && (res.content[0]?.text ?? "").length > 0, res.content[0]?.text);
  } catch (e) {
    check(9, "MCP council_options responds without error", false, e instanceof Error ? e.message : String(e));
  } finally { await client.close().catch(() => undefined); }
  check(9, "folder migrated: osen with the old sha256, a link, one backup", isLink(legacy9) && same(tree(osen9), seedTree) && backups(h9).length === 1, String(readdirSync(support(h9))));
}

let failedRun = false;
try {
  await main();
} catch (e) {
  failedRun = true;
  total++;
  console.log(`FAIL stand aborted: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
} finally {
  for (const k of kids) k.kill("SIGKILL");
  for (const h of sandboxes) { try { chmodSync(support(h), 0o755); } catch {} }
}
console.log(`\nResult: ${ok} of ${total}`);
if (ok === total && !failedRun) {
  rmSync(work, { recursive: true, force: true });
  console.log("All checks passed, work folder deleted.");
  process.exit(0);
}
console.log(`There are failures. Work folder kept: ${work}`);
process.exit(1);
