// Contract check of the osen MCP server (change 179): SDK pin, protocol version, tool list and schemas, response shapes
// and how the host agents have the server registered. The server is a child process over stdio; participants are scripted only, 0 model calls.
//   COUNCIL_DEV=1 COUNCIL_HOME=.council-data/contract-<label> node packages/mcp/scenarios/contract/check.ts
// COUNCIL_HOME must not exist or must be empty. It is created and kept (evidence); the host checks are read-only.
// The output has no paths, times or ids, so two runs in different folders are byte-identical.
import "../../../core/scenarios/language-ru.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { configPath, initialRegistry, listSessions, readSession, requestStop } from "@model-council/core";
import { checkProtocol, checkSdkPin, collectResponses, compareWithGolden, shapeDiff, SNAPSHOTS } from "../../src/contract.ts";
import type { Finding } from "../../src/contract.ts";
import { hostsAfter } from "./hosts.ts";

const usage = "Run: COUNCIL_DEV=1 COUNCIL_HOME=.council-data/contract-<label> node packages/mcp/scenarios/contract/check.ts (COUNCIL_HOME must not exist or be empty)";
const raw = process.env.COUNCIL_HOME?.trim();
if (process.env.COUNCIL_DEV !== "1" || !raw || (existsSync(resolve(raw)) && readdirSync(resolve(raw)).length > 0)) {
  console.error(`COUNCIL_DEV=1 and a new or empty COUNCIL_HOME are required. ${usage}`);
  process.exit(2);
}
const home = resolve(raw);
mkdirSync(home, { recursive: true });
// no detected CLIs on this machine: the snapshots do not depend on it
writeFileSync(configPath(home), JSON.stringify(initialRegistry([])));

const root = join(import.meta.dirname, "../../../..");
const mcpSrc = join(root, "packages/mcp/src");
// ru: the goldens are Russian. Only these variables reach the server: no secrets.
const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_HOME: home, COUNCIL_DEV: "1" };

let ok = 0, failed = 0;
const line = (check: string, detail: string | null) => {
  if (detail === null) { ok++; console.log(`ok    ${check}`); } else { failed++; console.log(`FAIL  ${check}: ${detail}`); }
};
const findings = (fs: Finding[]) => fs.forEach((f) => line(f.check, f.ok ? null : f.detail));

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const client = new Client({ name: "contract-check", version: "0" });
const hosts = await hostsAfter(async () => {
  try {
    findings(checkSdkPin(root));
    findings(await checkProtocol(root, env));

    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(mcpSrc, "main.ts")], cwd: root, stderr: "ignore", env }));
    const golden = JSON.parse(readFileSync(join(mcpSrc, "__golden__/ru-server.json"), "utf8")) as { instructions: string; tools: unknown[] };
    const tools = JSON.parse(JSON.stringify((await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))));
    const diffs = shapeDiff("tools", golden.tools, tools);
    if (diffs.length === 0) line("tools and schemas", null);
    else diffs.forEach((d) => line("tools and schemas", d));
    const got = client.getInstructions() ?? "";
    const at = [...golden.instructions].findIndex((c, i) => c !== got[i]);
    line("instructions", got === golden.instructions ? null : `differs from the reference (lengths ${golden.instructions.length} / ${got.length}, first difference at offset ${at < 0 ? Math.min(golden.instructions.length, got.length) : at})`);

    const shapeDiffs = compareWithGolden(await collectResponses(client));
    for (const name of SNAPSHOTS) {
      const mine = shapeDiffs.filter((d) => d.startsWith(`${name}: `));
      if (mine.length === 0) line(`shape ${name}`, null);
      else mine.forEach((d) => line(`shape ${name}`, d.slice(name.length + 2)));
    }
  } finally {
    await client.close().catch(() => {});
    // sessions live in detached executors: stop them before exit
    try {
      for (const x of listSessions(home)) {
        const pid = readSession(home, x.id)?.state.pid ?? null;
        if (x.status !== "running" || pid === null) continue;
        requestStop(home, x.id);
        for (const t0 = Date.now(); alive(pid) && Date.now() - t0 < 5000; ) await sleep(50);
      }
    } catch { /* nothing to stop */ }
  }
}, (e) => line("stand", e instanceof Error ? e.message : String(e)), root);
// real environment: the hosts run read-only commands, after the cleanup above
for (const h of hosts) console.log(`${h.host}: ${h.state} - ${h.detail}`);
const st = (h: string) => hosts.find((x) => x.host === h)?.state ?? "not checked";
console.log(`contract: ${ok} ok, ${failed} failed; hosts: claude ${st("claude")}, codex ${st("codex")}`);
process.exit(failed > 0 || hosts.some((h) => h.state === "mismatch") ? 1 : 0);
