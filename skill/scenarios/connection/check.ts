// Live check of the agent connection module @model-council/connect (change 140, steps 0-5 of the Live Scenario; change 241 cases in steps 1 and 4; change 257 cases in step 6).
// The module is called directly with ConnectDeps over a fake HOME; the installer is the real `node skill/install.ts` with a fake
// HOME and fake `claude` and `codex` first in PATH: they edit $HOME/.claude.json and $HOME/.codex/fake-state.json and write
// calls to a log. The owner's global agent settings are not changed. Model calls 0.
//   COUNCIL_DEV=1 node skill/scenarios/connection/check.ts
// The stand creates the .council-data/connection-check-<label> folder itself; removes it on success, keeps it as evidence on failure.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { checkConnection, connect, disconnect, status, update } from "@model-council/connect";
import type { Bin, ClientId, ConnectDeps, ServerCommand } from "@model-council/connect";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("COUNCIL_DEV=1 is required. Run: COUNCIL_DEV=1 node skill/scenarios/connection/check.ts");
  process.exit(2);
}
const t0 = Date.now();
const root = resolve(import.meta.dirname, "../../..");
const mainTs = join(root, "packages/mcp/src/main.ts");
const installTs = join(root, "skill/install.ts");
const work = join(root, ".council-data", `connection-check-${Date.now()}`);
const bin = join(work, "bin"), log = join(work, "calls.log"), data = join(work, "data");
mkdirSync(bin, { recursive: true });

let failed = 0;
const check = (step: number, what: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} step ${step}: ${what}${ok || !detail ? "" : `\n    ${detail.slice(0, 600)}`}`);
};
const put = (f: string, t: string) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, t); };
const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const json = (v: unknown) => JSON.stringify(v);

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
  if (process.env.FAKE_FAIL_ADD === "1" || (process.env.FAKE_FAIL_ADD_CMD && args[sep + 1] === process.env.FAKE_FAIL_ADD_CMD)) { console.error("boom"); process.exit(1); }
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

// ---- helpers ----
const pathEnv = `${bin}:${process.env.PATH ?? ""}`;
let failAdd = false;
let failAddCmd = "";
const envFor = (home: string): Record<string, string> => ({ PATH: pathEnv, HOME: home, ...(failAdd ? { FAKE_FAIL_ADD: "1" } : {}), ...(failAddCmd ? { FAKE_FAIL_ADD_CMD: failAddCmd } : {}) });
const apps = join(work, "Applications", "Claude.app");
mkdirSync(apps, { recursive: true });
const depsFor = (home: string): ConnectDeps => ({
  home,
  desktopApps: [apps],
  hasCommand: (b: Bin) => { try { execFileSync(join(bin, b), ["--version"], { env: envFor(home), stdio: "ignore" }); return true; } catch { return false; } },
  exec: (b: Bin, args: string[]) => {
    try { return { ok: true, stdout: execFileSync(join(bin, b), args, { env: envFor(home), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" }; }
    catch (e) { const x = e as { stdout?: string; stderr?: string; message: string }; return { ok: false, stdout: String(x.stdout ?? ""), stderr: String(x.stderr ?? x.message) }; }
  },
});
function install(home: string, lang: string, ...args: string[]) {
  const env = { PATH: pathEnv, HOME: home, COUNCIL_HOME: data, COUNCIL_LANG: lang };
  try { return { code: 0, out: execFileSync(process.execPath, [installTs, ...args], { env, cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { const x = e as { status: number; stdout: string; stderr: string }; return { code: x.status, out: `${x.stdout}${x.stderr}` }; }
}
function tree(dir: string): string {
  const r: Record<string, string> = {};
  if (existsSync(dir)) for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (statSync(join(dir, rel)).isFile()) r[rel] = createHash("sha256").update(readFileSync(join(dir, rel))).digest("hex");
  }
  return json(Object.entries(r).sort());
}
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
const mutating = () => calls().filter((c) => / mcp (add|remove) /.test(c));
const resetLog = () => rmSync(log, { force: true });
const A = join(work, "A"), B = join(work, "B");
const wrapperIn = (dir: string) => join(dir, "Osen.app/Contents/Resources/bin/osen-mcp");
put(wrapperIn(A), `#!/bin/sh\nexec "${process.execPath}" "${mainTs}" "$@"\n`);
chmodSync(wrapperIn(A), 0o755);
const cmdA: ServerCommand = { command: wrapperIn(A), args: [] }, cmdB: ServerCommand = { command: wrapperIn(B), args: [] };
const desktopFile = (home: string) => join(home, "Library/Application Support/Claude/claude_desktop_config.json");
const foreignDesktop = { theme: "x", mcpServers: { other: { command: "x", args: ["y"] } }, preferences: { a: 1 } };
const foreignClaude = { theme: "dark", mcpServers: { other: { type: "stdio", command: "x", args: ["y"], env: {} } } };
const foreignCodex = { servers: { other: { command: "x", args: ["y"] } } };
const settings = (c: ClientId, home: string) => (c === "claude-desktop" ? desktopFile(home) : c === "claude-code" ? join(home, ".claude.json") : join(home, ".codex/fake-state.json"));
const seeds: Record<ClientId, unknown> = { "claude-desktop": foreignDesktop, "claude-code": foreignClaude, codex: foreignCodex };
const serversOf = (c: ClientId, home: string) => { const d = readJson(settings(c, home)); return c === "codex" ? d.servers : d.mcpServers; };

