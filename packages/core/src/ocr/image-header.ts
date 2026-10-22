export type ImageFormat = "png" | "jpeg" | "gif" | "bmp" | "tiff" | "webp" | "heic";

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"]);
const BMP_DIB_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

const startsWith = (b: Uint8Array, sig: readonly number[]) => b.length >= sig.length && sig.every((v, i) => b[i] === v);
const ascii = (b: Uint8Array, from: number, to: number) => Buffer.from(b.subarray(from, to)).toString("latin1");

/** Format by the file signature (extension is never considered); undefined — not an image. head — the first bytes, size — the file size. */
export function imageSignature(head: Uint8Array, size: number): ImageFormat | undefined {
  try {
    const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
    if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
    if (startsWith(b, [0xff, 0xd8, 0xff])) return "jpeg";
    const tag = ascii(b, 0, 6);
    if (tag === "GIF87a" || tag === "GIF89a") return "gif";
    if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "webp";
    if (b.length >= 12 && ascii(b, 4, 8) === "ftyp") {
      const boxSize = Math.min(b.readUInt32BE(0), b.length);
      const brands = [ascii(b, 8, 12)];
      for (let at = 16; at + 4 <= boxSize; at += 4) brands.push(ascii(b, at, at + 4));
      if (brands.some((x) => HEIC_BRANDS.has(x))) return "heic";
    }
    const little = startsWith(b, [0x49, 0x49, 0x2a, 0x00]);
    if (little || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) {
      const ifd = little ? b.readUInt32LE(4) : b.readUInt32BE(4);
      return ifd >= 8 && ifd < size ? "tiff" : undefined;
    }
    if (b[0] === 0x42 && b[1] === 0x4d && BMP_DIB_SIZES.has(b.readUInt32LE(14)) && b.readUInt32LE(10) < size) {
      const d = bmpDimensions(b);
      return d && d.width > 0 && d.height > 0 ? "bmp" : undefined;
    }
  } catch { /* header shorter than the format needs: not an image */ }
  return undefined;
}

type Dim = { width: number; height: number };

function bmpDimensions(b: Buffer): Dim | undefined {
  if (b.readUInt32LE(14) === 12) return { width: b.readUInt16LE(18), height: b.readUInt16LE(20) };
  return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
}

function tiffDimensions(b: Buffer): Dim | undefined {
  const le = b[0] === 0x49;
  const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const ifd = u32(4);
  const count = u16(ifd);
  let width: number | undefined;
  let height: number | undefined;
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e);
    if (tag !== 256 && tag !== 257) continue;
    const type = u16(e + 2);
    const value = type === 3 ? u16(e + 8) : type === 4 ? u32(e + 8) : undefined;
    if (value === undefined) continue;
    if (tag === 256) width = value;
    else height = value;
  }
  return width && height ? { width, height } : undefined;
}

function jpegDimensions(b: Buffer): Dim | undefined {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return undefined;
    const marker = b[at + 1]!;
    if (marker === 0xff) { at++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    if (marker === 0xd9) return undefined;
    const len = b.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(at + 5), width: b.readUInt16BE(at + 7) };
    }
    if (len < 2) return undefined;
    at += 2 + len;
  }
  return undefined;
}

function webpDimensions(b: Buffer): Dim | undefined {
  const kind = ascii(b, 12, 16);
  if (kind === "VP8 ") return b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a ? { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff } : undefined;
  if (kind === "VP8L") {
    if (b[20] !== 0x2f) return undefined;
    const v = b.readUInt32LE(21);
    return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8X") return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  return undefined;
}

// ISO BMFF boxes in [from, to): calls visit(type, bodyStart, bodyEnd); a box with a broken size ends the walk
function boxes(b: Buffer, from: number, to: number, visit: (type: string, start: number, end: number) => void): void {
  let at = from;
  while (at + 8 <= to) {
    let size = b.readUInt32BE(at);
    let head = 8;
    if (size === 1) { size = Number(b.readBigUInt64BE(at + 8)); head = 16; }
    else if (size === 0) size = to - at;
    if (size < head || at + size > to) return;
    visit(ascii(b, at + 4, at + 8), at + head, at + size);
    at += size;
  }
}

function heicDimensions(b: Buffer): Dim | undefined {
  let best: Dim | undefined;
  boxes(b, 0, b.length, (t, s, e) => {
    if (t !== "meta") return;
    boxes(b, s + 4, e, (t2, s2, e2) => {
      if (t2 !== "iprp") return;
      boxes(b, s2, e2, (t3, s3, e3) => {
        if (t3 !== "ipco") return;
        boxes(b, s3, e3, (t4, s4) => {
          if (t4 !== "ispe") return;
          const d = { width: b.readUInt32BE(s4 + 4), height: b.readUInt32BE(s4 + 8) };
          if (!best || d.width * d.height > best.width * best.height) best = d;
        });
      });
    });
  });
  return best;
}

/** Pixel size from the header; undefined when it cannot be read (the image counts as damaged). Never throws. */
export function imageDimensions(bytes: Uint8Array, format: ImageFormat): Dim | undefined {
  try {
    const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let d: Dim | undefined;
    switch (format) {
      case "png": d = ascii(b, 12, 16) === "IHDR" ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : undefined; break;
      case "gif": d = { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }; break;
      case "bmp": d = bmpDimensions(b); break;
      case "tiff": d = tiffDimensions(b); break;
      case "jpeg": d = jpegDimensions(b); break;
      case "webp": d = webpDimensions(b); break;
      case "heic": d = heicDimensions(b); break;
    }
    return d && d.width > 0 && d.height > 0 ? d : undefined;
  } catch {
    return undefined;
  }
}
