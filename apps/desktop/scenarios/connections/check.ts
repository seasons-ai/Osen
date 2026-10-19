// Live check of the "Connections" tab backend (change 142): the real main-process module createConnections over the real
// connection module (change 140) and the council command install (change 141), on a fake HOME with fake `claude` and `codex`
// first in PATH and the real zsh. No Electron, no `deps` seam, 0 model calls. Real owner files are hashed before and after.
//   COUNCIL_DEV=1 COUNCIL_HOME=<new folder inside the project> node apps/desktop/scenarios/connections/check.ts
//   ... --seed-only   build the fake HOME and data folder for the dev window, print the launch command, delete nothing
// The fake HOME/bin live in an ASCII-only folder (zsh cannot read .zprofile under the Cyrillic project path);
// the stand folder and COUNCIL_HOME are removed on success and kept on failure.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createLogger } from "@model-council/core";
import { createConnections } from "../../src/main/connections.ts";

const seedOnly = process.argv.includes("--seed-only");
if (process.env.COUNCIL_DEV !== "1" || !process.env.COUNCIL_HOME) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME (a new folder) are required. Run: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node apps/desktop/scenarios/connections/check.ts");
  process.exit(2);
}
const root = resolve(import.meta.dirname, "../../../..");
const dataDir = resolve(process.env.COUNCIL_HOME);
if (existsSync(dataDir) && readdirSync(dataDir).length > 0) {
  console.error(`COUNCIL_HOME ${dataDir} is not empty: the stand writes only to a new folder.`);
  process.exit(2);
}
mkdirSync(dataDir, { recursive: true });

const ascii = (p: string) => /^[\x20-\x7e]+$/.test(p);
const base = [join(root, ".council-data"), tmpdir()].find(ascii)!;
mkdirSync(base, { recursive: true });
const work = realpathSync(mkdtempSync(join(base, "connections-check-")));
const fakeBin = join(work, "bin"), callsLog = join(work, "calls.log"), wrapper = join(work, "App/Osen.app/Contents/Resources/bin/council");
const mainTs = join(root, "packages/mcp/src/main.ts");
const SERVER = { command: process.execPath, args: [mainTs] };

const put = (f: string, t: string, mode?: number) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, t); if (mode) chmodSync(f, mode); };
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));