// ---- step 0: need and failures ----
{
  const n: Record<string, string> = {};
  for (const c of ["claude-code", "codex", "claude-desktop"] as ClientId[]) {
    const home = join(work, `home-need-${c}`);
    put(settings(c, home), json(seeds[c]));
    const cmd = c === "claude-desktop" ? { command: process.execPath, args: [mainTs] } : { command: "node", args: [mainTs] };
    const r1 = await connect(c, cmd, depsFor(home));
    const r2 = await connect(c, cmd, depsFor(home));
    n[c] = r1.ok && r2.ok ? `${r1.need}/${r2.need}/${r2.changed}` : `refused ${json(r1)}`;
  }
  check(0, "need: restart_client for claude-desktop and codex, unverified for claude-code; a repeated connect gives none, changed false",
    n["claude-desktop"] === "restart_client/none/false" && n["codex"] === "restart_client/none/false" && n["claude-code"] === "unverified/none/false", json(n));

  const home = join(work, "home-fail");
  failAdd = true;
  const r = await connect("claude-code", { command: "node", args: [mainTs] }, depsFor(home));
  failAdd = false;
  check(0, "FAKE_FAIL_ADD=1: claude-code connect returns ok false, refusal failed, reason cli with boom",
    !r.ok && r.refusal === "failed" && r.reason?.code === "cli" && r.reason.detail.includes("boom"), json(r));

  const dh = join(work, "home-chmod");
  const f = desktopFile(dh);
  put(f, json(foreignDesktop));
  const before = readFileSync(f);
  chmodSync(f, 0o000);
  let s, r2;
  try {
    const cmd = { command: process.execPath, args: [mainTs] };
    s = await status("claude-desktop", cmd, depsFor(dh));
    r2 = await connect("claude-desktop", cmd, depsFor(dh));
  } finally { chmodSync(f, 0o644); }
  check(0, "desktop config with chmod 000: status corrupt/unreadable, connect refuses, file unchanged",
    s?.state === "corrupt" && s.reason?.code === "unreadable" && !!r2 && !r2.ok && r2.refusal === "corrupt" && readFileSync(f).equals(before), json([s, r2]));
}

