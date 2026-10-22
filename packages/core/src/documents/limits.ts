export const DOC_LIMITS = { bytes: 100 * 2 ** 20, ms: 30_000, rssBytes: 512 * 2 ** 20, chars: 20_000_000, parts: 10_000, unpackedBytes: 512 * 2 ** 20, ratio: 200 } as const;
export interface DocLimits { bytes: number; ms: number; rssBytes: number; chars: number; parts: number; unpackedBytes: number; ratio: number }
export type DocFailure = "bytes" | "encrypted" | "damaged" | "no_text" | "zip_parts" | "zip_size" | "zip_ratio" | "chars" | "timeout" | "memory" | "unsupported" | "failed"
  | "odf_kind" | "drm";
export class DocError extends Error {
  readonly code: DocFailure;
  readonly detail?: string;
  constructor(code: DocFailure, detail?: string) { super(code); this.code = code; if (detail !== undefined) this.detail = detail; }
}
