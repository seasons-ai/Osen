import { spawnSync } from "node:child_process";
import { existsSync, fstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOC_LIMITS } from "../documents/limits.ts";
import { materialsMessages } from "../messages/materials.ts";
import { imageDimensions, type ImageFormat } from "./image-header.ts";
import { orderLines, type OcrLine } from "./order.ts";

export const OCR_LIMITS = { bytes: 50 * 2 ** 20, pixels: 100_000_000, ms: 30_000, rssBytes: 512 * 2 ** 20, folderImages: 50 } as const;

export type OcrFailure = "missing" | "start" | "bytes" | "pixels" | "damaged" | "no_text" | "timeout" | "memory" | "chars" | "failed";
export type OcrResult = { ok: true; text: string } | { ok: false; code: OcrFailure; detail?: string };
export type OcrPdfResult = { ok: true; pages: { n: number; text: string }[] } | { ok: false; code: OcrFailure | "page_timeout" | "encrypted"; detail?: string };
export interface OcrImageRequest { mode: "image"; ms: number; rssBytes: number }
export interface OcrPdfRequest { mode: "pdf"; pages: number[]; pageMs: number; ms: number; rssBytes: number }
export type OcrRequest = OcrImageRequest | OcrPdfRequest;

// No network, no file writes; reading is open because the system frameworks of Vision live on disk.
const PROFILE = "(version 1)(allow default)(deny network*)(deny file-write*)";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

let override: string | undefined;

export function setOcrRuntime(next?: { helper?: string }): void {
  override = next?.helper;
}

function helperPath(): string {
  if (override !== undefined) return override;
  if (process.env.COUNCIL_DEV === "1" && process.env.COUNCIL_OCR_HELPER) return process.env.COUNCIL_OCR_HELPER;
  return join(import.meta.dirname, "bin/osen-ocr");
}

const valid = (l: unknown): l is OcrLine => typeof l === "object" && l !== null && typeof (l as OcrLine).t === "string";