// ---- step 1: the full chain for each client ----
for (const c of ["claude-code", "codex", "claude-desktop"] as ClientId[]) {
  const home = join(work, `home-chain-${c}`);
  const d = depsFor(home);
  const ctx = c;
  put(settings(c, home), json(seeds[c]));
  if (c !== "claude-desktop") put(desktopFile(home), json(foreignDesktop));
  const orig = readJson(settings(c, home));
  resetLog();
  const s0 = await status(c, cmdA, d);
  check(1, `${ctx}: status not_connected`, s0.state === "not_connected", json(s0));
  const before = tree(home);
  const dry = await connect(c, cmdA, d, { dryRun: true });
  check(1, `${ctx}: dry-run connect: planned, home sha256 unchanged, no add/remove calls`, dry.ok && dry.changed && tree(home) === before && mutating().length === 0, json(dry));
  const r1 = await connect(c, cmdA, d);
  const entry = serversOf(c, home).osen;
  const others = { ...serversOf(c, home) }; delete others.osen;
  const origServers = c === "codex" ? orig.servers : orig.mcpServers;
  const rest = { ...readJson(settings(c, home)) };
  delete rest.mcpServers; delete rest.servers;
  const origRest = { ...orig }; delete origRest.mcpServers; delete origRest.servers;
  check(1, `${ctx}: connect → connected, entry is the wrapper, foreign servers and keys equal by value`,
    r1.ok && r1.state === "connected" && entry?.command === cmdA.command && isDeepStrictEqual(others, origServers) && isDeepStrictEqual(rest, origRest), json([r1, entry]));
  const bytes = readFileSync(settings(c, home)), nCalls = calls().length;
  const r2 = await connect(c, cmdA, d);
  check(1, `${ctx}: repeated connect: changed false, file bytes identical, no new add calls`, r2.ok && !r2.changed && readFileSync(settings(c, home)).equals(bytes) && calls().filter((x) => / mcp add /.test(x)).length === calls().slice(0, nCalls).filter((x) => / mcp add /.test(x)).length, json(r2));
  renameSync(A, B);
  const s1 = await status(c, cmdB, d);
  check(1, `${ctx}: after moving the app folder status is stale_path`, s1.state === "stale_path", json(s1));
  const u = await update(c, cmdB, d);
  const s2 = await status(c, cmdB, d);
  check(1, `${ctx}: update → connected, entry command is the new path`, u.ok && s2.state === "connected" && s2.entry?.command === cmdB.command, json([u, s2]));
  const x = await disconnect(c, cmdB, d);
  const after = readJson(settings(c, home));
  const gone = !(c === "codex" ? after.servers : after.mcpServers)?.osen;
  check(1, `${ctx}: disconnect → settings equal to the original by value, no osen`, x.ok && gone && isDeepStrictEqual(after, orig), json([x, after]));
  renameSync(B, A);
}
// claude-desktop: an empty mcpServers and an absent one are equal by value (change 241)
for (const orig of [{ x: 1, mcpServers: {} }, { x: 1 }]) {
  const home = join(work, `home-empty-${Object.keys(orig).length}`);
  const d = depsFor(home);
  put(desktopFile(home), json(orig));
  const r1 = await connect("claude-desktop", cmdA, d), r2 = await disconnect("claude-desktop", cmdA, d);
  const { mcpServers = {}, ...rest } = readJson(desktopFile(home));
  check(1, `claude-desktop ${json(orig)}: connect, disconnect → x is 1, mcpServers empty or absent, no osen`,
    r1.ok && r2.ok && isDeepStrictEqual(rest, { x: 1 }) && isDeepStrictEqual(mcpServers, {}), json([r1, r2, readJson(desktopFile(home))]));
}

