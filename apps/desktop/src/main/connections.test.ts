import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnections, UnknownClientError } from "./connections.ts";
import type { ConnectionsOptions } from "./connections.ts";

let root: string;
let home: string;
let app: string;
const SERVER = { command: "/opt/node", args: ["/opt/Osen.app/Contents/Resources/bin/osen-mcp"] };
const desktopFile = () => join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osen-conn-"));
  home = join(root, "home");
  app = join(root, "Claude.app");
  mkdirSync(home);
  mkdirSync(app);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// every file under the fake HOME with its mtime and bytes
function snapshot(dir: string, out: Record<string, string> = {}): Record<string, string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) snapshot(p, out);
    else out[p] = `${statSync(p).mtimeMs}:${readFileSync(p, "utf8")}`;
  }
  return out;
}

function make(over: Partial<ConnectionsOptions> = {}) {
  const lines: string[] = [];
  const logger = { info: (m: string) => void lines.push(m), error: (m: string) => void lines.push(m) };
  const api = createConnections({
    home, env: { PATH: "/usr/bin:/bin", OSEN_TEST_SECRET: "s3cr3t" }, serverCommand: SERVER, councilWrapper: null, logger,
    desktopApps: [app], shell: "/bin/sh",
    deps: { hasCommand: () => false, exec: () => ({ ok: false, stdout: "", stderr: "" }) },
    ...over,
  });
  return { api, lines };
}

