// Read-only check of how the host agents (Claude Code, Codex) have the `osen` MCP server registered.
// Runs only `claude mcp get osen` / `codex mcp get osen --json`; never prints env values or raw host output.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export type Host = "claude" | "codex";
export type HostState = "connected" | "not connected" | "mismatch" | "not checked";
export interface HostResult { host: Host; state: HostState; detail: string }

interface Entry { command: string; args: string[]; status?: string }

const real = (p: string): string => {
  try { return realpathSync(p); } catch { return p; }
};

function parseClaude(text: string): Entry | null {
  const command = /^\s*Command:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (!command) return null;
  // the whole rest of the line is ONE argument: the repo path may contain a space
  const arg = /^\s*Args:\s*(.*)$/m.exec(text)?.[1]?.trim();
  const status = /^\s*Status:\s*(.+)$/m.exec(text)?.[1]?.trim();
  return { command, args: arg ? [arg] : [], status };
}

function parseCodex(text: string): Entry | null {
  try {
    const t = (JSON.parse(text) as { transport?: { command?: unknown; args?: unknown } }).transport;
    if (typeof t?.command !== "string") return null;
    const args = Array.isArray(t.args) && t.args.every((a) => typeof a === "string") ? (t.args as string[]) : [];
    return { command: t.command, args };
  } catch {
    return null;
  }
}

export function checkHost(host: Host, root: string, opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): HostResult {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const args = host === "claude" ? ["mcp", "get", "osen"] : ["mcp", "get", "osen", "--json"];
  const r = spawnSync(host, args, {
    cwd: root, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
  });
  const notChecked = (detail: string): HostResult => ({ host, state: "not checked", detail });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return notChecked(`${host} is not installed (not found in PATH)`);
    if (code === "ETIMEDOUT") return notChecked(`${host} did not answer within ${timeoutMs / 1000} s`);
    return notChecked(`${host} could not be run (${code ?? "unknown error"})`);
  }
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const entry = host === "claude" ? parseClaude(text) : parseCodex(r.stdout ?? "");
  if (!entry) {
    if (text.includes("No MCP server named")) return { host, state: "not connected", detail: `no osen entry in ${host}` };
    return notChecked(`unrecognized output of \`${host} mcp get osen\` (exit ${r.status ?? r.signal})`);
  }
  const serverFile = entry.args.length ? entry.args[entry.args.length - 1] : entry.command;
  const expected = join(root, "packages/mcp/src/main.ts");
  const line = [entry.command, ...entry.args].join(" ");
  // node (by name or absolute path) runs the file; the installer and .mcp.json write exactly this form
  const runner = entry.args.length === 0 || basename(entry.command) === "node";
  if (runner && real(resolve(root, serverFile)) === real(expected)) {
    // the entry is ours, but Claude has not approved it or could not start it
    if (entry.status && /pending approval|failed/i.test(entry.status)) return { host, state: "not connected", detail: `${line} (${entry.status})` };
    return { host, state: "connected", detail: line };
  }
  return { host, state: "mismatch", detail: `entry runs ${line}, expected ${expected}` };
}
