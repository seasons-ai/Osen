import { makeCfb, makeZip } from "./fixture.ts";
import type { FileKindId } from "./kinds.ts";

// A minimal non-text file for each kind of change 216: the start of the format padded with NUL bytes (the end of the file is zeros too, except for DMG).
const file = (head: Buffer | number[] | string, at = 0, size = 1024): Buffer => {
  const b = Buffer.alloc(size);
  (typeof head === "string" ? Buffer.from(head, "latin1") : Buffer.from(head)).copy(b, at);
  return b;
};
const u32be = (n: number): number[] => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const box = (name: string, brand: string): Buffer => file([...u32be(24), ...Buffer.from(name + brand, "latin1")]);
const withAt = (b: Buffer, at: number, s: string): Buffer => { Buffer.from(s, "latin1").copy(b, at); return b; };
// an Ogg page: 27-byte header, one lacing byte, then the first packet
const ogg = (packet: string): Buffer => withAt(withAt(file("OggS"), 26, "\x01"), 28, packet);

export interface KindFixture { name: string; kind: FileKindId; bytes: Uint8Array }

export const KIND_FIXTURES: readonly KindFixture[] = [
  { name: "mp3-id3", kind: "mp3", bytes: file("ID3\x03") },
  { name: "mp3-frame", kind: "mp3", bytes: file([0xff, 0xfb, 0x90, 0x00]) },
  { name: "aac-f1", kind: "aac", bytes: file([0xff, 0xf1, 0x50]) },
  { name: "aac-f9", kind: "aac", bytes: file([0xff, 0xf9, 0x50]) },
  { name: "m4a", kind: "m4a", bytes: box("ftyp", "M4A ") },
  { name: "wav", kind: "wav", bytes: withAt(file("RIFF"), 8, "WAVE") },
  { name: "aiff", kind: "aiff", bytes: withAt(file("FORM"), 8, "AIFF") },
  { name: "aifc", kind: "aiff", bytes: withAt(file("FORM"), 8, "AIFC") },
  { name: "flac", kind: "flac", bytes: file("fLaC") },
  { name: "ogg-opus", kind: "ogg", bytes: ogg("OpusHead") },
  { name: "ogg-vorbis", kind: "ogg", bytes: ogg("\x01vorbis") },
  { name: "mp4", kind: "video", bytes: box("ftyp", "isom") },
  { name: "mov", kind: "video", bytes: box("ftyp", "qt  ") },
  { name: "3gp", kind: "video", bytes: box("ftyp", "3gp4") },
  { name: "mov-moov", kind: "video", bytes: withAt(file([]), 4, "moov") },
  { name: "mkv", kind: "video", bytes: file([0x1a, 0x45, 0xdf, 0xa3]) },
  { name: "avi", kind: "video", bytes: withAt(file("RIFF"), 8, "AVI ") },
  { name: "ogg-theora", kind: "video", bytes: ogg("\x80theora") },
  { name: "rar", kind: "rar", bytes: file([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) },
  { name: "7z", kind: "7z", bytes: file([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
  { name: "tar", kind: "tar", bytes: withAt(file([]), 257, "ustar\0") },
  { name: "gzip", kind: "gzip", bytes: file([0x1f, 0x8b, 0x08]) },
  { name: "bzip2", kind: "bzip2", bytes: file("BZh9") },
  { name: "xz", kind: "xz", bytes: file([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) },
  { name: "zstd", kind: "zstd", bytes: file([0x28, 0xb5, 0x2f, 0xfd]) },
  // a DMG may start with the bytes of a compressed stream: the trailer decides
  { name: "dmg", kind: "dmg", bytes: withAt(file("BZh9"), 512, "koly") },
  { name: "macho", kind: "program", bytes: file([0xcf, 0xfa, 0xed, 0xfe]) },
  { name: "macho-fat", kind: "program", bytes: file([0xca, 0xfe, 0xba, 0xbe, ...u32be(2)]) },
  { name: "elf", kind: "program", bytes: file([0x7f, 0x45, 0x4c, 0x46]) },
  { name: "pe", kind: "program", bytes: withAt(withAt(file("MZ"), 0x3c, "\x80"), 0x80, "PE\0\0") },
  { name: "pe-mz-only", kind: "program", bytes: withAt(file("MZ"), 0x3c, "\xff\xff\xff\x7f") },
  { name: "ar", kind: "program", bytes: file("!<arch>\n") },
  { name: "sqlite", kind: "sqlite", bytes: file("SQLite format 3\0") },
  { name: "ttf", kind: "font", bytes: file([0x00, 0x01, 0x00, 0x00]) },
  { name: "otf", kind: "font", bytes: file("OTTO") },
  { name: "ttc", kind: "font", bytes: file("ttcf") },
  { name: "woff", kind: "font", bytes: file("wOFF") },
  { name: "woff2", kind: "font", bytes: file("wOF2") },
  { name: "xls", kind: "xls", bytes: makeCfb({ streams: ["Workbook"] }) },
  { name: "xls-book", kind: "xls", bytes: makeCfb({ streams: ["Book"] }) },
  { name: "ppt", kind: "ppt", bytes: makeCfb({ streams: ["PowerPoint Document"] }) },
  { name: "iwork", kind: "iwork", bytes: makeZip([{ name: "Index/Document.iwa", data: "x" }, { name: "Metadata/Properties.plist", data: "y" }]) },
  { name: "cfb-other", kind: "unknown", bytes: makeCfb({ streams: ["Contents"] }) },
  { name: "java-class", kind: "unknown", bytes: file([0xca, 0xfe, 0xba, 0xbe, ...u32be(52)]) },
  { name: "nul-bytes", kind: "unknown", bytes: file([]) },
];
