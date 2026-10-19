import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ActionOptions, ActionResult, ClientAction, ClientId, ConnectDeps, Reason, ServerCommand, State, Status } from "./types.ts";

export const CLIENTS: readonly ClientId[] = ["claude-desktop", "claude-code", "codex"];
// the Codex app shares Codex CLI's config.toml, so it is not a separate client
export const NEED: Record<ClientId, ClientAction> = { "claude-desktop": "restart_client", "claude-code": "unverified", codex: "restart_client" };

export function settingsFile(client: ClientId, home: string): string {
  if (client === "claude-desktop") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return client === "claude-code" ? join(home, ".claude.json") : join(home, ".codex", "config.toml");
}

export function skillsDir(client: ClientId, home: string): string | null {
  if (client === "claude-desktop") return null;
  return join(home, client === "claude-code" ? ".claude" : ".codex", "skills");
}

export function desktopApps(home: string): string[] {
  return ["/Applications/Claude.app", join(home, "Applications", "Claude.app")];
}

type Read = { kind: "none" } | { kind: "found"; entry: ServerCommand } | { kind: "corrupt"; reason: Reason };
type Doc = { kind: "ok"; obj: Record<string, unknown> } | { kind: "corrupt"; reason: Reason };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const toEntry = (e: Record<string, unknown>): ServerCommand => ({ command: String(e.command ?? ""), args: Array.isArray(e.args) ? e.args.map(String) : [] });

// JSON settings file; a missing file, and for the desktop an empty one, is `{}`
function readDoc(file: string, emptyIsObject: boolean): Doc {
  if (!existsSync(file)) return { kind: "ok", obj: {} };
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (e) { return { kind: "corrupt", reason: { code: "unreadable", detail: msg(e) } }; }
  if (emptyIsObject && text.trim() === "") return { kind: "ok", obj: {} };
  let v: unknown;
  try { v = JSON.parse(text); } catch (e) { return { kind: "corrupt", reason: { code: "parse", detail: msg(e) } }; }
  if (!isObj(v) || (v.mcpServers !== undefined && !isObj(v.mcpServers))) return { kind: "corrupt", reason: { code: "shape", detail: file } };
  return { kind: "ok", obj: v };
}

function readEntry(client: ClientId, deps: ConnectDeps, name: string): Read {
  if (client === "codex") {
    const r = deps.exec("codex", ["mcp", "get", name, "--json"]);
    try {
      const t = JSON.parse(r.stdout)?.transport;
      if (isObj(t)) return { kind: "found", entry: toEntry(t) };
    } catch { /* not JSON: the text is checked below */ }
    // "no entry" only on an explicit CLI answer: codex mcp add silently overwrites an existing entry
    const text = `${r.stdout}${r.stderr}`.trim();
    return text.includes("No MCP server named") ? { kind: "none" } : { kind: "corrupt", reason: { code: "codex_unclear", detail: text } };
  }
  const d = readDoc(settingsFile(client, deps.home), client === "claude-desktop");
  if (d.kind === "corrupt") return d;
  const e = (d.obj.mcpServers as Record<string, unknown> | undefined)?.[name];
  return isObj(e) ? { kind: "found", entry: toEntry(e) } : { kind: "none" };
}

const serverFile = (e: ServerCommand) => (e.args.length ? e.args[e.args.length - 1]! : e.command);
const ourForm = (f: string) => {
  const p = f.split("/");
  const tail = (...t: string[]) => p.length >= t.length && t.every((s, i) => p[p.length - t.length + i] === s);
  return tail("packages", "mcp", "src", "main.ts") || tail("bin", "osen-mcp");
};

function classify(e: ServerCommand, c: ServerCommand): State {
  if (e.command === c.command && e.args.length === c.args.length && e.args.every((a, i) => a === c.args[i])) return "connected";
  const f = serverFile(e);
  if (f === serverFile(c) || (ourForm(f) && !existsSync(f))) return "stale_path";
  return "foreign";
}

export function status(client: ClientId, cmd: ServerCommand, deps: ConnectDeps, opts: ActionOptions = {}): Status {
  const file = settingsFile(client, deps.home);
  const installed = client === "claude-desktop" ? existsSync(file) || deps.desktopApps.some((p) => existsSync(p)) : deps.hasCommand(client === "codex" ? "codex" : "claude");
  if (!installed) return { client, state: "not_installed", file };
  const r = readEntry(client, deps, opts.name ?? "osen");
  if (r.kind === "corrupt") return { client, state: "corrupt", file, reason: r.reason };
  if (r.kind === "none") return { client, state: "not_connected", file };
  return { client, state: classify(r.entry, cmd), file, entry: r.entry };
}

