// Live check that council_status separates an unreadable journal from an unknown session: real MCP server over stdio
// (en and ru), sessions made by the real `council` process with scripted participants, 0 real model calls.
//   COUNCIL_DEV=1 node packages/mcp/scenarios/unreadable-sessions/check.ts
// Uses COUNCIL_HOME if given (kept), otherwise creates .council-data/unreadable-sessions-mcp-* and removes it on success.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("COUNCIL_DEV=1 is required. Run: COUNCIL_DEV=1 node packages/mcp/scenarios/unreadable-sessions/check.ts");
  process.exit(2);
}
const root = join(import.meta.dirname, "../../../..");
const given = process.env.COUNCIL_HOME?.trim();
let home: string;
if (given) { home = resolve(given); mkdirSync(home, { recursive: true }); }
else { mkdirSync(join(root, ".council-data"), { recursive: true }); home = mkdtempSync(join(root, ".council-data/unreadable-sessions-mcp-")); }
const scen = (f: string) => `scripted:${join(root, "packages/core/scenarios/consensus", f)}`;

let failed = 0;
const check = (ok: boolean, what: string, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}: ${what}${ok || !detail ? "" : ` -- ${detail.slice(0, 300)}`}`);
};

function makeSession(): string {
  const r = spawnSync(process.execPath, [join(root, "packages/core/src/council.ts"), "--topic", "Unreadable journal check", "--participant", scen("p1.json"), "--participant", scen("p2.json"), "--max-rounds", "3"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_HOME: home, COUNCIL_DEV: "1", COUNCIL_LANG: "en" } });
  const id = /^Session (\S+) ·/m.exec(r.stdout)?.[1];
  if (!id) throw new Error(`no session id: ${r.stdout}\n${r.stderr}`);
  return id;
}

type Res = { isError?: boolean; content: { type: string; text: string }[] };
const logPath = join(home, "logs/app.log");
const logText = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");

async function probe(lang: "en" | "ru", a: string, b: string, c: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "packages/mcp/src/main.ts")], cwd: root, stderr: "ignore",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_HOME: home, COUNCIL_DEV: "1", COUNCIL_LANG: lang } });
  const client = new Client({ name: "unreadable-sessions-check", version: "0" });
  await client.connect(transport);
  const status = async (sessionId: string) => {
    const before = logText().length;
    const r = (await client.callTool({ name: "council_status", arguments: { sessionId } })) as Res;
    return { r, text: r.content[0]?.text ?? "", log: logText().slice(before) };
  };
  try {
    const notFound = lang === "en" ? /was not found/ : /не найдена/;
    const unreadable = lang === "en" ? /could not be read/ : /не удалось прочитать/;
    const rc = await status(c);
    check(rc.r.isError === true && rc.text.includes(c) && rc.text.includes("EACCES") && unreadable.test(rc.text), `${lang}: council_status on C is a tool error with id and EACCES`, rc.text);
    check(/Tool error council_status/.test(rc.log) && rc.log.includes("EACCES"), `${lang}: app.log has "Tool error council_status" with EACCES`, rc.log);
    const ra = await status(a);
    check(ra.r.isError !== true && JSON.parse(ra.text).sessionId === a, `${lang}: the next call with healthy A succeeds`, ra.text);
    for (const [label, id] of [["B (garbage journal)", b], ["a nonexistent id", "no-such-session"]] as const) {
      const r = await status(id);
      check(r.r.isError === true && notFound.test(r.text) && !r.text.includes("EACCES"), `${lang}: ${label} is "not found"`, r.text);
      check(!r.log.includes("EACCES"), `${lang}: log lines for ${label} have no EACCES`, r.log);
    }
  } finally {
    await client.close();
  }
}

let cFile = "";
try {
  const a = makeSession(), b = makeSession(), c = makeSession();
  writeFileSync(join(home, "sessions", b, "events.jsonl"), "garbage\n");
  cFile = join(home, "sessions", c, "events.jsonl");
  chmodSync(cFile, 0o000);
  if (process.getuid?.() === 0) console.log("NOT VERIFIED: running as root, chmod 000 does not block reads");
  for (const lang of ["en", "ru"] as const) await probe(lang, a, b, c);
} catch (e) {
  check(false, "stand ran to the end", e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  if (cFile && existsSync(cFile)) chmodSync(cFile, 0o644);
}
if (failed === 0 && !given) rmSync(home, { recursive: true, force: true });
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED (data kept in ${home})`);
process.exit(failed === 0 ? 0 : 1);
