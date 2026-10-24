import { materialsMessages } from "../messages/materials.ts";

// Kind of a file that did not become text, by its first bytes (and the last 512 for DMG). Used only after text and the supported extractions failed,
// so a signature never narrows what was accepted. xls, ppt, xlsb and iwork are not in the table: the document extractor names them from the container.
export type FileKindId =
  | "mp3" | "aac" | "m4a" | "wav" | "aiff" | "flac" | "ogg" | "video"
  | "rar" | "7z" | "tar" | "gzip" | "bzip2" | "xz" | "zstd" | "dmg"
  | "program" | "sqlite" | "font" | "xls" | "ppt" | "xlsb" | "iwork" | "unknown";

export const TAIL_BYTES = 512;

type Extra = "mp3Frame" | "ftypBrand" | "riffForm" | "machoFat" | "peHeader" | "oggCodec" | "tarMagic" | "bzip2Level";
export interface KindSignature { kind: FileKindId; offset: number; bytes: Buffer; extra?: Extra }

const ascii = (s: string): Buffer => Buffer.from(s, "latin1");
const hex = (...b: number[]): Buffer => Buffer.from(b);
const at = (head: Buffer, offset: number, s: string): boolean => head.subarray(offset, offset + s.length).equals(ascii(s));

// Order matters only between records with the same bytes and different extras (ftyp, RIFF, Ogg).
export const KIND_SIGNATURES: readonly KindSignature[] = [
  { kind: "mp3", offset: 0, bytes: ascii("ID3") },
  { kind: "mp3", offset: 0, bytes: hex(0xff), extra: "mp3Frame" },
  { kind: "aac", offset: 0, bytes: hex(0xff, 0xf1) },
  { kind: "aac", offset: 0, bytes: hex(0xff, 0xf9) },
  { kind: "m4a", offset: 4, bytes: ascii("ftyp"), extra: "ftypBrand" },
  { kind: "wav", offset: 0, bytes: ascii("RIFF"), extra: "riffForm" },
  { kind: "aiff", offset: 0, bytes: ascii("FORM"), extra: "riffForm" },
  { kind: "flac", offset: 0, bytes: ascii("fLaC") },
  { kind: "ogg", offset: 0, bytes: ascii("OggS"), extra: "oggCodec" },
  { kind: "video", offset: 4, bytes: ascii("ftyp"), extra: "ftypBrand" },
  { kind: "video", offset: 4, bytes: ascii("moov") },
  { kind: "video", offset: 4, bytes: ascii("mdat") },
  { kind: "video", offset: 4, bytes: ascii("wide") },
  { kind: "video", offset: 0, bytes: hex(0x1a, 0x45, 0xdf, 0xa3) },
  { kind: "video", offset: 0, bytes: ascii("RIFF"), extra: "riffForm" },
  { kind: "video", offset: 0, bytes: ascii("OggS"), extra: "oggCodec" },
  { kind: "rar", offset: 0, bytes: hex(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07) },
  { kind: "7z", offset: 0, bytes: hex(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) },
  { kind: "tar", offset: 257, bytes: ascii("ustar"), extra: "tarMagic" },
  { kind: "gzip", offset: 0, bytes: hex(0x1f, 0x8b) },
  { kind: "bzip2", offset: 0, bytes: ascii("BZh"), extra: "bzip2Level" },
  { kind: "xz", offset: 0, bytes: hex(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00) },
  { kind: "zstd", offset: 0, bytes: hex(0x28, 0xb5, 0x2f, 0xfd) },
  { kind: "program", offset: 0, bytes: hex(0xfe, 0xed, 0xfa, 0xce) },
  { kind: "program", offset: 0, bytes: hex(0xfe, 0xed, 0xfa, 0xcf) },
  { kind: "program", offset: 0, bytes: hex(0xce, 0xfa, 0xed, 0xfe) },
  { kind: "program", offset: 0, bytes: hex(0xcf, 0xfa, 0xed, 0xfe) },
  { kind: "program", offset: 0, bytes: hex(0xca, 0xfe, 0xba, 0xbe), extra: "machoFat" },
  { kind: "program", offset: 0, bytes: hex(0x7f, 0x45, 0x4c, 0x46) },
  { kind: "program", offset: 0, bytes: ascii("MZ"), extra: "peHeader" },
  { kind: "program", offset: 0, bytes: ascii("!<arch>\n") },
  { kind: "sqlite", offset: 0, bytes: ascii("SQLite format 3\0") },
  { kind: "font", offset: 0, bytes: hex(0x00, 0x01, 0x00, 0x00) },
  { kind: "font", offset: 0, bytes: ascii("OTTO") },
  { kind: "font", offset: 0, bytes: ascii("true") },
  { kind: "font", offset: 0, bytes: ascii("ttcf") },
  { kind: "font", offset: 0, bytes: ascii("wOFF") },
  { kind: "font", offset: 0, bytes: ascii("wOF2") },
];

