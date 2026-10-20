// Check of the verified CLI versions record (change 175) by real council and MCP processes (claude/codex stubs on node, 0 model calls):
//   COUNCIL_DEV=1 node packages/core/scenarios/verified-record/check.ts
// The processes' PATH is only the stub folder, SHELL is an empty script: the real claude and codex are not launched.
// The stand creates the .council-data/verified-record-* folder itself and deletes it on success.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setProcessLanguage } from "../../src/i18n/index.ts";
import { providerMessages } from "../../src/messages/providers.ts";
import { VERIFIED_FILE } from "../../src/cli-agents/verified-record.ts";
import { inspectProviders } from "../../src/registry/providers.ts";
import { readRegistry } from "../../src/registry/config.ts";

if (process.env.COUNCIL_DEV !== "1") { console.error("COUNCIL_DEV=1 is required. Usage: COUNCIL_DEV=1 node packages/core/scenarios/verified-record/check.ts"); process.exit(2); }
const repo = resolve(import.meta.dirname, "../../../..");
const fixtures = join(repo, "packages/core/src/cli-agents/fixtures");
const work = join(repo, ".council-data", `verified-record-${Date.now()}`);
mkdirSync(work, { recursive: true });

let total = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n       ${detail.slice(0, 600).replace(/\n/g, "\n       ")}`}`);
}

// Expected catalog texts in a language (the process language is switched only around the call).
type Lang = "en" | "ru";
function msg<T>(lang: Lang, f: (m: ReturnType<typeof providerMessages>) => T): T {
  setProcessLanguage(lang);
  try { return f(providerMessages()); } finally { setProcessLanguage("en"); }
}

// ---------- stubs ----------
const turn = JSON.stringify({ stance: "agree", reasoning: "r", solution: null, answers: [], questions: [] });
const stub = (agent: "claude" | "codex", version: string, dir: string) => `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
const a = process.argv.slice(2);
const out = (f) => process.stdout.write(fs.readFileSync(f));
if (a[0] === "--version") { console.log(${JSON.stringify(agent === "claude" ? `${version} (Claude Code)` : `codex-cli ${version}`)}); process.exit(0); }
${agent === "claude"
    ? `if (a[0] === "--help") { out(${JSON.stringify(join(fixtures, "claude-2.1.288-help.txt"))}); process.exit(0); }`
    : `if (a[0] === "exec" && a[1] === "--help") { out(${JSON.stringify(join(fixtures, "codex-0.159.2-exec-help.txt"))}); process.exit(0); }
if (a[0] === "features" && a[1] === "list") { out(${JSON.stringify(join(fixtures, "codex-0.159.2-features.txt"))}); process.exit(0); }
if (a[0] === "exec") {
  fs.writeFileSync(path.join(${JSON.stringify(dir)}, "argv.json"), JSON.stringify(a));
  process.stdin.resume(); process.stdin.on("data", () => {});
  process.stdin.on("end", () => {
    console.log(JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text: ${JSON.stringify(turn)} } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
  });
} else process.exit(2);`}
${agent === "claude" ? "process.exit(2);" : ""}
`;

interface Setup { dir: string; home: string; env: Record<string, string> }
let seq = 0;
function setup(claude: string, codex: string, http = false): Setup {
  const dir = join(work, `c${++seq}`);
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(bin, "claude"), stub("claude", claude, dir));
  writeFileSync(join(bin, "codex"), stub("codex", codex, dir));
  writeFileSync(join(bin, "empty-shell"), "#!/bin/sh\nexit 0\n");
  for (const f of ["claude", "codex", "empty-shell"]) chmodSync(join(bin, f), 0o755);
  const providers: unknown[] = [
    { id: "claude", kind: "cli", agent: "claude", label: "Claude stub", models: ["m"], path: join(bin, "claude") },
    { id: "codex", kind: "cli", agent: "codex", label: "Codex stub", models: ["m"], path: join(bin, "codex") },
  ];
  if (http) providers.push({ id: "local", kind: "openai-http", label: "Local", baseUrl: "http://127.0.0.1:9/v1", models: ["m"] });
  writeFileSync(join(home, "config.json"), JSON.stringify({ providers, defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, participants: [] } }, null, 2));
  return { dir, home, env: { PATH: bin, SHELL: join(bin, "empty-shell"), HOME: dir, COUNCIL_DEV: "1", COUNCIL_HOME: home } };
}

