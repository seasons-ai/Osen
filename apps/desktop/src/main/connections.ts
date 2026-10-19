import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { CLIENTS, checkConnection, connect, desktopApps, disconnect, settingsFile, status, update } from "@model-council/connect";
import type { Bin, CheckResult, ClientId, ConnectDeps, ServerCommand } from "@model-council/connect";
import type { Logger } from "@model-council/core";
import type { Language } from "@model-council/core/i18n";
import type { ClientActionReply, ClientStatusView, CommandActionReply, CommandStatusView, ConnectionsView, InstallResult, RemoveResult } from "../shared/connections.ts";
import { shell } from "../shared/messages/shell.ts";
import { LINK_HINT_LINE, commandStatus, installCommand, removeCommand } from "./command-install.ts";

const run = promisify(execFile);
const MARK = "__OSEN_PATH__";
// An executable that cannot exist: module 141 reports its own "no_wrapper" refusal for it.
const NO_WRAPPER = "/nonexistent/Osen.app/Contents/Resources/bin/council";

export interface ConnectionsOptions {
  home: string;
  env: Record<string, string | undefined>;
  serverCommand: ServerCommand | null; // what main writes into a client; null — the packaged wrapper is missing
  councilWrapper: string | null;       // target of the council link; null — module 141 refuses with no_wrapper
  logger: Logger;
  desktopApps?: string[];
  shell?: string;
  timeoutMs?: number;
  language?: () => Language;
  deps?: Partial<Pick<ConnectDeps, "hasCommand" | "exec">>; // test seam
}

export type ConnectionsApi = ReturnType<typeof createConnections>;

/** An unknown client id arrived from the window. Already logged by the module; the bridge must not log it again. */
export class UnknownClientError extends Error {}

type Action = "connect" | "update" | "disconnect";
const ACTIONS = { connect, update, disconnect };
// Status needs a command to classify an entry; without a server command nothing can be called "connected".
const NO_COMMAND: ServerCommand = { command: "", args: [] };