// ---- step 2: refusals; module status and the real installer in en and ru ----
{
  const other = join(work, "other-copy/packages/mcp/src/main.ts");
  put(other, "// another copy\n");
  const wrongSkill = (home: string) => { for (const a of ["claude", "codex"]) put(join(home, `.${a}/skills/osen/SKILL.md`), "foreign\n"); };
  const entryFor = (kind: "foreign" | "other", desktop: boolean) => ({ command: kind === "foreign" ? "npx" : desktop ? process.execPath : "node", args: [kind === "foreign" ? "other-server" : other] });
  const cases: { name: string; expect: string; desktop: string; en: string; ru: string; kind?: "foreign" | "other" }[] = [
    { name: "foreign osen entry", kind: "foreign", expect: "foreign", desktop: "", en: "mismatch:", ru: "расхождение:" },
    { name: "osen entry pointing to an existing other copy", kind: "other", expect: "foreign", desktop: "", en: "mismatch:", ru: "расхождение:" },
    { name: "desktop broken JSON", expect: "corrupt", desktop: "{ broken", en: "could not parse", ru: "не удалось разобрать" },
    { name: "desktop mcpServers is an array", expect: "corrupt", desktop: '{"mcpServers": []}', en: "mcpServers is not an object", ru: "mcpServers не объект" },
  ];
  for (const k of cases) {
    const home = join(work, `home-ref-${cases.indexOf(k)}`);
    const claudeE = k.kind ? entryFor(k.kind, false) : entryFor("foreign", false);
    put(join(home, ".claude.json"), json({ mcpServers: { osen: { type: "stdio", ...claudeE, env: {} } } }));
    put(join(home, ".codex/fake-state.json"), json({ servers: { osen: claudeE } }));
    put(desktopFile(home), k.kind ? json({ mcpServers: { osen: entryFor(k.kind, true) } }) : k.desktop);
    wrongSkill(home);
    const d = depsFor(home);
    const cmd = { command: process.execPath, args: [mainTs] };
    const sts = await Promise.all((["claude-code", "codex", "claude-desktop"] as ClientId[]).map(async (c) => (await status(c, c === "claude-desktop" ? cmd : { command: "node", args: [mainTs] }, d)).state));
    const want = k.kind ? [k.expect, k.expect, k.expect] : [k.expect, k.expect, k.expect].map((e, i) => (i === 2 ? e : "foreign"));
    check(2, `${k.name}: module status ${want.join("/")}`, json(sts) === json(want), json(sts));
    const before = tree(home);
    for (const [lang, phrase] of [["en", k.en], ["ru", k.ru]] as const) {
      const r = install(home, lang);
      const lines = r.out.split("\n");
      const need = k.kind ? ["Claude Code", "Codex", "Claude Desktop"] : ["Claude Desktop"];
      const ok = need.every((t) => lines.some((l) => l.startsWith(`${t} · `) && l.includes(phrase)));
      check(2, `${k.name}: installer ${lang}: code 1, reason "${phrase}" in the affected lines, home byte-identical`, r.code === 1 && ok && tree(home) === before, `${r.code}\n${r.out}`);
    }
  }
}

// ---- step 3: the real installer on a fresh fake HOME ----
{
  const home = join(work, "home-inst");
  put(desktopFile(home), json(foreignDesktop));
  const orig = readJson(desktopFile(home));
  const before = tree(home);
  resetLog();
  const dry = install(home, "ru", "--dry-run");
  check(3, "--dry-run: code 0, desktop file, mcpServers.osen, будет добавлен, без скилла; home unchanged",
    dry.code === 0 && ["claude_desktop_config.json", "mcpServers.osen", "будет добавлен", "без скилла"].every((s) => dry.out.includes(s)) && tree(home) === before && mutating().length === 0, dry.out);
  const inst = install(home, "ru");
  const dc = readJson(desktopFile(home));
  const rest = { ...dc }; const dsrv = { ...dc.mcpServers }; delete dsrv.osen; delete rest.mcpServers;
  const origRest = { ...orig }; delete origRest.mcpServers;
  check(3, "install: code 0, skills added for Claude Code and Codex, desktop restart line",
    inst.code === 0 && inst.out.includes("Claude Code · скилл · добавлен") && inst.out.includes("Codex · скилл · добавлен") && inst.out.includes("Claude Desktop · перезапусти клиент"), inst.out);
  check(3, "desktop file: mcpServers.osen = {command: node, args: [main.ts]}, foreign content equal by value, no skill folder for Claude Desktop",
    isDeepStrictEqual(dc.mcpServers.osen, { command: process.execPath, args: [mainTs] }) && isDeepStrictEqual(dsrv, orig.mcpServers) && isDeepStrictEqual(rest, origRest)
      && !existsSync(join(home, "Library/Application Support/Claude/skills")), json(dc));
  check(3, "claude and codex entries are present", !!readJson(join(home, ".claude.json")).mcpServers?.osen && !!readJson(join(home, ".codex/fake-state.json")).servers?.osen);
  const again = install(home, "ru");
  check(3, "repeat: Всё уже установлено.", again.code === 0 && again.out.includes("Всё уже установлено."), again.out);
  const un = install(home, "ru", "--uninstall");
  const sc = readJson(join(home, ".claude.json")).mcpServers ?? {}, sx = readJson(join(home, ".codex/fake-state.json")).servers ?? {};
  check(3, "--uninstall: code 0, no osen anywhere, desktop content equal to the original by value",
    un.code === 0 && !sc.osen && !sx.osen && isDeepStrictEqual(readJson(desktopFile(home)), orig), un.out);
}

