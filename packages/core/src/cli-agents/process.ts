import { spawn } from "node:child_process";

export interface RunSpec {
  command: string;                               // absolute path of the executable file
  args: readonly string[];
  cwd: string;
  stdin: string;                                 // written verbatim, then stdin is closed
  env: Record<string, string | undefined>;       // whole environment; not merged with process.env
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  killGraceMs?: number;                          // default 2000
}
export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;                                // no more than the last 64 KB
  spawnError?: NodeJS.ErrnoException;
  aborted: boolean;
}

const STDERR_MAX = 64 * 1024;
const EXIT_CLOSE_GRACE_MS = 2000;

export function runProcess(spec: RunSpec): Promise<RunResult> {
  const { signal } = spec;
  if (signal?.aborted) return Promise.resolve({ exitCode: null, signal: null, stdout: "", stderr: "", aborted: true });

  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: "pipe", detached: true });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    let settled = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let spawnError: NodeJS.ErrnoException | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(exitTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: exit?.code ?? null, signal: exit?.signal ?? null, stdout, stderr, aborted,
        ...(spawnError ? { spawnError } : {}),
      });
    };

    // Signal to the whole group; if there is no group, to the process itself.
    const killTree = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid === undefined) throw new Error("no pid");
        process.kill(-child.pid, sig);
      } catch {
        try { child.kill(sig); } catch { /* already finished */ }
      }
    };

    function onAbort(): void {
      if (settled || aborted) return;
      aborted = true;
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), spec.killGraceMs ?? 2000);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      spec.onStdout?.(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > STDERR_MAX) stderr = stderr.slice(-STDERR_MAX);
    });
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
      settle();
    });
    child.on("exit", (code, sig) => {
      exit = { code, signal: sig };
      exitTimer = setTimeout(settle, EXIT_CLOSE_GRACE_MS);
    });
    child.on("close", settle);

    child.stdin.end(spec.stdin);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
