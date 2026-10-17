// Check of the mandatory codex isolation by real council and MCP server processes (a codex stub on node, 0 model calls):
//   COUNCIL_DEV=1 node packages/core/scenarios/codex-isolation/check.ts
// Stub modes: A — `codex features list` fails; B — the list has no shell_tool; NODISABLE — the help does not declare --disable; C — everything is present.
// The processes' PATH is only the stub folder, SHELL is an empty script: the real codex and claude are not launched.
// The stand creates the .council-data/codex-isolation-check-* folder itself and deletes it on success.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { declaredFlags } from "../../src/cli-agents/flags.ts";
import { CODEX_ISOLATION_FEATURES } from "../../src/cli-agents/args.ts";

if (process.env.COUNCIL_DEV !== "1") { console.error("COUNCIL_DEV=1 is required. Usage: COUNCIL_DEV=1 node packages/core/scenarios/codex-isolation/check.ts"); process.exit(2); }
const repo = resolve(import.meta.dirname, "../../../..");
const fixtures = join(repo, "packages/core/src/cli-agents/fixtures");
const work = join(repo, ".council-data", `codex-isolation-check-${Date.now()}`);
mkdirSync(work, { recursive: true });

let total = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n       ${detail.slice(0, 500).replace(/\n/g, "\n       ")}`}`);
}

// ---------- stub ----------
const fullHelp = readFileSync(join(fixtures, "codex-0.159.2-exec-help.txt"), "utf8");
const lines = fullHelp.split("\n");
const at = lines.findIndex((l) => l.includes("--disable <FEATURE>"));
const noDisableHelp = lines.filter((_, i) => i !== at && i !== at + 1).join("\n");
check("the help with --disable declares the flag", declaredFlags(fullHelp).has("--disable"));
check("the NODISABLE help does not declare --disable", !declaredFlags(noDisableHelp).has("--disable"));

const features = readFileSync(join(fixtures, "codex-0.159.2-features.txt"), "utf8");
const featuresB = features.split("\n").filter((l) => !/^shell_tool\s/.test(l)).join("\n");
check("list B without shell_tool, the full one with it", features !== featuresB && /^shell_tool\s/m.test(features) && !/^shell_tool\s/m.test(featuresB));

const turn = JSON.stringify({ stance: "agree", reasoning: "r", solution: null, answers: [], questions: [] });
const stubSource = (dir: string) => `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
const d = ${JSON.stringify(dir)}, a = process.argv.slice(2);
const mode = fs.readFileSync(path.join(d, "mode"), "utf8").trim();
const out = (f) => process.stdout.write(fs.readFileSync(path.join(d, f)));
if (a[0] === "--version") { console.log("codex-cli 0.159.2"); process.exit(0); }
if (a[0] === "exec" && a[1] === "--help") { out(mode === "NODISABLE" ? "help-nodisable.txt" : "help.txt"); process.exit(0); }
if (a[0] === "features" && a[1] === "list") {
  if (mode === "A") { console.error("features list failed"); process.exit(1); }
  out(mode === "B" ? "features-b.txt" : "features.txt"); process.exit(0);
}
if (a[0] === "exec") {
  fs.writeFileSync(path.join(d, "argv.json"), JSON.stringify(a));
  process.stdin.resume(); process.stdin.on("data", () => {});
  process.stdin.on("end", () => {
    console.log(JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text: ${JSON.stringify(turn)} } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
  });
} else process.exit(2);
`;
function setup(mode: string): { dir: string; home: string; env: Record<string, string> } {
  const dir = join(work, mode);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, "mode"), mode);
  writeFileSync(join(dir, "help.txt"), fullHelp);
  writeFileSync(join(dir, "help-nodisable.txt"), noDisableHelp);
  writeFileSync(join(dir, "features.txt"), features);
  writeFileSync(join(dir, "features-b.txt"), featuresB);
  writeFileSync(join(bin, "codex"), stubSource(dir));
  writeFileSync(join(bin, "empty-shell"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "codex"), 0o755);
  chmodSync(join(bin, "empty-shell"), 0o755);
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  return { dir, home, env: { PATH: bin, SHELL: join(bin, "empty-shell"), HOME: dir, COUNCIL_DEV: "1", COUNCIL_HOME: home } };
}

