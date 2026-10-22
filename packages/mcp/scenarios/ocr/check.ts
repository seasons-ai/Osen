// The MCP part of the image text check: a real server over stdio, participants are scripted only (0 model calls).
// Started from packages/core/scenarios/ocr/check.ts, which writes the manifest of cases; separately:
//   COUNCIL_DEV=1 COUNCIL_HOME=<new empty folder inside the project> node packages/mcp/scenarios/ocr/check.ts <manifest.json> <ru|en>
// A case with a helper starts its own server with COUNCIL_OCR_HELPER. Writes only to COUNCIL_HOME, does not delete it. The last output line is RESULT {json}.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const home = process.env.COUNCIL_HOME, [manifestArg, lang] = process.argv.slice(2);
const usage = "Run: COUNCIL_DEV=1 COUNCIL_HOME=<new empty folder inside the project> node packages/mcp/scenarios/ocr/check.ts <manifest.json> <ru|en>";
if (process.env.COUNCIL_DEV !== "1" || !home || !manifestArg || !lang) { console.error(usage); process.exit(2); }
if (!existsSync(resolve(home)) || !statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0) {
  console.error(`COUNCIL_HOME ${resolve(home)} must exist and be empty. ${usage}`);
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
const dir = realpathSync(resolve(home));
const { cases } = JSON.parse(readFileSync(resolve(manifestArg), "utf8")) as { cases: { id: string; kind: "ok" | "refuse" | "folder"; path: string; helper?: string }[] };
const promptLog = join(dir, "prompts.jsonl");
const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: lang, COUNCIL_HOME: dir, COUNCIL_DEV: "1", COUNCIL_SCRIPTED_PROMPT_LOG: promptLog };
let n = 0;
const ok = (s: string) => { n++; console.log(`ok: ${s}`); };

type Res = { isError?: boolean; content: { type: string; text: string }[] };
const errors: string[] = [];
let transport: StdioClientTransport | undefined;
let client: Client | undefined;
async function open(helper?: string) {
  await close();
  transport = new StdioClientTransport({ command: process.execPath, args: [join(repo, "packages/mcp/src/main.ts")], cwd: repo, stderr: "pipe", env: { ...baseEnv, ...(helper ? { COUNCIL_OCR_HELPER: helper } : {}) } });
  client = new Client({ name: "ocr-check", version: "0" });
  client.onerror = (e) => errors.push(`client: ${e.message}`);
  transport.onerror = (e) => errors.push(`transport: ${e.message}`);
  await client.connect(transport);
}
async function close() {
  try { await client?.close(); } catch {}
  try { if (transport?.pid) process.kill(transport.pid, "SIGKILL"); } catch {}
  client = undefined; transport = undefined;
}
const body = (r: Res) => r.content[0]?.text ?? "";
const call = async (name: string, args: Record<string, unknown> = {}) => (await client!.callTool({ name, arguments: args })) as Res;
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
const promptLines = () => (existsSync(promptLog) ? readFileSync(promptLog, "utf8").split("\n").filter(Boolean) : []);
const parts = [{ providerId: "scripted", model: "consensus/p1.json" }, { providerId: "scripted", model: "consensus/p2.json" }];
const start = (path: string) => call("council_start", { topic: "Что на изображении?", participants: parts, maxRounds: 3, attachments: [path] });

const out: Record<string, unknown> = {};
async function main() {
  let current: string | undefined;
  for (const c of cases) {
    if (c.helper !== current || !client) { await open(c.helper); current = c.helper; }
    const sBefore = sessions().length, pBefore = promptLines().length;
    const r = await start(c.path);
    if (c.kind === "refuse") {
      assert.ok(r.isError === true, `${c.id}: expected isError, got «${body(r)}»`);
      assert.equal(sessions().length, sBefore, `${c.id}: a session appeared`);
      assert.equal(promptLines().length, pBefore, `${c.id}: a participant was called`);
      out[c.id] = { error: body(r) };
      continue;
    }
    const s = json(r, `council_start ${c.id}`);
    await done(s.sessionId);
    const sd = join(dir, "sessions", s.sessionId);
    const mats = readFileSync(join(sd, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "session_created").session.materials as { id: string; name: string; chars: number; sha256: string }[];
    const m1 = readFileSync(join(sd, "materials", `${mats[0]!.id}.txt`), "utf8");
    const fresh = promptLines().slice(pBefore);
    assert.ok(fresh.length >= 2 && fresh.every((l) => (JSON.parse(l) as { prompt: string }).prompt.includes(m1)), `${c.id}: not every turn request carries the snapshot text`);
    const skipped = (s.materials.skipped as { name: string; reason: string }[]).map((x) => ({ name: basename(x.name), reason: x.reason })).sort((a, b) => a.name.localeCompare(b.name));
    out[c.id] = { items: mats.map((m) => ({ name: basename(m.name), sha: m.sha256, chars: m.chars })), m1, skipped };
  }
  await close();
  assert.deepEqual(errors, [], "client/transport errors");
  ok(`MCP: ${cases.filter((c) => c.kind !== "refuse").length} cases through council_start (text in every turn request), ${cases.filter((c) => c.kind === "refuse").length} refusals as isError without a session or a participant call`);
}

let failed = false;
const guard = setTimeout(() => { console.error("FAILURE: the MCP part did not finish within 600 seconds"); try { transport?.pid && process.kill(transport.pid, "SIGKILL"); } catch {} process.exit(1); }, 600000);
try {
  await main();
  console.log(`MCP part result: checks ${n}; real model calls 0`);
  console.log(`RESULT ${JSON.stringify({ checks: n, cases: out, dataDir: dir })}`);
} catch (e) {
  failed = true;
  console.error(`FAILURE: ${e instanceof Error ? e.message : String(e)}\nData folder left in place: ${dir}`);
} finally {
  clearTimeout(guard);
  await close();
}
process.exit(failed ? 1 : 0);
