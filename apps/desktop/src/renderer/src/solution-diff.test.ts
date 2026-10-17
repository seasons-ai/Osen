import { describe, expect, it } from "vitest";
import { MAX_CHARS, MAX_WORDS, diffSolution } from "./solution-diff.ts";
import type { DiffPart } from "./solution-diff.ts";

const words = (s: string) => s.match(/\S+/g)?.length ?? 0;
const same = (text: string): DiffPart => ({ kind: "same", text });
const add = (text: string): DiffPart => ({ kind: "add", text });
const del = (text: string): DiffPart => ({ kind: "del", text });
const rep = (w: string, n: number) => Array.from({ length: n }, () => w).join(" ");

// Invariants 1 and 2 + consistency of counters; returns the result for further checks.
function check(prev: string, next: string) {
  const d = diffSolution(prev, next);
  expect(d.parts.filter((p) => p.kind !== "del").map((p) => p.text).join("")).toBe(next);
  d.parts.forEach((p, i) => {
    expect(p.text).not.toBe("");
    if (i > 0) expect(p.kind).not.toBe(d.parts[i - 1]!.kind);
  });
  const sum = (k: DiffPart["kind"]) => d.parts.filter((p) => p.kind === k).reduce((n, p) => n + words(p.text), 0);
  expect(d.added).toBe(sum("add"));
  expect(d.removed).toBe(sum("del"));
  return d;
}

describe("diffSolution: word mode", () => {
  it("word replacement", () => {
    expect(check("Один старый план", "Один новый план")).toEqual({
      parts: [same("Один "), del("старый"), add("новый"), same(" план")], added: 1, removed: 1, byLines: false,
    });
  });

  it("word addition", () => {
    const d = check("Один план", "Один новый план");
    expect(d.parts).toEqual([same("Один "), add("новый"), same(" план")]);
    expect([d.added, d.removed]).toEqual([1, 0]);
  });

  it("word deletion at the start, in the middle and at the end", () => {
    expect(check("лишнее Один план", "Один план").parts).toEqual([del("лишнее"), same("Один план")]);
    expect(check("Один лишнее план", "Один план").parts).toEqual([same("Один "), del("лишнее"), same("план")]);
    const end = check("Один план лишнее", "Один план");
    expect(end.parts).toEqual([same("Один план"), del("лишнее")]);
    expect([end.added, end.removed]).toEqual([0, 1]);
  });

  it("repeated words: counters are minimal", () => {
    const d = check("а а б а", "а б а а");
    expect([d.added, d.removed]).toEqual([1, 1]);
  });

  it("Cyrillic, punctuation and case", () => {
    expect(check("наш план.", "наш план").parts).toEqual([same("наш "), del("план."), add("план")]);
    expect(check("План", "план").parts).toEqual([del("План"), add("план")]);
    expect(check("Привет, мир", "Привет, новый мир").added).toBe(1);
  });

  it("equal texts", () => {
    const d = check("Один  план\nдва", "Один  план\nдва");
    expect(d).toEqual({ parts: [same("Один  план\nдва")], added: 0, removed: 0, byLines: false });
  });

  it("empty strings", () => {
    expect(check("", "а").parts).toEqual([add("а")]);
    expect(check("а", "").parts).toEqual([del("а")]);
    expect(check("", "")).toEqual({ parts: [], added: 0, removed: 0, byLines: false });
  });

  it("only spaces and line breaks changed", () => {
    const d = check("один два  три", "один\nдва три\n");
    expect(d).toEqual({ parts: [same("один\nдва три\n")], added: 0, removed: 0, byLines: false });
  });

  it("several added words in a row with a line break between them — one add part", () => {
    const d = check("начало конец", "начало новое\nслово конец");
    expect(d.parts).toEqual([same("начало "), add("новое\nслово"), same(" конец")]);
    expect(d.added).toBe(2);
  });
});

describe("diffSolution: thresholds", () => {
  it("2000 words — still words, 2001 — lines (for prev and for next)", () => {
    const ok = rep("с", MAX_WORDS);
    const big = rep("с", MAX_WORDS + 1);
    expect(check(ok, ok).byLines).toBe(false);
    expect(check(big, ok).byLines).toBe(true);
    expect(check(ok, big).byLines).toBe(true);
  });

  it("20000 characters — still words, 20001 — lines (for prev and for next)", () => {
    const ok = "я".repeat(MAX_CHARS);
    const big = "я".repeat(MAX_CHARS + 1);
    expect(check(ok, "я").byLines).toBe(false);
    expect(check(ok, ok).byLines).toBe(false);
    expect(check(big, "я").byLines).toBe(true);
    expect(check("я", big).byLines).toBe(true);
  });

  it("a word of 20001 characters — line mode", () => {
    const d = check("а", "я".repeat(20001));
    expect(d.byLines).toBe(true);
    expect([d.added, d.removed]).toEqual([1, 1]);
  });

  it("two texts of 2000 different words are compared quickly", () => {
    const a = Array.from({ length: MAX_WORDS }, (_, i) => `a${i}`).join(" ");
    const b = Array.from({ length: MAX_WORDS }, (_, i) => `b${i}`).join(" ");
    const t = Date.now();
    const d = check(a, b);
    expect(Date.now() - t).toBeLessThan(2000);
    expect([d.added, d.removed, d.byLines]).toEqual([MAX_WORDS, MAX_WORDS, false]);
  });
});

describe("diffSolution: line mode", () => {
  it("example with 2001 words: the middle is replaced entirely", () => {
    const mid = (w: string) => `${rep("слово", 1000)} ${w} ${rep("слово", 1000)}\n`;
    const d = check(`Начало\n${mid("слово").trimEnd()}\nКонец`, `Начало\n${mid("новое").trimEnd()}\nКонец`);
    expect(d.byLines).toBe(true);
    expect(d.parts).toEqual([
      same("Начало\n"),
      del(`${rep("слово", 2001)}\n`),
      add(`${rep("слово", 1000)} новое ${rep("слово", 1000)}\n`),
      same("Конец"),
    ]);
    expect([d.added, d.removed]).toEqual([2001, 2001]);
  });

  it("many short lines, a change in the middle", () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `строка ${i}\n`);
    const changed = lines.slice();
    changed[1200] = "другая\n";
    const d = check(lines.join(""), changed.join(""));
    expect(d.parts).toHaveLength(4);
    expect(d.parts[1]).toEqual(del("строка 1200\n"));
    expect(d.parts[2]).toEqual(add("другая\n"));
    expect([d.added, d.removed]).toEqual([1, 2]);
  });

  it("identical long texts", () => {
    const t = `${rep("слово", 2500)}\nвторая строка`;
    const d = check(t, t);
    expect(d).toEqual({ parts: [same(t)], added: 0, removed: 0, byLines: true });
  });

  it("only lines added at the end", () => {
    const base = Array.from({ length: 2100 }, () => "слово\n").join("");
    const d = check(base, `${base}новая строка`);
    expect(d.parts).toEqual([same(base), add("новая строка")]);
    expect([d.added, d.removed]).toEqual([2, 0]);
  });
});
