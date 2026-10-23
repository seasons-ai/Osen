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
function cp1251Ok(s: string): boolean {
  const b = enc1251(s);
  const cyr = b.filter((x) => x >= 0xc0 || [0xa8, 0xb8].includes(x));
  return cyr.length > 0 && cyr.filter((x) => x >= 0xe0 || x === 0xb8).length / cyr.length >= 0.5 && !validUtf8(b) && !/^(юя|яю)/.test(s);
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
    let tested = 0;
    for (const t of texts) {
      if (!cp1251Ok(t)) continue;
      tested++;
      expect(accepted(enc1251(t))).toBe(t);
    }
    expect(tested).toBeGreaterThan(100);
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
