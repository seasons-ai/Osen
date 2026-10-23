import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CLIENTS, NEED, connect, desktopApps, disconnect, settingsFile, skillsDir, status, update } from "./clients.ts";
import type { ClientId, ConnectDeps, ServerCommand } from "./types.ts";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "connect-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : null);
const json = (file: string) => JSON.parse(read(file) ?? "{}");

function setup(over: { claude?: boolean; codex?: boolean; desktopApp?: boolean; addFails?: boolean; codexRaw?: string } = {}) {
  const home = tmp();
  const calls: string[] = [];
  const claudeFile = join(home, ".claude.json"), codexState = join(home, ".codex/fake-state.json");
  const appPath = join(home, "Claude.app");
  if (over.desktopApp) mkdirSync(appPath);
  const deps: ConnectDeps = {
    home,
    desktopApps: [appPath],
    hasCommand: (b) => (b === "codex" ? over.codex !== false : over.claude !== false),
    exec: (bin, args) => {
      calls.push(`${bin} ${args.join(" ")}`);
      const ok = (stdout = "") => ({ ok: true, stdout, stderr: "" });
      if (bin === "claude") {
        if (over.addFails && args[1] === "add") return { ok: false, stdout: "", stderr: "boom\n" };
        const d = json(claudeFile);
        d.mcpServers ??= {};
        if (args[1] === "add") d.mcpServers[args[4]!] = { type: "stdio", command: args[6], args: args.slice(7), env: {} };
        else delete d.mcpServers[args[4]!];
        put(claudeFile, JSON.stringify(d));
        return ok();
      }
      if (over.codexRaw !== undefined && args[1] === "get") return ok(over.codexRaw);
      const d = json(codexState) as Record<string, { command: string; args: string[] }>;
      if (args[1] === "get") {
        const e = d[args[2]!];
        return e ? ok(JSON.stringify({ name: args[2], transport: { type: "stdio", ...e } })) : { ok: false, stdout: `Error: No MCP server named '${args[2]}' found.\n`, stderr: "" };
      }
      if (over.addFails && args[1] === "add") return { ok: false, stdout: "", stderr: "boom\n" };
      if (args[1] === "add") d[args[2]!] = { command: args[4]!, args: args.slice(5) }; else delete d[args[2]!];
      put(codexState, JSON.stringify(d));
      return ok();
    },
  };
  const files: Record<ClientId, string> = { "claude-desktop": settingsFile("claude-desktop", home), "claude-code": claudeFile, codex: codexState };
  const mutating = () => calls.filter((c) => / (add|remove)\b/.test(c));
  return { home, deps, calls, files, mutating };
}

const repoMain = (root: string) => join(root, "packages/mcp/src/main.ts");
const mkMain = () => { const root = tmp(); put(repoMain(root), "//"); return root; };
const cmdOf = (root: string): ServerCommand => ({ command: "node", args: [repoMain(root)] });
const seedEntry = (client: ClientId, s: ReturnType<typeof setup>, name: string, e: ServerCommand, extra: Record<string, unknown> = {}) => {
  if (client === "codex") put(s.files.codex, JSON.stringify({ [name]: e }));
  else put(s.files[client], JSON.stringify({ ...extra, mcpServers: { other: { command: "x", args: ["y"] }, [name]: e } }, null, 2));
};