// ---- fake claude and codex (they edit $HOME/.claude.json and $HOME/.codex/fake-state.json and log every call) ----
put(join(fakeBin, "fake.cjs"), `const fs = require("node:fs"), path = require("node:path");
const [agent, ...args] = process.argv.slice(2);
if (args[0] === "--version") { console.log(agent + " 0.0.0-stand"); process.exit(0); }
fs.appendFileSync(${JSON.stringify(callsLog)}, agent + " " + args.join(" ") + "\\n");
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
for (const agent of ["claude", "codex"]) put(join(fakeBin, agent), `#!/bin/sh\nexec "${process.execPath}" "${join(fakeBin, "fake.cjs")}" ${agent} "$@"\n`, 0o755);
put(wrapper, "#!/bin/sh\necho council-stand-wrapper\n", 0o755);

const SECRET = "s3cr3t-value";
const logger = createLogger(dataDir, "desktop", { ...process.env, COUNCIL_HOME: dataDir });
const profile = (home: string, line = "") => put(join(home, ".zprofile"), `export PATH="${fakeBin}:$PATH"\n${line}${line ? "\n" : ""}`);
const envFor = (home: string): Record<string, string> => ({ HOME: home, ZDOTDIR: home, PATH: `${fakeBin}:/usr/bin:/bin`, LANG: process.env.LANG ?? "en_US.UTF-8", TERM: process.env.TERM ?? "xterm", OSEN_STAND_SECRET: SECRET });
const desktopFile = (home: string) => join(home, "Library/Application Support/Claude/claude_desktop_config.json");
const mkHome = (name: string, app = true) => {
  const h = join(work, "homes", name);
  mkdirSync(h, { recursive: true });
  if (app) mkdirSync(join(h, "Applications/Claude.app"), { recursive: true });
  profile(h);
  return h;
};
const conn = (home: string, extra: Record<string, unknown> = {}) => createConnections({ home, env: envFor(home), serverCommand: SERVER, councilWrapper: wrapper, logger, desktopApps: [join(home, "Applications/Claude.app")], ...extra });
type Conn = ReturnType<typeof conn>;
const clientOf = async (c: Conn, id: string) => (await c.view()).clients.find((x) => x.client === id)!;

const foreignDesktop = { theme: "x", mcpServers: { other: { command: "x", args: ["y"] } }, preferences: { a: 1 } };
const foreignClaude = { theme: "dark", mcpServers: { other: { type: "stdio", command: "x", args: ["y"], env: {} } } };
const foreignCodex = { servers: { other: { command: "x", args: ["y"] } } };
const OWN_CODE = { type: "stdio", command: SERVER.command, args: SERVER.args, env: {} };

if (seedOnly) {
  const h = mkHome("seed");
  put(desktopFile(h), JSON.stringify(foreignDesktop, null, 2));
  put(join(h, ".claude.json"), JSON.stringify({ ...foreignClaude, mcpServers: { ...foreignClaude.mcpServers, osen: OWN_CODE } }));
  put(join(h, ".codex/fake-state.json"), JSON.stringify(foreignCodex));
  const info = { fakeHome: h, fakeBin, dataDir, wrapper, callsLog, serverCommand: SERVER };
  console.log(`COUNCIL_CONNECTIONS_STAND=${JSON.stringify(info)}`);
  console.log(`cd "${root}" && HOME=${h} PATH=${fakeBin}:$PATH COUNCIL_DEV=1 COUNCIL_HOME="${dataDir}" COUNCIL_COMMAND_WRAPPER=${wrapper} npm run desktop`);
  process.exit(0);
}

// ---- checks ----
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail.slice(0, 500)}`}`);
};
const tree = (dir: string): string => {
  const r: [string, string][] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n), st = lstatSync(p);
      if (st.isSymbolicLink()) r.push([p, `link:${readlinkSync(p)}`]);
      else if (st.isDirectory()) { r.push([p, "dir"]); walk(p); } else r.push([p, sha(p)]);
    }
  };
  walk(dir);
  return JSON.stringify(r);
};
const realHome = userInfo().homedir;
const realFiles = [".claude.json", ".codex/config.toml", "Library/Application Support/Claude/claude_desktop_config.json", ".local/bin/council"].map((f) => join(realHome, f));
const realState = () => realFiles.map((f) => {
  try {
    const st = lstatSync(f);
    if (st.isSymbolicLink()) return `link:${readlinkSync(f)}`;
    // a running Claude Code rewrites ~/.claude.json all the time: only its MCP servers are the stand's concern
    if (f.endsWith("/.claude.json")) return createHash("sha256").update(JSON.stringify(readJson(f).mcpServers ?? null)).digest("hex");
    return sha(f);
  } catch { return "absent"; }
});
const realBefore = realState();
const calls = () => (existsSync(callsLog) ? readFileSync(callsLog, "utf8").split("\n").filter(Boolean) : []);
const serversOf = (f: string) => readJson(f).mcpServers;
const ownEntry = (f: string) => ({ command: serversOf(f).osen?.command, args: serversOf(f).osen?.args });

