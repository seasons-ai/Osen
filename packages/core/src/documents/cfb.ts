import { DocError } from "./limits.ts";

export const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const MAX_ENTRIES = 100_000;
const END = 0xfffffffe;
const FREE = 0xffffffff;
const NO_STREAM = 0xffffffff;

/**
 * Names of the stream entries (type 2) that are direct children of the root entry of a Compound File Binary file.
 * Directory only: stream contents are never read. Nested storages are not entered, so an MSG that embeds a Word file is not a DOC.
 * Not a CFB header: unsupported. A good header and then a broken structure: damaged.
 */
export function cfbStreams(bytes: Uint8Array): string[] {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  if (b.length < 512 || !b.subarray(0, 8).equals(CFB_SIGNATURE)) throw new DocError("unsupported");
  const shift = b.readUInt16LE(0x1e);
  if (shift !== 9 && shift !== 12) throw new DocError("unsupported");
  const size = 1 << shift;
  const total = Math.floor(b.length / size) - 1; // sectors after the header
  const sector = (n: number): Buffer => {
    if (n >= total) throw new DocError("damaged");
    return b.subarray((n + 1) * size, (n + 2) * size);
  };

  // FAT sector numbers: 109 in the header, then the DIFAT chain
  const fatCount = b.readUInt32LE(0x2c);
  // more FAT sectors than sectors in the file is a broken header; this also bounds the FAT below by the file size
  if (fatCount > total) throw new DocError("damaged");
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < fatCount; i++) {
    const n = b.readUInt32LE(0x4c + i * 4);
    if (n !== FREE) fatSectors.push(n);
  }
  const seenDifat = new Set<number>();
  for (let n = b.readUInt32LE(0x44), left = b.readUInt32LE(0x48); fatSectors.length < fatCount && left > 0 && n !== END; left--) {
    if (seenDifat.has(n)) throw new DocError("damaged");
    seenDifat.add(n);
    const s = sector(n);
    for (let i = 0; i < size / 4 - 1 && fatSectors.length < fatCount; i++) {
      const f = s.readUInt32LE(i * 4);
      if (f !== FREE) fatSectors.push(f);
    }
    n = s.readUInt32LE(size - 4);
  }
  const fat = new Uint32Array(fatSectors.length * (size / 4));
  fatSectors.forEach((n, k) => {
    const s = sector(n);
    for (let i = 0; i < size / 4; i++) fat[k * (size / 4) + i] = s.readUInt32LE(i * 4);
  });

  // the whole directory chain first; a repeated sector is a loop
  const dir: Buffer[] = [];
  const seen = new Set<number>();
  for (let n = b.readUInt32LE(0x30); n !== END; n = fat[n] ?? FREE) {
    if (n === FREE || seen.has(n)) throw new DocError("damaged");
    seen.add(n);
    dir.push(sector(n));
  }
  const perSector = size / 128;
  if (dir.length * perSector > MAX_ENTRIES || dir.length === 0) throw new DocError("damaged");
  const count = dir.length * perSector;
  const entry = (id: number): Buffer => dir[Math.floor(id / perSector)]!.subarray((id % perSector) * 128, (id % perSector + 1) * 128);

  // red-black tree under the root entry: left, right and child ids
  const names: string[] = [];
  const visited = new Set<number>();
  const stack = [entry(0).readUInt32LE(0x4c)];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === NO_STREAM) continue;
    if (id >= count || visited.has(id)) throw new DocError("damaged");
    visited.add(id);
    const e = entry(id);
    if (e[0x42] === 2) {
      const len = Math.min(e.readUInt16LE(0x40), 64);
      names.push(e.subarray(0, Math.max(0, len - 2)).toString("utf16le"));
    }
    stack.push(e.readUInt32LE(0x44), e.readUInt32LE(0x48));
  }
  return names;
}
