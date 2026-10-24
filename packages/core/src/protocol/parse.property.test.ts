import { describe, it, expect } from "vitest";
import { extractJsonObject } from "./parse.ts";

// Own seeded generator: fast-check is not wired in.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Copy of the former extractJsonObject: whole answer, fenced blocks, then a scan from every "{" to its pair.
function former(raw: string): Record<string, unknown> | undefined {
  const obj = (text: string) => {
    try { const v: unknown = JSON.parse(text); return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined; } catch { return undefined; }
  };
  const whole = obj(raw.trim());
  if (whole) return whole;
  for (let open = raw.indexOf("```"); open !== -1; ) {
    let body = open + 3;
    while (body < raw.length && raw[body] !== "\n" && raw[body] !== "`") body++;
    const close = raw.indexOf("```", body);
    if (close === -1) break;
    const o = obj(raw.slice(body, close).trim());
    if (o) return o;
    open = raw.indexOf("```", close + 3);
  }
  const matchingBrace = (start: number) => {
    let depth = 0, inString = false;
    for (let i = start; i < raw.length; i++) {
      const c = raw[i];
      if (inString) { if (c === "\\") i++; else if (c === "\"") inString = false; }
      else if (c === "\"") inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return i;
    }
    return -1;
  };
  for (let i = raw.indexOf("{"); i !== -1; i = raw.indexOf("{", i + 1)) {
    const end = matchingBrace(i);
    if (end === -1) continue;
    const o = obj(raw.slice(i, end + 1));
    if (o) return o;
  }
  return undefined;
}

// Pieces: nested objects, strings with braces, escaped quotes and backslashes, unpaired braces and quotes and backslashes
// outside strings, fenced blocks, plain text.
const PIECES = [
  "{", "{", "{", "}", "}", "\"", "\\", "\\\"", " ", "a", ":", ",", "1", "\n", "```", "```json\n",
  '{"a":1}', '{"b":{"c":2}}', '{"s":"}"}', '{"s":"{"}', '{"q":"\\""}', '{"e":"\\\\"}', '"{"', '"}"', '"a {', "{bad}", "[1]",
];
function generate(rand: () => number, pieces: number): string {
  let s = "";
  for (let k = 0; k < pieces; k++) s += PIECES[Math.floor(rand() * PIECES.length)];
  return s;
}

describe("Bounded fenced response extraction", () => {
  it("Непарная скобка перед парной: an unpaired brace before a balanced object", () => {
    expect(extractJsonObject("{ {}")).toEqual({});
    expect(extractJsonObject('{ {"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('{"x": "}" {"a":1}')).toEqual({ a: 1 });
  });

  it("Кавычка вне строки меняет состояние строки у следующей скобки: the string state counts from each candidate", () => {
    expect(extractJsonObject('{"a {}')).toEqual({});
    const raw = '{"x {"a":1} "';
    expect(extractJsonObject(raw)).toEqual(former(raw));
    expect(former(raw)).toEqual({ a: 1 });
  });

  it("Эквивалентность прежнему алгоритму на любом входе: generated texts over 2,000 seeds", () => {
    let found = 0, unpairedQuoteOutside = 0;
    for (let seed = 1; seed <= 2_000; seed++) {
      const rand = mulberry32(seed);
      const raw = generate(rand, Math.floor(rand() * 41));
      const expected = former(raw);
      expect(extractJsonObject(raw), `seed ${seed}: ${JSON.stringify(raw)}`).toEqual(expected);
      if (expected !== undefined) found++;
      if (/^[^"]*"[^"]*$/.test(raw)) unpairedQuoteOutside++;
    }
    // The generator reaches both outcomes and texts with an odd quote.
    expect(found).toBeGreaterThan(200);
    expect(found).toBeLessThan(1_900);
    expect(unpairedQuoteOutside).toBeGreaterThan(0);
  });
});