// ---------- processes ----------
interface R { code: number | null; all: string; out: string }
function council(env: Record<string, string>, lang: Lang, args: string[]): Promise<R> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(repo, "packages/core/src/council.ts"), ...args], { env: { ...env, COUNCIL_LANG: lang }, cwd: repo, stdio: ["ignore", "pipe", "pipe"], timeout: 90000 });
    let all = "", out = "";
    child.stdout.on("data", (d) => { all += d; out += d; });
    child.stderr.on("data", (d) => { all += d; });
    child.on("close", (code) => done({ code, all, out }));
  });
}
const providers = (s: Setup, lang: Lang) => council(s.env, lang, ["providers"]);
// The provider block: its first line and the indented lines after it.
function block(all: string, id: string): string[] {
  const ls = all.split("\n");
  const i = ls.findIndex((l) => l.startsWith(`${id}  `));
  if (i < 0) return [];
  const res = [ls[i]!];
  for (let k = i + 1; k < ls.length && ls[k]!.startsWith("  "); k++) res.push(ls[k]!);
  return res;
}
const verifiedLine = (all: string, id: string) => block(all, id).find((l) => l.startsWith("  verified:"));
const warningLine = (all: string, id: string) => block(all, id).find((l) => /^  (warning|предупреждение):/.test(l));
const versionOf = (all: string, id: string) => block(all, id)[0]?.match(/\d+\.\d+\.\d+/)?.[0];
const WARN: Record<Lang, string> = { en: "  warning: ", ru: "  предупреждение: " };
const localPath = (s: Setup) => join(s.home, VERIFIED_FILE);
const today = new Date().toISOString().slice(0, 10);
const entry = (extra: Record<string, unknown> = {}) => ({ agent: "codex", version: "0.159.2", level: "real", checkedAt: today, os: "darwin-arm64", osenVersion: "0.0.0-check", modelCalls: 1, ...extra });
const record = (e: unknown) => JSON.stringify({ schemaVersion: 1, entries: [e] }, null, 2);