// ---- step 4: connection check ----
{
  const home = join(work, "home-check");
  const support = join(homedir(), "Library", "Application Support", "osen");
  const snap = () => (existsSync(support) ? json([readdirSync(support).sort(), statSync(support).mtimeMs]) : "absent");
  const realBefore = snap();
  put(desktopFile(home), json(foreignDesktop));
  const d = depsFor(home);
  await connect("claude-desktop", { command: process.execPath, args: [mainTs] }, d);
  const entry = (await status("claude-desktop", { command: process.execPath, args: [mainTs] }, d)).entry;
  const r = await checkConnection(entry, { extraEnv: { COUNCIL_DEV: "1", HOME: home } });
  check(4, "checkConnection on the repo command: ok, 7 tools council_*", r.ok && r.tools.length === 7 && r.tools.every((t) => t.startsWith("council_")), json(r));
  const sup = join(home, "Library/Application Support");
  check(4, "fake home has no osen or model-council data folder; the owner's real data folder is unchanged",
    !existsSync(join(sup, "osen")) && !existsSync(join(sup, "model-council")) && snap() === realBefore, `${realBefore} -> ${snap()}`);

  const stray = join(work, "stray.mjs"), silent = join(work, "silent.mjs");
  writeFileSync(stray, 'process.stdout.write("hello\\n"); setInterval(() => {}, 1000);\n');
  writeFileSync(silent, `import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (l) => { const m = JSON.parse(l); if (m.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "silent", version: "0" } } })); });
setInterval(() => {}, 1000);
`);
  const cases: [string, ServerCommand, string, number | undefined][] = [
    ["nonexistent file", { command: join(work, "nonexistent-server"), args: [] }, "spawn_failed", undefined],
    ["stdout noise before the first message", { command: process.execPath, args: [stray] }, "stray_stdout", undefined],
    ["no answer to tools/list", { command: process.execPath, args: [silent] }, "timeout", 3000],
  ];
  for (const [what, e, reason, timeoutMs] of cases) {
    const t = Date.now();
    const x = await checkConnection(e, { extraEnv: { HOME: home }, ...(timeoutMs ? { timeoutMs } : {}) });
    check(4, `${what}: ${reason} in ≤ 25 s`, !x.ok && x.reason === reason && Date.now() - t <= 25000, json(x));
  }
  // change 241: answers both requests, then prints text without a newline and exits
  const tail = join(work, "tail.mjs");
  writeFileSync(tail, `import { createInterface } from "node:readline";
const tools = ${json(["council_continue", "council_options", "council_resume", "council_say", "council_start", "council_status", "council_stop"])}.map((name) => ({ name }));
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") out({ id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "tail", version: "0" } } });
  if (m.method === "tools/list") { out({ id: m.id, result: { tools } }); process.stdout.write("garbage", () => process.exit(0)); }
});
`);
  const t = Date.now();
  const x = await checkConnection({ command: process.execPath, args: [tail] }, { extraEnv: { HOME: home } });
  check(4, "7 tools, then stdout text without a newline and exit: stray_stdout, detail starts with garbage, in ≤ 25 s",
    !x.ok && x.reason === "stray_stdout" && x.detail.startsWith("garbage") && Date.now() - t <= 25000, json(x));
}

// ---- step 5: the app command ----
{
  const home = join(work, "home-app");
  put(desktopFile(home), json(foreignDesktop));
  const d = depsFor(home);
  const r = await connect("claude-desktop", cmdA, d);
  const entry = readJson(desktopFile(home)).mcpServers?.osen;
  check(5, "connect claude-desktop with the app wrapper: the entry is exactly {command: wrapper, args: []}", r.ok && isDeepStrictEqual(entry, { command: cmdA.command, args: [] }), json([r, entry]));
  const x = await checkConnection((await status("claude-desktop", cmdA, d)).entry, { extraEnv: { COUNCIL_DEV: "1", HOME: home } });
  check(5, "checkConnection through the wrapper: ok", x.ok, json(x));
}

