// Live check of named lineups: the `council` command and the MCP server are real processes (stdio),
// participants are scripted only and the project's local fake HTTP server; 0 real model calls.
//   COUNCIL_DEV=1 COUNCIL_HOME=<folder> node packages/mcp/scenarios/lineups/check.ts
// Writes only to COUNCIL_HOME and does not delete it (this is the evidence of the check).
import "../../../core/scenarios/language-ru.ts";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { eventsPath, readSession } from "@model-council/core";
import { startFakeServer } from "../../../core/src/http/fake-server.ts";

if (process.env.COUNCIL_DEV !== "1" || !process.env.COUNCIL_HOME?.trim()) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME are required. Run: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node packages/mcp/scenarios/lineups/check.ts");
  process.exit(2);
}
const home = resolve(process.env.COUNCIL_HOME);
mkdirSync(join(home, "templates"), { recursive: true });

const root = join(import.meta.dirname, "../../../..");
const mainTs = join(root, "packages/mcp/src/main.ts");
const councilTs = join(root, "packages/core/src/council.ts");
const P1 = join(root, "packages/core/scenarios/consensus/p1.json");
const P2 = join(root, "packages/core/scenarios/consensus/p2.json");
const envFor = (h: string) => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_HOME: h, COUNCIL_DEV: "1" });

// ---- processes ----
const kids = new Set<ChildProcess>();
interface Run { code: number | null; out: string; err: string }
/** Starts council and waits for it to finish. */
function council(args: string[], h = home, timeoutMs = 60000): Promise<Run> {
  return new Promise((res) => {
    const child = spawn(process.execPath, [councilTs, ...args], { env: envFor(h), cwd: root });
    kids.add(child);
    const r: Run = { code: null, out: "", err: "" };
    child.stdout.on("data", (d) => { r.out += d; });
    child.stderr.on("data", (d) => { r.err += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); kids.delete(child); r.code = code; res(r); });
  });
}

// ---- MCP ----
type Res = { isError?: boolean; content: { type: string; text: string }[] };
interface Srv { client: Client; pid: number }
const servers: Srv[] = [];
async function connect(h = home): Promise<Srv> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mainTs], cwd: root, stderr: "ignore", env: envFor(h) });
  const client = new Client({ name: "lineups-check", version: "0" });
  await client.connect(transport);
  const s = { client, pid: transport.pid! };
  servers.push(s);
  return s;
}
const call = async (s: Srv, name: string, args: Record<string, unknown> = {}) => (await s.client.callTool({ name, arguments: args })) as Res;
const body = (r: Res) => r.content[0]?.text ?? "";
const json = (r: Res, what: string) => { if (r.isError) throw new Error(`${what}: tool error: ${body(r)}`); return JSON.parse(body(r)); };
async function statusUntilDone(s: Srv, id: string, ms = 40000) {
  let st: any;
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
    st = json(await call(s, "council_status", { sessionId: id, waitSec: 5 }), "council_status");
    if (st.status !== "running") return st;
  }
  throw new Error(`timed out waiting for the result of session ${id}: ${st?.status}`);
}

// ---- files and sessions ----
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const sessionIds = (h = home) => (existsSync(join(h, "sessions")) ? readdirSync(join(h, "sessions")).sort() : []);
const sessionOf = (id: string) => readSession(home, id)!.state.session!;
const positions = (id: string) => sessionOf(id).participants.map((p) => ({ providerId: p.providerId, model: p.model, role: p.role }));
const lineupsFile = join(home, "lineups.json");
const sessionId = (r: Run) => /^Сессия (\S+) ·/m.exec(r.out)?.[1] ?? "";

