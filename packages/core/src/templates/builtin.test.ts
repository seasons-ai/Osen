import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LANGUAGES } from "../i18n/language.ts";
import type { Language } from "../i18n/language.ts";
import { BUILTIN_TEMPLATES_DIR, NEUTRAL_FRAMING_FILE, loadTemplates, userTemplatesDir } from "./templates.ts";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "council-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const SETS: Record<Language, { categories: string[]; framing: [string, string] }> = {
  ru: {
    categories: ["Архитектура и код", "Продукт и стратегия", "Выбор и решения", "Разбор проблем", "Тексты и коммуникации"],
    framing: ["Как вести обсуждение:", "В каком виде выдать решение:"],
  },
  en: {
    categories: ["Architecture and code", "Product and strategy", "Choices and decisions", "Problem analysis", "Writing and communication"],
    framing: ["How to run the discussion:", "Decision format:"],
  },
};
// Clean data folder: no user templates.
const load = (language: Language) => loadTemplates({ builtinDir: BUILTIN_TEMPLATES_DIR, userDir: userTemplatesDir(tmp()), language });

describe.each(LANGUAGES)("встроенный набор шаблонов: %s", (language) => {
  const catalog = load(language);
  const { categories, framing } = SETS[language];
  const bad = (pred: (t: (typeof catalog.templates)[number]) => boolean) => catalog.templates.filter((t) => !pred(t)).map((t) => t.id);

  it("1. no load errors", () => {
    expect(catalog.errors).toEqual([]);
  });

  it("2. at least 12 templates, all built-in", () => {
    expect(catalog.templates.length).toBeGreaterThanOrEqual(12);
    expect(bad((t) => t.source === "builtin")).toEqual([]);
  });

  it("3. at least 4 categories, all from the spec list", () => {
    const cats = new Set(catalog.templates.map((t) => t.category));
    expect(cats.size).toBeGreaterThanOrEqual(4);
    expect([...cats].filter((c) => !categories.includes(c))).toEqual([]);
  });

  it("4. at least two different roles", () => {
    expect(bad((t) => new Set(t.roles).size >= 2)).toEqual([]);
  });

  it("5. file name equals <id>.json", () => {
    expect(bad((t) => basename(t.file) === `${t.id}.json`)).toEqual([]);
  });

  it("6. the frame contains both substrings", () => {
    expect(bad((t) => t.framing.includes(framing[0]) && t.framing.includes(framing[1]))).toEqual([]);
  });
});

describe("Built-in templates in two languages: matching set structure", () => {
  const shape = (language: Language) => new Map(load(language).templates.map((t) => [t.id, { roles: t.roles.length, limits: t.limits }]));
  const [en, ru] = [shape("en"), shape("ru")];

  it("same identifiers, number of roles and limits", () => {
    expect([...en.keys()].sort()).toEqual([...ru.keys()].sort());
    for (const [id, s] of ru) expect(en.get(id), id).toEqual(s);
  });

  it("the neutral frame is in both sets", () => {
    expect(LANGUAGES.filter((l) => !existsSync(join(BUILTIN_TEMPLATES_DIR, l, NEUTRAL_FRAMING_FILE)))).toEqual([]);
  });

  it("English set without Russian text", () => {
    const cyr = load("en").templates.filter((t) => /[а-яё₽]/i.test(JSON.stringify(t))).map((t) => t.id);
    expect(cyr).toEqual([]);
  });
});
