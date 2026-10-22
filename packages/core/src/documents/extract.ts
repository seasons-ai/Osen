import { spawnSync } from "node:child_process";
import { fstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { materialsMessages } from "../messages/materials.ts";
import { DOC_LIMITS, type DocFailure, type DocLimits } from "./limits.ts";

export { DOC_LIMITS, type DocLimits, type DocFailure } from "./limits.ts";
export type DocumentResult = { ok: true; text: string; format: string } | { ok: false; code: DocFailure; detail?: string };
export interface DocumentExtractorRuntime { command: string; script: string; env: Record<string, string>; tools?: { sandbox: string; textutil: string } }

const defaultRuntime = (): DocumentExtractorRuntime => ({ command: process.execPath, script: join(import.meta.dirname, "doc-extract.ts"), env: {} });
let runtime = defaultRuntime();

export function setDocumentExtractorRuntime(next?: Partial<DocumentExtractorRuntime>): void {
  runtime = { ...defaultRuntime(), ...next };
}

export function extractDocumentText(bytes: Uint8Array, limits: DocLimits = DOC_LIMITS): DocumentResult {
  if (bytes.length > limits.bytes) return { ok: false, code: "bytes" };
  const { ms, rssBytes, chars, parts, unpackedBytes, ratio } = limits;
  // ponytail: a synchronous call holds the event loop for up to ms + 2 s per file; an asynchronous collection is separate work, if documents become heavy.
  const r = spawnSync(runtime.command, [runtime.script, JSON.stringify({ ms, rssBytes, chars, parts, unpackedBytes, ratio, ...(runtime.tools ? { tools: runtime.tools } : {}) })], {
    input: bytes, env: runtime.env, timeout: ms + 2000, killSignal: "SIGKILL",
    maxBuffer: chars * 4 + 2 ** 20, stdio: ["pipe", "pipe", "ignore"],
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") return { ok: false, code: "timeout" };
  if (code === "ENOBUFS") return { ok: false, code: "chars" };
  // EPIPE: the extractor answered (a limit) and exited before reading all input; its reply on stdout still counts
  if (r.error && code !== "EPIPE") return { ok: false, code: "failed", detail: code ?? materialsMessages().docStartError };
  if (r.status !== 0) return { ok: false, code: "failed", detail: r.signal ?? `exit ${r.status}` };
  try {
    const result = JSON.parse(r.stdout.toString("utf8")) as DocumentResult;
    if (typeof result === "object" && result !== null && typeof result.ok === "boolean") return result;
  } catch { /* not JSON */ }
  return { ok: false, code: "failed", detail: materialsMessages().docBadReply };
}

const NOT_CACHED: readonly DocFailure[] = ["timeout", "memory", "failed", "textutil_unavailable"];
const CACHE_CHARS = 20_000_000;
const cache = new Map<string, DocumentResult>();
let cacheChars = 0;

export function readDocumentText(fd: number, limits: DocLimits = DOC_LIMITS): DocumentResult {
  const st = fstatSync(fd);
  if (st.size > limits.bytes) return { ok: false, code: "bytes" };
  const key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${Object.values(limits).join(",")}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const result = extractDocumentText(readFileSync(fd), limits);
  if (result.ok || !NOT_CACHED.includes(result.code)) {
    cache.set(key, result);
    if (result.ok) cacheChars += result.text.length;
    if (cacheChars > CACHE_CHARS) { cache.clear(); cacheChars = 0; }
  }
  return result;
}

export function documentReason(failure: { code: DocFailure; detail?: string }, limits: DocLimits = DOC_LIMITS): string {
  const m = materialsMessages();
  switch (failure.code) {
    case "bytes": return m.docBytes(limits.bytes / 2 ** 20);
    case "timeout": return m.docTimeout(limits.ms / 1000);
    case "memory": return m.docMemory(limits.rssBytes / 2 ** 20);
    case "chars": return m.docChars(limits.chars);
    case "zip_parts": return m.docParts(limits.parts);
    case "zip_size": return m.docUnpacked(limits.unpackedBytes / 2 ** 20);
    case "zip_ratio": return m.docRatio(limits.ratio);
    case "encrypted": return m.docEncrypted;
    case "damaged": return m.docDamaged;
    case "no_text": return m.docNoText;
    case "unsupported": return m.docUnsupported;
    case "textutil_unavailable": return m.docTextutilUnavailable;
    case "failed": return m.docFailed(failure.detail ?? m.docStartError);
  }
}
