import { describe, expect, it } from "vitest";
import { extractDocument } from "./detect.ts";
import { DOC_LIMITS } from "./extract.ts";
import { makeXlsx, type XlsxCell } from "./fixture.ts";

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEEDS = 300;
const MAX_SHEETS = 4, MAX_ROWS = 6, MAX_COLS = 6;
const WORDS = ["a", "б", "word", "x y", "tab\there", "line\nbreak", "cr\r\nlf", "mix\t\n\rend", "😀", "42"];

interface Sheet { name: string; rows: (string | null)[][] }

function generate(seed: number): Sheet[] {
  const rnd = mulberry32(seed);
  const int = (n: number): number => Math.floor(rnd() * n);
  // the first seeds pin the bounds: no sheet, one empty sheet, one cell, the maximum
  if (seed === 1) return [{ name: "E", rows: [] }];
  if (seed === 2) return [{ name: "One", rows: [["v"]] }];
  if (seed === 3) return Array.from({ length: MAX_SHEETS }, (_, s) => ({ name: `S${s}`, rows: Array.from({ length: MAX_ROWS }, (_, r) => Array.from({ length: MAX_COLS }, (_, c) => `${s}${r}${c}`)) }));
  return Array.from({ length: 1 + int(MAX_SHEETS) }, (_, s) => ({
    name: `Sheet ${s}`,
    rows: Array.from({ length: int(MAX_ROWS + 1) }, () =>
      Array.from({ length: int(MAX_COLS + 1) }, () => rnd() < 0.35 ? null : WORDS[int(WORDS.length)]! + int(100))),
  }));
}

const flat = (s: string): string => s.replace(/\r\n|[\t\n\r]/g, " ");

// What the spec says the text must be, computed from the original values.
function expected(sheets: Sheet[]): string {
  const blocks = sheets.map((sh) => [`# ${sh.name}`, ...sh.rows.flatMap((row) => {
    let last = row.length - 1;
    while (last >= 0 && row[last] === null) last--;
    return last < 0 ? [] : [row.slice(0, last + 1).map((c) => flat(c ?? "")).join("\t")];
  })].join("\n"));
  return blocks.join("\n\n");
}

describe("XLSX text: order and preservation of values", () => {
  it("random books give the original sheets, rows and values in order", () => {
    let sawEmptySheet = false, sawSingleCell = false, sawMax = false;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const sheets = generate(seed);
      const cells = sheets.flatMap((s) => s.rows.flat()).filter((c) => c !== null).length;
      if (sheets.some((s) => s.rows.flat().every((c) => c === null))) sawEmptySheet = true;
      if (cells === 1) sawSingleCell = true;
      if (sheets.length === MAX_SHEETS && sheets.every((s) => s.rows.length === MAX_ROWS && s.rows.every((r) => r.length === MAX_COLS))) sawMax = true;
      const bytes = makeXlsx({ scramble: seed % 2 === 0, sheets: sheets.map((s) => ({ name: s.name, rows: s.rows as XlsxCell[][] })) });
      const r = extractDocument(bytes, DOC_LIMITS);
      const ctx = `seed ${seed}`;
      if (cells === 0) expect(r, ctx).toEqual({ ok: false, code: "no_text" });
      else expect(r, ctx).toEqual({ ok: true, text: expected(sheets), format: "xlsx" });
    }
    expect({ sawEmptySheet, sawSingleCell, sawMax }).toEqual({ sawEmptySheet: true, sawSingleCell: true, sawMax: true });
  });
});
