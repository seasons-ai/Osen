import { describe, expect, it } from "vitest";
import { formatDate, formatNumber, plural, type PluralForms } from "./format.ts";

// Intl puts non-breaking (including narrow) spaces in ru: we compare after replacing any whitespace with a plain one.
const n = (s: string) => s.replace(/\s/g, " ");

describe("formatNumber", () => {
  it("separators by language", () => {
    expect(formatNumber(12345.5, undefined, "en")).toBe("12,345.5");
    expect(n(formatNumber(12345.5, undefined, "ru"))).toBe("12 345,5");
  });
});

describe("formatDate", () => {
  it("day and month by language", () => {
    const d = new Date(2026, 9, 12);
    const o = { day: "numeric", month: "short" } as const;
    expect(formatDate(d, o, "en")).toBe("Oct 12");
    expect(formatDate(d, o, "ru")).toBe("12 окт.");
  });
});

describe("plural", () => {
  const en: PluralForms = { one: "round", other: "rounds" };
  const ru: PluralForms = { one: "круг", few: "круга", many: "кругов", other: "круга" };

  it("en: one and other", () => {
    expect([1, 3, 0].map((k) => `${k} ${plural(k, en, "en")}`)).toEqual(["1 round", "3 rounds", "0 rounds"]);
  });

  it("ru: one, few, many, fractional", () => {
    const got = [1, 3, 5, 11, 21, 22, 25, 1.5].map((k) => `${k} ${plural(k, ru, "ru")}`);
    expect(got).toEqual(["1 круг", "3 круга", "5 кругов", "11 кругов", "21 круг", "22 круга", "25 кругов", "1.5 круга"]);
  });

  it("missing category — other", () => {
    expect(plural(5, { one: "a", other: "o" }, "ru")).toBe("o");
    expect(plural(3, { one: "a", many: "m", other: "o" }, "ru")).toBe("o");
  });
});

describe("formatList", () => {
  it("conjunction-based list by language", async () => {
    const { formatList } = await import("./format.ts");
    expect(formatList(["1", "3"], "ru")).toBe("1 и 3");
    expect(formatList(["1", "2", "3"], "ru")).toBe("1, 2 и 3");
    expect(formatList(["1", "2", "3"], "en")).toBe("1, 2, and 3");
  });
});