try {
  // 1. opening changes nothing
  {
    const h = mkHome("open");
    put(desktopFile(h), JSON.stringify(foreignDesktop));
    put(join(h, ".claude.json"), JSON.stringify(foreignClaude));
    const c = conn(h), before = tree(h);
    await c.view(); const v = await c.view();
    check("1 opening twice changes no file under the fake HOME and creates no council link", tree(h) === before && !existsSync(join(h, ".local/bin/council")) && v.command.state === "not_installed");
  }

  // 2, 3. connect keeps foreign servers and keys; repeat is a no-op
  {
    const h = mkHome("connect"), f = desktopFile(h), c = conn(h);
    put(f, JSON.stringify(foreignDesktop, null, 2));
    const r = await c.connect("claude-desktop");
    const d = readJson(f), { osen, ...rest } = d.mcpServers;
    const { mcpServers: _m, ...otherKeys } = d;
    check("2 connect Claude Desktop: entry equals serverCommand, foreign servers and keys intact, need restart_client",
      r.result.ok && r.result.need === "restart_client" && isDeepStrictEqual({ command: osen.command, args: osen.args }, SERVER)
      && isDeepStrictEqual(rest, foreignDesktop.mcpServers) && isDeepStrictEqual(otherKeys, { theme: "x", preferences: { a: 1 } }), JSON.stringify(r.result));
    const bytes = readFileSync(f), r2 = await c.connect("claude-desktop");
    check("3 repeat connect: changed false, file bytes unchanged", r2.result.ok && r2.result.changed === false && readFileSync(f).equals(bytes), JSON.stringify(r2.result));
  }

  // 4. foreign osen entry
  {
    const h = mkHome("foreign"), f = desktopFile(h), c = conn(h);
    put(f, JSON.stringify({ mcpServers: { osen: { command: "/usr/bin/other", args: ["z"] } } }));
    const bytes = readFileSync(f), st = await clientOf(c, "claude-desktop");
    const rs = [await c.connect("claude-desktop"), await c.update("claude-desktop"), await c.disconnect("claude-desktop")];
    check("4 foreign osen entry: state foreign, connect/update/disconnect refused, file unchanged",
      st.state === "foreign" && rs.every((r) => !r.result.ok && "refusal" in r.result && r.result.refusal === "foreign") && readFileSync(f).equals(bytes), JSON.stringify(rs.map((r) => r.result)));
  }

  // 5. corrupt JSON
  {
    const h = mkHome("corrupt"), f = desktopFile(h), c = conn(h);
    put(f, "{ not json");
    const bytes = readFileSync(f), st = await clientOf(c, "claude-desktop");
    const rs = [await c.connect("claude-desktop"), await c.update("claude-desktop"), await c.disconnect("claude-desktop")];
    check("5 corrupt JSON: state corrupt reason parse, all actions refused, file bytes unchanged",
      st.state === "corrupt" && st.reason?.code === "parse" && rs.every((r) => !r.result.ok) && readFileSync(f).equals(bytes), JSON.stringify([st, rs.map((r) => r.result)]));
  }

  // 6. unreadable config
  {
    const h = mkHome("unreadable"), f = desktopFile(h), c = conn(h);
    put(f, JSON.stringify(foreignDesktop));
    const bytes = readFileSync(f);
    chmodSync(f, 0o000);
    let st, r;
    try { st = await clientOf(c, "claude-desktop"); r = await c.connect("claude-desktop"); } finally { chmodSync(f, 0o644); }
    check("6 unreadable config (chmod 000): state corrupt, reason unreadable, connect refused, no write",
      st?.state === "corrupt" && st.reason?.code === "unreadable" && !!r && !r.result.ok && readFileSync(f).equals(bytes), JSON.stringify([st, r?.result]));
  }

  // 7. stale path
  {
    const h = mkHome("stale"), f = desktopFile(h), c = conn(h);
    const old = join(work, "Old/Osen.app/Contents/Resources/bin/osen-mcp");
    put(f, JSON.stringify({ theme: "x", mcpServers: { other: { command: "x", args: ["y"] }, osen: { command: old, args: [] } } }));
    const st = await clientOf(c, "claude-desktop"), r = await c.update("claude-desktop"), d = readJson(f);
    check("7 stale path: state stale_path; update rewrites only the osen entry to serverCommand",
      st.state === "stale_path" && r.result.ok && isDeepStrictEqual(ownEntry(f), SERVER) && isDeepStrictEqual(d.mcpServers.other, foreignDesktop.mcpServers.other) && d.theme === "x", JSON.stringify([st.state, r.result]));
  }

  // 8. disconnect removes only ours
  {
    const h = mkHome("disconnect"), f = desktopFile(h), c = conn(h);
    put(f, JSON.stringify(foreignDesktop));
    await c.connect("claude-desktop");
    const r = await c.disconnect("claude-desktop"), d = readJson(f);
    check("8 disconnect removes only our entry, other servers and keys stay", r.result.ok && !("osen" in d.mcpServers) && isDeepStrictEqual(d, foreignDesktop), JSON.stringify(d));
  }

  // 9. state changed after confirmation
  {
    const h = mkHome("race"), f = desktopFile(h), c = conn(h);
    put(f, JSON.stringify(foreignDesktop));
    const st = await clientOf(c, "claude-desktop");
    put(f, JSON.stringify({ mcpServers: { osen: { command: "/usr/bin/other", args: [] } } }));
    const bytes = readFileSync(f), r = await c.connect("claude-desktop");
    check("9 state changed after confirmation: view not_connected, then connect refused foreign, file unchanged",
      st.state === "not_connected" && !r.result.ok && "refusal" in r.result && r.result.refusal === "foreign" && readFileSync(f).equals(bytes), JSON.stringify([st.state, r.result]));
  }

  // 10. Claude Code and Codex through the fake CLIs
  {
    const h = mkHome("cli"), c = conn(h);
    put(join(h, ".claude.json"), JSON.stringify(foreignClaude));
    put(join(h, ".codex/fake-state.json"), JSON.stringify(foreignCodex));
    const tail = `-- ${SERVER.command} ${SERVER.args.join(" ")}`;
    const out: string[] = [];
    for (const [id, bin, file, key] of [["claude-code", "claude", ".claude.json", "mcpServers"], ["codex", "codex", ".codex/fake-state.json", "servers"]] as const) {
      const n0 = calls().length;
      const r = await c.connect(id);
      const add = calls().slice(n0).filter((l) => l.startsWith(`${bin} mcp add `));
      const st = readJson(join(h, file))[key];
      const okAdd = r.result.ok && add.length === 1 && add[0]!.endsWith(tail) && st.osen?.command === SERVER.command && isDeepStrictEqual(st.osen.args, SERVER.args) && "other" in st;
      const n1 = calls().length;
      const d = await c.disconnect(id);
      const rm = calls().slice(n1).filter((l) => l.startsWith(`${bin} mcp remove `));
      const okRm = d.result.ok && rm.length === 1 && !("osen" in readJson(join(h, file))[key]) && "other" in readJson(join(h, file))[key];
      if (!okAdd || !okRm) out.push(`${id}: ${JSON.stringify([r.result, add, d.result, rm])}`);
    }
    check("10 Claude Code and Codex: connect/disconnect go through the fake `mcp add/remove` with exactly serverCommand, foreign servers stay", out.length === 0 && calls().length > 0, out.join("\n"));
  }

  // 11. connection check: 7 tools, 0 sessions
  {
    const h = mkHome("check"), f = desktopFile(h), c = conn(h);
    put(f, JSON.stringify(foreignDesktop));
    await c.connect("claude-desktop");
    const r = await c.check("claude-desktop");
    const sessions = join(dataDir, "sessions");
    check("11 check on the connected entry: ok, 7 tools, 0 session folders in the stand data folder",
      r.ok && r.tools.length === 7 && (!existsSync(sessions) || readdirSync(sessions).length === 0), JSON.stringify(r));
  }

  // 12. recorded command that does not exist
  {
    const h = mkHome("nocmd"), f = desktopFile(h), c = conn(h);
    put(f, JSON.stringify({ mcpServers: { osen: { command: join(work, "nowhere/osen-mcp"), args: [] } } }));
    const r = await c.check("claude-desktop");
    check("12 check on a missing recorded command: spawn_failed", !r.ok && r.reason === "spawn_failed", JSON.stringify(r));
  }

  // 13. council link
  {
    const h = mkHome("link"), c = conn(h), link = join(h, ".local/bin/council"), zp = join(h, ".zprofile");
    const names: string[] = [];
    const expect = (what: string, ok: boolean, detail = "") => { if (!ok) names.push(`${what} ${detail}`); };
    const a = await c.installCommand();
    const zpBefore = sha(zp);
    expect("install", a.result.ok && a.result.changed && readlinkSync(link) === wrapper);
    const s = a.view.command;
    expect("not_in_path", s.state === "not_in_path" && s.hint.line === c.zprofileLine() && c.zprofileLine() === 'export PATH="$HOME/.local/bin:$PATH"', JSON.stringify(s));
    expect(".zprofile unchanged", sha(zp) === zpBefore);
    profile(h, 'export PATH="$HOME/.local/bin:$PATH"');
    expect("found", (await c.view()).command.state === "found");
    const shadow = join(work, "shadow");
    put(join(shadow, "council"), "#!/bin/sh\necho shadow\n", 0o755);
    profile(h, `export PATH="${shadow}:$HOME/.local/bin:$PATH"`);
    const sh = (await c.view()).command;
    expect("shadowed", sh.state === "shadowed" && sh.shadowedBy === join(shadow, "council"), JSON.stringify(sh));
    profile(h, 'export PATH="$HOME/.local/bin:$PATH"');
    const sibling = join(h, ".local/bin/other-tool");
    put(sibling, "x");
    rmSync(link);
    symlinkSync(join(work, "Moved/Osen.app/Contents/Resources/bin/council"), link);
    expect("stale", (await c.view()).command.state === "stale");
    const u = await c.installCommand();
    expect("stale updated", u.result.ok && u.result.updated && readlinkSync(link) === wrapper && readFileSync(sibling, "utf8") === "x");
    rmSync(link);
    put(link, "my own file\n");
    const fv = (await c.view()).command, fi = await c.installCommand(), fr = await c.removeCommand();
    expect("foreign", fv.state === "foreign" && !fi.result.ok && !fr.result.ok && readFileSync(link, "utf8") === "my own file\n" && !/[А-Яа-я]/.test(fi.result.ok ? "" : fi.result.message));
    rmSync(link);
    await c.installCommand();
    const rm = await c.removeCommand();
    expect("remove only our link", rm.result.ok && rm.result.removed && !existsSync(link) && readFileSync(sibling, "utf8") === "x" && rm.view.command.state === "not_installed");
    check("13 council link: not_in_path+hint, .zprofile untouched, found, shadowed, stale+update, foreign refused, remove only ours", names.length === 0, names.join("\n     "));
  }

  // 14. unknown client id
  {
    const h = mkHome("unknown"), c = conn(h), before = tree(h);
    let threw = false;
    try { await c.connect("bogus"); } catch { threw = true; }
    const lines = readFileSync(join(dataDir, "logs/app.log"), "utf8").split("\n").filter((l) => /refused connect for unknown client/.test(l));
    check("14 unknown client id: throws, exactly one `refused ... unknown client` log line, nothing written", threw && lines.length === 1 && tree(h) === before, `threw=${threw} lines=${lines.length}`);
  }

  // 15. no env leak
  {
    const log = readFileSync(join(dataDir, "logs/app.log"), "utf8");
    check("15 no env value leaks into logs/app.log", log.includes("Connections:") && !log.includes(SECRET));
  }

  // 16. real files untouched
  const after = realState();
  check("16 owner's real ~/.claude.json, ~/.codex/config.toml, Claude Desktop config and ~/.local/bin/council are untouched", isDeepStrictEqual(realBefore, after), `${realBefore} -> ${after}`);
} catch (e) {
  check("stand completed without an exception", false, e instanceof Error ? e.stack ?? e.message : String(e));
}
console.log(`RESULT: ${failed ? `FAIL (${failed})` : "OK"}`);
if (!failed) { rmSync(work, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); } else console.log(`stand kept: ${work}`);
process.exit(failed ? 1 : 0);