describe("client status states", () => {
  it("not_installed for each client without its binary or app", () => {
    const s = setup({ claude: false, codex: false });
    const cmd = cmdOf(mkMain());
    for (const c of CLIENTS) expect(status(c, cmd, s.deps).state).toBe("not_installed");
  });
  it("desktop is installed by the app bundle or by the settings file", () => {
    const cmd = cmdOf(mkMain());
    expect(status("claude-desktop", cmd, setup({ desktopApp: true }).deps).state).toBe("not_connected");
    const s = setup();
    put(s.files["claude-desktop"], "{}");
    expect(status("claude-desktop", cmd, s.deps).state).toBe("not_connected");
  });
  for (const c of CLIENTS) {
    it(`${c}: not_connected, connected and files untouched by status`, () => {
      const s = setup({ desktopApp: true });
      const cmd = cmdOf(mkMain());
      expect(status(c, cmd, s.deps)).toMatchObject({ state: "not_connected", file: settingsFile(c, s.home) });
      expect(existsSync(s.files[c])).toBe(false);
      seedEntry(c, s, "osen", cmd);
      const before = read(s.files[c]);
      const st = status(c, cmd, s.deps);
      expect(st.state).toBe("connected");
      expect(st.entry).toEqual(cmd);
      expect(read(s.files[c])).toBe(before);
      expect(s.mutating()).toEqual([]);
    });
    it(`${c}: foreign entry for another server`, () => {
      const s = setup({ desktopApp: true });
      seedEntry(c, s, "osen", { command: "npx", args: ["-y", "other-mcp"] });
      const before = read(s.files[c]);
      expect(status(c, cmdOf(mkMain()), s.deps).state).toBe("foreign");
      expect(read(s.files[c])).toBe(before);
    });
    it(`${c}: another repo copy with an existing main.ts is foreign, a missing launcher is stale_path`, () => {
      const s = setup({ desktopApp: true });
      const other = mkMain();
      seedEntry(c, s, "osen", cmdOf(other));
      expect(status(c, cmdOf(mkMain()), s.deps).state).toBe("foreign");
      const fresh = cmdOf(other);
      seedEntry(c, s, "osen", { command: "/nonexistent/node", args: fresh.args });
      expect(status(c, fresh, s.deps).state).toBe("stale_path");
    });
    it(`${c}: a vanished server file of our form is stale_path, a vanished foreign path is foreign`, () => {
      const s = setup({ desktopApp: true });
      const cmd = cmdOf(mkMain());
      seedEntry(c, s, "osen", { command: "node", args: ["/gone/copy/packages/mcp/src/main.ts"] });
      expect(status(c, cmd, s.deps).state).toBe("stale_path");
      seedEntry(c, s, "osen", { command: "node", args: ["/другой/путь/main.ts"] });
      expect(status(c, cmd, s.deps).state).toBe("foreign");
    });
  }
  for (const c of ["claude-code", "claude-desktop"] as const) {
    it(`${c}: corrupt for parse and shape errors`, () => {
      const s = setup({ desktopApp: true });
      const cmd = cmdOf(mkMain());
      for (const [text, code] of [["{not json", "parse"], ["[]", "shape"], ["null", "shape"], ['{"mcpServers": []}', "shape"]] as const) {
        put(s.files[c], text);
        expect(status(c, cmd, s.deps)).toMatchObject({ state: "corrupt", reason: { code } });
        expect(read(s.files[c])).toBe(text);
      }
    });
  }
  it("codex: unclear CLI answer is corrupt codex_unclear", () => {
    const s = setup({ codexRaw: "something odd" });
    expect(status("codex", cmdOf(mkMain()), s.deps)).toMatchObject({ state: "corrupt", reason: { code: "codex_unclear", detail: "something odd" } });
  });
  it("desktop: empty and whitespace-only file counts as {}", () => {
    const s = setup();
    for (const t of ["", "  \n\t"]) {
      put(s.files["claude-desktop"], t);
      expect(status("claude-desktop", cmdOf(mkMain()), s.deps).state).toBe("not_connected");
    }
  });
  it("unreadable settings file is corrupt unreadable and connect refuses", () => {
    for (const c of ["claude-desktop", "claude-code"] as const) {
      const s = setup();
      put(s.files[c], '{"a":1}');
      chmodSync(s.files[c], 0);
      try {
        const cmd = cmdOf(mkMain());
        expect(status(c, cmd, s.deps)).toMatchObject({ state: "corrupt", reason: { code: "unreadable" } });
        expect(connect(c, cmd, s.deps)).toMatchObject({ ok: false, refusal: "corrupt" });
      } finally { chmodSync(s.files[c], 0o644); }
      expect(read(s.files[c])).toBe('{"a":1}');
    }
  });
  it("file and skills locations", () => {
    expect(settingsFile("codex", "/h")).toBe("/h/.codex/config.toml");
    expect(settingsFile("claude-code", "/h")).toBe("/h/.claude.json");
    expect(settingsFile("claude-desktop", "/h")).toBe("/h/Library/Application Support/Claude/claude_desktop_config.json");
    expect(skillsDir("claude-desktop", "/h")).toBeNull();
    expect(skillsDir("codex", "/h")).toBe("/h/.codex/skills");
    expect(skillsDir("claude-code", "/h")).toBe("/h/.claude/skills");
    expect(desktopApps("/h")).toEqual(["/Applications/Claude.app", "/h/Applications/Claude.app"]);
  });
});

