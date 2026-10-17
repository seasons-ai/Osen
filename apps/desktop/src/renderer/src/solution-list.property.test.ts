import { describe, expect, it } from "vitest";
import { parseNumberedList } from "./solution-list.ts";

// Own seeded generator: fast-check is not used.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEXTS = ["Принять тариф", "Версия 2.0 до 15.03", "см. https://example.com/a?b=1.2", "100 пунктов, 3) раза", "a", "  два  пробела ", "1. вложенный номер", "Ёж"];
const pick = <T,>(r: () => number, a: T[]): T => a[Math.floor(r() * a.length)] as T;

type Gen = { text: string; lines: string[]; markers: string[]; items: string[] };

// List of n items: numbers of 1–3 digits, markers "." and ")", empty lines between, \n or \r\n.
function genList(r: () => number, n: number): Gen {
  const eol = r() < 0.3 ? "\r\n" : "\n";
  const lines: string[] = [], markers: string[] = [], items: string[] = [];
  let text = "";
  for (let i = 0; i < n; i++) {
    const marker = `${Math.floor(r() * 10 ** (1 + Math.floor(r() * 3)))}${r() < 0.5 ? "." : ")"} `;
    const item = pick(r, TEXTS);
    markers.push(marker); items.push(item); lines.push(marker + item);
    text += marker + item + eol;
    while (r() < 0.3) text += (r() < 0.5 ? "" : "  ") + eol;
  }
  return { text, lines, markers, items };
}

describe("Requirement „Solution panel view per osen mockup“: numbered list", () => {
  it("items without numbers, nothing lost or changed", () => {
    for (const seed of [1, 2, 3, 4]) {
      const r = mulberry32(seed);
      for (let k = 0; k < 300; k++) {
        const n = 2 + Math.floor(r() * 6);
        const g = genList(r, n);
        const res = parseNumberedList(g.text);
        expect(res, g.text).not.toBeNull();
        expect(res!.length).toBe(n);
        expect(res!.map((x, i) => g.markers[i] + x)).toEqual(g.lines);
        expect(res).toEqual(g.items);
      }
    }
  });

  it("one numbered line — null", () => {
    for (const seed of [5, 6]) {
      const r = mulberry32(seed);
      for (let k = 0; k < 200; k++) expect(parseNumberedList(genList(r, 1).text)).toBeNull();
    }
  });

  it("line without a number, a 4-digit number and an indent before digits — null", () => {
    const r = mulberry32(7);
    const bad = ["Абзац без номера", "1234. четыре цифры", " 1. отступ", "1.нет пробела", "1 . x", "- пункт"];
    for (let k = 0; k < 300; k++) {
      const g = genList(r, 2 + Math.floor(r() * 4));
      const lines = g.text.split(/\r?\n/);
      const at = Math.floor(r() * (lines.length + 1));
      lines.splice(at, 0, pick(r, bad));
      expect(parseNumberedList(lines.join("\n")), lines.join("|")).toBeNull();
    }
  });

  it("examples", () => {
    expect(parseNumberedList("1. a\n2. b\n3. c\n4. d")).toEqual(["a", "b", "c", "d"]);
    expect(parseNumberedList("1. Принять тариф")).toBeNull();
    expect(parseNumberedList("Абзац\n\nещё")).toBeNull();
    expect(parseNumberedList("1) x\n\n10. y")).toEqual(["x", "y"]);
    expect(parseNumberedList("1. a\r\n2. b\r\n")).toEqual(["a", "b"]);
    expect(parseNumberedList("1. a\n1234. b")).toBeNull();
  });
});
