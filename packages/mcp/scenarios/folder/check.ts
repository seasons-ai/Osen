// Live check of the folder snapshot through MCP: the server is a child process over stdio, like a real agent's.
// Participants are scripted only, 0 real model calls.
//   COUNCIL_DEV=1 node packages/mcp/scenarios/folder/check.ts
// Writes only to <repository>/.council-data/mcp-folder-check-*; deletes it on success, leaves it on failure.
import "../../../core/scenarios/language-ru.ts";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FOLDER_LIMITS, readSession } from "@model-council/core";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Run: COUNCIL_DEV=1 node packages/mcp/scenarios/folder/check.ts");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
const work = join(repo, ".council-data", `mcp-folder-check-${Date.now()}-${randomBytes(3).toString("hex")}`);
const home = join(work, "home"), src = join(work, "src");
for (const d of [home, src]) mkdirSync(d, { recursive: true });
const proj = join(src, "sample");
const rnd = () => randomBytes(4).toString("hex");
const MARK = "МАРКЕР-MCP-ПАПКА-39", SECRET = `СЕКРЕТ-ENV-${rnd()}`;
const ENGINE = `// ${MARK}\nexport const engine = () => 1;\n`;
const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_HOME: home, COUNCIL_DEV: "1" };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let n = 0;
const ok = (s: string) => { n++; console.log(`ok: ${s}`); };

type Res = { isError?: boolean; content: { type: string; text: string }[] };
const errors: string[] = [];
const transport = new StdioClientTransport({ command: process.execPath, args: [join(repo, "packages/mcp/src/main.ts")], cwd: repo, stderr: "pipe", env: baseEnv });
let serverErr = "";
transport.stderr?.on("data", (d) => { serverErr += d; });
const client = new Client({ name: "folder-check", version: "0" });
client.onerror = (e) => errors.push(`client: ${e.message}`);
transport.onerror = (e) => errors.push(`transport: ${e.message}`);
const responses: string[] = [];
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as Res;
  responses.push(body(r));
  return r;
};
const body = (r: Res) => r.content[0]?.text ?? "";
const json = (r: Res, what: string) => { assert.ok(!r.isError, `${what}: tool error: ${body(r)}`); return JSON.parse(body(r)); };
const status = async (id: string, waitSec?: number) => json(await call("council_status", { sessionId: id, ...(waitSec === undefined ? {} : { waitSec }) }), "council_status");
async function done(id: string) {
  let st: any;
  for (let i = 0; i < 10; i++) { st = await status(id, 20); if (st.status !== "running") return st; }
  assert.fail(`session ${id} did not finish within 10 calls: ${JSON.stringify(st)}`);
}

