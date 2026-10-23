// The MCP part of the ZIP archive check: a real server over stdio, scripted participants only (0 model calls).
// Started from packages/core/scenarios/zip-archive/check.ts; separately:
//   COUNCIL_DEV=1 COUNCIL_HOME=<new empty folder inside the project> node packages/mcp/scenarios/zip-archive/check.ts <archive file> <ru|en>
// Writes only to COUNCIL_HOME, does not delete it. The last output line is RESULT {json}.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const home = process.env.COUNCIL_HOME, [zipArg, lang] = process.argv.slice(2);
const usage = "Run: COUNCIL_DEV=1 COUNCIL_HOME=<new empty folder inside the project> node packages/mcp/scenarios/zip-archive/check.ts <archive file> <ru|en>";
if (process.env.COUNCIL_DEV !== "1" || !home || !zipArg || !lang) { console.error(usage); process.exit(2); }
if (!existsSync(resolve(home)) || !statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0) {
  console.error(`COUNCIL_HOME ${resolve(home)} must exist and be empty. ${usage}`);
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
const dir = realpathSync(resolve(home)), zip = realpathSync(resolve(zipArg));
const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: lang, COUNCIL_HOME: dir, COUNCIL_DEV: "1" };

type Res = { isError?: boolean; content: { type: string; text: string }[] };
const errors: string[] = [];
const transport = new StdioClientTransport({ command: process.execPath, args: [join(repo, "packages/mcp/src/main.ts")], cwd: repo, stderr: "pipe", env: baseEnv });
const client = new Client({ name: "zip-archive-check", version: "0" });
client.onerror = (e) => errors.push(`client: ${e.message}`);
transport.onerror = (e) => errors.push(`transport: ${e.message}`);
const body = (r: Res) => r.content[0]?.text ?? "";
const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Res;
const json = (r: Res, what: string) => { assert.ok(!r.isError, `${what}: tool error: ${body(r)}`); return JSON.parse(body(r)); };
const parts = [{ providerId: "scripted", model: "consensus/p1.json" }, { providerId: "scripted", model: "consensus/p2.json" }];

let result: object | undefined;
async function main() {
  await client.connect(transport);
  const s = json(await call("council_start", { topic: "Что в архиве?", participants: parts, maxRounds: 3, attachments: [zip] }), "council_start");
  let st: any;
  for (let i = 0; i < 10; i++) {
    st = json(await call("council_status", { sessionId: s.sessionId, waitSec: 20 }), "council_status");
    if (st.status !== "running") break;
  }
  assert.notEqual(st.status, "running", "the session did not finish");
  const sd = join(dir, "sessions", s.sessionId);
  const created = readFileSync(join(sd, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "session_created").session;
  const materials = created.materials.map((m: { name: string; chars: number; sha256: string }, i: number) => ({ name: m.name, chars: m.chars, sha256: m.sha256, text: readFileSync(join(sd, "materials", `m${i + 1}.txt`), "utf8") }));
  assert.equal(s.materials.count, materials.length);
  assert.deepEqual(errors, [], "client/transport errors");
  console.log(`ok: MCP: council_start with the archive - materials.count ${s.materials.count}, session finished (${st.status})`);
  result = { checks: 1, count: s.materials.count, chars: s.materials.chars, materials, workspace: created.workspace };
}

let failed = false;
const guard = setTimeout(() => { console.error("FAILURE: the MCP part did not finish within 120 seconds"); try { transport.pid && process.kill(transport.pid, "SIGKILL"); } catch {} process.exit(1); }, 120000);
try {
  await main();
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