const M4A_BRANDS = ["M4A ", "M4B ", "M4P "];
const VIDEO_BRANDS = ["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "qt  ", "M4V ", "avc1", "dash"];
const OGG_VIDEO = "\x80theora";

// Layer III only (second byte FA/FB/F2/F3/E2/E3) with a valid bitrate and sample-rate index: broken UTF-16 LE (FF FE) is not MP3.
const MP3_SECOND = [0xfa, 0xfb, 0xf2, 0xf3, 0xe2, 0xe3];

// First packet of an Ogg stream: page header of 27 bytes, then one lacing byte per segment.
function oggIsVideo(head: Buffer): boolean {
  return head.length > 26 && at(head, 27 + head[26]!, OGG_VIDEO);
}

function extraOk(extra: Extra, kind: FileKindId, head: Buffer): boolean {
  switch (extra) {
    case "mp3Frame": return MP3_SECOND.includes(head[1] ?? 0) && (head[2]! >> 4) !== 0 && (head[2]! >> 4) !== 15 && ((head[2]! >> 2) & 3) !== 3;
    case "ftypBrand": {
      const brand = head.subarray(8, 12).toString("latin1");
      return (kind === "m4a" ? M4A_BRANDS : VIDEO_BRANDS).includes(brand) || (kind === "video" && brand.startsWith("3g"));
    }
    case "riffForm": {
      const form = head.subarray(8, 12).toString("latin1");
      return kind === "wav" ? form === "WAVE" : kind === "aiff" ? form === "AIFF" || form === "AIFC" : form === "AVI ";
    }
    case "machoFat": return head.length >= 8 && head.readUInt32BE(4) < 45;
    case "peHeader": {
      if (head.length < 0x40) return true;
      const pe = head.readUInt32LE(0x3c);
      return pe + 4 > head.length || at(head, pe, "PE\0\0");
    }
    case "oggCodec": return kind === "video" ? oggIsVideo(head) : !oggIsVideo(head);
    case "tarMagic": return head[262] === 0 || head[262] === 0x20;
    case "bzip2Level": return head[3]! >= 0x31 && head[3]! <= 0x39;
  }
}

/** Kind by the first bytes; tail is the last TAIL_BYTES of the file (DMG: "koly" starts the trailer), undefined when the file is shorter. */
/** minBytes: shortest signature that counts (text in another encoding is named by a kind only for a signature of 4+ bytes, design.md). */
export function fileKind(head: Buffer, tail?: Buffer, minBytes = 1): FileKindId | undefined {
  if (tail?.length === TAIL_BYTES && at(tail, 0, "koly")) return "dmg";
  const hit = KIND_SIGNATURES.find((s) => s.bytes.length >= minBytes && head.subarray(s.offset, s.offset + s.bytes.length).equals(s.bytes) && (!s.extra || extraOk(s.extra, s.kind, head)));
  return hit?.kind;
}

/** Reason for a file that did not become text: the kind reason, else fallback (encoding not recognized), else the unknown-binary reason. */
export function nonTextReason(head: Buffer, tail: Buffer | undefined, fallback?: string): string {
  const m = materialsMessages();
  // fallback is set for text without control bytes in an unknown encoding: "ID3", "MZ" or "BZh" at its start is more likely text than a file of that kind
  const kind = fileKind(head, tail, fallback === undefined ? 1 : 4);
  return kind ? m.kindReason(kind) : (fallback ?? m.kindReason("unknown"));
}
