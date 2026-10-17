import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LANGUAGE, LANGUAGE_NAMES, LANGUAGES, parseLanguage } from "./language.ts";
import { getProcessLanguage, setProcessLanguage } from "./process-language.ts";

describe("parseLanguage", () => {
  it("returns exact values as is", () => {
    expect(parseLanguage("en")).toBe("en");
    expect(parseLanguage("ru")).toBe("ru");
  });

  it("everything else — null", () => {
    for (const v of ["EN", " ru", "ru ", "de", "", undefined, null, 1, {}, ["ru"]]) expect(parseLanguage(v)).toBeNull();
  });

  it("default en, names exist for each language", () => {
    expect(DEFAULT_LANGUAGE).toBe("en");
    expect(Object.keys(LANGUAGE_NAMES)).toEqual([...LANGUAGES]);
  });
});

describe("process language", () => {
  const before = getProcessLanguage();
  afterEach(() => setProcessLanguage(before));

  // A global test setup may set ru, so the default is checked on a fresh module load.
  it("en by default", async () => {
    vi.resetModules();
    const fresh = await import("./process-language.ts");
    expect(fresh.getProcessLanguage()).toBe("en");
  });

  it("set changes the value", () => {
    setProcessLanguage("ru");
    expect(getProcessLanguage()).toBe("ru");
    setProcessLanguage("en");
    expect(getProcessLanguage()).toBe("en");
  });
});
