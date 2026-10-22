// The MCP part of the local PDF check: a real server over stdio, participants are scripted only (0 model calls).
// Started from packages/core/scenarios/pdf/check.ts; separately:
//   COUNCIL_DEV=1 node packages/core/scenarios/pdf/check.ts --fixtures <folder>
//   COUNCIL_DEV=1 COUNCIL_HOME=<new empty folder inside the project> node packages/mcp/scenarios/pdf/check.ts <folder with fixtures>
// Writes only to COUNCIL_HOME, does not delete it. The last output line is RESULT {json}.
import "../../../core/scenarios/language-ru.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sha256Of } from "@model-council/core";

const home = process.env.COUNCIL_HOME, fxArg = process.argv[2];
const usage = "Run: COUNCIL_DEV=1 COUNCIL_HOME=<new empty folder inside the project> node packages/mcp/scenarios/pdf/check.ts <folder with fixtures>";
if (process.env.COUNCIL_DEV !== "1" || !home || !fxArg) { console.error(usage); process.exit(2); }
if (!existsSync(resolve(home)) || !statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0) {
  console.error(`COUNCIL_HOME ${resolve(home)} must exist and be empty. ${usage}`);
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
const dir = realpathSync(resolve(home)), fx = realpathSync(resolve(fxArg));
const EXPECTED = "Первая страница\n\nВторая страница";
const SECRET = "stand-secret-value";
const REASON = {
  locked: "PDF зашифрован — пароль не запрашивается",
  scan: "в PDF не найден текст",
  broken: "PDF повреждён",
  blank201: "в PDF больше 200 страниц без текстового слоя",
};
const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_HOME: dir, COUNCIL_DEV: "1" };
let n = 0;
const ok = (s: string) => { n++; console.log(`ok: ${s}`); };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

type Res = { isError?: boolean; content: { type: string; text: string }[] };
const errors: string[] = [];
const transport = new StdioClientTransport({ command: process.execPath, args: [join(repo, "packages/mcp/src/main.ts")], cwd: repo, stderr: "pipe", env: baseEnv });
let serverErr = "";
transport.stderr?.on("data", (d) => { serverErr += d; });
const client = new Client({ name: "pdf-check", version: "0" });
client.onerror = (e) => errors.push(`client: ${e.message}`);
transport.onerror = (e) => errors.push(`transport: ${e.message}`);
const responses: string[] = [];
const body = (r: Res) => r.content[0]?.text ?? "";
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as Res;
  responses.push(body(r));
  return r;
};
const json = (r: Res, what: string) => { assert.ok(!r.isError, `${what}: tool error: ${body(r)}`); return JSON.parse(body(r)); };
async function done(id: string) {
  let st: any;
  for (let i = 0; i < 10; i++) {
    st = json(await call("council_status", { sessionId: id, waitSec: 20 }), "council_status");
    if (st.status !== "running") return st;
  }
  assert.fail(`session ${id} did not finish: ${JSON.stringify(st)}`);
}
const sessions = () => (existsSync(join(dir, "sessions")) ? readdirSync(join(dir, "sessions")) : []);
function allFiles(d: string): string[] {
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(d, e.name)) : [join(d, e.name)]));
}
const tree = (d: string) => Object.fromEntries(allFiles(d).map((f) => [f, sha(readFileSync(f))]));
const parts = [{ providerId: "scripted", model: "consensus/p1.json" }, { providerId: "scripted", model: "consensus/p2.json" }];
const start = (attachments: string[]) => call("council_start", { topic: "Что в PDF?", participants: parts, maxRounds: 3, attachments });

