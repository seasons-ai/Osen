import { spawnSync } from "node:child_process";
import { fstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { materialsMessages } from "../messages/materials.ts";

export const PDF_LIMITS = { bytes: 100 * 2 ** 20, pages: 2000, ms: 30_000, rssBytes: 512 * 2 ** 20, chars: 20_000_000 } as const;
export interface PdfLimits { bytes: number; pages: number; ms: number; rssBytes: number; chars: number }
export type PdfFailure = "bytes" | "pages" | "chars" | "timeout" | "memory" | "encrypted" | "damaged" | "no_text" | "failed";
export type PdfResult = { ok: true; text: string; pages: number } | { ok: false; code: PdfFailure; detail?: string };
export interface PdfExtractorRuntime { command: string; script: string; env: Record<string, string> }

const defaultRuntime = (): PdfExtractorRuntime => ({ command: process.execPath, script: join(import.meta.dirname, "pdf-extract.ts"), env: {} });
let runtime = defaultRuntime();

export function setPdfExtractorRuntime(next?: Partial<PdfExtractorRuntime>): void {
  runtime = { ...defaultRuntime(), ...next };
}

export function extractPdfText(bytes: Uint8Array, limits: PdfLimits = PDF_LIMITS): PdfResult {
  if (bytes.length > limits.bytes) return { ok: false, code: "bytes" };
  const { pages, chars, ms, rssBytes } = limits;
  // ponytail: a synchronous call holds the event loop for up to ms + 2 s per file; an asynchronous collection is separate work, if PDFs become heavy.
  const r = spawnSync(runtime.command, [runtime.script, JSON.stringify({ pages, chars, ms, rssBytes })], {
    input: bytes, env: runtime.env, timeout: ms + 2000, killSignal: "SIGKILL",
    maxBuffer: chars * 4 + 2 ** 20, stdio: ["pipe", "pipe", "ignore"],
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") return { ok: false, code: "timeout" };
  if (code === "ENOBUFS") return { ok: false, code: "chars" };
  if (r.error) return { ok: false, code: "failed", detail: code ?? materialsMessages().pdfStartError };
  if (r.status !== 0) return { ok: false, code: "failed", detail: r.signal ?? `exit ${r.status}` };
  try {
    const result = JSON.parse(r.stdout.toString("utf8")) as PdfResult;
    if (typeof result === "object" && result !== null && typeof result.ok === "boolean") return result;
  } catch { /* not JSON */ }
  return { ok: false, code: "failed", detail: materialsMessages().pdfBadReply };
}

const NOT_CACHED: readonly PdfFailure[] = ["timeout", "memory", "failed"];
const CACHE_CHARS = 20_000_000;
const cache = new Map<string, PdfResult>();
let cacheChars = 0;

export function readPdfText(fd: number, limits: PdfLimits = PDF_LIMITS): PdfResult {
  const st = fstatSync(fd);
  if (st.size > limits.bytes) return { ok: false, code: "bytes" };
  const key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${Object.values(limits).join(",")}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const result = extractPdfText(readFileSync(fd), limits);
  if (result.ok || !NOT_CACHED.includes(result.code)) {
    cache.set(key, result);
    if (result.ok) cacheChars += result.text.length;
    if (cacheChars > CACHE_CHARS) { cache.clear(); cacheChars = 0; }
  }
  return result;
}

export function pdfReason(failure: { code: PdfFailure; detail?: string }, limits: PdfLimits = PDF_LIMITS): string {
  const m = materialsMessages();
  switch (failure.code) {
    case "bytes": return m.pdfBytes(limits.bytes / 2 ** 20);
    case "pages": return m.pdfPages(limits.pages);
    case "timeout": return m.pdfTimeout(limits.ms / 1000);
    case "memory": return m.pdfMemory(limits.rssBytes / 2 ** 20);
    case "chars": return m.pdfChars(limits.chars);
    case "encrypted": return m.pdfEncrypted;
    case "damaged": return m.pdfDamaged;
    case "no_text": return m.pdfNoText;
    case "failed": return m.pdfFailed(failure.detail ?? m.pdfStartError);
  }
}
