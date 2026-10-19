// Connections tab contract (change 142): main reports the modules' own codes, the window draws texts from the catalog.
import type { ActionResult, CheckResult, ClientAction, ClientId, Reason, ServerCommand, State } from "@model-council/connect";
import type { CommandState, InstallResult, RemoveResult } from "../main/command-install.ts";

export type { ActionResult, CheckResult, ClientAction, ClientId, CommandState, InstallResult, RemoveResult, ServerCommand };

/** One client as main reports it: the module's status, or the exception text when the module threw. */
export type ClientStatusView =
  | { client: ClientId; state: State; file: string; entryKey: string; entry: ServerCommand | null; reason: Reason | null }
  | { client: ClientId; state: "error"; file: string; entryKey: string; entry: null; reason: { code: "exception"; detail: string } };

/** The council command row: the state of change 141, or the exception text when the state could not be read. */
export type CommandStatusView = CommandState | { state: "error"; link: string; reason: string };

export interface ConnectionsView {
  clients: ClientStatusView[]; // in the module's order
  command: CommandStatusView;
  serverCommand: ServerCommand | null; // what main writes into a client; null — the packaged wrapper is missing
}

export type ClientActionRefusal = { ok: false; client: string; refusal: "no_server_command"; state: ClientStatusView["state"] };

export interface ClientActionReply { result: ActionResult | ClientActionRefusal; view: ConnectionsView }
export interface CommandActionReply<R> { result: R; view: ConnectionsView }
