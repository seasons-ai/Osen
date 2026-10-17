import { afterEach, describe, expect, it } from "vitest";
import type { Language } from "@model-council/core/i18n";
import { moscowDay } from "@model-council/core/protocol";
import { formatCount, formatMoney, formatPrice } from "./usage-format.ts";
import { periodDays, periodLabel } from "./usage-summary.ts";

// Own seeded generator: fast-check is not used.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LANGS: Language[] = ["en", "ru"];
// Number from the language string: group separators (spaces, en comma) removed, ru comma becomes a dot.
const parse = (s: string, language: Language): number => Number(language === "en" ? s.replace(/,/g, "") : s.replace(/\s/g, "").replace(",", "."));
const digits = (s: string, language: Language): string => (s.split(language === "en" ? "." : ",")[1] ?? "");

// Bounds of small cost and random values of different magnitudes.
const EDGE = [0, 0.00001, 0.00004, 0.00005, 0.00009999, 0.0001, 0.00011, 0.5, 1, 3, 999.9999, 1000, 1000000, 1234567.891];
const amounts = (seed: number): number[] => {
  const r = mulberry32(seed);
  return [...EDGE, ...Array.from({ length: 300 }, () => Math.round(r() * 10 ** Math.floor(r() * 9) * 1e6) / 1e6 / (r() < 0.3 ? 1e4 : 1))];
};

const origTz = process.env["TZ"];
afterEach(() => { if (origTz === undefined) delete process.env["TZ"]; else process.env["TZ"] = origTz; });

describe("Requirement «Numbers, money and history dates by language»", () => {
  it("number from the string of both languages equals the original rounded to 4 digits", () => {
    for (const seed of [1, 2, 3]) for (const x of amounts(seed)) for (const language of LANGS) {
      const s = formatMoney(x, "USD", language).replace(/ USD$/, "");
      if (s.startsWith("< ")) { expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(0.0001); continue; }
      const v = parse(s, language);
      expect(Math.abs(v - x), `${language} ${x} → ${s}`).toBeLessThanOrEqual(0.5e-4 + 1e-9 * Math.abs(x));
      expect(digits(s, language).length).toBeLessThanOrEqual(4);
      expect(Math.abs(parse(formatPrice(x, language), language) - x)).toBeLessThanOrEqual(0.5e-6 + 1e-9 * Math.abs(x));
    }
    for (const n of [0, 1, 999, 1000, 1000000, 123456789]) for (const language of LANGS) expect(parse(formatCount(n, language), language)).toBe(n);
  });
  it("non-zero cost is not shown as zero, zero stays zero", () => {
    for (const seed of [4, 5]) for (const x of amounts(seed)) for (const language of LANGS) {
      const s = formatMoney(x, "$", language);
      if (x > 0) expect(s, `${language} ${x}`).not.toMatch(/^0(?:[.,]0*)? /);
      // Threshold exactly 0.0001: below it is always «<», otherwise rounding shows «0.0001» for the reported value.
      if (x > 0) expect(s.startsWith("< "), `${language} ${x}`).toBe(x < 0.0001);
      if (x === 0) expect(s).toBe("0 $");
    }
    expect([formatMoney(0.00001, "$", "en"), formatMoney(0.00001, "$", "ru"), formatMoney(0.0001, "$", "en")]).toEqual(["< 0.0001 $", "< 0,0001 $", "0.0001 $"]);
  });
  it("period day is the same in en and ru and does not depend on the system timezone", () => {
    const r = mulberry32(6);
    // Boundaries of Moscow day (21:00Z) ± one second and random moments.
    const base = Date.UTC(2026, 9, 8, 21, 0, 0);
    const moments = [-1000, 0, 1000, 86400000 - 1000, 86400000].map((d) => new Date(base + d));
    for (let i = 0; i < 100; i++) moments.push(new Date(Date.UTC(2026, 0, 1) + Math.floor(r() * 365 * 86400000)));
    const want = moments.map((now) => moscowDay(now));
    for (const tz of ["UTC", "Europe/Moscow", "Pacific/Kiritimati", "America/Los_Angeles", "Asia/Kolkata"]) {
      process.env["TZ"] = tz;
      moments.forEach((now, i) => {
        const days = periodDays({ mode: "today", from: "", to: "" }, now);
        expect(days, `${tz} ${now.toISOString()}`).toEqual({ from: want[i], to: want[i] });
        const d = days as { from: string; to: string };
        // Number in the label — the same day in both languages.
        const en = periodLabel({ mode: "today", from: "", to: "" }, d, "en"), ru = periodLabel({ mode: "today", from: "", to: "" }, d, "ru");
        expect(ru).toBe(`${d.from.slice(8)}.${d.from.slice(5, 7)}.${d.from.slice(0, 4)}`);
        expect(Number(/\d+(?=, \d{4})/.exec(en)?.[0]), `${tz} ${en}`).toBe(Number(d.from.slice(8)));
      });
    }
    // Entry at 23:30 Moscow on 8 October (20:30Z) stays in the day of 8 October in any timezone.
    for (const tz of ["UTC", "Pacific/Kiritimati", "America/Los_Angeles"]) {
      process.env["TZ"] = tz;
      expect(periodDays({ mode: "today", from: "", to: "" }, new Date("2026-10-08T20:30:00Z"))).toEqual({ from: "2026-10-08", to: "2026-10-08" });
    }
  });
  it("period label does not depend on the system timezone", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 40; i++) {
      const d = new Date(Date.UTC(2026, Math.floor(r() * 12), 1 + Math.floor(r() * 28))).toISOString().slice(0, 10);
      const labels = ["UTC", "Pacific/Kiritimati", "America/Los_Angeles"].map((tz) => { process.env["TZ"] = tz; return LANGS.map((l) => periodLabel({ mode: "range", from: d, to: d }, { from: d, to: d }, l)); });
      expect(labels[1]).toEqual(labels[0]);
      expect(labels[2]).toEqual(labels[0]);
    }
  });
});