type Op = "add" | "replace" | "remove";
type Failure = { ok: false; reason: Reason };

// atomic write of the desktop file: tmp next to it, then rename; no tmp file survives
function writeDesktop(file: string, name: string, cmd: ServerCommand | null): Failure | null {
  const d = readDoc(file, true);
  if (d.kind === "corrupt") return { ok: false, reason: d.reason };
  const obj = d.obj;
  const servers = (obj.mcpServers ?? {}) as Record<string, unknown>;
  if (cmd) { servers[name] = { command: cmd.command, args: cmd.args }; obj.mcpServers = servers; }
  else {
    delete servers[name];
    // absent and {} mean the same to the client; dropping the key keeps connect + disconnect a round trip
    if (Object.keys(servers).length === 0) delete obj.mcpServers;
  }
  const tmp = `${file}.osen-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", existsSync(file) ? { mode: statSync(file).mode & 0o777 } : {});
    renameSync(tmp, file);
    return null;
  } catch (e) {
    rmSync(tmp, { force: true });
    return { ok: false, reason: { code: "write", detail: msg(e) } };
  }
}

function writeCli(client: ClientId, deps: ConnectDeps, name: string, op: Op, cmd: ServerCommand): Failure | null {
  const bin = client === "codex" ? "codex" : "claude";
  const rm = client === "codex" ? ["mcp", "remove", name] : ["mcp", "remove", "--scope", "user", name];
  const add = client === "codex" ? ["mcp", "add", name, "--", cmd.command, ...cmd.args] : ["mcp", "add", "--scope", "user", name, "--", cmd.command, ...cmd.args];
  for (const args of [...(op === "add" ? [] : [rm]), ...(op === "remove" ? [] : [add])]) {
    const r = deps.exec(bin, args);
    if (!r.ok) return { ok: false, reason: { code: "cli", detail: (r.stderr || r.stdout).trim() } };
  }
  return null;
}

function apply(client: ClientId, cmd: ServerCommand, deps: ConnectDeps, opts: ActionOptions, before: Status, op: Op): ActionResult {
  const name = opts.name ?? "osen";
  const { file } = before;
  const goal: State = op === "remove" ? "not_connected" : "connected";
  if (opts.dryRun) return { ok: true, client, file, changed: true, state: goal, need: NEED[client] };
  const f = client === "claude-desktop" ? writeDesktop(file, name, op === "remove" ? null : cmd) : writeCli(client, deps, name, op, cmd);
  const after = status(client, cmd, deps, opts);
  if (f) return { ok: false, client, file, refusal: "failed", state: after.state, ...(before.entry ? { entry: before.entry } : {}), reason: f.reason };
  if (after.state !== goal) return { ok: false, client, file, refusal: "failed", state: after.state, ...(after.entry ? { entry: after.entry } : {}), reason: { code: "verify", detail: file } };
  return { ok: true, client, file, changed: true, state: goal, need: NEED[client] };
}

function refuse(s: Status): ActionResult {
  return { ok: false, client: s.client, file: s.file, refusal: s.state as Exclude<State, "connected">, state: s.state, ...(s.entry ? { entry: s.entry } : {}), ...(s.reason ? { reason: s.reason } : {}) };
}
const same = (s: Status, state: State): ActionResult => ({ ok: true, client: s.client, file: s.file, changed: false, state, need: "none" });

export function connect(client: ClientId, cmd: ServerCommand, deps: ConnectDeps, opts: ActionOptions = {}): ActionResult {
  const s = status(client, cmd, deps, opts);
  if (s.state === "connected") return same(s, "connected");
  return s.state === "not_connected" ? apply(client, cmd, deps, opts, s, "add") : refuse(s);
}

export function update(client: ClientId, cmd: ServerCommand, deps: ConnectDeps, opts: ActionOptions = {}): ActionResult {
  const s = status(client, cmd, deps, opts);
  if (s.state === "connected") return same(s, "connected");
  return s.state === "stale_path" ? apply(client, cmd, deps, opts, s, "replace") : refuse(s);
}

export function disconnect(client: ClientId, cmd: ServerCommand, deps: ConnectDeps, opts: ActionOptions = {}): ActionResult {
  const s = status(client, cmd, deps, opts);
  if (s.state === "not_connected") return same(s, "not_connected");
  return s.state === "connected" || s.state === "stale_path" ? apply(client, cmd, deps, opts, s, "remove") : refuse(s);
}