function makeProj() {
  rmSync(proj, { recursive: true, force: true });
  const w = (rel: string, text: string | Buffer) => { mkdirSync(join(proj, rel, ".."), { recursive: true }); writeFileSync(join(proj, rel), text); };
  w("README.md", "# Проект\nКороткое описание проекта.\n");
  w("src/engine.ts", ENGINE);
  for (let i = 0; i < 100; i++) w(`src/gen/f${String(i).padStart(3, "0")}.ts`, `export const v${i} = [\n${"  1234567890,\n".repeat(75)}];\n`);
  w(".env.local", `TOKEN=${SECRET}\n`);
  w("blob.bin", Buffer.from([0, 1, 2, 0, 255, 254, 0, 0]));
  w("node_modules/x/index.js", "module.exports = 1;\n");
  symlinkSync(join(proj, "README.md"), join(proj, "link.md"));
}
/** files/chars are computed from the fixture itself: text files without hidden ones, ignore, symlinks and binary ones. */
function expected() {
  let files = 0, chars = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.isSymbolicLink()) continue;
      if (e.isDirectory()) { walk(join(d, e.name)); continue; }
      const b = readFileSync(join(d, e.name));
      if (b.includes(0)) continue;
      files++; chars += b.toString("utf8").length;
    }
  };
  walk(proj);
  return { files, chars };
}
function allFiles(d: string): string[] {
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(d, e.name)) : [join(d, e.name)]));
}
const sdir = (id: string) => join(home, "sessions", id);
const hashes = (id: string) => Object.fromEntries(["workspace", "materials"].flatMap((s) => allFiles(join(sdir(id), s))).map((f) => [f, createHash("sha256").update(readFileSync(f)).digest("hex")]));
const sessions = () => (existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")) : []);
const appLog = () => (existsSync(join(home, "logs/app.log")) ? readFileSync(join(home, "logs/app.log"), "utf8") : "");
const leaks = (text: string, needles: [string, string][]) => { for (const [what, nd] of needles) assert.ok(!text.includes(nd), `leak: ${what} (${nd}) found`); };

async function main() {
  makeProj();
  const exp = expected();
  assert.ok(exp.chars > 60000, `fixture is too small: ${exp.chars}`);
  await client.connect(transport);
  const pid = transport.pid!;

  // ---- 1. Connection ----
  assert.ok(client.getInstructions()?.includes("снимка папки"), "the instructions do not contain \"снимка папки\"");
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 7, `tools ${tools.length}`);
  const cs = tools.find((t) => t.name === "council_start")!;
  assert.ok(cs.description?.includes("снимка папки"), "the council_start description does not contain \"снимка папки\"");
  const att: any = (cs.inputSchema.properties as any)?.attachments;
  assert.ok(att?.type === "array" && att.items?.type === "string", `attachments: ${JSON.stringify(att)}`);
  ok("connection: the instructions and the council_start description mention the folder snapshot, 7 tools, attachments is an array of strings");

  // ---- 2. Launch with a folder ----
  const parts = [{ providerId: "scripted", model: "folder/marker-p1.json" }, { providerId: "scripted", model: "folder/p2.json" }];
  const r2 = await call("council_start", { topic: "Проверь файл sample/src/engine.ts", participants: parts, maxRounds: 2, attachments: [proj] });
  console.log("--- council_start ---\n" + JSON.stringify(JSON.parse(body(r2)), null, 2));
  const s = json(r2, "council_start");
  assert.deepEqual(s.folder, exp, `folder ${JSON.stringify(s.folder)}`);
  const m = s.materials;
  assert.ok(m.count >= 1 && m.chars <= 60000, `materials ${m.count}/${m.chars}`);
  assert.equal(m.left.count, exp.files - m.count, "materials.left.count");
  assert.equal(m.left.items.length, Math.min(20, m.left.count), "left.items.length");
  assert.ok(m.left.items.every((i: any) => i.name && i.reason), "left.items has no reason");
  const sk = (nm: string) => m.skipped.find((x: any) => x.name.includes(nm));
  assert.ok(/окруж/i.test(sk(".env.local")?.reason ?? ""), `.env.local: ${JSON.stringify(sk(".env.local"))}`);
  for (const nm of ["blob.bin", "node_modules", "link.md"]) assert.ok(sk(nm)?.reason, `skipped has no ${nm}: ${JSON.stringify(m.skipped)}`);
  assert.equal(s.maxCalls, 12);
  ok(`council_start: folder {${exp.files}, ${exp.chars}}, materials ${m.count}/${m.chars}, left ${m.left.count}, skipped is full, maxCalls 12`);
  const id: string = s.sessionId;

  // ---- 3. Result ----
  const fin = await done(id);
  console.log("--- council_status ---\n" + JSON.stringify(fin, null, 2));
  assert.equal(fin.status, "consensus", `status ${fin.status}`);
  assert.ok(fin.participants.every((p: any) => p.state === "active"), "not all participants are active");
  assert.deepEqual(fin.folder, s.folder);
  const fr = fin.filesRead.find((f: any) => f.name === "sample/src/engine.ts" && f.participantId === "p1");
  assert.ok(fr && fr.chars === ENGINE.length && fr.shown <= fr.chars, `filesRead ${JSON.stringify(fin.filesRead)}`);
  assert.ok(fin.solution != null, "solution null");
  ok("council_status: consensus, both active, same folder, filesRead sample/src/engine.ts for p1, solution in place");

  // ---- 4. Calls ----
  const turns = readSession(home, id)!.state.turns;
  const withRead = turns.filter((t) => t.filesRead?.length);
  assert.ok(withRead.length >= 1 && withRead.every((t) => t.attempts === 2), `turns with filesRead: ${JSON.stringify(withRead.map((t) => t.attempts))} (total turns ${turns.length})`);
  const sum = turns.reduce((a, t) => a + t.attempts, 0);
  assert.ok(sum <= s.maxCalls, `calls ${sum} > ${s.maxCalls}`);
  ok(`reading the file fit into 2 calls of the turn; total calls ${sum} ≤ ${s.maxCalls}`);

  // ---- 4b. Explicit file before the folder (change 110): the same snapshot, the file is read from it ----
  const sx = json(await call("council_start", { topic: "Проверь файл sample/src/engine.ts", participants: parts, maxRounds: 2, attachments: [join(proj, "src/engine.ts"), proj] }), "council_start: explicit file before the folder");
  assert.deepEqual(sx.folder, s.folder, `explicit file before the folder: folder ${JSON.stringify(sx.folder)} ≠ ${JSON.stringify(s.folder)} (one folder, files ${exp.files})`);
  const fx = await done(sx.sessionId);
  assert.equal(fx.status, "consensus", `explicit file before the folder: status ${fx.status}`);
  assert.ok(fx.filesRead.some((f: any) => f.name === "sample/src/engine.ts"), `explicit file before the folder: filesRead ${JSON.stringify(fx.filesRead)}`);
  ok(`explicit file before the folder: folder {${exp.files}, ${exp.chars}} as for a single folder, sample/src/engine.ts in filesRead`);

  // ---- 5. Nothing extra ----
  const needles: [string, string][] = [["text of engine.ts", MARK], ["secret", SECRET], ["absolute path of src", src]];
  leaks(responses.join("\n"), needles); leaks(appLog(), needles); leaks(serverErr, needles);
  for (const f of allFiles(sdir(id))) assert.ok(!readFileSync(f, "utf8").includes(SECRET), `secret in ${f}`);
  assert.ok(!existsSync(join(sdir(id), "workspace/sample/.env.local")), ".env.local in the snapshot");
  assert.ok(readFileSync(join(sdir(id), "workspace/sample/src/engine.ts"), "utf8").includes(MARK), "the snapshot is incomplete");
  ok("responses, app.log and stderr without the marker, the secret and the src path; no secret in the session files; the snapshot is complete");

  // ---- 6. The snapshot does not depend on the source ----
  const h0 = hashes(id);
  assert.ok(Object.keys(h0).length > 0);
  writeFileSync(join(proj, "src/engine.ts"), "// другой текст\n");
  rmSync(proj, { recursive: true, force: true });
  const again = await status(id);
  const strip = ({ wait, ...r }: any) => r;
  assert.deepEqual(strip(again), strip(fin), "council_status changed after the source was removed");
  assert.deepEqual(hashes(id), h0, "snapshot hashes changed");
  ok("after the source is removed council_status is the same (except wait), snapshot hashes did not change");

  // ---- 7. Without a folder ----
  const base = (f: string) => ({ providerId: "scripted", model: `consensus/${f}` });
  const s7 = json(await call("council_start", { topic: "Обсуждение без материалов", participants: [base("p1.json"), base("p2.json")], maxRounds: 3 }), "council_start without a folder");
  assert.equal(s7.folder, null);
  assert.deepEqual(s7.materials.left, { count: 0, items: [] });
  const f7 = await done(s7.sessionId);
  assert.equal(f7.folder, null);
  assert.deepEqual(f7.filesRead, []);
  assert.deepEqual(f7.materials.names, []);
  assert.ok("status" in f7 && "solution" in f7, "no status/solution");
  assert.ok(!existsSync(join(sdir(s7.sessionId), "workspace")), "workspace exists");
  ok("session without a folder: folder null, left empty, filesRead and materials.names empty, no workspace");

  // ---- 8. Refusals ----
  makeProj();
  mkdirSync(join(src, "huge"), { recursive: true });
  writeFileSync(join(src, "huge/a.txt"), "a".repeat(FOLDER_LIMITS.snapshotChars + 1));
  const before = sessions().length;
  assert.equal(before, 3); // folder, explicit file before the folder (4b), without a folder
  const texts: string[] = [];
  const refuse = async (what: string, att: string, must: (RegExp | string)[]) => {
    const r = await call("council_start", { topic: "t", participants: parts, maxRounds: 1, attachments: [att] });
    assert.ok(r.isError === true, `${what}: not an error: ${body(r)}`);
    const t = body(r); texts.push(`${what}: ${t}`);
    for (const x of must) assert.ok(typeof x === "string" ? t.includes(x) : x.test(t), `${what}: no ${x} in "${t}"`);
    leaks(t, needles);
    assert.ok((await client.callTool({ name: "council_options", arguments: {} }) as Res).content.length > 0, "the server does not respond");
    assert.equal(sessions().length, before, `${what}: a session appeared`);
  };
  await refuse("a", join(proj, ".env.local"), [".env.local", /окруж/i]);
  await refuse("b", "src/a.ts", ["src/a.ts", /абсолютн/i]);
  await refuse("c", join(src, "huge"), [String(FOLDER_LIMITS.snapshotChars + 1), String(FOLDER_LIMITS.snapshotChars)]);
  console.log("--- refusals ---\n" + texts.join("\n"));
  ok("refusals: .env.local, relative path, folder over the limit — isError, server alive, no sessions added, no leaks");

  // ---- 9. Same-named folders ----
  const dirA = join(src, "a/language"), dirB = join(src, "b/language");
  for (const [d, t] of [[dirA, "из a"], [dirB, "из b"]] as const) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, "check.ts"), `// ${rnd()} ${t}\n`); }
  const cons = (f: string) => ({ providerId: "scripted", model: `consensus/${f}` });
  const r9 = await call("council_start", { topic: "Одноимённые папки", participants: [cons("p1.json"), cons("p2.json")], maxRounds: 3, attachments: [dirA, dirB] });
  const s9 = json(r9, "council_start with same-named folders");
  console.log("--- council_start (same-named) ---\n" + JSON.stringify(s9.materials, null, 2));
  const f9 = await done(s9.sessionId);
  assert.equal(f9.status, "consensus", `status ${f9.status}`);
  const names9: string[] = f9.materials.names;
  for (const nm of ["language/check.ts", "language (2)/check.ts"]) assert.ok(names9.includes(nm), `materials.names has no ${nm}: ${names9}`);
  assert.equal(s9.materials.count, 2, `materials.count ${s9.materials.count}`);
  assert.equal(readFileSync(join(sdir(s9.sessionId), "workspace/language/check.ts"), "utf8"), readFileSync(join(dirA, "check.ts"), "utf8"));
  assert.equal(readFileSync(join(sdir(s9.sessionId), "workspace/language (2)/check.ts"), "utf8"), readFileSync(join(dirB, "check.ts"), "utf8"));
  ok(`same-named folders through MCP: consensus, materials.names — ${names9.join(", ")}; workspace/language/ and workspace/language (2)/ with the contents of each`);

  // ---- 10. Protocol and shutdown ----
  assert.deepEqual(errors, [], "client/transport errors");
  leaks(appLog(), needles.slice(1)); leaks(serverErr, needles.slice(1));
  await client.close();
  for (let t0 = Date.now(); ; await sleep(50)) {
    try { process.kill(pid, 0); } catch { break; }
    assert.ok(Date.now() - t0 < 5000, "the server process did not finish within 5 seconds");
  }
  ok("the protocol is clean, app.log without the secret and the src path, the server finished after close()");
}

let failed = false;
const guard = setTimeout(() => { console.error(`FAILURE: the stand did not finish within 120 seconds\nStand left in place: ${work}`); try { transport.pid && process.kill(transport.pid, "SIGKILL"); } catch {} process.exit(1); }, 120000);
try {
  await main();
  console.log(`Result: all checks passed (${n})`);
} catch (e) {
  failed = true;
  console.error(`FAILURE: ${e instanceof Error ? e.message : String(e)}\nStand left in place: ${work}`);
} finally {
  clearTimeout(guard);
  try { await client.close(); } catch {}
  try { if (transport.pid) process.kill(transport.pid, "SIGKILL"); } catch {}
  if (!failed) rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
