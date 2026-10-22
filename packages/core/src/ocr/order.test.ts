import { describe, expect, it } from "vitest";
import { orderLines, type OcrLine } from "./order.ts";

// mulberry32: a small seeded generator, so a failing layout is reproducible
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function layout(seed: number): { input: OcrLine[]; expected: string } {
  const rand = prng(seed);
  const rows = Math.floor(rand() * 8); // 0 and 1 included
  const input: OcrLine[] = [];
  const expected: string[] = [];
  for (let r = 0; r < rows; r++) {
    const words = 1 + Math.floor(rand() * 4);
    const row: string[] = [];
    for (let k = 0; k < words; k++) {
      const t = `r${r}w${k}`;
      row.push(t);
      input.push({ t, x: 0.02 + k * 0.22 + rand() * 0.05, y: 0.02 + r * 0.12 + (rand() - 0.5) * 0.01, w: 0.15, h: 0.05 });
    }
    expected.push(row.join(" "));
  }
  for (let i = input.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [input[i], input[j]] = [input[j]!, input[i]!];
  }
  return { input, expected: expected.join("\n") };
}

describe("orderLines", () => {
  it("returns lines top to bottom and left to right for generated layouts, whatever the input order", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { input, expected } = layout(seed);
      expect(orderLines(input), `seed ${seed}`).toBe(expected);
    }
  });

  it("handles empty input, one record and blank texts", () => {
    expect(orderLines([])).toBe("");
    expect(orderLines([{ t: "  one  ", x: 0, y: 0, w: 1, h: 1 }])).toBe("one");
    expect(orderLines([{ t: "  ", x: 0, y: 0, w: 1, h: 1 }])).toBe("");
  });

  it("gives the same result for identical records in any order", () => {
    const a: OcrLine = { t: "b", x: 0.1, y: 0.1, w: 0.1, h: 0.1 };
    const b: OcrLine = { t: "a", x: 0.1, y: 0.1, w: 0.1, h: 0.1 };
    expect(orderLines([a, b])).toBe(orderLines([b, a]));
  });
});