// ---- step 6: change 257 (A1 another launcher, A2 update restores the entry, IL5 language from the data folder .env) ----
{
  // A1: the osen entry runs this copy's main.ts with another existing program
  const progDir = join(work, "other-node");
  const otherNode = join(progDir, "node");
  mkdirSync(progDir, { recursive: true });
  writeFileSync(otherNode, readFileSync(process.execPath));
  chmodSync(otherNode, 0o755);
  const home = join(work, "home-257-a1");
  put(desktopFile(home), json({ mcpServers: { osen: { command: otherNode, args: [mainTs] } } }));
  const before = tree(home);
  for (const [lang, head, bad] of [["en", "the entry runs the same server with another program", "missing file"], ["ru", "запись запускает тот же сервер другой программой", "несуществующий файл"]] as const) {
    const r = install(home, lang, "--dry-run");
    const line = r.out.split("\n").find((l) => /^Claude Desktop · (server|сервер) /.test(l)) ?? "";
    check(6, `A1 ${lang}: another launcher: code 1, line names recorded ${otherNode} and expected ${process.execPath}, no "${bad}", file byte-identical`,
      r.code === 1 && line.includes(head) && line.includes(otherNode) && line.includes(process.execPath) && !r.out.includes(bad) && tree(home) === before, `${r.code}\n${r.out}`);
  }

  // A2: a failed add during update keeps the previous entry (claude) / one add and no remove (codex)
  const oldCmd = wrapperIn(B);
  const home2 = join(work, "home-257-a2");
  put(join(home2, ".claude.json"), json({ mcpServers: { osen: { type: "stdio", command: oldCmd, args: [], env: {} } } }));
  put(join(home2, ".codex/fake-state.json"), json({ servers: { osen: { command: oldCmd, args: [] } } }));
  const d2 = depsFor(home2);
  const s0 = await status("claude-code", cmdA, d2);
  failAddCmd = cmdA.command;
  resetLog();
  const u = await update("claude-code", cmdA, d2);
  failAddCmd = "";
  const kept = readJson(join(home2, ".claude.json")).mcpServers?.osen;
  check(6, "A2 claude-code: precondition stale_path; update with a failing add → refusal failed, state stale_path, osen entry unchanged",
    s0.state === "stale_path" && !u.ok && u.refusal === "failed" && u.state === "stale_path" && kept?.command === oldCmd, json([s0, u, kept]));
  resetLog();
  const sc = await status("codex", cmdA, d2);
  const uc = await update("codex", cmdA, d2);
  const entryC = readJson(join(home2, ".codex/fake-state.json")).servers?.osen;
  check(6, "A2 codex: stale_path; update → connected, one `mcp add`, zero `mcp remove` in the call log",
    sc.state === "stale_path" && uc.ok && entryC?.command === cmdA.command && calls().filter((c) => / mcp add /.test(c)).length === 1 && calls().filter((c) => / mcp remove /.test(c)).length === 0, `${json([sc, uc])}\n${calls().join("\n")}`);

  // IL5: COUNCIL_LANG only in the data folder .env; the process env wins; no files are created
  const home3 = join(work, "home-257-il5"), data3 = join(work, "data-il5");
  put(desktopFile(home3), json(foreignDesktop));
  put(join(data3, ".env"), "COUNCIL_LANG=ru\n");
  const run = (extra: Record<string, string>) => {
    const env = { PATH: pathEnv, HOME: home3, COUNCIL_HOME: data3, ...extra };
    try { return { code: 0, out: execFileSync(process.execPath, [installTs, "--dry-run"], { env, cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
    catch (e) { const x = e as { status: number; stdout: string; stderr: string }; return { code: x.status, out: `${x.stdout}${x.stderr}` }; }
  };
  const files = (dir: string) => json(readdirSync(dir, { recursive: true, encoding: "utf8" }).sort());
  const dataBefore = files(data3), homeBefore = tree(home3);
  const ru = run({});
  check(6, "IL5 .env ru, no COUNCIL_LANG in the process env: Russian dry-run output, data folder and HOME file lists unchanged",
    ru.code === 0 && ru.out.startsWith("Предпросмотр: изменений не будет") && files(data3) === dataBefore && tree(home3) === homeBefore, `${ru.code}\n${ru.out}`);
  const en = run({ COUNCIL_LANG: "en" });
  check(6, "IL5 process env COUNCIL_LANG=en wins over .env ru: English output", en.code === 0 && en.out.startsWith("Preview: nothing will be changed") && files(data3) === dataBefore, `${en.code}\n${en.out}`);
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
if (failed) { console.log(`\nFailed: ${failed}. The stand folder is kept: ${work} (${secs} s)`); process.exit(1); }
rmSync(work, { recursive: true, force: true });
console.log(`\nAll passed, the stand folder is removed (${secs} s).`);