// ---------- processes ----------
interface R { code: number | null; all: string }
function council(env: Record<string, string>, lang: "en" | "ru" | undefined, args: string[]): Promise<R> {
  const e = { ...env, ...(lang ? { COUNCIL_LANG: lang } : {}) };
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(repo, "packages/core/src/council.ts"), ...args], { env: e, cwd: repo, stdio: ["ignore", "pipe", "pipe"], timeout: 90000 });
    let all = "";
    child.stdout.on("data", (d) => { all += d; });
    child.stderr.on("data", (d) => { all += d; });
    child.on("close", (code) => done({ code, all }));
  });
}
const scripted = join(repo, "packages/core/scenarios/consensus/p1.json");
const run = (env: Record<string, string>) => council(env, undefined, ["--topic", "тест", "--participant", `scripted:${scripted}`, "--participant", "codex:default", "--max-rounds", "1"]);
const CYR = /[А-Яа-яЁё]/;
const codexLine = (all: string) => all.split("\n").find((l) => l.startsWith("codex")) ?? "";
const reasonOf = (all: string) => codexLine(all).split("  version ")[0]!; // without the path: it contains Cyrillic

const MARK: Record<string, string> = { A: "codex features list", B: "shell_tool", NODISABLE: "--disable" };

async function main() {
  for (const mode of ["A", "B", "NODISABLE"]) {
    const s = setup(mode);
    const en = await council(s.env, undefined, ["providers"]);
    const l = codexLine(en.all);
    check(`${mode}: providers (en) — codex unavailable, the reason has the version and "${MARK[mode]}"`, /unavailable/i.test(l) && l.includes("0.159.2") && l.includes(MARK[mode]!) && !CYR.test(reasonOf(en.all)), en.all);
    const ru = await council(s.env, "ru", ["providers"]);
    const lr = codexLine(ru.all);
    check(`${mode}: providers (ru) — the reason is in Russian with the version and "${MARK[mode]}"`, CYR.test(reasonOf(ru.all)) && lr.includes("0.159.2") && lr.includes(MARK[mode]!), ru.all);
    const r = await run(s.env);
    check(`${mode}: start rejected (non-zero code, the reason is in the output), codex not called`, r.code !== 0 && r.all.includes("0.159.2") && r.all.includes(MARK[mode]!) && !existsSync(join(s.dir, "argv.json")), `code ${r.code}\n${r.all}`);
  }

  const c = setup("C");
  const pc = await council(c.env, undefined, ["providers"]);
  check("C: providers — codex available", /codex\s+cli\s+available/i.test(codexLine(pc.all)), pc.all);
  const rc = await run(c.env);
  check("C: start completed (code 0)", rc.code === 0, `code ${rc.code}\n${rc.all}`);
  const argv: string[] = existsSync(join(c.dir, "argv.json")) ? JSON.parse(readFileSync(join(c.dir, "argv.json"), "utf8")) : [];
  const i = argv.indexOf("--sandbox");
  check("C: argv contains --sandbox read-only", i >= 0 && argv[i + 1] === "read-only", argv.join(" "));
  const dis = argv.flatMap((a, k) => (a === "--disable" ? [argv[k + 1]] : []));
  check(`C: argv contains --disable for each of the ${CODEX_ISOLATION_FEATURES.length} features`, JSON.stringify([...dis].sort()) === JSON.stringify([...CODEX_ISOLATION_FEATURES].sort()), dis.join(","));

  const a = setup("A");
  const client = new Client({ name: "codex-isolation-check", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, "packages/mcp/src/main.ts")], cwd: repo, stderr: "ignore", env: a.env }));
  try {
    const res = (await client.callTool({ name: "council_options", arguments: {} })) as { content: { text: string }[] };
    const text = res.content[0]?.text ?? "";
    const codex = (JSON.parse(text).providers as { id: string; available: boolean; reason?: string }[]).find((p) => p.id === "codex");
    check("MCP A: council_options — codex unavailable, the reason has the version and \"codex features list\"", !!codex && codex.available === false && !!codex.reason?.includes("0.159.2") && !!codex.reason?.includes("codex features list"), text);
  } finally { await client.close(); }
}

try { await main(); } catch (e) { check("the stand ran without an exception", false, String(e)); }
console.log(`\n${total - failed} of ${total}`);
if (!failed) rmSync(work, { recursive: true, force: true }); else console.log(`Folder left in place: ${work}`);
process.exit(failed ? 1 : 0);
