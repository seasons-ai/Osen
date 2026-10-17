import { describe, expect, it } from "vitest";
import { formatTokens } from "./session-ui.tsx";

// Own seeded generator: fast-check is not used.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EDGE = [0, 999, 1000, 1049, 1050, 999999, 1000000, 1234567];
const values = (seed: number): number[] => {
  const r = mulberry32(seed);
  return [...EDGE, ...Array.from({ length: 400 }, () => Math.floor(r() * 10 ** (1 + Math.floor(r() * 7))))];
};
// «x.yk» → x.y * 1000 (in tenths, without fractional error); without «k» — the number itself.
const value = (s: string): number => (s.endsWith("k") ? Math.round(Number(s.slice(0, -1)) * 10) * 100 : Number(s));

describe("Solution panel view per osen mockup: formatTokens", () => {
  it("table of bounds", () => {
    const table: [number, string][] = [[0, "0"], [999, "999"], [1000, "1.0k"], [1049, "1.0k"], [1050, "1.0k"], [31200, "31.2k"], [999999, "999.9k"], [1234567, "1234.5k"]];
    for (const [n, s] of table) expect(formatTokens(n)).toBe(s);
  });
  it("monotonic: a ≤ b ⇒ value does not decrease", () => {
    const v = [...new Set(values(1))].sort((a, b) => a - b);
    for (let i = 1; i < v.length; i++) expect(value(formatTokens(v[i]!))).toBeGreaterThanOrEqual(value(formatTokens(v[i - 1]!)));
  });
  it("truncation down: value ≤ n < value + 100", () => {
    for (const n of values(2).filter((x) => x >= 1000)) {
      const w = value(formatTokens(n));
      expect(w).toBeLessThanOrEqual(n);
      expect(n).toBeLessThan(w + 100);
    }
  });
  it("not «1000.0k» up to a million and not «0.0k»", () => {
    for (const n of values(3)) {
      const s = formatTokens(n);
      if (n < 1_000_000) expect(s).not.toBe("1000.0k");
      expect(s).not.toBe("0.0k");
    }
  });
});
