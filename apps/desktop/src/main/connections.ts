import { execFile } from "node:child_process";
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
      exec: o.deps?.exec ?? (async (bin, args) => {
        const abs = find(bin);
        if (!abs) return { ok: false, stdout: "", stderr: `${bin}: not found in PATH` };
        let timer: NodeJS.Timeout | undefined;
        try {
          const pending = run(abs, args, { env: { ...o.env, HOME: home, PATH: path } as NodeJS.ProcessEnv, encoding: "utf8", timeout: 20_000 });
          pending.child.stdin?.end();
          // execFile settles on the child's close: a CLI that ignores SIGTERM would hold the serial chain forever, so bound the wait
          const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), 21_000); timer.unref(); });
          const done = await Promise.race([pending, late]);
          if (!done) { pending.child.kill("SIGKILL"); pending.child.stdout?.destroy(); pending.child.stderr?.destroy(); pending.catch(() => {}); return { ok: false, stdout: "", stderr: `${bin}: no answer within 20 s` }; }
          return { ok: true, stdout: done.stdout, stderr: "" };
        } catch (e) {
          const x = e as { stdout?: string; stderr?: string; message: string; killed?: boolean; code?: unknown };
          // killed without an error code = the time limit (maxBuffer also kills, but sets a code); its output is empty: name the limit so the row has a reason
          return { ok: false, stdout: String(x.stdout ?? ""), stderr: x.killed && x.code == null ? `${bin}: no answer within 20 s` : String(x.stderr ?? x.message) };
        } finally { clearTimeout(timer); }
      }),
    };
    return { deps, path };
  };

  const commandOptions = () => ({ home, wrapper: o.councilWrapper ?? NO_WRAPPER, env: o.env, ...(o.shell ? { shell: o.shell } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...(o.language ? { language: o.language() } : {}) });

  const clientView = async (id: ClientId, deps: ConnectDeps): Promise<ClientStatusView> => {
    const file = settingsFile(id, home);
    const entryKey = file.endsWith(".toml") ? "mcp_servers.osen" : "mcpServers.osen";
    try {
      const s = await status(id, o.serverCommand ?? NO_COMMAND, deps);
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
    return { clients: await Promise.all(CLIENTS.map((id) => clientView(id, deps))), command, serverCommand: o.serverCommand };
  };

  // view and client actions run one at a time, so a view never reads the state before a running action wrote it.
  // A failed operation rejects its own caller only; the chain keeps going.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  const view = (): Promise<ConnectionsView> => serial(async () => viewWith((await makeDeps()).deps));

  const known = (id: unknown, action: string): ClientId => {
    if (typeof id === "string" && (CLIENTS as readonly string[]).includes(id)) return id as ClientId;
    logger.error(`Connections: refused ${action} for unknown client ${JSON.stringify(id)}`.slice(0, 100));
    throw new UnknownClientError(shell().connectionClientUnknown(String(id).slice(0, 40)));
  };

  const act = (action: Action) => async (raw: unknown): Promise<ClientActionReply> => {
    const id = known(raw, action);
    return serial(async () => {
      const { deps } = await makeDeps();
      let result: ClientActionReply["result"];
      if (!o.serverCommand) {
        result = { ok: false, client: id, refusal: "no_server_command", state: (await clientView(id, deps)).state };
      } else {
        result = await ACTIONS[action](id, o.serverCommand, deps);
      }
      const code = !result.ok && "reason" in result && result.reason ? ` reason=${result.reason.code}` : "";
      logger.info(`Connections: ${action} ${id} -> ${result.ok ? `ok changed=${result.changed} state=${result.state}` : `refused ${result.refusal} state=${result.state}${code}`}`);
      return { result, view: await viewWith(deps) };
    });
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
      const entry = (await status(id, o.serverCommand ?? NO_COMMAND, deps)).entry ?? null;
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
