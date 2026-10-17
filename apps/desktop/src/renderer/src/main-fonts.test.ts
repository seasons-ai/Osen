import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const imports = [...main.matchAll(/^import\s+"([^"]+)";/gm)].map((m) => m[1]!);
const fonts = [
  ...["cyrillic", "latin"].flatMap((s) => ["400", "500", "600"].map((w) => `@fontsource/ibm-plex-sans/${s}-${w}.css`)),
  ...["cyrillic", "latin"].flatMap((s) => ["400", "500"].map((w) => `@fontsource/jetbrains-mono/${s}-${w}.css`)),
];

it("interface fonts without network: main.tsx loads 10 @fontsource files before the tokens", () => {
  const tokens = imports.findIndex((i) => i.endsWith("brand/tokens.css"));
  expect(tokens).toBeGreaterThan(-1);
  for (const f of fonts) {
    const at = imports.indexOf(f);
    expect(at, f).toBeGreaterThan(-1);
    expect(at, `${f} после токенов`).toBeLessThan(tokens);
  }
});
