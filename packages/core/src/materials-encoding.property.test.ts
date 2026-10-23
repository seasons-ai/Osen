import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import "../scenarios/language-ru.ts";
import { collectMaterials, MaterialsError } from "./materials.ts";
import { enc1251, encKoi8r, utf16be, utf16le } from "./text-encoding.testutil.ts";

const opts = { materialsChars: 1_000_000, materialsIgnore: [] };
const root = realpathSync(mkdtempSync(join(tmpdir(), "materials-enc-prop-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const UP = [..."АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯЁ"];
const LOW = [..."абвгдежзийклмнопрстуфхцчшщъыьэюяё"];
const ASCII = [..."abcxyz0189.,;:-()"];

function randomText(r: () => number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    const x = r();
    if (x < 0.55) s += LOW[Math.floor(r() * LOW.length)];
    else if (x < 0.65) s += UP[Math.floor(r() * UP.length)];
    else if (x < 0.8) s += " ";
    else if (x < 0.86) s += "\n";
    else s += ASCII[Math.floor(r() * ASCII.length)];
  }
  return s;
}
// A Windows-1251 text is only decodable when it has Cyrillic with enough lowercase, is not accidentally valid UTF-8 (UTF-8 wins by design)
// and does not start with a letter pair that spells a UTF-16 BOM (FE FF, FF FE: "юя", "яю"; the BOM wins by design)
const validUtf8 = (b: Buffer) => { try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; } };
const latin = (x: number | undefined) => x !== undefined && /[A-Za-z]/.test(String.fromCharCode(x));
// the fourth condition: at most 20 % of Cyrillic letters touch a Latin ASCII letter
// Russian, Ukrainian and Belarusian letters, and their lowercase, as the requirement names them
const isCyr = (x: number) => x >= 0xc0 || [0xa8, 0xb8, 0xa1, 0xa2, 0xa5, 0xaa, 0xaf, 0xb2, 0xb3, 0xb4, 0xba, 0xbf].includes(x);
const isLow = (x: number) => x >= 0xe0 || [0xb8, 0xa2, 0xb3, 0xba, 0xbf, 0xb4].includes(x);
function nearLatinShare(s: string): number {
  const b = enc1251(s);
  const idx = [...b.keys()].filter((i) => isCyr(b[i]!));
  return idx.filter((i) => latin(b[i - 1]) || latin(b[i + 1])).length / idx.length;
}
const nearLatinOk = (s: string) => nearLatinShare(s) <= 0.2;
function cp1251BaseOk(s: string): boolean {
  const b = enc1251(s);
  const cyr = b.filter(isCyr);
  return cyr.length > 0 && cyr.filter(isLow).length / cyr.length >= 0.5 && !validUtf8(b) && !/^(юя|яю)/.test(s);
}
const cp1251Ok = (s: string) => cp1251BaseOk(s) && nearLatinOk(s);
// Russian words, `marked` of them with a Latin letter glued after the last Cyrillic letter
function gluedText(r: () => number, words: number, marked: number): string {
  return Array.from({ length: words }, (_, i) => {
    const w = Array.from({ length: 1 + Math.floor(r() * 4) }, () => LOW[Math.floor(r() * LOW.length)]).join("");
    return i < marked ? w + ASCII[Math.floor(r() * 6)] : w;
  }).join(" ");
}
// A Latin ASCII word of 2+ letters with 1-3 bytes C0-FF put inside or at an edge, as Latin-1 / Windows-1252 accented letters
function westernWord(r: () => number): number[] {
  const w = Array.from({ length: 2 + Math.floor(r() * 7) }, () => 0x61 + Math.floor(r() * 26) - (r() < 0.2 ? 0x20 : 0));
  for (let k = 1 + Math.floor(r() * 3); k > 0; k--) w.splice(Math.floor(r() * (w.length + 1)), 0, 0xc0 + Math.floor(r() * 64));
  return w;
}

let n = 0;
function accepted(buf: Buffer): string | MaterialsError {
  const f = join(root, `f${n++}.txt`);
  writeFileSync(f, buf);
  try { return collectMaterials([f], opts).materials[0]!.text; } catch (e) { if (e instanceof MaterialsError) return e; throw e; }
}

describe("property: text encodings round-trip exactly", () => {
  const edge = [
    "", "а", "Я", "ё", "аА", "аАаА", "ааАА", "аб Ёё\n", "«а» — б…", "x\n" + "я".repeat(4094) + "\n" + "я".repeat(10),
  ];
  it("UTF-16 LE/BE with BOM: any text including empty, single char, newline at the head boundary", () => {
    const r = rng(1212);
    const texts = [...edge, "\n".repeat(8191) + "\nа", "а".repeat(4095) + "\nб", ...Array.from({ length: 120 }, () => randomText(r, Math.floor(r() * 300)))];
    for (const t of texts) for (const enc of [utf16le, utf16be]) expect(accepted(enc(t))).toBe(t);
  });

  it("Windows-1251: decodable texts round-trip, including exactly the lowercase threshold and a newline at byte 8192", () => {
    const r = rng(1251);
    const texts = ["а", "аА", "аАаА", "я".repeat(8191) + "\nя", "я".repeat(8192) + "\n" + "Я".repeat(3), ...Array.from({ length: 150 }, () => randomText(r, 1 + Math.floor(r() * 400)))];
    // the fourth condition at its border: exactly 20 % of Cyrillic letters touch a Latin letter, and one more
    const border: string[] = [];
    for (let k = 1; k <= 12; k++) {
      const t = gluedText(r, k, k);
      // pad with lone Cyrillic letters until exactly 20 % (k of 5k); the padding is never empty, words have at most 4 letters
      const ok = t + " а".repeat(5 * k - enc1251(t).filter(isCyr).length);
      expect(nearLatinShare(ok), ok).toBe(0.2);
      expect(nearLatinShare(ok + "x"), ok).toBeGreaterThan(0.2);
      border.push(ok);
      texts.push(ok, ok + "x");
    }
    for (const t of border) expect(cp1251BaseOk(t), t).toBe(true);
    let tested = 0, nearLatinRefused = 0;
    for (const t of texts) {
      if (!cp1251BaseOk(t)) continue;
      const res = accepted(enc1251(t));
      if (nearLatinOk(t)) { tested++; expect(res, t).toBe(t); continue; }
      nearLatinRefused++;
      expect(res, t).toBeInstanceOf(MaterialsError);
      expect((res as MaterialsError).reasons[0], t).toContain("кодировка не распознана");
    }
    expect(tested).toBeGreaterThan(100);
    expect(nearLatinRefused).toBeGreaterThanOrEqual(12);
    // typographic punctuation does not hurt
    expect(accepted(enc1251("«а» — «б» … №1"))).toBe("«а» — «б» … №1");
  });

  it("UTF-8 with BOM: any text round-trips without U+FEFF", () => {
    const r = rng(8);
    for (let i = 0; i < 40; i++) {
      const t = randomText(r, Math.floor(r() * 200));
      expect(accepted(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(t)]))).toBe(t);
    }
  });

  it("too many non-Cyrillic non-neutral high bytes (50-89 % Cyrillic) are rejected", () => {
    const r = rng(90);
    for (let i = 0; i < 40; i++) {
      const cyr = 10 + Math.floor(r() * 30), other = Math.ceil(cyr * (0.15 + r() * 0.8)); // Cyrillic share 0.5 .. 0.87
      const bytes = [...Array(cyr).fill(0xe0), ...Array(other).fill(0xa3)];
      for (let k = bytes.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [bytes[k], bytes[j]] = [bytes[j]!, bytes[k]!]; }
      expect(accepted(Buffer.from(bytes.flatMap((b) => [b, 0x20])))).toBeInstanceOf(MaterialsError);
    }
  });

  it("Western 8-bit text (accented letters inside or at the edge of Latin words) is never accepted", () => {
    const r = rng(1252);
    const sep = [0x20, 0x20, 0x0a, 0x2c, 0x3b, 0x2e];
    // border: one accented letter per word, two-letter words
    expect(accepted(Buffer.from("de\xe9 a\xe0 \xfcb \xe9t", "latin1"))).toBeInstanceOf(MaterialsError);
    for (let i = 0; i < 80; i++) {
      const bytes = [0x4e, 0x3a, 0x20]; // "N: " keeps the head off a UTF-16 BOM
      for (let w = 1 + Math.floor(r() * 30); w > 0; w--) bytes.push(...westernWord(r), sep[Math.floor(r() * sep.length)]!);
      const res = accepted(Buffer.from(bytes));
      expect(res, Buffer.from(bytes).toString("latin1")).toBeInstanceOf(MaterialsError);
      expect((res as MaterialsError).reasons[0]).toContain("кодировка не распознана");
    }
  });

  it("KOI8-R text with capitals is never taken for Windows-1251", () => {
    const r = rng(8);
    for (let i = 0; i < 80; i++) {
      const t = "Привет " + randomText(r, 20 + Math.floor(r() * 200));
      const b = encKoi8r(t);
      if (validUtf8(b)) continue;
      // the heuristic can only say yes when the Windows-1251 view is mostly lowercase, i.e. the KOI8-R text is mostly uppercase
      const res = accepted(b);
      const up = [...t].filter((c) => UP.includes(c)).length, low = [...t].filter((c) => LOW.includes(c)).length;
      if (low > up) expect(res, t).toBeInstanceOf(MaterialsError);
    }
    // pure lowercase KOI8-R
    for (let i = 0; i < 20; i++) expect(accepted(encKoi8r(LOW.slice(0, 20 + i).join(" ")))).toBeInstanceOf(MaterialsError);
  });
});
