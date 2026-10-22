import { spawn } from "node:child_process";
import type { Language } from "../i18n/language.ts";
import { acceptanceMessages } from "../messages/acceptance.ts";

export interface RunSpec {
  command: string;                               // absolute path of the executable file
  args: readonly string[];
  cwd: string;
  stdin: string;                                 // written verbatim, then stdin is closed
  env: Record<string, string | undefined>;       // whole environment; not merged with process.env
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onSpawn?: (pid: number) => void;                // called once, right after the child is started
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
    if (child.pid !== undefined) spec.onSpawn?.(child.pid);
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
      // After a stop the SIGKILL timer stays armed: a leader that exited early may leave a SIGTERM-ignoring descendant in the group.
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

const INSPECT_TIMEOUT_MS = 10_000;
const INSPECT_MAX_BYTES = 4 * 1024 * 1024;

/** Reads the output of one CLI call in its own process group: a stop, the time limit or too much output ends the whole group.
 *  Rejects on a non-zero exit, a launch error, the time limit, more than maxBytes and the caller's signal; only that signal means an interruption. */
export async function readOutput(command: string, args: readonly string[], env: Record<string, string | undefined>, signal?: AbortSignal, timeoutMs = INSPECT_TIMEOUT_MS, maxBytes = INSPECT_MAX_BYTES): Promise<string> {
  const overflow = new AbortController();
  const timeout = AbortSignal.timeout(timeoutMs);
  let bytes = 0;
  const run = await runProcess({
    command, args, cwd: process.cwd(), stdin: "", env,
    signal: AbortSignal.any([overflow.signal, timeout, ...(signal ? [signal] : [])]),
    onStdout: (chunk) => { bytes += Buffer.byteLength(chunk); if (bytes > maxBytes) overflow.abort(); },
  });
  if (run.spawnError) throw run.spawnError;
  const fail = (message: string, failure?: OutputFailure): Error => failure
    ? new OutputError(failure, message, run.stderr)
    : Object.assign(new Error(message), { stderr: run.stderr }); // stderr: for callers that report it alone
  if (run.aborted) {
    if (signal?.aborted) throw fail("interrupted");
    throw overflow.signal.aborted
      ? fail(`output is larger than ${maxBytes} bytes`, { code: "too_large", maxBytes })
      : fail(`no answer within ${timeoutMs} ms`, { code: "timeout", ms: timeoutMs });
  }
  if (run.exitCode !== 0) {
    const stderr = run.stderr.trim();
    throw fail(`${command} ${args.join(" ")} exited with ${run.exitCode ?? run.signal}${stderr ? `: ${stderr}` : ""}`,
      { code: "exit", command: `${command} ${args.join(" ")}`, exitCode: run.exitCode, signal: run.signal, stderr });
  }
  return run.stdout;
}

/** Why a CLI read failed, as data: the text is built later, in the language of whoever shows it. */
export type OutputFailure =
  | { code: "too_large"; maxBytes: number }
  | { code: "timeout"; ms: number }
  | { code: "exit"; command: string; exitCode: number | null; signal: string | null; stderr: string };

/** `message` stays English (logs); `stderr` is what the process wrote, for callers that report it alone. */
export class OutputError extends Error {
  readonly failure: OutputFailure;
  readonly stderr: string;
  constructor(failure: OutputFailure, message: string, stderr: string = failure.code === "exit" ? failure.stderr : "") {
    super(message);
    this.failure = failure;
    this.stderr = stderr;
  }
}

/** Text of a failed CLI read in the given language (default: the process language); other errors keep their own message. */
export function describeOutputError(e: unknown, language?: Language): string {
  if (!(e instanceof OutputError)) return e instanceof Error ? e.message : String(e);
  const m = acceptanceMessages(language);
  const f = e.failure;
  if (f.code === "too_large") return m.outputTooLarge(f.maxBytes);
  if (f.code === "timeout") return m.outputNoAnswer(f.ms);
  return f.exitCode === null && f.signal !== null ? m.outputSignaled(f.command, f.signal, f.stderr) : m.outputExited(f.command, f.exitCode, f.stderr);
}