describe("connect, update and disconnect", () => {
  for (const c of CLIENTS) {
    it(`${c}: connect from the repo writes node + main.ts, repeat is a no-op, need follows the client`, () => {
      const s = setup({ desktopApp: true });
      const cmd = cmdOf(mkMain());
      const r = connect(c, cmd, s.deps);
      expect(r).toMatchObject({ ok: true, changed: true, state: "connected", need: NEED[c] });
      expect(status(c, cmd, s.deps).entry).toEqual(cmd);
      const before = read(s.files[c]);
      expect(connect(c, cmd, s.deps)).toMatchObject({ ok: true, changed: false, need: "none" });
      expect(read(s.files[c])).toBe(before);
      expect(s.mutating().length).toBe(c === "claude-desktop" ? 0 : 1);
    });
    it(`${c}: connect from the app writes the wrapper alone, no node`, () => {
      const s = setup({ desktopApp: true });
      const cmd: ServerCommand = { command: join(tmp(), "Osen.app/Contents/Resources/bin/osen-mcp"), args: [] };
      expect(connect(c, cmd, s.deps).ok).toBe(true);
      expect(status(c, cmd, s.deps)).toMatchObject({ state: "connected", entry: cmd });
      expect(read(s.files[c])).not.toContain("node");
    });
    it(`${c}: dryRun changes nothing and calls no add or remove`, () => {
      const s = setup({ desktopApp: true });
      const cmd = cmdOf(mkMain());
      expect(connect(c, cmd, s.deps, { dryRun: true })).toMatchObject({ ok: true, changed: true, state: "connected" });
      expect(existsSync(s.files[c])).toBe(false);
      connect(c, cmd, s.deps);
      const stale = { command: "/nonexistent/node", args: cmd.args };
      seedEntry(c, s, "osen", stale);
      const before = read(s.files[c]);
      s.calls.length = 0;
      expect(update(c, cmd, s.deps, { dryRun: true })).toMatchObject({ ok: true, changed: true });
      expect(disconnect(c, cmd, s.deps, { dryRun: true })).toMatchObject({ ok: true, changed: true, state: "not_connected" });
      expect(read(s.files[c])).toBe(before);
      expect(s.mutating()).toEqual([]);
    });
    it(`${c}: update replaces a stale entry, keeps the rest, repeat is a no-op`, () => {
      const s = setup({ desktopApp: true });
      const cmd = cmdOf(mkMain());
      seedEntry(c, s, "osen", { command: "/nonexistent/node", args: cmd.args });
      expect(update(c, cmd, s.deps)).toMatchObject({ ok: true, changed: true, state: "connected" });
      expect(status(c, cmd, s.deps).state).toBe("connected");
      if (c !== "codex") expect(json(s.files[c]).mcpServers.other).toEqual({ command: "x", args: ["y"] });
      expect(update(c, cmd, s.deps)).toMatchObject({ ok: true, changed: false, need: "none" });
    });
    it(`${c}: update, connect and disconnect refuse a foreign entry and change nothing`, () => {
      const s = setup({ desktopApp: true });
      seedEntry(c, s, "osen", { command: "npx", args: ["other"] });
      const before = read(s.files[c]);
      const cmd = cmdOf(mkMain());
      for (const f of [update, connect, disconnect]) expect(f(c, cmd, s.deps)).toMatchObject({ ok: false, refusal: "foreign", entry: { command: "npx" } });
      expect(read(s.files[c])).toBe(before);
      expect(s.mutating()).toEqual([]);
    });
    it(`${c}: connect on stale_path refuses with stale_path, update on not_connected refuses`, () => {
      const s = setup({ desktopApp: true });
      const cmd = cmdOf(mkMain());
      expect(update(c, cmd, s.deps)).toMatchObject({ ok: false, refusal: "not_connected" });
      seedEntry(c, s, "osen", { command: "/nonexistent/node", args: cmd.args });
      const before = read(s.files[c]);
      expect(connect(c, cmd, s.deps)).toMatchObject({ ok: false, refusal: "stale_path", state: "stale_path" });
      expect(read(s.files[c])).toBe(before);
    });
    it(`${c}: disconnect removes our entry, not_connected is a no-op`, () => {
      const s = setup({ desktopApp: true });
      const cmd = cmdOf(mkMain());
      expect(disconnect(c, cmd, s.deps)).toMatchObject({ ok: true, changed: false, need: "none", state: "not_connected" });
      connect(c, cmd, s.deps);
      expect(disconnect(c, cmd, s.deps)).toMatchObject({ ok: true, changed: true, state: "not_connected" });
      expect(status(c, cmd, s.deps).state).toBe("not_connected");
    });
    it(`${c}: not_installed and corrupt are refusals`, () => {
      const cmd = cmdOf(mkMain());
      const s = setup({ claude: false, codex: false });
      expect(connect(c, cmd, s.deps)).toMatchObject({ ok: false, refusal: "not_installed" });
      expect(existsSync(s.files[c])).toBe(false);
    });
  }
  it("claude-code and codex use the documented CLI commands", () => {
    const cmd = cmdOf(mkMain());
    const a = setup(); connect("claude-code", cmd, a.deps); disconnect("claude-code", cmd, a.deps);
    expect(a.mutating()).toEqual([`claude mcp add --scope user osen -- node ${cmd.args[0]}`, "claude mcp remove --scope user osen"]);
    const b = setup(); connect("codex", cmd, b.deps); disconnect("codex", cmd, b.deps);
    expect(b.mutating()).toEqual([`codex mcp add osen -- node ${cmd.args[0]}`, "codex mcp remove osen"]);
  });
  it("custom entry name is used", () => {
    const s = setup();
    const cmd = cmdOf(mkMain());
    connect("claude-code", cmd, s.deps, { name: "model-council" });
    expect(Object.keys(json(s.files["claude-code"]).mcpServers)).toEqual(["model-council"]);
    expect(status("claude-code", cmd, s.deps).state).toBe("not_connected");
  });
  it("failed CLI add is a failed refusal with reason cli and re-read state", () => {
    for (const c of ["claude-code", "codex"] as const) {
      const s = setup({ addFails: true });
      expect(connect(c, cmdOf(mkMain()), s.deps)).toMatchObject({ ok: false, refusal: "failed", state: "not_connected", reason: { code: "cli", detail: "boom" } });
    }
  });
  it("desktop: foreign keys and servers are kept, a missing file is created", () => {
    const s = setup({ desktopApp: true });
    const cmd = cmdOf(mkMain());
    expect(connect("claude-desktop", cmd, s.deps)).toMatchObject({ ok: true, need: "restart_client" });
    expect(json(s.files["claude-desktop"])).toEqual({ mcpServers: { osen: { command: "node", args: cmd.args } } });
    const orig = { preferences: { a: [1, null] }, mcpServers: { fs: { command: "npx", args: ["x"], env: { K: "v" } } } };
    put(s.files["claude-desktop"], JSON.stringify(orig));
    connect("claude-desktop", cmd, s.deps);
    expect(json(s.files["claude-desktop"]).mcpServers.fs).toEqual(orig.mcpServers.fs);
    expect(json(s.files["claude-desktop"]).preferences).toEqual(orig.preferences);
    disconnect("claude-desktop", cmd, s.deps);
    expect(json(s.files["claude-desktop"])).toEqual(orig);
  });
  it("Пустой mcpServers: connect then disconnect keeps x and other servers, mcpServers empty or absent", () => {
    const cmd = cmdOf(mkMain());
    for (const orig of ['{"x":1,"mcpServers":{}}', '{"x":1}', '{"x":1,"mcpServers":{"fs":{"command":"npx","args":["y"]}}}']) {
      const s = setup({ desktopApp: true });
      put(s.files["claude-desktop"], orig);
      expect(connect("claude-desktop", cmd, s.deps)).toMatchObject({ ok: true, changed: true });
      expect(disconnect("claude-desktop", cmd, s.deps)).toMatchObject({ ok: true, changed: true });
      const { mcpServers = {}, ...rest } = json(s.files["claude-desktop"]);
      const { mcpServers: before = {}, ...restBefore } = JSON.parse(orig);
      expect(rest).toEqual(restBefore);
      expect(mcpServers).toEqual(before);
    }
  });
  it("desktop: corrupt file is a refusal and stays byte-identical", () => {
    const s = setup();
    put(s.files["claude-desktop"], "{oops");
    expect(connect("claude-desktop", cmdOf(mkMain()), s.deps)).toMatchObject({ ok: false, refusal: "corrupt", reason: { code: "parse" } });
    expect(read(s.files["claude-desktop"])).toBe("{oops");
  });
  it("desktop: write failure is failed write, leaves no tmp file and the config byte-identical", () => {
    const s = setup();
    const f = s.files["claude-desktop"];
    put(f, '{"a": 1}');
    chmodSync(dirname(f), 0o555);
    try {
      expect(connect("claude-desktop", cmdOf(mkMain()), s.deps)).toMatchObject({ ok: false, refusal: "failed", reason: { code: "write" } });
    } finally { chmodSync(dirname(f), 0o755); }
    expect(readdirSync(dirname(f))).toEqual([f.split("/").pop()]);
    expect(read(f)).toBe('{"a": 1}');
  });
});
