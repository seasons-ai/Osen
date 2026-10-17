import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Former product names must not appear in any renderer or main catalog in both languages
describe("message catalogs: the Osen name", () => {
  const files = readdirSync(import.meta.dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it.each(files)("%s: нет «Model Council» и «Мозговой штурм»", async (file) => {
    const mod = (await import(join(import.meta.dirname, file))) as Record<string, unknown>;
    const catalogs = Object.values(mod).filter((v): v is (l: "en" | "ru") => Record<string, unknown> => typeof v === "function");
    expect(catalogs.length).toBeGreaterThan(0);
    for (const catalog of catalogs) for (const language of ["en", "ru"] as const) {
      for (const [key, value] of Object.entries(catalog(language) ?? {})) {
        const text = String(value);
        expect(text, `${file} ${language}.${key}`).not.toMatch(/Model Council|Мозговой штурм/);
      }
    }
  });

  it("the Osen name in both languages, the rail letter is not in the dictionary (the rail shows the mark)", async () => {
    const { shell } = await import("./shell.ts");
    const { resultMain } = await import("./result-main.ts");
    for (const language of ["en", "ru"] as const) {
      expect(shell(language).appName).toBe("Osen");
      expect(Object.keys(shell(language))).not.toContain("brandLetter");
    }
    expect([resultMain("en").docTitle, resultMain("ru").docTitle]).toEqual(["Osen: discussion", "Osen: обсуждение"]);
  });
});
