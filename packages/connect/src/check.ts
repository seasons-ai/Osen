import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerCommand } from "./types.ts";

// Free connection check: initialize + tools/list over stdio only, so no model is ever called.
export const SERVER_TOOLS = ["council_continue", "council_options", "council_resume", "council_say", "council_start", "council_status", "council_stop"] as const;

export type CheckResult =
  | { ok: true; tools: string[]; durationMs: number }
  | { ok: false; reason: "no_entry" | "spawn_failed" | "timeout" | "missing_tools" | "stray_stdout"; detail: string; tools?: string[]; durationMs: number };

type Reason = Extract<CheckResult, { ok: false }>["reason"];

export function checkConnection(entry: ServerCommand | null | undefined, opts: { extraEnv?: Record<string, string>; timeoutMs?: number } = {}): Promise<CheckResult> {
  const t0 = Date.now();
  if (!entry) return Promise.resolve({ ok: false, reason: "no_entry", detail: "no server entry", durationMs: 0 });
  const home = mkdtempSync(join(tmpdir(), "osen-check-"));
  const env: Record<string, string | undefined> = { ...process.env };
  delete env["COUNCIL_HOME"];
  delete env["COUNCIL_DEV"];
  Object.assign(env, { COUNCIL_HOME: home }, opts.extraEnv);

  return new Promise<CheckResult>((resolve) => {
    let done = false, buf = "", err = "", tools: string[] | undefined, exited = false, stage: 1 | 2 | 3 = 1;
    const child = spawn(entry.command, entry.args, { stdio: ["pipe", "pipe", "pipe"], env });
    const send = (m: object): void => { child.stdin.write(`${JSON.stringify(m)}\n`); };
    const finish = (r: { ok: true; tools: string[] } | { ok: false; reason: Reason; detail: string; tools?: string[] }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!exited) child.kill();
      rmSync(home, { recursive: true, force: true });
      resolve({ ...r, durationMs: Date.now() - t0 } as CheckResult);
    };
    const fail = (reason: Reason, detail: string, t?: string[]): void => finish({ ok: false, reason, detail, ...(t ? { tools: t } : {}) });
    const verdict = (): void => {
      // output without a trailing newline never reaches onLine: it is still stray stdout
      const tail = buf.trim();
      if (tail) return fail("stray_stdout", tail.slice(0, 200));
      const missing = SERVER_TOOLS.filter((n) => !tools?.includes(n));
      if (missing.length) fail("missing_tools", `missing: ${missing.join(", ")}`, tools);
      else finish({ ok: true, tools: tools ?? [] });
    };
    const timer = setTimeout(() => {
      // tools/list already answered: only the exit is late, the result stands
      if (tools) verdict(); else fail("timeout", `no answer in ${opts.timeoutMs ?? 20000} ms${err ? `; stderr: ${err.slice(-500)}` : ""}`);
    }, opts.timeoutMs ?? 20000);

    const onLine = (line: string): void => {
      let m: { jsonrpc?: unknown; id?: unknown; result?: { tools?: { name?: unknown }[] } } | undefined;
      try { const p: unknown = JSON.parse(line); if (p && typeof p === "object" && !Array.isArray(p)) m = p; } catch { /* stray */ }
      if (!m || m.jsonrpc !== "2.0") return fail("stray_stdout", line.slice(0, 200));
      if (m.id === 1 && stage === 1) {
        stage = 2;
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      } else if (m.id === 2 && stage === 2) {
        stage = 3;
        tools = (m.result?.tools ?? []).map((t) => String(t.name));
        child.stdin.end();
      }
    };
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while (!done && (i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    });
    child.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-500); });
    child.stdin.on("error", () => { /* child gone: handled by exit/error */ });
    child.on("error", (e) => fail("spawn_failed", e.message));
    child.on("exit", () => { exited = true; });
    // "close" fires after stdout is drained, so an unterminated tail is already in buf
    child.on("close", (code, sig) => {
      if (stage === 3) return verdict();
      fail("spawn_failed", `exited before tools/list (${code ?? sig})${err ? `: ${err.slice(-500)}` : ""}`);
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "osen-connection-check", version: "1" } } });
  });
}