async function main() {
  // 1. Built-in record, real level.
  const s1 = setup("2.1.288", "0.159.2");
  const r1 = await providers(s1, "en");
  check("built-in record, claude 2.1.288: `verified: real, 2026-10-07`, no claude warning, exit 0", r1.code === 0 && verifiedLine(r1.all, "claude") === "  verified: real, 2026-10-07" && warningLine(r1.all, "claude") === undefined, r1.all);

  // 2. Interface level, per language; the start is not refused.
  const ifaceWarn: Record<Lang, string> = { en: msg("en", (m) => m.versionInterfaceOnly("codex", "0.159.2")), ru: msg("ru", (m) => m.versionInterfaceOnly("codex", "0.159.2")) };
  const levels: Record<string, string[]> = {};
  const note = (key: string, ...v: (string | undefined)[]) => { (levels[key] ??= []).push(v.join("|")); };
  for (const lang of ["en", "ru"] as const) {
    const r = await providers(s1, lang);
    check(`codex 0.159.2 (${lang}): \`verified: interface, 2026-10-16\` and the interface-only warning, exit 0`, r.code === 0 && verifiedLine(r.all, "codex") === "  verified: interface, 2026-10-16" && warningLine(r.all, "codex") === `${WARN[lang]}${ifaceWarn[lang]}`, r.all);
    note("iface", verifiedLine(r.all, "codex"), versionOf(r.all, "codex"));
  }
  const scripted = join(repo, "packages/core/scenarios/consensus/p1.json");
  const run = await council(s1.env, "en", ["--topic", "test", "--participant", `scripted:${scripted}`, "--participant", "codex:default", "--max-rounds", "1"]);
  check("codex at the interface level: a discussion with codex is not refused by the record (exit 0, codex was called)", run.code === 0 && existsSync(join(s1.dir, "argv.json")) && !/rejected|отклонён/i.test(run.all), `code ${run.code}\n${run.all}`);

  // 3. Version outside the record, per language.
  for (const lang of ["en", "ru"] as const) {
    const n = await providers(setup("2.1.289", "0.159.2"), lang);
    const nm = msg(lang, (m) => m.versionNewer("claude", "2.1.289", "2.1.288", "2.1.288"));
    check(`claude 2.1.289 (${lang}): \`verified: none\` and the newer warning with range 2.1.288–2.1.288`, verifiedLine(n.all, "claude") === "  verified: none" && warningLine(n.all, "claude") === `${WARN[lang]}${nm}` && nm.includes("2.1.288–2.1.288"), n.all);
    note("newer", verifiedLine(n.all, "claude"), versionOf(n.all, "claude"));
    const o = await providers(setup("2.1.287", "0.159.2"), lang);
    const om = msg(lang, (m) => m.versionOlder("claude", "2.1.287", "2.1.288", "2.1.288"));
    check(`claude 2.1.287 (${lang}): \`verified: none\` and the older warning`, verifiedLine(o.all, "claude") === "  verified: none" && warningLine(o.all, "claude") === `${WARN[lang]}${om}`, o.all);
    note("older", verifiedLine(o.all, "claude"), versionOf(o.all, "claude"));
  }
  check("no cli-verified.json was created by reading (steps 1-3)", !existsSync(localPath(s1)) && !existsSync(join(s1.dir, "home", "cli-verified.json")));

  // 4. Local record: a new process.
  const s4 = setup("2.1.288", "0.159.2");
  writeFileSync(localPath(s4), record(entry()));
  const r4 = await providers(s4, "en");
  check("local real entry for codex 0.159.2: `verified: real, <date>`, no interface warning", verifiedLine(r4.all, "codex") === `  verified: real, ${today}` && warningLine(r4.all, "codex") === undefined, r4.all);

  // 4b. Cache in a long-running process: the same process, the file appears between two calls.
  const s4b = setup("2.1.288", "0.159.2");
  const codexIn = async () => {
    const found = await inspectProviders(readRegistry(s4b.home), { env: s4b.env, dataDir: s4b.home });
    return found.find((f) => f.status.id === "codex")!.status;
  };
  const before = await codexIn();
  writeFileSync(localPath(s4b), record(entry()));
  const after = await codexIn();
  check("one long-running process: before the file the codex warning is interface-only, after it — real without a warning (the file state is re-read)",
    before.verified?.level === "interface" && before.warning === ifaceWarn.en && after.verified?.level === "real" && after.warning === undefined, JSON.stringify({ before: before.verified, bw: before.warning, after: after.verified, aw: after.warning }));
  // The MCP server (council_options does not expose warnings, so only availability is visible): same process before and after the file.
  const s4c = setup("2.1.288", "0.159.2");
  const client = new Client({ name: "verified-record-check", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, "packages/mcp/src/main.ts")], cwd: repo, stderr: "ignore", env: { ...s4c.env, COUNCIL_LANG: "en" } }));
  try {
    const codexAvail = async () => {
      const res = (await client.callTool({ name: "council_options", arguments: {} })) as { content: { text: string }[] };
      return (JSON.parse(res.content[0]?.text ?? "{}").providers as { id: string; available: boolean }[]).find((p) => p.id === "codex")?.available;
    };
    const a = await codexAvail();
    writeFileSync(localPath(s4c), record(entry()));
    const b = await codexAvail();
    check("MCP server: council_options in one process answers with codex available before and after the local file appears", a === true && b === true, `${a} ${b}`);
    // The live process re-reads the file: a rejected state is logged once per file state ([discovery] line in logs/app.log).
    const logLines = () => { try { return readFileSync(join(s4c.home, "logs", "app.log"), "utf8").split("\n").filter((l) => l.includes("[discovery]") && l.includes(VERIFIED_FILE)); } catch { return []; } };
    const n0 = logLines().length;
    writeFileSync(localPath(s4c), record(entry({ modelCalls: undefined })));
    const c1 = await codexAvail();
    const l1 = logLines();
    const c2 = await codexAvail();
    const l2 = logLines();
    check("MCP server: an invalid local file written under the running process is logged once in logs/app.log ([discovery], cli-verified.json, modelCalls), none before; codex stays available",
      n0 === 0 && l1.length === 1 && l1[0]!.includes("modelCalls") && c1 === true, `before ${n0}, after ${l1.length}\n${l1.join("\n")}`);
    check("MCP server: a repeated council_options without changing the file adds no log line (once per file state)", l2.length === 1 && c2 === true, `${l2.length} lines`);
  } finally { await client.close(); }

  // 5. Invalid local record, a fresh copy for each case.
  const cases: { name: string; write: (s: Setup) => void; field?: string; code?: string }[] = [
    { name: "real without modelCalls", write: (s) => writeFileSync(localPath(s), record(entry({ modelCalls: undefined }))), field: "modelCalls" },
    { name: "an unknown field", write: (s) => writeFileSync(localPath(s), record(entry({ bogusField: 1 }))), field: "bogusField" },
    { name: "not JSON", write: (s) => writeFileSync(localPath(s), "{ not json") },
    { name: "chmod 000", write: (s) => { writeFileSync(localPath(s), record(entry())); chmodSync(localPath(s), 0o000); }, code: "EACCES" },
  ];
  for (const c of cases) {
    if (c.code && process.getuid?.() === 0) { console.log(`note: "${c.name}" skipped: running as root, chmod 000 does not deny reading`); continue; }
    for (const lang of c.field === "modelCalls" ? (["en", "ru"] as const) : (["en"] as const)) {
      const s = setup("2.1.288", "0.159.2");
      c.write(s);
      let before: Buffer | undefined;
      try {
        if (!c.code) before = readFileSync(localPath(s));
        const r = await providers(s, lang);
        if (c.code) chmodSync(localPath(s), 0o644);
        const after = readFileSync(localPath(s));
        if (c.code) before = after;
        const w = warningLine(r.all, "codex") ?? "";
        const one = msg(lang, (m) => m.recordRejected(VERIFIED_FILE, "", ""));
        const head = one.slice(0, one.indexOf("("));
        check(`invalid local record (${c.name}, ${lang}): exit 0, built-in applies, the warning names ${VERIFIED_FILE}${c.field ? ` and ${c.field}` : ""}${c.code ? ` and ${c.code}` : ""}, no data-folder path, the file is unchanged`,
          r.code === 0 && verifiedLine(r.all, "codex") === "  verified: interface, 2026-10-16" && w.includes(ifaceWarn[lang]) && w.includes(head) && w.includes(VERIFIED_FILE)
          && (!c.field || w.includes(c.field)) && (!c.code || w.includes(c.code)) && !r.all.includes(s.home) && before!.equals(after), r.all);
        if (c.field === "modelCalls") note("5a", verifiedLine(r.all, "codex"), w.includes(VERIFIED_FILE) ? VERIFIED_FILE : "");
      } finally { try { chmodSync(localPath(s), 0o644); } catch { /* absent */ } }
    }
  }
  check("language: the verified lines, versions and the file name are identical in en and ru (steps 2, 3, 5)",
    Object.values(levels).every((v) => v.length >= 2 && v.every((x) => x === v[0])), JSON.stringify(levels));

  // 7. Machine output.
  const s7 = setup("2.1.288", "0.159.2", true);
  const j = await council(s7.env, "en", ["providers", "--json"]);
  let items: { id: string; verified: unknown }[] = [];
  try { items = JSON.parse(j.out).providers; } catch { /* reported below */ }
  check("providers --json: codex verified = {level: interface, checkedAt: 2026-10-16}, claude real, an HTTP provider has verified null",
    JSON.stringify(items.find((p) => p.id === "codex")?.verified) === JSON.stringify({ level: "interface", checkedAt: "2026-10-16" })
    && JSON.stringify(items.find((p) => p.id === "claude")?.verified) === JSON.stringify({ level: "real", checkedAt: "2026-10-07" })
    && items.find((p) => p.id === "local")?.verified === null, j.out);
}

try { await main(); } catch (e) { check("the stand ran without an exception", false, String(e)); }
console.log(`\n${total - failed}/${total} checks passed`);
if (!failed) rmSync(work, { recursive: true, force: true }); else console.log(`Folder left in place: ${work}`);
process.exit(failed ? 1 : 0);