describe("connections", () => {
  it.each([["nope"], [5], [null], [{ command: "/evil" }], ["__proto__"]])("unknown client %j is refused with one log line and no file changed", async (id) => {
    const { api, lines } = make();
    writeFileSync(join(home, ".keep"), "x");
    const before = snapshot(home);
    for (const f of [api.connect, api.update, api.disconnect, api.check]) await expect(f(id)).rejects.toBeInstanceOf(UnknownClientError);
    expect(lines.filter((l) => l.startsWith("Connections: refused"))).toHaveLength(4);
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.length <= 100)).toBe(true);
    expect(snapshot(home)).toEqual(before);
  });

  it("a single refusal logs exactly one line", async () => {
    const { api, lines } = make();
    await expect(api.connect("nope")).rejects.toThrow("Неизвестный клиент");
    expect(lines).toEqual(['Connections: refused connect for unknown client "nope"']);
  });

  it("extra arguments and fields are ignored: the entry equals the server command", async () => {
    const { api } = make();
    const connect = api.connect as (id: unknown, ...x: unknown[]) => ReturnType<typeof api.connect>;
    const r = await connect("claude-desktop", { command: "/evil", args: ["x"] }, "/etc/passwd");
    expect(r.result).toMatchObject({ ok: true, changed: true, state: "connected" });
    expect(JSON.parse(readFileSync(desktopFile(), "utf8"))).toEqual({ mcpServers: { osen: SERVER } });
    expect(r.view.clients.find((c) => c.client === "claude-desktop")).toMatchObject({ state: "connected", entry: SERVER, entryKey: "mcpServers.osen" });
  });

  it("view() writes nothing", async () => {
    mkdirSync(join(home, "Library", "Application Support", "Claude"), { recursive: true });
    writeFileSync(desktopFile(), '{"mcpServers":{"other":{"command":"x"}}}');
    const before = snapshot(home);
    const { api } = make();
    const v = await api.view();
    expect(v.clients.map((c) => c.client)).toEqual(["claude-desktop", "claude-code", "codex"]);
    expect(v.clients[0]).toMatchObject({ state: "not_connected", reason: null });
    expect(v.command.state).toBe("not_installed");
    expect(snapshot(home)).toEqual(before);
  });

  it("without a server command nothing is written and the refusal carries the current state", async () => {
    const { api, lines } = make({ serverCommand: null });
    const r = await api.connect("claude-desktop");
    expect(r.result).toEqual({ ok: false, client: "claude-desktop", refusal: "no_server_command", state: "not_connected" });
    expect(r.view.serverCommand).toBeNull();
    expect(() => readFileSync(desktopFile())).toThrow();
    expect(lines).toEqual(["Connections: connect claude-desktop -> refused no_server_command state=not_connected"]);
  });

  it("a throwing status becomes the error state of that row only", async () => {
    const { api } = make({ deps: { hasCommand: (b) => { if (b === "claude") throw new Error("boom"); return false; }, exec: () => ({ ok: false, stdout: "", stderr: "" }) } });
    const v = await api.view();
    expect(v.clients.map((c) => c.state)).toEqual(["not_connected", "error", "not_installed"]);
    expect(v.clients[1]).toMatchObject({ entry: null, reason: { code: "exception", detail: "boom" } });
    expect(v.clients[2]!.entryKey).toBe("mcp_servers.osen");
  });

  it("check uses the recorded entry, not the server command, and writes nothing", async () => {
    mkdirSync(join(home, "Library", "Application Support", "Claude"), { recursive: true });
    writeFileSync(desktopFile(), JSON.stringify({ mcpServers: { osen: { command: "/no/such/node", args: ["/no/such/bin/osen-mcp"] } } }));
    const before = snapshot(home);
    const { api, lines } = make();
    const r = await api.check("claude-desktop");
    expect(r).toMatchObject({ ok: false, reason: "spawn_failed" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Connections: check claude-desktop -> spawn_failed ms=\d+$/);
    expect(snapshot(home)).toEqual(before);
  });

  it("check without a recorded entry reports no_entry", async () => {
    expect(await make().api.check("claude-desktop")).toMatchObject({ ok: false, reason: "no_entry" });
  });

  it("no environment value reaches the log", async () => {
    const { api, lines } = make();
    await api.view();
    await api.connect("claude-desktop");
    await api.check("claude-desktop");
    await api.disconnect("claude-desktop");
    await api.installCommand();
    await api.removeCommand();
    expect(lines.length).toBeGreaterThan(4);
    expect(lines.join("\n")).not.toContain("s3cr3t");
  });

  it("install without a wrapper is refused by module 141 and creates no link", async () => {
    const { api } = make();
    const r = await api.installCommand();
    expect(r.result).toMatchObject({ ok: false, code: "no_wrapper" });
    expect(r.view.command.state).toBe("not_installed");
    expect(() => statSync(join(home, ".local"))).toThrow();
  });

  it("zprofileLine is the module's hint line", () => {
    expect(make().api.zprofileLine()).toBe('export PATH="$HOME/.local/bin:$PATH"');
  });

  it("logs one line per action", async () => {
    const { api, lines } = make();
    await api.connect("claude-desktop");
    await api.connect("claude-desktop");
    expect(lines).toEqual(["Connections: connect claude-desktop -> ok changed=true state=connected", "Connections: connect claude-desktop -> ok changed=false state=connected"]);
  });
  it("Клиент отвечает долго: a slow codex does not block the event loop", async () => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const stub = join(bin, "codex");
    writeFileSync(stub, `#!/bin/sh\nsleep 0.3\nprintf '%s' '{"name":"osen","transport":{"type":"stdio","command":"x","args":["y"]}}'\n`);
    chmodSync(stub, 0o755);
    const { api } = make({ env: { PATH: `${bin}:/usr/bin:/bin` }, shell: "/usr/bin/false", deps: undefined }) // no login-shell PATH: only the stub codex can be found;
    let last = Date.now();
    let maxGap = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 20);
    let v: Awaited<ReturnType<typeof api.view>>;
    try {
      v = await api.view();
      // a blocked loop never ran the overdue tick, so count the open gap too
      maxGap = Math.max(maxGap, Date.now() - last);
    } finally {
      clearInterval(timer);
    }
    expect(v.clients.find((c) => c.client === "codex")).toMatchObject({ state: "foreign" });
    expect(maxGap).toBeLessThan(150);
  });

  it("a view requested during an action reads the state after the action", async () => {
    let transport: { type: string; command: string; args: string[] } | null = null;
    const sleep = () => new Promise<void>((r) => setTimeout(r, 60));
    const exec = async (bin: string, args: string[]) => {
      await sleep();
      if (bin !== "codex") return { ok: false, stdout: "", stderr: "" };
      if (args[0] === "mcp" && args[1] === "get") {
        return transport ? { ok: true, stdout: JSON.stringify({ name: "osen", transport }), stderr: "" } : { ok: false, stdout: "", stderr: "Error: No MCP server named 'osen' found." };
      }
      if (args[1] === "add") { const [command = "", ...rest] = args.slice(4); transport = { type: "stdio", command, args: rest }; }
      if (args[1] === "remove") transport = null;
      return { ok: true, stdout: "", stderr: "" };
    };
    const { api } = make({ deps: { hasCommand: (bin: string) => bin === "codex", exec } as ConnectionsOptions["deps"] });
    const action = api.connect("codex");
    await new Promise((r) => setTimeout(r, 10));
    const [, v] = await Promise.all([action, api.view()]);
    expect(v.clients.find((c) => c.client === "codex")?.state).toBe("connected");
  });
});
