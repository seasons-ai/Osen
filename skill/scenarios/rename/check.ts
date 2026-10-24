// Live check of the MCP server and skill rename to osen (change 81, steps 1–3 of the Live Scenario); step 4 — the installer does not
// migrate the legacy model-council data folder, council does (change 98); step 5 — an osen folder with another repository copy's
// marker is foreign: install, uninstall and preview do not change it (change 112); with no osen server entry the server is not added
// next to a foreign skill folder, with another copy's marker or without a marker (change 257).
// The server is a child process over stdio; the installer is the real `node skill/install.ts` with a fake HOME and fake
// `claude` and `codex` first in PATH: they edit $HOME/.claude.json and the stand's entries file and write calls to a log.
// The owner's global agent settings are not changed. Participants are scripted, model calls 0.
//   COUNCIL_DEV=1 node skill/scenarios/rename/check.ts
// The stand creates the .council-data/rename-check-<label> folder itself; removes it on success, keeps it as evidence on failure.
import "../../../packages/core/scenarios/language-ru.ts";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("COUNCIL_DEV=1 is required. Run: COUNCIL_DEV=1 node skill/scenarios/rename/check.ts");
  process.exit(2);
}
const root = resolve(import.meta.dirname, "../../..");
const mainTs = join(root, "packages/mcp/src/main.ts");
const installTs = join(root, "skill/install.ts");
const work = join(root, ".council-data", `rename-check-${Date.now()}`);
const bin = join(work, "bin"), log = join(work, "calls.log"), data = join(work, "data");
mkdirSync(bin, { recursive: true });

let failed = 0;
const check = (step: number, what: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} step ${step}: ${what}${ok || !detail ? "" : `\n    ${detail.slice(0, 600)}`}`);
};
const put = (f: string, t: string) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, t); };
const readJson = (f: string) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {});

// ---- fake claude and codex ----
const fake = join(bin, "fake.cjs");
writeFileSync(fake, `const fs = require("node:fs"), path = require("node:path");
const [agent, ...args] = process.argv.slice(2);
if (args[0] === "--version") { console.log(agent + " 0.0.0-stand"); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log)}, agent + " " + args.join(" ") + "\\n");
const home = process.env.HOME;
const file = agent === "claude" ? path.join(home, ".claude.json") : path.join(home, ".codex", "fake-state.json");
const d = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const key = agent === "claude" ? "mcpServers" : "servers";
d[key] = d[key] || {};
const verb = args[1], name = agent === "claude" && verb !== "get" ? args[4] : args[2];
const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(d)); };
const sep = args.indexOf("--");
if (verb === "get") {
  const e = d[key][name];
  if (!e) { console.error("Error: No MCP server named '" + name + "' found."); process.exit(1); }
  console.log(JSON.stringify({ name, transport: { type: "stdio", command: e.command, args: e.args } }));
} else if (verb === "add") {
  if (agent === "claude" && d[key][name]) { console.error("MCP server " + name + " already exists"); process.exit(1); }
  d[key][name] = { ...(agent === "claude" ? { type: "stdio" } : {}), command: args[sep + 1], args: args.slice(sep + 2), ...(agent === "claude" ? { env: {} } : {}) };
  save();
} else if (verb === "remove") {
  if (!d[key][name]) { console.error("No MCP server named " + name); process.exit(1); }
  delete d[key][name]; save();
} else { console.error("unknown"); process.exit(2); }
`);
for (const agent of ["claude", "codex"]) {
  put(join(bin, agent), `#!/bin/sh\nexec "${process.execPath}" "${fake}" ${agent} "$@"\n`);
  chmodSync(join(bin, agent), 0o755);
}

