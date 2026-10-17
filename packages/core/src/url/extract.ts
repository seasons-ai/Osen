import { Worker } from "node:worker_threads";
import { extname, join } from "node:path";
import { decodeText } from "../materials.ts";
import { materialsMessages } from "../messages/materials.ts";

export const URL_TEXT_LIMITS = { ms: 15_000, heapMb: 256 } as const;

export type UrlTextFailureCode = "charset" | "not-text" | "empty" | "timeout" | "memory" | "damaged";

export class UrlTextError extends Error {
  override name = "UrlTextError";
  readonly code: UrlTextFailureCode;
  readonly reason: string;
  constructor(code: UrlTextFailureCode, reason: string) {
    super(reason);
    this.code = code;
    this.reason = reason;
  }
}

export interface UrlTextInput {
  bytes: Uint8Array;
  contentType: "text/plain" | "text/markdown" | "text/html";
  charset?: string | undefined;
}
export interface UrlTextOptions { deadline?: number; worker?: string }

const reasonOf = (code: "not-text" | "empty" | "timeout" | "memory" | "damaged"): string => {
  const m = materialsMessages();
  return { "not-text": m.urlNotText, empty: m.urlEmpty, timeout: m.urlTimeout, memory: m.urlMemory, damaged: m.urlDamaged }[code];
};

const fail = (code: "not-text" | "empty" | "timeout" | "memory" | "damaged"): UrlTextError => new UrlTextError(code, reasonOf(code));

function runWorker(html: string, options: UrlTextOptions): Promise<string> {
  const deadline = options.deadline ?? Date.now() + URL_TEXT_LIMITS.ms;
  const left = deadline - Date.now();
  if (left <= 0) return Promise.reject(fail("timeout"));
  const file = options.worker ?? join(import.meta.dirname, "html-worker" + extname(import.meta.filename));
  return new Promise((resolve, reject) => {
    const thread = new Worker(file, {
      workerData: { html },
      resourceLimits: { maxOldGenerationSizeMb: URL_TEXT_LIMITS.heapMb },
      stdout: true, stderr: true,
    });
    let done = false;
    const settle = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void thread.terminate();
      fn();
    };
    const timer = setTimeout(() => settle(() => reject(fail("timeout"))), left);
    thread.on("message", (m: { text: string }) => settle(() => resolve(m.text)));
    thread.on("error", (e) => settle(() => reject(
      fail((e as { code?: string }).code === "ERR_WORKER_OUT_OF_MEMORY" ? "memory" : "damaged"))));
    thread.on("exit", () => settle(() => reject(fail("damaged"))));
  });
}

export async function extractUrlText(input: UrlTextInput, options: UrlTextOptions = {}): Promise<string> {
  const { charset } = input;
  if (charset !== undefined && !["utf-8", "utf8"].includes(charset.toLowerCase())) {
    const safe = charset.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
    throw new UrlTextError("charset", materialsMessages().urlCharset(safe));
  }
  // decodeText keeps the BOM (ignoreBOM); we strip one
  const decoded = decodeText(Buffer.from(input.bytes));
  if (decoded === undefined) throw fail("not-text");
  const text = decoded.replace(/^\uFEFF/, "");
  const result = input.contentType === "text/html" ? await runWorker(text, options) : text;
  if (!result.trim()) throw fail("empty");
  return result;
}
