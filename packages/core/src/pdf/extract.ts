import { spawnSync } from "node:child_process";
import { fstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { materialsMessages } from "../messages/materials.ts";
import { OCR_LIMITS, runOcrHelper, type OcrPdfRequest, type OcrPdfResult } from "../ocr/run.ts";

export const PDF_LIMITS = { bytes: 100 * 2 ** 20, pages: 2000, ms: 30_000, rssBytes: 512 * 2 ** 20, chars: 20_000_000 } as const;
export interface PdfLimits { bytes: number; pages: number; ms: number; rssBytes: number; chars: number }
// Pages without a text layer are recognized by the osen-ocr helper; 5 s per page and 300 s per file.
export const PDF_OCR_LIMITS = { pages: 200, pageMs: 5_000, ms: 300_000 } as const;
// Recognition time of all scanned PDFs of one attached folder; leftMs is spent by helper runs.
export const PDF_FOLDER_OCR_MS = 300_000;
export interface PdfOcrBudget { leftMs: number }
export type PdfFailure = "bytes" | "pages" | "chars" | "timeout" | "memory" | "encrypted" | "damaged" | "no_text" | "failed"
  | "ocr_pages" | "ocr_missing" | "ocr_start" | "ocr_page_timeout" | "ocr_timeout" | "ocr_memory" | "ocr_failed" | "ocr_folder";
export type PdfResult = { ok: true; text: string; pages: number; fallback?: true } | { ok: false; code: PdfFailure; detail?: string };
/** Reply of the PDF.js stage when some pages have no text: the cleaned text of every page and the blank page numbers. */
export type PdfScan = { ok: true; pages: number; parts: string[]; blank: number[] };
export interface PdfExtractorRuntime { command: string; script: string; env: Record<string, string> }

const defaultRuntime = (): PdfExtractorRuntime => ({ command: process.execPath, script: join(import.meta.dirname, "pdf-extract.ts"), env: {} });
let runtime = defaultRuntime();

let ocrTesting: { now?: () => number; run?: (request: OcrPdfRequest, bytes: Uint8Array) => OcrPdfResult; folderMs?: number } = {};
/** Test seam: clock, runner of the pdf-mode helper and size of the folder budget; no argument resets. */
export function setPdfOcrTesting(next: typeof ocrTesting = {}): void {
  ocrTesting = next;
}
export const newPdfOcrBudget = (): PdfOcrBudget => ({ leftMs: ocrTesting.folderMs ?? PDF_FOLDER_OCR_MS });

export function setPdfExtractorRuntime(next?: Partial<PdfExtractorRuntime>): void {
  runtime = { ...defaultRuntime(), ...next };
}

export function extractPdfText(bytes: Uint8Array, limits: PdfLimits = PDF_LIMITS, budget?: PdfOcrBudget): PdfResult {
  if (bytes.length > limits.bytes) return { ok: false, code: "bytes" };
  const { pages, chars, ms, rssBytes } = limits;
  // ponytail: a synchronous call holds the event loop for up to ms + 2 s of PDF.js plus 300 s + 2 s of recognition per file; asynchronous collection is a separate change, if PDFs become heavy.
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
    const result = JSON.parse(r.stdout.toString("utf8")) as PdfResult | PdfScan;
    if (typeof result === "object" && result !== null && typeof result.ok === "boolean") {
      return "blank" in result ? recognizeBlank(bytes, limits, result, budget) : result;
    }
  } catch { /* not JSON */ }
  return { ok: false, code: "failed", detail: materialsMessages().pdfBadReply };
}

// Same cleaning as in pdf-text.ts, which is not imported here because it loads PDF.js.
const clean = (s: string): string => (s.replace(/[\x00-\x08\x0e-\x1f\x7f]/g, "") as string & { toWellFormed(): string }).toWellFormed();

/** Text of all pages in number order: recognized text of a blank page replaces its layer; pages without text are dropped. */
export function mergePages(parts: readonly string[], recognized: ReadonlyMap<number, string>): string {
  const texts: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    const text = recognized.has(i) ? clean(recognized.get(i)!) : parts[i - 1]!;
    if (/\S/.test(text)) texts.push(text);
  }
  return texts.join("\n\n");
}

