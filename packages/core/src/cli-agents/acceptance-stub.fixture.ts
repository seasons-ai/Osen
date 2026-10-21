import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Node stub of a CLI for the acceptance probes: codex-style JSONL output, or claude-style JSON when argv has --print.
// The mode comes from STUB_MODE in the environment:
//   good (default): refuses files, tools and servers, answers "ok"; a long prompt streams slowly until stopped
//   read: prints the file named in the prompt (outside-file leak)
//   leak: prints AGENTS.md or CLAUDE.md of its folder (instruction leak)
//   tool: emits a command_execution item (tool call despite isolation)
//   mcp: runs the commands of the servers in .mcp.json
//   survive: starts a detached child before its first output and writes its pid to STUB_PIDFILE
//   history: writes a session file under CODEX_HOME or CLAUDE_CONFIG_DIR before the first output
//   quick: exits silently on a long prompt (turn finished before the stop)
//   err: exits with code 1 and a message on stderr
//   resume_fail: the stop turn writes a flag to STUB_STATE; the next turn after it exits with code 1
//   slow: every turn hangs without output (the first probe stays running until it is stopped)
// STUB_LOG (optional): every turn launch appends its pid, one line per launch.
// Options (writeAcceptanceStub): version line for --version, help text for --help, features text for `features list`; each answers only when given.
const SCRIPT = `const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const prompt = fs.readFileSync(0, "utf8");
const mode = process.env.STUB_MODE || "good";
const isClaude = process.argv.includes("--print");
if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, process.pid + "\\n");
const afterStop = process.env.STUB_STATE ? path.join(process.env.STUB_STATE, "after-stop") : "";
if (mode === "resume_fail" && afterStop && fs.existsSync(afterStop) && !prompt.includes("very long essay")) { process.stderr.write("resumed turn failed"); process.exit(1); }
const emit = (text) => {
  if (isClaude) process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, usage: { input_tokens: 3, output_tokens: 2 } }) + "\\n");
  else {
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } }) + "\\n");
  }
};
const streamForever = () => setInterval(() => process.stdout.write("chunk\\n"), 300);
const sleepForever = () => setTimeout(() => emit("late"), 60000);
if (mode === "err") { process.stderr.write("boom"); process.exit(1); }
if (mode === "slow") setTimeout(() => emit("late"), 600000);
else if (prompt.includes("very long essay")) {
  if (mode === "quick") process.exit(0);
  if (mode === "resume_fail" && afterStop) fs.writeFileSync(afterStop, "");
  if (mode === "history") {
    const dir = process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR;
    fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sessions", "x.jsonl"), "{}\\n");
  }
  if (mode === "survive") {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    fs.writeFileSync(process.env.STUB_PIDFILE, String(child.pid));
  }
  if (isClaude) sleepForever(); else streamForever();
} else if (prompt.includes("Read the file")) {
  const file = /Read the file (\\S+) and/.exec(prompt)[1];
  emit(mode === "read" ? fs.readFileSync(file, "utf8") : "no");
} else if (prompt.includes("touch ")) {
  if (mode === "tool" && !isClaude) process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "touch x" } }) + "\\n");
  if (mode === "touch") fs.writeFileSync(/touch (\\S+)\\. Then/.exec(prompt)[1], "");
  emit(mode === "tool" || mode === "touch" ? "done" : "no");
} else if (prompt.includes("capital of France")) {
  const files = ["AGENTS.md", "CLAUDE.md"].filter((f) => fs.existsSync(f));
  emit(mode === "leak" && files.length ? fs.readFileSync(files[0], "utf8") : "Paris");
} else if (mode === "mcp") {
  if (fs.existsSync(".mcp.json")) {
    const servers = JSON.parse(fs.readFileSync(".mcp.json", "utf8")).mcpServers;
    for (const s of Object.values(servers)) spawnSync(s.command, s.args);
  }
  emit("ok");
} else {
  emit("ok");
}
`;

export interface StubInspection { version?: string; help?: string; features?: string }

/** Writes the stub into dir and returns its path; the shebang is the running node, so PATH is not needed. */
export function writeAcceptanceStub(dir: string, inspection: StubInspection = {}): string {
  const file = join(dir, "cli-stub.js");
  const head = `const INSPECTION = ${JSON.stringify(inspection)};\nconst argv = process.argv.slice(2);\nif (argv.includes("--version") && INSPECTION.version !== undefined) { process.stdout.write(INSPECTION.version + "\\n"); process.exit(0); }\nif (argv.includes("--help") && INSPECTION.help !== undefined) { process.stdout.write(INSPECTION.help); process.exit(0); }\nif (argv[0] === "features" && INSPECTION.features !== undefined) { process.stdout.write(INSPECTION.features); process.exit(0); }\n`;
  writeFileSync(file, `#!${process.execPath}\n${head}${SCRIPT}`);
  chmodSync(file, 0o755);
  return file;
}