const env = (home: string) => ({ PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, COUNCIL_HOME: data, COUNCIL_LANG: "ru", COUNCIL_DEV: "1" });
function install(home: string, ...args: string[]) {
  try { return { code: 0, out: execFileSync(process.execPath, [installTs, ...args], { env: env(home), cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { const x = e as { status: number; stdout: string; stderr: string }; return { code: x.status, out: `${x.stdout}${x.stderr}` }; }
}
function tree(dir: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (statSync(join(dir, rel)).isFile()) r[rel] = createHash("sha256").update(readFileSync(join(dir, rel))).digest("hex");
  }
  return r;
}
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
const mutating = () => calls().filter((c) => / mcp (add|remove) /.test(c));
const resetLog = () => rmSync(log, { force: true });

// ---- step 1: the osen MCP server ----
{
  const transport = new StdioClientTransport({ command: process.execPath, args: [mainTs], cwd: root, stderr: "ignore", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_HOME: data, COUNCIL_LANG: "ru", COUNCIL_DEV: "1" } });
  const client = new Client({ name: "rename-check", version: "0" });
  await client.connect(transport);
  check(1, "serverInfo.name in the initialize response is osen", client.getServerVersion()?.name === "osen", JSON.stringify(client.getServerVersion()));
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check(1, "seven council_* tools", names.length === 7 && names.every((n) => n.startsWith("council_")), names.join(", "));
  const res = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);
  const start = res(await client.callTool({ name: "council_start", arguments: { topic: "Имя сервера", participants: ["consensus/p1.json", "consensus/p2.json"].map((model) => ({ providerId: "scripted", model })) } }));
  let s = { status: "running" };
  for (let i = 0; i < 10 && s.status === "running"; i++) s = res(await client.callTool({ name: "council_status", arguments: { sessionId: start.sessionId, waitSec: 10 } }));
  check(1, "council_start with scripted participants → council_status: consensus", s.status === "consensus", JSON.stringify(s).slice(0, 300));
  await client.close();
}

// ---- step 2: the installer under a fake HOME ----
const main = mainTs;
function seedLegacy(home: string, over: { claudeArgs?: string[]; codexMarker?: string | null; claudeMarker?: string } = {}) {
  for (const agent of ["claude", "codex"] as const) {
    const dir = join(home, `.${agent}/skills/model-council`);
    put(join(dir, "SKILL.md"), "---\nname: model-council\ndescription: прежний\n---\n");
    const marker = agent === "codex" ? over.codexMarker : over.claudeMarker;
    if (marker !== null) put(join(dir, ".model-council-install"), marker ?? root + "\n");
    put(join(home, `.${agent}/skills/other-skill/SKILL.md`), `чужой ${agent}\n`);
  }
  put(join(home, ".claude.json"), JSON.stringify({ theme: "dark", mcpServers: { other: { type: "stdio", command: "x", args: ["y"], env: {} }, "model-council": { type: "stdio", command: "node", args: over.claudeArgs ?? [main], env: {} } } }));
  put(join(home, ".codex/fake-state.json"), JSON.stringify({ servers: { other: { command: "x", args: ["y"] }, "model-council": { command: "node", args: [main] } } }));
}
const claudeServers = (home: string) => readJson(join(home, ".claude.json")).mcpServers ?? {};
const codexServers = (home: string) => readJson(join(home, ".codex/fake-state.json")).servers ?? {};

{
  const home = join(work, "home-a");
  seedLegacy(home);
  const before = tree(home);
  resetLog();
  const dry = install(home, "--dry-run");
  check(2, "--dry-run: code 0, osen install and model-council removal for both agents in the output",
    dry.code === 0 && ["Claude Code", "Codex"].every((a) => dry.out.includes(`${a} · сервер · будет добавлен`) && dry.out.includes(`${a} · сервер model-council · будет удалён`)
      && dry.out.includes(`${a} · скилл · будет удалён · ${join(home, a === "Codex" ? ".codex" : ".claude", "skills/model-council")}`)
      && dry.out.includes(`${a} · скилл · будет добавлен · ${join(home, a === "Codex" ? ".codex" : ".claude", "skills/osen")}`)), dry.out);
  check(2, "--dry-run: sha256 of HOME files unchanged, no add/remove calls", JSON.stringify(tree(home)) === JSON.stringify(before) && mutating().length === 0, mutating().join("; "));

  resetLog();
  const inst = install(home);
  check(2, "install: code 0", inst.code === 0, inst.out);
  for (const agent of ["claude", "codex"] as const) {
    const skill = join(home, `.${agent}/skills/osen`);
    check(2, `${agent}: osen folder with name: osen and the .osen-install marker`, /^name: osen$/m.test(readFileSync(join(skill, "SKILL.md"), "utf8")) && readFileSync(join(skill, ".osen-install"), "utf8") === root + "\n");
    check(2, `${agent}: no model-council folder, other-skill is in place`, !existsSync(join(home, `.${agent}/skills/model-council`)) && existsSync(join(home, `.${agent}/skills/other-skill/SKILL.md`)));
  }
  const want = [`claude mcp add --scope user osen -- node ${main}`, `codex mcp add osen -- node ${main}`, "claude mcp remove --scope user model-council", "codex mcp remove model-council"];
  check(2, "calls: mcp add … osen -- node <repository>/packages/mcp/src/main.ts and mcp remove … model-council for both agents", want.every((c) => calls().includes(c)), calls().join("\n    "));
  check(2, "servers: osen is ours, no model-council, other is in place",
    [claudeServers(home), codexServers(home)].every((s) => s.osen?.args?.[0] === main && !s["model-council"] && s.other), JSON.stringify([claudeServers(home), codexServers(home)]));

  const after = tree(home);
  resetLog();
  const again = install(home);
  check(2, "repeat: \"Всё уже установлено.\", no changes", again.code === 0 && again.out.includes("Всё уже установлено.") && JSON.stringify(tree(home)) === JSON.stringify(after) && mutating().length === 0, again.out);

  seedLegacy(home);
  resetLog();
  const un = install(home, "--uninstall");
  check(2, "--uninstall: code 0, neither osen nor this installation's legacy entries remain; other is in place",
    un.code === 0 && ["claude", "codex"].every((a) => !existsSync(join(home, `.${a}/skills/osen`)) && !existsSync(join(home, `.${a}/skills/model-council`)) && existsSync(join(home, `.${a}/skills/other-skill/SKILL.md`)))
      && [claudeServers(home), codexServers(home)].every((s) => JSON.stringify(Object.keys(s)) === '["other"]'), un.out);
}

{
  const home = join(work, "home-b");
  seedLegacy(home, { claudeArgs: ["/другой/путь/main.ts"], codexMarker: null, claudeMarker: "/другой/репозиторий\n" });
  const legacy = () => Object.fromEntries(Object.entries(tree(home)).filter(([k]) => k.includes("skills/model-council")));
  const before = legacy();
  resetLog();
  const r = install(home);
  check(2, "foreign entry under the legacy name: code 1, mismatch message", r.code === 1 && r.out.includes("расхождение") && r.out.includes("/другой/путь/main.ts"), r.out);
  check(2, "foreign model-council folders (no marker, another repository in the marker) untouched", JSON.stringify(legacy()) === JSON.stringify(before) && Object.keys(before).length >= 3);
  check(2, "the model-council server at a foreign path is not removed for Claude Code", claudeServers(home)["model-council"]?.args?.[0] === "/другой/путь/main.ts" && !calls().includes("claude mcp remove --scope user model-council"));
  check(2, "osen is installed for both agents", [claudeServers(home), codexServers(home)].every((s) => s.osen?.args?.[0] === main) && ["claude", "codex"].every((a) => existsSync(join(home, `.${a}/skills/osen/.osen-install`))));
}

// ---- step 3: skill text ----
{
  const text = readFileSync(join(root, "skill/osen/SKILL.md"), "utf8");
  const found = ["Model Council", "Мозговой штурм", "model-council"].filter((w) => text.includes(w));
  check(3, "skill/osen/SKILL.md has no \"Model Council\", \"Мозговой штурм\", \"model-council\"", found.length === 0, found.join(", "));
  const description = text.split("\n").find((l) => l.startsWith("description: ")) ?? "";
  check(3, "the description contains trigger phrases in two languages", description.includes("«собери совет моделей»") && description.includes("«convene a council of models»"));
}

// ---- step 4: the installer does not migrate the legacy data folder, council does (change 98) ----
{
  const home = join(work, "home-c");
  const support = join(home, "Library", "Application Support");
  const old = join(support, "model-council"), osen = join(support, "osen");
  const markers: Record<string, string> = { "preferences.json": '{"language":"ru"}\n', "sessions/x/events.jsonl": "{}\n", ".env": "KEY=stand\n" };
  for (const [f, t] of Object.entries(markers)) put(join(old, f), t);
  // links differ from folders: lstat, link target, sha256 of files
  // Claude/ is Claude Desktop's settings folder (change 140): the installer connects it when Claude.app is on the machine
  const lsTree = (dir: string) => readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((rel) => rel !== "Claude" && !rel.startsWith("Claude/")).sort().map((rel) => {
    const p = join(dir, rel), st = lstatSync(p);
    return st.isSymbolicLink() ? `${rel} -> ${readlinkSync(p)}` : st.isDirectory() ? `${rel}/` : `${rel} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
  });
  // without COUNCIL_HOME and COUNCIL_LANG: language and folder come from the fake HOME
  const bare = { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home };
  const run = (file: string, args: string[], extra: Record<string, string> = {}) => {
    try { return { code: 0, out: execFileSync(process.execPath, [file, ...args], { env: { ...bare, ...extra }, cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
    catch (e) { const x = e as { status: number; stdout: string; stderr: string }; return { code: x.status, out: `${x.stdout}${x.stderr}` }; }
  };
  const before = lsTree(support);
  for (const args of [["--dry-run"], [], ["--uninstall"]]) {
    const r = run(installTs, args);
    const what = args[0] ?? "no flags";
    if (args[0] === "--dry-run") check(4, "--dry-run: Russian output from the legacy folder, code 0", r.code === 0 && r.out.startsWith("Предпросмотр: изменений не будет"), r.out);
    else check(4, `${what}: code 0`, r.code === 0, r.out);
    check(4, `${what}: Library/Application Support unchanged (model-council is a folder, no osen and no copy)`, JSON.stringify(lsTree(support)) === JSON.stringify(before), lsTree(support).join("\n    "));
  }
  const c = run(join(root, "packages/core/src/council.ts"), ["--topic", "перенос", "--participant", "scripted:packages/core/scenarios/consensus/p1.json", "--participant", "scripted:packages/core/scenarios/consensus/p2.json", "--max-rounds", "3"], { COUNCIL_DEV: "1" });
  const backups = readdirSync(support).filter((n) => n.startsWith("model-council-backup-"));
  const appLog = existsSync(join(osen, "logs/app.log")) ? readFileSync(join(osen, "logs/app.log"), "utf8") : "";
  check(4, "then council migrates: code 0, markers in osen byte for byte, one copy, model-council → osen, a line in app.log",
    c.code === 0 && Object.entries(markers).every(([f, t]) => existsSync(join(osen, f)) && readFileSync(join(osen, f), "utf8") === t)
      && backups.length === 1 && lstatSync(old).isSymbolicLink() && readlinkSync(old) === "osen"
      && appLog.includes(`${old} -> ${osen}`) && appLog.includes(join(support, backups[0]!)),
    `${c.out}\n    ${lsTree(support).join("\n    ")}\n    ${appLog}`);
}

// ---- step 5: an osen folder from another repository copy is foreign (change 112) ----
{
  const home = join(work, "home-d");
  const other = "/другая/копия";
  const skills = ["claude", "codex"].map((a) => join(home, `.${a}/skills/osen`));
  const seed = (marker: string, serverMain: string) => {
    seedLegacy(home);
    for (const dir of skills) {
      put(join(dir, "SKILL.md"), "от другой копии\n");
      put(join(dir, "refs/a.md"), "вложенный другой копии\n");
      put(join(dir, ".osen-install"), marker);
    }
    const c = readJson(join(home, ".claude.json")), x = readJson(join(home, ".codex/fake-state.json"));
    c.mcpServers.osen = { type: "stdio", command: "node", args: [serverMain], env: {} };
    x.servers.osen = { command: "node", args: [serverMain] };
    put(join(home, ".claude.json"), JSON.stringify(c)); put(join(home, ".codex/fake-state.json"), JSON.stringify(x));
    // Claude Desktop (change 140) is found through /Applications/Claude.app; its entry runs the installer's own node
    put(join(home, "Library/Application Support/Claude/claude_desktop_config.json"), JSON.stringify({ mcpServers: { osen: { command: process.execPath, args: [serverMain] } } }));
  };
  const skillTree = () => JSON.stringify(skills.map((d) => existsSync(d) ? tree(d) : null));
  const mismatch = (out: string) => ["Claude Code", "Codex"].every((a) => out.includes(`${a} · скилл · расхождение: папка установлена из другой копии репозитория: ${other}, не изменено`));
  seed(`${other}\n`, `${other}/packages/mcp/src/main.ts`);
  const before = tree(home), skillsBefore = skillTree();

  resetLog();
  const dry = install(home, "--dry-run");
  check(5, "--dry-run: code 1, mismatch with the marker path for both agents' skill", dry.code === 1 && mismatch(dry.out), dry.out);
  check(5, "--dry-run: sha256 of HOME files unchanged, no add/remove calls", JSON.stringify(tree(home)) === JSON.stringify(before) && mutating().length === 0, mutating().join("; "));

  resetLog();
  const inst = install(home);
  check(5, "install: code 1, mismatch, without \"Перезапусти агентов\"", inst.code === 1 && mismatch(inst.out) && !inst.out.includes("Перезапусти агентов"), inst.out);
  check(5, "install: HOME byte for byte unchanged (osen folders with a marker, legacy model-council in place), no add/remove calls",
    JSON.stringify(tree(home)) === JSON.stringify(before) && mutating().length === 0, mutating().join("; "));

  resetLog();
  const un = install(home, "--uninstall");
  check(5, "--uninstall: code 1, mismatch, osen folders byte for byte in place", un.code === 1 && mismatch(un.out) && skillTree() === skillsBefore, un.out);

  seed(root + "\n", main);
  const inst2 = install(home);
  check(5, "control: this copy's marker — install updates, code 0",
    inst2.code === 0 && skills.every((d) => /^name: osen$/m.test(readFileSync(join(d, "SKILL.md"), "utf8")) && !existsSync(join(d, "refs/a.md"))), inst2.out);
  const un2 = install(home, "--uninstall");
  check(5, "control: --uninstall removes, code 0", un2.code === 0 && skills.every((d) => !existsSync(d)), un2.out);

  const deploy = readFileSync(join(root, "docs/deploy.md"), "utf8");
  check(5, "docs/deploy.md: the skill installer is not said to migrate", !deploy.includes("skill installer"));
}

// ---- step 5, change 257: a foreign osen skill folder and no osen server entry: the server is not added ----
for (const [what, marker] of [["another copy's marker", "/другая/копия\n"], ["no marker", null]] as const) {
  const home = join(work, `home-e-${marker === null ? "nomarker" : "other"}`);
  seedLegacy(home);
  for (const a of ["claude", "codex"]) {
    put(join(home, `.${a}/skills/osen/SKILL.md`), "от другой копии\n");
    if (marker !== null) put(join(home, `.${a}/skills/osen/.osen-install`), marker);
  }
  // drop the legacy server entries too: the agent configs hold only the foreign `other` server
  const c = readJson(join(home, ".claude.json")), x = readJson(join(home, ".codex/fake-state.json"));
  delete c.mcpServers["model-council"]; delete x.servers["model-council"];
  put(join(home, ".claude.json"), JSON.stringify(c)); put(join(home, ".codex/fake-state.json"), JSON.stringify(x));
  // Claude Desktop already has its own connected entry, so only the agents' servers are in question
  put(join(home, "Library/Application Support/Claude/claude_desktop_config.json"), JSON.stringify({ mcpServers: { osen: { command: process.execPath, args: [main] } } }));
  for (const a of ["claude", "codex"]) rmSync(join(home, `.${a}/skills/model-council`), { recursive: true, force: true });
  const before = tree(home);
  for (const flags of [[], ["--dry-run"]]) {
    const label = `${what}${flags.length ? " --dry-run" : ""}`;
    resetLog();
    const r = install(home, ...flags);
    const lines = r.out.split("\n");
    const ok = ["Claude Code", "Codex"].every((a) => lines.some((l) => l.startsWith(`${a} · скилл · расхождение`)) && lines.some((l) => l.startsWith(`${a} · сервер · расхождение: сервер не добавлен: папка скилла osen чужая`)));
    check(5, `no osen server, foreign skill (${label}): skill mismatch, "сервер не добавлен" for both agents, code 1, no "Перезапусти агентов"`, r.code === 1 && ok && !r.out.includes("Перезапусти агентов"), `${r.code}\n${r.out}`);
    check(5, `no osen server, foreign skill (${label}): HOME byte for byte unchanged, osen not in the agent configs, no add/remove calls`,
      JSON.stringify(tree(home)) === JSON.stringify(before) && !claudeServers(home).osen && !codexServers(home).osen && mutating().length === 0, mutating().join("; "));
  }
}

if (failed) { console.log(`\nFailed: ${failed}. The stand folder is kept: ${work}`); process.exit(1); }
rmSync(work, { recursive: true, force: true });
console.log("\nAll passed, the stand folder is removed.");
