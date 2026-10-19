import type { ActionResult, ClientStatusView, CommandStatusView } from "../../shared/connections.ts";

// Pure view model of the Connections tab: rows and buttons come from the module's codes, texts from the catalog.

export type RowKind = "not_installed" | "not_connected" | "connected" | "foreign" | "stale_path" | "corrupt" | "undetermined";
export type ClientButton = "connect" | "update" | "disconnect" | "check";

const CLIENT_BUTTONS: Record<RowKind, ClientButton[]> = {
  not_installed: [],
  not_connected: ["connect"],
  connected: ["disconnect", "check"],
  foreign: [],
  stale_path: ["update", "disconnect", "check"],
  corrupt: [],
  undetermined: [],
};

export function clientRow(s: ClientStatusView): { kind: RowKind; buttons: ClientButton[] } {
  let kind: RowKind;
  if (s.state === "error") kind = "undetermined";
  else if (s.state === "corrupt") kind = s.reason?.code === "parse" || s.reason?.code === "shape" ? "corrupt" : "undetermined";
  else kind = s.state;
  return { kind, buttons: CLIENT_BUTTONS[kind] };
}

export type CommandKind = "not_installed" | "found" | "not_in_path" | "shadowed" | "stale" | "foreign" | "undetermined";
export type CommandButton = "install" | "update" | "remove" | "copy";

const COMMAND_BUTTONS: Record<CommandKind, CommandButton[]> = {
  not_installed: ["install"],
  found: ["remove"],
  not_in_path: ["remove", "copy"],
  shadowed: ["remove"],
  stale: ["update", "remove"],
  foreign: [],
  undetermined: [],
};

export function commandRow(s: CommandStatusView): { kind: CommandKind; buttons: CommandButton[] } {
  const kind: CommandKind = s.state === "check_failed" || s.state === "error" ? "undetermined" : s.state;
  return { kind, buttons: COMMAND_BUTTONS[kind] };
}

export type StepNote = "confirm_in_client" | "restart_client" | "unverified" | "done";

// The note depends only on `need`, never on the client id.
export function stepNote(r: ActionResult): StepNote | null {
  if (!r.ok || !r.changed) return null;
  return r.need === "none" ? "done" : r.need;
}