let result: object | undefined;
async function main() {
  const before = tree(fx);
  await client.connect(transport);

  // ---- 3. Good PDF ----
  const tools = (await client.listTools()).tools;
  const cs = tools.find((t) => t.name === "council_start")!;
  const desc = `${cs.description ?? ""}\n${JSON.stringify(cs.inputSchema)}`;
  assert.ok(desc.includes("PDF с текстовым слоем"), "the council_start description does not contain \"PDF с текстовым слоем\"");
  const s = json(await start([join(fx, "text.pdf")]), "council_start");
  assert.equal(s.materials.count, 1);
  assert.equal(s.materials.chars, EXPECTED.length);
  const fin = await done(s.sessionId);
  assert.ok(fin.status !== "running", JSON.stringify(fin));
  const sd = join(dir, "sessions", s.sessionId);
  const created = readFileSync(join(sd, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "session_created").session;
  const m = created.materials[0];
  assert.ok(String(m.name).endsWith("text.pdf"));
  assert.deepEqual([m.chars, m.sha256], [EXPECTED.length, sha256Of(EXPECTED)]);
  const snapshot = join(sd, "materials", "m1.txt");
  assert.equal(readFileSync(snapshot, "utf8"), EXPECTED);
  ok(`MCP: council_start with text.pdf — materials.count 1, chars ${EXPECTED.length}; session finished (${fin.status}); the journal has the text sha256; m1.txt equals the text; the description contains "PDF с текстовым слоем"`);

  // ---- 10. Text without recognition promises ----
  assert.ok(desc.includes("сканированные PDF не принимаются"), "no \"сканированные PDF не принимаются\"");
  ok("MCP: the attachments description contains \"сканированные PDF не принимаются\" (the tool's own description does not have this phrase — it is in the parameter description)");

  // ---- 6. Refusals ----
  const nSessions = sessions().length;
  for (const [f, reason] of Object.entries(REASON)) {
    const r = await start([join(fx, `${f}.pdf`)]);
    assert.ok(r.isError === true && body(r).includes(reason), `${f}.pdf: ${r.isError} «${body(r)}»`);
    assert.equal(sessions().length, nSessions, `${f}.pdf: a session appeared`);
  }
  ok("MCP, explicit locked/scan/broken/blank201: isError with a reason for each, no new sessions");
  const rf = json(await start([join(fx, "proj")]), "council_start with a folder");
  assert.equal(rf.materials.count, 2);
  const sk = rf.materials.skipped as { name: string; reason: string }[];
  assert.equal(sk.length, 5, JSON.stringify(sk));
  for (const [f, reason] of Object.entries(REASON)) assert.ok(sk.some((x) => x.name.endsWith(`proj/${f}.pdf`) && x.reason.includes(reason)), `no ${f}.pdf: ${JSON.stringify(sk)}`);
  const envSk = sk.find((x) => x.name.endsWith("proj/.env"));
  assert.ok(envSk?.reason, JSON.stringify(sk));
  await done(rf.sessionId);
  const folderMaterials = readFileSync(join(dir, "sessions", rf.sessionId, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "session_created").session.materials as { name: string }[];
  assert.ok(folderMaterials.length === 2 && folderMaterials.some((x) => x.name.endsWith("README.md")) && folderMaterials.some((x) => x.name.endsWith("good.pdf")), JSON.stringify(folderMaterials));
  ok(`MCP, folder: materials.skipped — four PDFs with reasons and .env ("${envSk.reason}"), 2 materials collected`);

  // ---- Scan through the real osen-ocr helper ----
  const ss = json(await start([join(fx, "ocr.pdf")]), "council_start with a scan");
  assert.equal(ss.materials.count, 1);
  await done(ss.sessionId);
  const sdScan = join(dir, "sessions", ss.sessionId);
  const sc = readFileSync(join(sdScan, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "session_created").session.materials[0];
  const scanSnapshot = join(sdScan, "materials", "m1.txt");
  const scanText = readFileSync(scanSnapshot, "utf8");
  assert.equal(scanText.split("\n\n").length, 2, JSON.stringify(scanText));
  assert.deepEqual([sc.chars, sc.sha256, ss.materials.chars], [scanText.length, sha256Of(scanText), scanText.length]);
  ok(`MCP: council_start with the scan ocr.pdf - recognized text of two pages (${scanText.length} chars), the journal sha256 equals the snapshot text`);

  // ---- leaks and source similarity ----
  const log = existsSync(join(dir, "logs/app.log")) ? readFileSync(join(dir, "logs/app.log"), "utf8") : "";
  const zones = [...responses, log, serverErr, ...allFiles(dir).map((f) => readFileSync(f, "utf8"))];
  assert.ok(!zones.some((t) => t.includes(SECRET)), "the .env control string was found");
  ok("the .env control string is neither in the MCP responses, nor in app.log, nor in the server's stderr, nor in the session files");
  assert.deepEqual(tree(fx), before, "source files changed");
  ok("source files (PDF, the proj folder) are byte-for-byte unchanged");
  assert.deepEqual(errors, [], "client/transport errors");
  result = { checks: n, sha256: m.sha256, chars: m.chars, snapshot, scanSha256: sc.sha256, scanChars: sc.chars, scanSnapshot };
}

let failed = false;
const guard = setTimeout(() => { console.error("FAILURE: the MCP part did not finish within 120 seconds"); try { transport.pid && process.kill(transport.pid, "SIGKILL"); } catch {} process.exit(1); }, 120000);
try {
  await main();
  console.log(`MCP part result: checks ${n}; real model calls 0`);
  console.log(`RESULT ${JSON.stringify(result)}`);
} catch (e) {
  failed = true;
  console.error(`FAILURE: ${e instanceof Error ? e.message : String(e)}\nData folder left in place: ${dir}`);
} finally {
  clearTimeout(guard);
  try { await client.close(); } catch {}
  try { if (transport.pid) process.kill(transport.pid, "SIGKILL"); } catch {}
}
process.exit(failed ? 1 : 0);
