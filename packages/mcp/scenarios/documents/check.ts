// The MCP part of the local document check (DOCX, XLSX, PPTX): a real server over stdio, participants are scripted only (0 model calls).
// Started from packages/core/scenarios/documents/check.ts, which prepares the fixtures folder; separately:
//   COUNCIL_DEV=1 COUNCIL_HOME=<new empty folder inside the project> node packages/mcp/scenarios/documents/check.ts <fixtures folder> <ru|en> <reason text for a damaged document> [<document file name> <expected text file name>]
// The document defaults to report.docx with expected.txt; the damaged-document refusal runs only for that default document.
// Writes only to COUNCIL_HOME, does not delete it. The last output line is RESULT {json}.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const home = process.env.COUNCIL_HOME, [fxArg, lang, damaged, docName = "report.docx", expName = "expected.txt"] = process.argv.slice(2);
const usage = "Run: COUNCIL_DEV=1 COUNCIL_HOME=<new empty folder inside the project> node packages/mcp/scenarios/documents/check.ts <fixtures folder> <ru|en> <damaged reason> [<document file name> <expected text file name>]";
if (process.env.COUNCIL_DEV !== "1" || !home || !fxArg || !lang || !damaged) { console.error(usage); process.exit(2); }
if (!existsSync(resolve(home)) || !statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0) {
  console.error(`COUNCIL_HOME ${resolve(home)} must exist and be empty. ${usage}`);
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
const dir = realpathSync(resolve(home)), fx = realpathSync(resolve(fxArg));
const EXPECTED = readFileSync(join(fx, expName), "utf8");
const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: lang, COUNCIL_HOME: dir, COUNCIL_DEV: "1" };
let n = 0;
const ok = (s: string) => { n++; console.log(`ok: ${s}`); };
const sha256 = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

type Res = { isError?: boolean; content: { type: string; text: string }[] };
const errors: string[] = [];
const transport = new StdioClientTransport({ command: process.execPath, args: [join(repo, "packages/mcp/src/main.ts")], cwd: repo, stderr: "pipe", env: baseEnv });
const client = new Client({ name: "documents-check", version: "0" });
client.onerror = (e) => errors.push(`client: ${e.message}`);
transport.onerror = (e) => errors.push(`transport: ${e.message}`);
const body = (r: Res) => r.content[0]?.text ?? "";
const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Res;
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
const parts = [{ providerId: "scripted", model: "consensus/p1.json" }, { providerId: "scripted", model: "consensus/p2.json" }];
const start = (attachments: string[]) => call("council_start", { topic: "Что в документе?", participants: parts, maxRounds: 3, attachments });

let result: object | undefined;
async function main() {
  await client.connect(transport);
  const s = json(await start([join(fx, docName)]), "council_start");
  assert.equal(s.materials.count, 1);
  assert.equal(s.materials.chars, EXPECTED.length);
  const fin = await done(s.sessionId);
  const sd = join(dir, "sessions", s.sessionId);
  const m = readFileSync(join(sd, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "session_created").session.materials[0];
  assert.deepEqual([m.chars, m.sha256], [EXPECTED.length, sha256(EXPECTED)]);
  const snapshot = join(sd, "materials", "m1.txt");
  assert.equal(readFileSync(snapshot, "utf8"), EXPECTED);
  ok(`MCP: council_start with ${docName} — materials.count 1, chars ${EXPECTED.length}; session finished (${fin.status}); the journal has the text sha256; m1.txt equals the text`);

  if (docName === "report.docx") {
    const before = sessions().length;
    const r = await start([join(fx, "broken.docx")]);
    assert.ok(r.isError === true && body(r).includes(damaged), `broken.docx: ${r.isError} «${body(r)}»`);
    assert.equal(sessions().length, before, "a session appeared");
    ok(`MCP: a damaged .docx gives isError with "${damaged}", no new session`);
  }
  assert.deepEqual(errors, [], "client/transport errors");
  result = { checks: n, sha256: m.sha256, chars: m.chars, snapshot };
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
