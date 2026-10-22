import { describe, expect, it } from "vitest";
import { imageDimensions, imageSignature, type ImageFormat } from "./image-header.ts";
import { makeImage } from "./fixture.ts";

const u32be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

function png(w: number, h: number): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32be(13), Buffer.from("IHDR"), u32be(w), u32be(h), Buffer.alloc(5)]);
}
function jpeg(w: number, h: number, sof = 0xc0): Buffer {
  const app = Buffer.concat([Buffer.from([0xff, 0xe0, 0, 6]), Buffer.alloc(4)]);
  const dht = Buffer.concat([Buffer.from([0xff, 0xc4, 0, 4]), Buffer.alloc(2)]); // C4 is not a frame header
  const frame = Buffer.alloc(11);
  frame.set([0xff, sof, 0, 9, 8], 0);
  frame.writeUInt16BE(h, 5);
  frame.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app, dht, frame]);
}
function gif(w: number, h: number): Buffer {
  const b = Buffer.alloc(13);
  b.write("GIF89a");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}
function bmp(w: number, h: number, dib = 40): Buffer {
  const b = Buffer.alloc(14 + dib + 16);
  b.write("BM");
  b.writeUInt32LE(14 + dib, 10);
  b.writeUInt32LE(dib, 14);
  if (dib === 12) { b.writeUInt16LE(w, 18); b.writeUInt16LE(h, 20); } else { b.writeInt32LE(w, 18); b.writeInt32LE(h, 22); }
  return b;
}
function tiff(w: number, h: number, le: boolean, wide = false): Buffer {
  const b = Buffer.alloc(8 + 2 + 24 + 4);
  const w16 = (v: number, o: number) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const w32 = (v: number, o: number) => (le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));
  b.write(le ? "II" : "MM");
  w16(42, 2);
  w32(8, 4);
  w16(2, 8);
  [[256, w], [257, h]].forEach(([tag, v], i) => {
    const e = 10 + i * 12;
    w16(tag!, e);
    w16(wide ? 4 : 3, e + 2);
    w32(1, e + 4);
    if (wide) w32(v!, e + 8); else w16(v!, e + 8);
  });
  return b;
}
function webp(kind: "VP8 " | "VP8L" | "VP8X", w: number, h: number): Buffer {
  const b = Buffer.alloc(40);
  b.write("RIFF");
  b.writeUInt32LE(32, 4);
  b.write("WEBP", 8);
  b.write(kind, 12);
  if (kind === "VP8 ") { b.set([0x9d, 0x01, 0x2a], 23); b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28); }
  if (kind === "VP8L") { b[20] = 0x2f; b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21); }
  if (kind === "VP8X") { b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); }
  return b;
}
const box = (type: string, ...body: Buffer[]) => { const c = Buffer.concat(body); return Buffer.concat([u32be(8 + c.length), Buffer.from(type), c]); };
function heic(sizes: [number, number][]): Buffer {
  const ispes = sizes.map(([w, h]) => box("ispe", Buffer.alloc(4), u32be(w), u32be(h)));
  return Buffer.concat([box("ftyp", Buffer.from("heic"), Buffer.alloc(4), Buffer.from("mif1")), box("meta", Buffer.alloc(4), box("iprp", box("ipco", ...ispes)))]);
}

const synthetic: [ImageFormat, Buffer, { width: number; height: number }][] = [
  ["png", png(640, 480), { width: 640, height: 480 }],
  ["jpeg", jpeg(321, 123), { width: 321, height: 123 }],
  ["jpeg", jpeg(50, 60, 0xc2), { width: 50, height: 60 }],
  ["gif", gif(17, 9), { width: 17, height: 9 }],
  ["bmp", bmp(30, 20), { width: 30, height: 20 }],
  ["bmp", bmp(31, -21), { width: 31, height: 21 }],
  ["bmp", bmp(12, 8, 12), { width: 12, height: 8 }],
  ["tiff", tiff(100, 50, true), { width: 100, height: 50 }],
  ["tiff", tiff(100, 50, false), { width: 100, height: 50 }],
  ["tiff", tiff(70000, 80000, true, true), { width: 70000, height: 80000 }],
  ["webp", webp("VP8 ", 200, 100), { width: 200, height: 100 }],
  ["webp", webp("VP8L", 300, 150), { width: 300, height: 150 }],
  ["webp", webp("VP8X", 4000, 3000), { width: 4000, height: 3000 }],
  ["heic", heic([[160, 120], [4032, 3024], [320, 240]]), { width: 4032, height: 3024 }],
];

describe("image header", () => {
  it.each(synthetic)("%s: signature and dimensions of synthetic bytes", (format, bytes, dims) => {
    expect(imageSignature(bytes, bytes.length)).toBe(format);
    expect(imageDimensions(bytes, format)).toEqual(dims);
  });

  it("keeps text that only looks like a TIFF or BMP header as non-image", () => {
    for (const text of ["BM is a sentence about a plumber.", "BM\n", "II*\0", "MM\0*", "II*\0" + "\0\0\0\0", "BM" + "x".repeat(40)]) {
      const b = Buffer.from(text, "latin1");
      expect(imageSignature(b, b.length), text).toBeUndefined();
    }
    expect(imageSignature(tiff(1, 1, true).subarray(0, 8), 8)).toBeUndefined(); // first IFD offset equals the file size
    expect(imageSignature(bmp(0, 5), 100)).toBeUndefined();
    const oddDib = bmp(30, 20);
    oddDib.writeUInt32LE(41, 14);
    expect(imageSignature(oddDib, oddDib.length)).toBeUndefined();
    const farPixels = bmp(30, 20);
    farPixels.writeUInt32LE(farPixels.length, 10);
    expect(imageSignature(farPixels, farPixels.length)).toBeUndefined();
    expect(imageSignature(Buffer.from("plain text"), 10)).toBeUndefined();
  });

  it("returns undefined for truncated or broken headers and never throws", () => {
    expect(imageDimensions(png(1, 1).subarray(0, 18), "png")).toBeUndefined();
    expect(imageDimensions(png(0, 5), "png")).toBeUndefined();
    expect(imageDimensions(jpeg(5, 5).subarray(0, 20), "jpeg")).toBeUndefined();
    expect(imageDimensions(tiff(5, 5, true).subarray(0, 12), "tiff")).toBeUndefined();
    expect(imageDimensions(heic([[5, 5]]).subarray(0, 40), "heic")).toBeUndefined();
    expect(imageDimensions(Buffer.alloc(0), "gif")).toBeUndefined();
    const formats: ImageFormat[] = ["png", "jpeg", "gif", "bmp", "tiff", "webp", "heic"];
    for (const [, bytes] of synthetic) {
      for (let cut = 0; cut < bytes.length; cut++) for (const f of formats) expect(() => imageDimensions(bytes.subarray(0, cut), f)).not.toThrow();
    }
  });
});

describe("image header on real encoded images", () => {
  it.each(["png", "jpeg", "tiff", "gif", "bmp", "heic"] as const)("%s", (format) => {
    const bytes = makeImage(format, ["Header"], { width: 640, height: 300 });
    expect(imageSignature(bytes.subarray(0, 8192), bytes.length)).toBe(format);
    expect(imageDimensions(bytes, format)).toEqual({ width: 640, height: 300 });
  });
});
