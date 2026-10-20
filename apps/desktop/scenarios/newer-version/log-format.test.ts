import { describe, it, expect } from "vitest";
import { oneLine } from "./log-format.ts";

// Own seeded generator: fast-check is not wired in.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BREAKS = ["\n", "\r\n", "\r"];
const WORDS = ["", "Тема s1", "прочитано до события №3", "a · b", " "];

// Body as alternating text pieces and breaks: empty, single-line, repeated and mixed breaks.
function generate(seed: number): { body: string; pieces: string[] } {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const breaks = seed % 4 === 0 ? 0 : 1 + int(5);
  const pieces = Array.from({ length: breaks + 1 }, () => WORDS[int(WORDS.length)]!);
  let body = "";
  pieces.forEach((p, i) => {
    body += p;
    if (i === breaks) return;
    const br = BREAKS[int(BREAKS.length)]!;
    // A lone CR followed by LF would read as one CRLF break.
    body += body.endsWith("\r") && br === "\n" ? "\r\n" : br;
  });
  return { body, pieces };
}

describe("Notification diagnostic body formatting", () => {
  it("every line break becomes one separator, text and order are kept, the raw body is unchanged", () => {
    for (let seed = 0; seed < 500; seed++) {
      const { body, pieces } = generate(seed);
      const raw = body;
      const line = oneLine(body);
      expect(line, JSON.stringify(body)).not.toMatch(/[\r\n]/);
      expect(line, JSON.stringify(body)).toBe(pieces.join(" · "));
      expect(body).toBe(raw);
    }
  });

  it("boundary bodies", () => {
    expect(oneLine("")).toBe("");
    expect(oneLine("Тема s1")).toBe("Тема s1");
    expect(oneLine("a\r\nb")).toBe("a · b");
    expect(oneLine("a\n\nb")).toBe("a ·  · b");
    expect(oneLine("a\rb\nc\r\n")).toBe("a · b · c · ");
  });
});
