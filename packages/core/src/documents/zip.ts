import { inflateRawSync } from "node:zlib";
import { DOC_LIMITS, DocError, type DocLimits } from "./limits.ts";

export interface ZipEntry { name: string; method: number; flags: number; compressedSize: number; size: number; localOffset: number; madeBy: number; external: number }
export interface Zip { entries: Map<string, ZipEntry>; read(name: string): Uint8Array }

const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;
const MAX32 = 0xffffffff;

// ponytail: ZIP64 is not supported (design.md Non-Goals); such files end up as "unsupported" or "damaged".
export function openZip(bytes: Uint8Array, limits: Pick<DocLimits, "ratio" | "unpackedBytes"> = DOC_LIMITS, duplicates?: string[]): Zip {
  let unpacked = 0;
  const counted = new Set<string>();
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = (): never => { throw new DocError("unsupported"); };
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) bad();
  const count = v.getUint16(eocd + 10, true), cdSize = v.getUint32(eocd + 12, true), cdOffset = v.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === MAX32 || cdOffset === MAX32 || count === 0 || cdOffset + cdSize > bytes.length) bad();
  const entries = new Map<string, ZipEntry>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const cp866 = new TextDecoder("ibm866");
  let pos = cdOffset;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > bytes.length || v.getUint32(pos, true) !== CEN) bad();
    const nameLen = v.getUint16(pos + 28, true), extraLen = v.getUint16(pos + 30, true), commentLen = v.getUint16(pos + 32, true);
    const end = pos + 46 + nameLen + extraLen + commentLen;
    if (end > cdOffset + cdSize) bad();
    let name = "";
    const raw = bytes.subarray(pos + 46, pos + 46 + nameLen);
    // flag bit 11: UTF-8 or the archive is damaged; without it UTF-8 when valid, else CP866 (the legacy DOS code page of archivers)
    try { name = decoder.decode(raw); } catch { if (v.getUint16(pos + 8, true) & 0x800) bad(); name = cp866.decode(raw); }
    const localOffset = v.getUint32(pos + 42, true);
    if (localOffset === MAX32) bad();
    if (entries.has(name)) {
      if (!duplicates) bad();
      duplicates!.push(name);
      pos = end;
      continue;
    }
    entries.set(name, {
      name, flags: v.getUint16(pos + 8, true), method: v.getUint16(pos + 10, true),
      compressedSize: v.getUint32(pos + 20, true), size: v.getUint32(pos + 24, true), localOffset,
      madeBy: v.getUint16(pos + 4, true), external: v.getUint32(pos + 38, true),
    });
    pos = end;
  }
  const dataRange = (e: ZipEntry): [number, number] => {
    if (e.localOffset + 30 > bytes.length || v.getUint32(e.localOffset, true) !== LOC) throw new DocError("damaged");
    const start = e.localOffset + 30 + v.getUint16(e.localOffset + 26, true) + v.getUint16(e.localOffset + 28, true);
    if (start + e.compressedSize > bytes.length) throw new DocError("damaged");
    return [start, start + e.compressedSize];
  };
  const zip: Zip & { ranges(): [number, number][] } = {
    entries,
    ranges: () => [...entries.values()].map(dataRange),
    read(name) {
      const e = entries.get(name);
      if (!e) throw new DocError("damaged");
      entryChecks(e, limits.ratio);
      // parts read before checkZip ([Content_Types].xml, _rels/.rels) must not bypass the unpacked size limit, alone or together
      if (!counted.has(name)) { counted.add(name); unpacked += e.size; }
      if (unpacked > limits.unpackedBytes) throw new DocError("zip_size");
      const [s, t] = dataRange(e);
      const data = bytes.subarray(s, t);
      if (e.method === 0) {
        if (e.compressedSize !== e.size) throw new DocError("damaged");
        return data;
      }
      let out: Uint8Array;
      try { out = inflateRawSync(data, { maxOutputLength: Math.max(1, e.size) }); } catch { throw new DocError("damaged"); }
      if (out.length !== e.size) throw new DocError("damaged");
      return out;
    },
  };
  return zip;
}

function entryChecks(e: ZipEntry, ratio: number): void {
  if (e.flags & 1) throw new DocError("encrypted");
  if ((e.method !== 0 && e.method !== 8) || e.size === MAX32 || e.compressedSize === MAX32) throw new DocError("damaged");
  if (e.size > 0 && (e.compressedSize === 0 || e.size / e.compressedSize > ratio)) throw new DocError("zip_ratio");
}

export function checkZip(zip: Zip, limits: Pick<DocLimits, "parts" | "unpackedBytes" | "ratio">): void {
  const all = [...zip.entries.values()];
  if (all.length > limits.parts) throw new DocError("zip_parts");
  if (all.some((e) => e.flags & 1)) throw new DocError("encrypted");
  if (all.some((e) => (e.method !== 0 && e.method !== 8) || e.size === MAX32 || e.compressedSize === MAX32)) throw new DocError("damaged");
  if (all.reduce((sum, e) => sum + e.size, 0) > limits.unpackedBytes) throw new DocError("zip_size");
  for (const e of all) entryChecks(e, limits.ratio);
  const ranges = (zip as Zip & { ranges(): [number, number][] }).ranges().sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i]![0] < ranges[i - 1]![1]) throw new DocError("damaged");
}