/** The only launch point of the helper: empty environment, no file paths in arguments, bytes on stdin. */
export function runOcrHelper(request: OcrImageRequest, bytes: Uint8Array): OcrResult;
export function runOcrHelper(request: OcrPdfRequest, bytes: Uint8Array): OcrPdfResult;
export function runOcrHelper(request: OcrRequest, bytes: Uint8Array): OcrResult | OcrPdfResult {
  const helper = helperPath();
  if (!existsSync(helper)) return { ok: false, code: "missing" };
  // ponytail: a synchronous call holds the event loop for up to ms + 2 s per image; an asynchronous collection is separate work, if images become heavy.
  const r = spawnSync(SANDBOX_EXEC, ["-p", PROFILE, helper, JSON.stringify(request)], {
    input: bytes, env: {}, cwd: "/", timeout: request.ms + 2000, killSignal: "SIGKILL",
    maxBuffer: DOC_LIMITS.chars * 4 + 2 ** 20, stdio: ["pipe", "pipe", "ignore"],
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") return { ok: false, code: "timeout" };
  if (code === "ENOBUFS") return { ok: false, code: "chars" };
  if (r.error) return { ok: false, code: "start" };
  let reply: { ok?: unknown; lines?: unknown; pages?: unknown; code?: unknown } | undefined;
  try {
    const parsed: unknown = JSON.parse(r.stdout.toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { ok?: unknown }).ok === "boolean") reply = parsed;
  } catch { /* not JSON */ }
  // a helper killed by a signal (crash) was started: its reason is a failure, not a launch error
  if (!reply && r.signal) return { ok: false, code: "failed", detail: r.signal };
  if (!reply) return r.status !== 0 ? { ok: false, code: "start" } : { ok: false, code: "failed", detail: materialsMessages().docBadReply };
  if (request.mode === "pdf") {
    if (reply.ok === true) {
      if (!Array.isArray(reply.pages)) return { ok: false, code: "failed", detail: materialsMessages().docBadReply };
      const raw = reply.pages as ({ n?: unknown; lines?: unknown } | null)[];
      // a malformed page would become silently empty: the whole reply is refused instead
      if (!raw.every((p) => typeof p?.n === "number" && Array.isArray(p.lines) && p.lines.every(valid))) {
        return { ok: false, code: "failed", detail: materialsMessages().docBadReply };
      }
      return { ok: true, pages: raw.map((p) => ({ n: p!.n as number, text: orderLines(p!.lines as OcrLine[]) })) };
    }
    const c = typeof reply.code === "string" ? reply.code : "";
    if (c === "damaged" || c === "no_text" || c === "timeout" || c === "memory" || c === "page_timeout" || c === "encrypted") return { ok: false, code: c };
    return { ok: false, code: "failed", detail: c ? `helper:${c}` : materialsMessages().docBadReply };
  }
  if (reply.ok === true && Array.isArray(reply.lines)) {
    if (!reply.lines.every(valid)) return { ok: false, code: "failed", detail: materialsMessages().docBadReply };
    const text = orderLines(reply.lines as OcrLine[]);
    if (text.length > DOC_LIMITS.chars) return { ok: false, code: "chars" };
    return /\S/.test(text) ? { ok: true, text } : { ok: false, code: "no_text" };
  }
  const c = typeof reply.code === "string" ? reply.code : "";
  if (c === "damaged" || c === "no_text" || c === "timeout" || c === "memory") return { ok: false, code: c };
  return { ok: false, code: "failed", detail: c ? `helper:${c}` : materialsMessages().docBadReply };
}

export const OCR_NOT_CACHED: readonly OcrFailure[] = ["timeout", "memory", "missing", "start", "failed"];
const CACHE_CHARS = 20_000_000;
const cache = new Map<string, OcrResult>();
let cacheChars = 0;

/** Text of an image by an open file; refusals by size and header are decided before the helper starts. */
export function readImageText(fd: number, format: ImageFormat): OcrResult {
  const st = fstatSync(fd);
  if (st.size > OCR_LIMITS.bytes) return { ok: false, code: "bytes" };
  const key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${helperPath()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const bytes = readFileSync(fd);
  const dims = imageDimensions(bytes, format);
  if (!dims) return { ok: false, code: "damaged" };
  if (dims.width * dims.height > OCR_LIMITS.pixels) return { ok: false, code: "pixels" };
  const result = runOcrHelper({ mode: "image", ms: OCR_LIMITS.ms, rssBytes: OCR_LIMITS.rssBytes }, bytes);
  if (result.ok || !OCR_NOT_CACHED.includes(result.code)) {
    cache.set(key, result);
    if (result.ok) cacheChars += result.text.length;
    if (cacheChars > CACHE_CHARS) { cache.clear(); cacheChars = 0; }
  }
  return result;
}

// an unknown helper code stays language-free in detail as helper:<code>; the reason gets catalog words instead
export function ocrFailedDetail(detail: string | undefined): string {
  const m = materialsMessages();
  return detail?.startsWith("helper:") ? m.ocrHelperError : detail ?? m.docBadReply;
}

export function imageReason(failure: { code: OcrFailure; detail?: string }): string {
  const m = materialsMessages();
  switch (failure.code) {
    case "missing": return m.imgMissing;
    case "start": return m.imgStart;
    case "no_text": return m.imgNoText;
    case "damaged": return m.imgDamaged;
    case "bytes": return m.imgBytes(OCR_LIMITS.bytes / 2 ** 20);
    case "pixels": return m.imgPixels(OCR_LIMITS.pixels / 1_000_000);
    case "timeout": return m.imgTimeout(OCR_LIMITS.ms / 1000);
    case "memory": return m.imgMemory(OCR_LIMITS.rssBytes / 2 ** 20);
    case "chars": return m.imgChars(DOC_LIMITS.chars);
    case "failed": return m.imgFailed(ocrFailedDetail(failure.detail));
  }
}
