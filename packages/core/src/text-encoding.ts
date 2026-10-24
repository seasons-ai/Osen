import { materialsMessages } from "./messages/materials.ts";

export const CP1251_MIN_CYRILLIC_SHARE = 0.9;
export const CP1251_MIN_LOWER_SHARE = 0.5;
// Latin-1 / Windows-1252 accented letters share bytes C0-FF with Cyrillic but sit inside Latin words ("Prénom")
export const CP1251_MAX_LATIN_NEIGHBOR_SHARE = 0.2;

const CONTROL = /[\x00-\x08\x0e-\x1f\x7f]/;
const NEUTRAL = new Set([0x85, 0x88, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x99, 0xa0, 0xa7, 0xa9, 0xab, 0xae, 0xb0, 0xb1, 0xb7, 0xb9, 0xbb]);
const CYR_EXTRA = [0xa8, 0xb8, 0xa1, 0xa2, 0xa5, 0xaa, 0xaf, 0xb2, 0xb3, 0xb4, 0xba, 0xbf];
const LOWER_EXTRA = new Set([0xb8, 0xa2, 0xb3, 0xba, 0xbf, 0xb4]);
const isCyrillic = (b: number): boolean => b >= 0xc0 || CYR_EXTRA.includes(b);
const isLower = (b: number): boolean => b >= 0xe0 || LOWER_EXTRA.has(b);
const isLatin = (b: number | undefined): boolean => b !== undefined && ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a));

function utf16(bytes: Buffer, label: "utf-16le" | "utf-16be"): string | { refused: string } | undefined {
  const refused = { refused: materialsMessages().encodingUnknown };
  try {
    const text = new TextDecoder(label, { fatal: true }).decode(bytes.subarray(2));
    return CONTROL.test(text) ? undefined : text;
  } catch {
    return refused;
  }
}

function windows1251(bytes: Buffer): string | { refused: string } | undefined {
  if (bytes.some((b) => b <= 0x08 || (b >= 0x0e && b <= 0x1f) || b === 0x7f)) return undefined;
  let nonNeutral = 0, cyr = 0, lower = 0, nearLatin = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b < 0x80 || NEUTRAL.has(b)) continue;
    nonNeutral++;
    if (!isCyrillic(b)) continue;
    cyr++;
    if (isLower(b)) lower++;
    if (isLatin(bytes[i - 1]) || isLatin(bytes[i + 1])) nearLatin++;
  }
  if (cyr === 0 || cyr / nonNeutral < CP1251_MIN_CYRILLIC_SHARE || lower / cyr < CP1251_MIN_LOWER_SHARE
    || nearLatin / cyr > CP1251_MAX_LATIN_NEIGHBOR_SHARE) return { refused: materialsMessages().encodingUnknown };
  const text = new TextDecoder("windows-1251").decode(bytes);
  return CONTROL.test(text) ? undefined : text;
}

// string — text, undefined — non-text, { refused } — unsupported or undecodable encoding.
// head is the first bytes of the file (NUL check); readAll is called only when the file may be text.
export function decodeFileText(head: Buffer, readAll: () => Buffer): string | { refused: string } | undefined {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) {
    if (head.length >= 4 && head[2] === 0 && head[3] === 0) return { refused: materialsMessages().encodingUnknown };
    return utf16(readAll(), "utf-16le");
  }
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return utf16(readAll(), "utf-16be");
  if (head.length >= 4 && head.readUInt32BE(0) === 0xfeff) return { refused: materialsMessages().encodingUnknown }; // UTF-32 BE BOM
  if (head.includes(0)) return undefined;
  const bytes = readAll();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // a UTF-8 BOM before invalid UTF-8 is not Windows-1251 text
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { refused: materialsMessages().encodingUnknown };
    return windows1251(bytes);
  }
  return CONTROL.test(text) ? undefined : text;
}