export function createConnections(o: ConnectionsOptions) {
  const { home, logger } = o;
  const apps = o.desktopApps ?? desktopApps(home);

  // The owner's login-shell PATH, then the process PATH: a Finder launch has a minimal PATH. One probe per call.
  const mergedPath = async (): Promise<string> => {
    let shellPath = "";
    try {
      const env: Record<string, string | undefined> = { ...o.env, HOME: home };
      const pending = run(o.shell ?? (env.SHELL || "/bin/zsh"), ["-ilc", `printf '\\n${MARK}%s${MARK}\\n' "$PATH"`], { env: env as NodeJS.ProcessEnv, timeout: o.timeoutMs ?? 5_000 });
      pending.child.stdin?.end();
      shellPath = (await pending).stdout.match(new RegExp(`${MARK}(.*?)${MARK}`))?.[1] ?? "";
    } catch {
      shellPath = ""; // fall back to the process PATH
    }
    return [...new Set([...shellPath.split(delimiter), ...(o.env.PATH ?? "").split(delimiter)].filter(Boolean))].join(delimiter);
  };

  const makeDeps = async (): Promise<{ deps: ConnectDeps; path: string }> => {
    const path = await mergedPath();
    const find = (bin: string): string | null => {
      for (const d of path.split(delimiter)) {
        const p = join(d, bin);
        try { accessSync(p, constants.X_OK); return p; } catch { /* next */ }
      }
      return null;
    };
    const deps: ConnectDeps = {
      home,
      desktopApps: apps,
      hasCommand: o.deps?.hasCommand ?? ((bin: Bin) => find(bin) !== null),
      exec: o.deps?.exec ?? ((bin, args) => {
        const abs = find(bin);
        if (!abs) return { ok: false, stdout: "", stderr: `${bin}: not found in PATH` };
        try {
          const stdout = execFileSync(abs, args, { env: { ...o.env, HOME: home, PATH: path } as NodeJS.ProcessEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
          return { ok: true, stdout, stderr: "" };
        } catch (e) {
          const x = e as { stdout?: string; stderr?: string; message: string };
          return { ok: false, stdout: String(x.stdout ?? ""), stderr: String(x.stderr ?? x.message) };
        }
      }),
    };
    return { deps, path };
  };

  const commandOptions = () => ({ home, wrapper: o.councilWrapper ?? NO_WRAPPER, env: o.env, ...(o.shell ? { shell: o.shell } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...(o.language ? { language: o.language() } : {}) });

  const clientView = (id: ClientId, deps: ConnectDeps): ClientStatusView => {
    const file = settingsFile(id, home);
    const entryKey = file.endsWith(".toml") ? "mcp_servers.osen" : "mcpServers.osen";
    try {
      const s = status(id, o.serverCommand ?? NO_COMMAND, deps);
      return { client: id, state: s.state, file: s.file, entryKey, entry: s.entry ?? null, reason: s.reason ?? null };
    } catch (e) {
      return { client: id, state: "error", file, entryKey, entry: null, reason: { code: "exception", detail: e instanceof Error ? e.message : String(e) } };
    }
  };

  const viewWith = async (deps: ConnectDeps): Promise<ConnectionsView> => {
    let command: CommandStatusView;
    try {
      command = await commandStatus(commandOptions());
    } catch (e) {
      command = { state: "error", link: join(home, ".local", "bin", "council"), reason: e instanceof Error ? e.message : String(e) };
    }
    return { clients: CLIENTS.map((id) => clientView(id, deps)), command, serverCommand: o.serverCommand };
  };

  const view = async (): Promise<ConnectionsView> => viewWith((await makeDeps()).deps);

  const known = (id: unknown, action: string): ClientId => {
    if (typeof id === "string" && (CLIENTS as readonly string[]).includes(id)) return id as ClientId;
    logger.error(`Connections: refused ${action} for unknown client ${JSON.stringify(id)}`.slice(0, 100));
    throw new UnknownClientError(shell().connectionClientUnknown(String(id).slice(0, 40)));
  };

  const act = (action: Action) => async (raw: unknown): Promise<ClientActionReply> => {
    const id = known(raw, action);
    const { deps } = await makeDeps();
    let result: ClientActionReply["result"];
    if (!o.serverCommand) {
      result = { ok: false, client: id, refusal: "no_server_command", state: clientView(id, deps).state };
    } else {
      result = ACTIONS[action](id, o.serverCommand, deps);
    }
    const code = !result.ok && "reason" in result && result.reason ? ` reason=${result.reason.code}` : "";
    logger.info(`Connections: ${action} ${id} -> ${result.ok ? `ok changed=${result.changed} state=${result.state}` : `refused ${result.refusal} state=${result.state}${code}`}`);
    return { result, view: await viewWith(deps) };
  };

  return {
    view,
    connect: act("connect"),
    update: act("update"),
    disconnect: act("disconnect"),
    async check(raw: unknown): Promise<CheckResult> {
      const id = known(raw, "check");
      const { deps, path } = await makeDeps();
      // the RECORDED command is checked, not the one main would write
      const entry = status(id, o.serverCommand ?? NO_COMMAND, deps).entry ?? null;
      const r = await checkConnection(entry, { extraEnv: { PATH: path } });
      logger.info(`Connections: check ${id} -> ${r.ok ? `ok tools=${r.tools.length} ms=${r.durationMs}` : `${r.reason} ms=${r.durationMs}`}`);
      return r;
    },
    async installCommand(): Promise<CommandActionReply<InstallResult>> {
      const result = await installCommand(commandOptions());
      logger.info(`Connections: install council command -> ${result.ok ? `ok changed=${result.changed} state=${result.status.state}` : `refused ${result.code}`}`);
      return { result, view: await view() };
    },
    async removeCommand(): Promise<CommandActionReply<RemoveResult>> {
      const result = removeCommand(commandOptions());
      logger.info(`Connections: remove council command -> ${result.ok ? `ok removed=${result.removed}` : `refused ${result.code}`}`);
      return { result, view: await view() };
    },
    zprofileLine: (): string => LINK_HINT_LINE,
  };
}
