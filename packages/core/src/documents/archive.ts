import { DocError, type DocFailure, type DocLimits } from "./limits.ts";
import { openZip, type Zip, type ZipEntry } from "./zip.ts";

export type ArchiveEntryKind = "file" | "dir" | "symlink" | "encrypted";
export interface ArchiveEntry { name: string; size: number; kind: ArchiveEntryKind }
export type ArchiveList = { ok: true; entries: ArchiveEntry[]; duplicates: string[] } | { ok: false; code: DocFailure };
export type ArchiveRead = { ok: true; entries: ({ i: number; data: string } | { i: number; code: DocFailure })[] } | { ok: false; code: DocFailure };
type Limits = Pick<DocLimits, "parts" | "unpackedBytes" | "ratio">;

const MAX32 = 0xffffffff;

function kindOf(e: ZipEntry): ArchiveEntryKind {
  if (e.name.endsWith("/")) return "dir";
  if ((e.madeBy >>> 8) === 3 && ((e.external >>> 16) & 0o170000) === 0o120000) return "symlink";
  return e.flags & 1 ? "encrypted" : "file";
}

export function listArchive(bytes: Uint8Array, limits: Limits): ArchiveList {
  if (bytes.length >= 22) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (v.getUint32(bytes.length - 22, true) === 0x06054b50 && v.getUint16(bytes.length - 12, true) === 0) return { ok: true, entries: [], duplicates: [] };
  }
  const duplicates: string[] = [];
  let zip: Zip & { ranges?(): [number, number][] };
  try { zip = openZip(bytes, { ratio: limits.ratio, unpackedBytes: limits.unpackedBytes }, duplicates); } catch { return { ok: false, code: "damaged" }; }
  const all = [...zip.entries.values()];
  if (all.length + duplicates.length > limits.parts) return { ok: false, code: "zip_parts" };
  if (all.reduce((sum, e) => sum + e.size, 0) > limits.unpackedBytes) return { ok: false, code: "zip_size" };
  for (const e of all) {
    if (kindOf(e) === "dir" || kindOf(e) === "encrypted") continue;
    if ((e.method !== 0 && e.method !== 8) || e.size === MAX32 || e.compressedSize === MAX32) return { ok: false, code: "damaged" };
    if (e.size > 0 && (e.compressedSize === 0 || e.size / e.compressedSize > limits.ratio)) return { ok: false, code: "zip_ratio" };
  }
  try {
    const ranges = zip.ranges!().sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) if (ranges[i]![0] < ranges[i - 1]![1]) return { ok: false, code: "damaged" };
  } catch { return { ok: false, code: "damaged" }; }
  return { ok: true, entries: all.map((e) => ({ name: e.name, size: e.size, kind: kindOf(e) })), duplicates };
}

export function readArchive(bytes: Uint8Array, indices: readonly number[], limits: Limits): ArchiveRead {
  let zip: Zip;
  try { zip = openZip(bytes, { ratio: limits.ratio, unpackedBytes: limits.unpackedBytes }, []); } catch { return { ok: false, code: "damaged" }; }
  const all = [...zip.entries.values()];
  return {
    ok: true,
    entries: indices.map((i) => {
      const e = all[i];
      if (e === undefined || kindOf(e) !== "file") return { i, code: "unsupported" as const };
      try { return { i, data: Buffer.from(zip.read(e.name)).toString("base64") }; } catch (err) {
        return { i, code: err instanceof DocError ? err.code : ("damaged" as const) };
      }
    }),
  };
}
