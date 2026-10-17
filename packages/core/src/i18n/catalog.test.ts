import { afterEach, describe, expect, it } from "vitest";
import { defineMessages } from "./catalog.ts";
import { getProcessLanguage, setProcessLanguage } from "./process-language.ts";

const M = defineMessages({
  en: { title: "Settings", greet: (name: string, n: number) => `Hi ${name}, ${n}` },
  ru: { title: "Настройки", greet: (name: string, n: number) => `Привет, ${name}, ${n}` },
});

describe("defineMessages", () => {
  const before = getProcessLanguage();
  afterEach(() => setProcessLanguage(before));

  it("follows the process language at call time", () => {
    setProcessLanguage("en");
    expect(M().title).toBe("Settings");
    setProcessLanguage("ru");
    expect(M().title).toBe("Настройки");
  });

  it("explicit language outranks the process language", () => {
    setProcessLanguage("ru");
    expect(M("en").title).toBe("Settings");
    setProcessLanguage("en");
    expect(M("ru").title).toBe("Настройки");
  });

  it("function messages receive arguments", () => {
    expect(M("en").greet("Ann", 2)).toBe("Hi Ann, 2");
    expect(M("ru").greet("Аня", 2)).toBe("Привет, Аня, 2");
  });
});

// Type check: lines with @ts-expect-error fail in npm run typecheck if the key check stops working.
describe("catalog types", () => {
  it("en and ru keys and signatures match", () => {
    // @ts-expect-error ru has no key b
    defineMessages({ en: { a: "a", b: "b" }, ru: { a: "а" } });
    // @ts-expect-error ru has an extra key b
    defineMessages({ en: { a: "a" }, ru: { a: "а", b: "б" } });
    // @ts-expect-error ru has an incompatible function signature
    defineMessages({ en: { a: (n: number) => `${n}` }, ru: { a: (n: string) => n } });
    // @ts-expect-error string in en, function in ru
    defineMessages({ en: { a: "a" }, ru: { a: () => "а" } });
    expect(true).toBe(true);
  });
});
