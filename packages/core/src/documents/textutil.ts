import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { DocResult } from "./detect.ts";
import type { DocLimits } from "./limits.ts";

// One constant, nothing interpolated: no network, no writes. Reading stays open because textutil reads fonts and system settings.
export const SANDBOX_PROFILE = "(version 1)(allow default)(deny network*)(deny file-write*)";
export const SYSTEM_TOOLS = { sandbox: "/usr/bin/sandbox-exec", textutil: "/usr/bin/textutil" };

const unavailable: DocResult = { ok: false, code: "textutil_unavailable" };

/** RTF or DOC bytes to text through /usr/bin/textutil inside sandbox-exec; never an unsandboxed run. Missing tools: textutil_unavailable. */
export function runTextutil(
  bytes: Uint8Array, format: "rtf" | "doc", limits: Pick<DocLimits, "ms" | "rssBytes" | "chars">,
  tools: { sandbox: string; textutil: string } = SYSTEM_TOOLS, signal?: AbortSignal,
): Promise<DocResult> {
  if (!existsSync(tools.sandbox) || !existsSync(tools.textutil)) return Promise.resolve(unavailable);
  // textutil refuses a file that starts with a UTF-8 BOM
  const input = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  return new Promise((resolve) => {
    const child = spawn(tools.sandbox, ["-p", SANDBOX_PROFILE, tools.textutil, "-stdin", "-stdout", "-convert", "txt", "-format", format, "-encoding", "UTF-8"], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
    let killedFor: "chars" | "timeout" | "memory" | "aborted" | undefined;
    const kill = (why: typeof killedFor): void => { killedFor ??= why; child.kill("SIGKILL"); };
    const out: Buffer[] = [];
    let outBytes = 0;
    let errText = "";
    let settled = false;
    const done = (r: DocResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const timer = setTimeout(() => kill("timeout"), limits.ms);
    // ponytail: RSS is polled every 100 ms, not a hard cap; a spike between polls goes unseen. Time, input and output limits still hold.
    const poll = setInterval(() => {
      execFile("/bin/ps", ["-o", "rss=", "-p", String(child.pid)], (err, stdout) => {
        if (!err && Number.parseInt(stdout, 10) * 1024 > limits.rssBytes) kill("memory");
      });
    }, 100);
    const onAbort = (): void => kill("aborted");
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort);
    child.stdout.on("data", (c: Buffer) => {
      out.push(c);
      outBytes += c.length;
      if (outBytes > limits.chars * 3) kill("chars");
    });
    child.stderr.on("data", (c: Buffer) => { if (errText.length < 64 * 1024) errText += c.toString("utf8"); });
    child.stdin.on("error", () => { /* the child exited before reading everything: its exit code says why */ });
    child.on("error", () => done(unavailable));
    child.on("close", (code, sig) => {
      if (killedFor === "aborted") return done(unavailable);
      if (killedFor) return done({ ok: false, code: killedFor });
      // exit 71: sandbox-exec could not start the target, 65: invalid profile; a signal we did not send: the run is not trusted
      if (sig || code === 71 || code === 65) return done(unavailable);
      if (code !== 0) return done({ ok: false, code: "damaged" });
      const raw = Buffer.concat(out);
      // textutil exits 0 on a file it cannot read, with an empty stdout and a message on stderr
      if (raw.length === 0 && errText.trim() !== "") return done({ ok: false, code: "damaged" });
      const text = raw.toString("utf8");
      if (text.length > limits.chars) return done({ ok: false, code: "chars" });
      if (!/\S/.test(text)) return done({ ok: false, code: "no_text" });
      const clean = (text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "") as string & { toWellFormed(): string }).toWellFormed();
      done({ ok: true, text: clean.replace(/\n+$/, ""), format });
    });
    child.stdin.end(input);
  });
}