function recognizeBlank(bytes: Uint8Array, limits: PdfLimits, scan: PdfScan, budget?: PdfOcrBudget): PdfResult {
  if (scan.blank.length > PDF_OCR_LIMITS.pages) return { ok: false, code: "ocr_pages" };
  const left = budget ? Math.floor(budget.leftMs) : PDF_OCR_LIMITS.ms; // spawnSync rejects a fractional timeout
  if (budget && left <= 0) return { ok: false, code: "ocr_folder" };
  const ms = Math.min(PDF_OCR_LIMITS.ms, left);
  const now = ocrTesting.now ?? (() => performance.now());
  const started = now();
  const ocr = (ocrTesting.run ?? runOcrHelper)({ mode: "pdf", pages: scan.blank, pageMs: PDF_OCR_LIMITS.pageMs, ms, rssBytes: OCR_LIMITS.rssBytes }, bytes);
  if (budget) budget.leftMs -= now() - started;
  if (!ocr.ok && ocr.code === "timeout" && ms < PDF_OCR_LIMITS.ms) return { ok: false, code: "ocr_folder" };
  if (!ocr.ok) {
    // no usable helper: the pages that have a text layer are still read; the result is marked so that no cache keeps it
    if ((ocr.code === "missing" || ocr.code === "start") && scan.parts.some((t) => /\S/.test(t))) {
      const text = mergePages(scan.parts, new Map());
      return text.length > limits.chars ? { ok: false, code: "chars" } : { ok: true, text, pages: scan.pages, fallback: true };
    }
    const codes: Record<typeof ocr.code, PdfFailure> = {
      missing: "ocr_missing", start: "ocr_start", page_timeout: "ocr_page_timeout", timeout: "ocr_timeout", memory: "ocr_memory",
      damaged: "damaged", encrypted: "encrypted", no_text: "no_text", chars: "chars", failed: "ocr_failed", bytes: "ocr_failed", pixels: "ocr_failed",
    };
    const code = codes[ocr.code];
    return ocr.code === "failed" ? { ok: false, code, detail: ocr.detail } : { ok: false, code };
  }
  const recognized = new Map(ocr.pages.map((p) => [p.n, p.text]));
  // a reply without one of the requested pages would silently drop it: refuse instead of partial text
  if (scan.blank.some((n) => !recognized.has(n))) return { ok: false, code: "ocr_failed", detail: materialsMessages().docBadReply };
  const text = mergePages(scan.parts, recognized);
  if (text.length > limits.chars) return { ok: false, code: "chars" };
  return /\S/.test(text) ? { ok: true, text, pages: scan.pages } : { ok: false, code: "no_text" };
}

export const PDF_NOT_CACHED: readonly PdfFailure[] = ["timeout", "memory", "failed", "ocr_missing", "ocr_start", "ocr_page_timeout", "ocr_timeout", "ocr_memory", "ocr_failed", "ocr_folder"];
const CACHE_CHARS = 20_000_000;
const cache = new Map<string, PdfResult>();
let cacheChars = 0;

export function readPdfText(fd: number, limits: PdfLimits = PDF_LIMITS, budget?: PdfOcrBudget): PdfResult {
  const st = fstatSync(fd);
  if (st.size > limits.bytes) return { ok: false, code: "bytes" };
  const key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${Object.values(limits).join(",")}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const result = extractPdfText(readFileSync(fd), limits, budget);
  if (result.ok && result.fallback) return result;
  if (result.ok || !PDF_NOT_CACHED.includes(result.code)) {
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
    case "ocr_pages": return m.pdfOcrPages(PDF_OCR_LIMITS.pages);
    case "ocr_missing": return m.imgMissing;
    case "ocr_start": return m.imgStart;
    case "ocr_page_timeout": return m.pdfOcrPageTimeout(PDF_OCR_LIMITS.pageMs / 1000);
    case "ocr_timeout": return m.pdfOcrTimeout(PDF_OCR_LIMITS.ms / 1000);
    case "ocr_memory": return m.pdfOcrMemory(OCR_LIMITS.rssBytes / 2 ** 20);
    case "ocr_folder": return m.pdfOcrFolder(PDF_FOLDER_OCR_MS / 1000);
    case "ocr_failed": return m.pdfOcrFailed(failure.detail ?? m.docBadReply);
  }
}