let total = 0, passed = 0;
const failed: number[] = [];
async function check(n: number, title: string, fn: () => Promise<string | void>) {
  total++;
  try {
    const note = await fn();
    passed++;
    console.log(`${n}. ${title}: OK${note ? ` — ${note}` : ""}`);
  } catch (e) {
    failed.push(n);
    console.log(`${n}. ${title}: FAIL — ${e instanceof Error ? e.message : String(e)}`);
  }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const eq = (a: unknown, b: unknown, what: string) => must(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const code = (r: Run, want: number, what: string) => must(r.code === want, `${what}: expected code ${want}, got ${r.code}; stdout: ${r.out.slice(-300)}; stderr: ${r.err.slice(-300)}`);

const expected = [
  { providerId: "scripted", model: P1, role: "Критик" },
  { providerId: "scripted", model: P2, role: "Автор" },
];
const NAME = "Ревью";
let srcId = "", lineupId = "", mcp!: Srv;
let fakeSrv: Awaited<ReturnType<typeof startFakeServer>> | undefined;

async function main() {
  await check(1, "Preparation: a template with roles, two scenario files", async () => {
    const tpl = { id: "roles-check", title: "Роли", category: "Проверка", description: "Шаблон стенда", exampleTopic: "Пример", framing: "Рамка стенда.", roles: ["Критик", "Автор"] };
    writeFileSync(join(home, "templates", "roles-check.json"), JSON.stringify(tpl));
    must(existsSync(P1) && existsSync(P2), "no scenario files");
    return `${P1}, ${P2}`;
  });

  await check(2, "CLI: source session from a template with roles", async () => {
    const r = await council(["--topic", "Первая", "--template", "roles-check", "--participant", `scripted:${P1}`, "--participant", `scripted:${P2}`, "--max-rounds", "3"]);
    code(r, 0, "council");
    srcId = sessionId(r);
    must(srcId && sessionIds().includes(srcId), `session not found in the storage (${srcId})`);
    eq(positions(srcId), expected, "participants of the source session");
    return `session ${srcId}, code ${r.code}, origin ${sessionOf(srcId).origin}`;
  });

  await check(3, "CLI: lineups save", async () => {
    const evBefore = readFileSync(eventsPath(home, srcId)), idsBefore = sessionIds();
    const r = await council(["lineups", "save", NAME, "--from-session", srcId]);
    code(r, 0, "lineups save");
    const m = /^Состав (\S+) «Ревью» сохранён: участников 2\.$/m.exec(r.out);
    must(m, `no save line: ${r.out}`);
    lineupId = m[1]!;
    must(readFileSync(eventsPath(home, srcId)).equals(evBefore), "events.jsonl of the source session changed");
    eq(sessionIds(), idsBefore, "session list");
    const saved = JSON.parse(readFileSync(lineupsFile, "utf8"));
    eq(saved.map((l: any) => [l.id, l.name, l.participants]), [[lineupId, NAME, expected]], "lineups.json");
    return `lineup ${lineupId}, code ${r.code}, the source session journal is byte-for-byte unchanged, no new sessions`;
  });

  await check(4, "CLI: lineups (list)", async () => {
    const r = await council(["lineups"]);
    code(r, 0, "lineups");
    eq(r.out.trim().split("\n"), [`${lineupId}  ${NAME}`, `  1. scripted:${P1} — Критик`, `  2. scripted:${P2} — Автор`], "list output");
    return `${r.out.trim().split("\n").length} lines, code 0`;
  });

  await check(5, "CLI: launch by lineup", async () => {
    const before = sessionIds();
    const r = await council(["--topic", "Вторая", "--lineup", lineupId, "--max-rounds", "3"]);
    code(r, 0, "council --lineup");
    must(r.out.includes(`Состав: «${NAME}» (${lineupId})`), `no "Состав: …" line: ${r.out.slice(0, 300)}`);
    const added = sessionIds().filter((i) => !before.includes(i));
    eq(added.length, 1, "new sessions");
    eq(positions(added[0]!), expected, "participants of the new session");
    eq(sessionOf(added[0]!).origin, "cli", "origin");
    return `session ${added[0]}, code 0, origin cli, same participants`;
  });

  await check(6, "CLI: repeated name", async () => {
    const h = sha(lineupsFile), ids = sessionIds();
    const r = await council(["lineups", "save", NAME, "--from-session", srcId]);
    code(r, 2, "repeated name");
    must(r.err.trim().length > 0, "the reason in stderr is empty");
    eq(sha(lineupsFile), h, "sha256 lineups.json");
    eq(sessionIds(), ids, "sessions");
    return `code 2, stderr: ${r.err.trim().split("\n")[0]}`;
  });

  await check(7, "MCP: council_options shows the lineup", async () => {
    mcp = await connect();
    const h = sha(lineupsFile);
    const o = json(await call(mcp, "council_options"), "council_options");
    const l = o.lineups.find((x: any) => x.id === lineupId);
    must(l, `the lineup is not in lineups: ${JSON.stringify(o.lineups)}`);
    eq([l.name, l.available], [NAME, true], "name and availability");
    eq(l.participants.map((p: any) => ({ providerId: p.providerId, model: p.model, role: p.role })), expected, "positions");
    eq(l.participants.map((p: any) => p.available), [true, true], "available of positions");
    eq(o.lineupsError, null, "lineupsError");
    eq(sha(lineupsFile), h, "sha256 lineups.json");
    return `lineup ${l.id}, available true, lineupsError null, lineups.json unchanged`;
  });

  await check(8, "MCP: council_start by lineup", async () => {
    const before = sessionIds();
    const st = json(await call(mcp, "council_start", { topic: "Третья", lineupId, maxRounds: 3 }), "council_start");
    eq([st.lineup?.id, st.lineup?.name], [lineupId, NAME], "lineup in the response");
    const done = await statusUntilDone(mcp, st.sessionId);
    const added = sessionIds().filter((i) => !before.includes(i));
    eq(added, [st.sessionId], "new session");
    eq(positions(st.sessionId), expected, "session participants");
    eq(sessionOf(st.sessionId).origin, "mcp", "origin");
    return `session ${st.sessionId}, result ${done.status}, origin mcp, lineup ${st.lineup.id} "${st.lineup.name}"`;
  });

  await check(9, "MCP: lineupId together with participants", async () => {
    const ids = sessionIds();
    const r = await call(mcp, "council_start", { topic: "Четвёртая", lineupId, participants: [{ providerId: "scripted", model: P1 }, { providerId: "scripted", model: P2 }] });
    must(r.isError === true, `expected a tool error, got: ${body(r).slice(0, 200)}`);
    must(/несовместим/.test(body(r)), `no word "несовместим": ${body(r)}`);
    eq(sessionIds(), ids, "sessions");
    return `isError true: ${body(r).split("\n")[0]}`;
  });

  await check(10, "Availability between the choice and the start (fake HTTP server)", async () => {
    // ponytail: the server is started in this same process (a child does not report the request counter), council and MCP reach it over HTTP.
    fakeSrv = await startFakeServer({});
    const cfgPath = join(home, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const withoutFake = structuredClone(cfg);
    cfg.providers.push({ id: "fake", kind: "openai-http", label: "Fake", models: [], baseUrl: fakeSrv.url });
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    const r = await council(["--topic", "Пятая", "--participant", `scripted:${P1}`, "--participant", "fake:fake-agree", "--max-rounds", "3"]);
    code(r, 0, "session with fake");
    const fid = sessionId(r);
    const sv = await council(["lineups", "save", "С провайдером", "--from-session", fid]);
    code(sv, 0, "lineups save");
    const lid = /^Состав (\S+) «С провайдером»/m.exec(sv.out)?.[1];
    must(lid, `no lineup id: ${sv.out}`);
    const want = positions(fid);
    eq(want.map((p) => p.providerId), ["scripted", "fake"], "positions of the session with fake");
    const find = async () => json(await call(mcp, "council_options"), "council_options").lineups.find((x: any) => x.id === lid);
    const l1 = await find();
    eq(l1?.available, true, "available before removal");
    // the catalog changes: we delete only fake
    const now = JSON.parse(readFileSync(cfgPath, "utf8"));
    now.providers = now.providers.filter((p: any) => p.id !== "fake");
    writeFileSync(cfgPath, JSON.stringify(now, null, 2));
    eq(now, withoutFake, "config.json without fake differs from the original");
    const lh = sha(lineupsFile), ids = sessionIds(), reqs = fakeSrv.requests.length;
    const c = await council(["--topic", "Шестая", "--lineup", lid]);
    code(c, 2, "council --lineup after removal");
    must(c.err.includes("fake") && c.err.includes("не найден в реестре"), `stderr does not name fake and "не найден в реестре": ${c.err}`);
    const m = await call(mcp, "council_start", { topic: "Седьмая", lineupId: lid });
    must(m.isError === true && body(m).includes("fake") && body(m).includes("не найден в реестре"), `MCP: expected an error with fake and a reason:isError=${m.isError} ${body(m)}`);
    const l2 = await find();
    eq(l2?.available, false, "available after removal");
    eq(l2.participants.map((p: any) => ({ providerId: p.providerId, model: p.model, role: p.role })), want, "positions without substitution");
    eq(l2.participants.map((p: any) => p.available), [true, false], "available of positions");
    must(/fake/.test(l2.participants[1].reason ?? ""), `the fake position has no reason: ${l2.participants[1].reason}`);
    eq(sessionIds(), ids, "sessions after refusals");
    eq(sha(lineupsFile), lh, "sha256 lineups.json");
    eq(fakeSrv.requests.length, reqs, "requests to the fake server after removal");
    return `lineup ${lid}; session ${fid}; CLI code 2 ("${c.err.trim().split("\n")[1]?.trim()}"); MCP refusal; fake position: "${l2.participants[1].reason}"; requests to the server ${reqs} → ${fakeSrv.requests.length}`;
  });

  await check(11, "An old settings set without lineups.json", async () => {
    const old = join(home, "old");
    mkdirSync(join(old, "templates"), { recursive: true });
    copyFileSync(join(home, "config.json"), join(old, "config.json"));
    copyFileSync(join(home, "templates", "roles-check.json"), join(old, "templates", "roles-check.json"));
    const cfgSha = sha(join(old, "config.json")), tplSha = sha(join(old, "templates", "roles-check.json"));
    const r = await council(["lineups"], old);
    code(r, 0, "lineups on an old folder");
    eq(r.out.trim(), "Составов нет.", "output");
    const s = await connect(old);
    const o = json(await call(s, "council_options"), "council_options (old)");
    eq([o.lineups, o.lineupsError], [[], null], "lineups and lineupsError");
    eq(sha(join(old, "config.json")), cfgSha, "config.json");
    eq(sha(join(old, "templates", "roles-check.json")), tplSha, "template");
    must(!existsSync(join(old, "lineups.json")), "lineups.json was created");
    return "\"Составов нет.\", lineups [], lineupsError null, config.json and the template as before, lineups.json not created";
  });
}

const EXPECTED = 11;
const t0 = Date.now();
try {
  await main();
} catch (e) {
  total++; failed.push(0);
  console.log(`STAND FAILURE: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  for (const s of servers) { try { process.kill(s.pid, "SIGKILL"); } catch { /* already finished */ } }
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* already finished */ } }
  await fakeSrv?.close();
}
console.log(`\n12. Real model calls: 0`);
console.log(`Result: ${passed} of ${total}; stand: ${home} (${Math.round((Date.now() - t0) / 1000)} s)`);
const ok = passed === total && total === EXPECTED;
console.log(ok ? "PASS" : `FAIL: steps ${failed.join(", ") || "?"} (checked ${total} of ${EXPECTED})`);
process.exit(ok ? 0 : 1);
