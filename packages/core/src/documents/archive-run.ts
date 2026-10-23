import { spawnSync } from "node:child_process";
import { materialsMessages } from "../messages/materials.ts";
import type { ArchiveList, ArchiveRead } from "./archive.ts";
import { documentExtractorRuntime } from "./extract.ts";
import { DOC_LIMITS, type DocFailure, type DocLimits } from "./limits.ts";

export type RunFailure = { ok: false; code: DocFailure; detail?: string };

function run(bytes: Uint8Array, limits: DocLimits, extra: object, maxBuffer: number): unknown | RunFailure {
  if (bytes.length > limits.bytes) return { ok: false, code: "bytes" };
  const runtime = documentExtractorRuntime();
  const { ms, rssBytes, chars, parts, unpackedBytes, ratio, cells } = limits;
  const r = spawnSync(runtime.command, [runtime.script, JSON.stringify({ ms, rssBytes, chars, parts, unpackedBytes, ratio, cells, ...extra })], {
    input: bytes, env: runtime.env, timeout: ms + 2000, killSignal: "SIGKILL", maxBuffer, stdio: ["pipe", "pipe", "ignore"],
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") return { ok: false, code: "timeout" };
  if (code === "ENOBUFS") return { ok: false, code: "memory" };
  if (r.error) return { ok: false, code: "failed", detail: code ?? materialsMessages().docStartError };
  if (r.status !== 0) return { ok: false, code: "failed", detail: r.signal ?? `exit ${r.status}` };
  try {
    const result = JSON.parse(r.stdout.toString("utf8")) as unknown;
    if (typeof result === "object" && result !== null && typeof (result as { ok?: unknown }).ok === "boolean") return result;
  } catch { /* not JSON */ }
  return { ok: false, code: "failed", detail: materialsMessages().docBadReply };
}

export function listArchiveEntries(bytes: Uint8Array, limits: DocLimits = DOC_LIMITS): ArchiveList | RunFailure {
  return run(bytes, limits, { mode: "list" }, 64 * 2 ** 20) as ArchiveList | RunFailure;
}

export function readArchiveEntries(
  bytes: Uint8Array, indices: readonly number[], expectedBytes: number, limits: DocLimits = DOC_LIMITS,
): { ok: true; entries: Map<number, Uint8Array | DocFailure> } | RunFailure {
  const r = run(bytes, limits, { mode: "read", indices }, Math.ceil(expectedBytes * 4 / 3) + 2 ** 20 + indices.length * 64) as ArchiveRead | RunFailure;
  if (!r.ok) return r;
  const entries = new Map<number, Uint8Array | DocFailure>();
  for (const e of r.entries) entries.set(e.i, "data" in e ? new Uint8Array(Buffer.from(e.data, "base64")) : e.code);
  return { ok: true, entries };
}
