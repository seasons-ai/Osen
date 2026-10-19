// Contract of the agent connection module (change 140). The module returns codes; texts are drawn by callers.

export type ClientId = "claude-desktop" | "claude-code" | "codex";
export type Bin = "claude" | "codex";

export type State = "not_installed" | "not_connected" | "connected" | "foreign" | "stale_path" | "corrupt";

// What the owner has to do in the client after a change (docs/clients.md, "Restart after writing the entry").
export type ClientAction = "none" | "confirm_in_client" | "restart_client" | "unverified";

// Server command: the program and its arguments, exactly as written into the client's entry.
export interface ServerCommand { command: string; args: string[] }

export interface Reason {
  code: "unreadable" | "parse" | "shape" | "cli" | "codex_unclear" | "write" | "verify";
  // raw detail: a system error message, CLI output or a path; not translated
  detail: string;
}

export interface Status {
  client: ClientId;
  state: State;
  // settings file the entry lives in (for output)
  file: string;
  // the recorded entry, when there is one
  entry?: ServerCommand;
  // for `corrupt`
  reason?: Reason;
}

export type ActionResult =
  | { ok: true; client: ClientId; file: string; changed: boolean; state: State; need: ClientAction }
  | { ok: false; client: ClientId; file: string; refusal: "not_installed" | "not_connected" | "foreign" | "stale_path" | "corrupt" | "failed"; state: State; entry?: ServerCommand; reason?: Reason };

export interface ActionOptions {
  // compute the plan only: no file writes and no `add`/`remove` CLI calls
  dryRun?: boolean;
  // entry name; default "osen" (the installer passes "model-council" for the legacy entry)
  name?: string;
}

export interface ConnectDeps {
  home: string;
  hasCommand(bin: Bin): boolean;
  exec(bin: Bin, args: string[]): { ok: boolean; stdout: string; stderr: string };
  // Claude.app bundle paths that count as "Claude Desktop installed" (docs/clients.md); the installer passes
  // /Applications/Claude.app and ~/Applications/Claude.app, tests pass their own
  desktopApps: string[];
}
