// Stub MCP stdio server; behaviour from STUB_MODE: ok | stray | silent | six | tail
import { createInterface } from "node:readline";
const mode = process.env.STUB_MODE;
const ALL = ["council_continue", "council_options", "council_resume", "council_say", "council_start", "council_status", "council_stop"];
if (mode === "stray") process.stdout.write("hello\n");
const out = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
createInterface({ input: process.stdin }).on("line", (l) => {
  if (mode === "silent") return;
  const m = JSON.parse(l);
  if (m.method === "initialize") out({ id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "stub", version: "1" } } });
  if (m.method === "tools/list") out({ id: m.id, result: { tools: (mode === "six" ? ALL.slice(1) : ALL).map((name) => ({ name })) } });
  if (m.method === "tools/list" && mode === "tail") process.stdout.write("garbage", () => process.exit(0));
});
