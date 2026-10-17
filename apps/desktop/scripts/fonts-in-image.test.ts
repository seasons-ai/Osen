import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FONT_FILES, missingFontFiles } from "./templates-in-image.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "council-fonts-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// this is how Vite names @fontsource files in out/renderer/assets: name, hash, extension
const built = (name: string) => `${name}-Ab12_cD.woff2`;
const fill = (files: string[]) => {
  mkdirSync(join(dir, "out/renderer/assets"), { recursive: true });
  for (const f of files) writeFileSync(join(dir, "out/renderer/assets", f), "x");
};

it("Interface fonts without a network: 10 woff2 are required — Plex Sans 400/500/600 and JetBrains Mono 400/500, Cyrillic and Latin", () => {
  expect(FONT_FILES).toHaveLength(10);
  expect(FONT_FILES).toContain("ibm-plex-sans-cyrillic-600-normal");
  expect(FONT_FILES).toContain("jetbrains-mono-latin-500-normal");
});

it("build with all files: nothing is missing; woff and foreign styles do not interfere", () => {
  fill([...FONT_FILES.map(built), "ibm-plex-sans-latin-400-normal-x.woff", "ibm-plex-sans-latin-ext-400-normal-y.woff2"]);
  expect(missingFontFiles(dir)).toEqual([]);
});

it("no JetBrains Mono cyrillic-500: it is in the missing list", () => {
  fill(FONT_FILES.filter((f) => f !== "jetbrains-mono-cyrillic-500-normal").map(built));
  expect(missingFontFiles(dir)).toEqual(["jetbrains-mono-cyrillic-500-normal"]);
});

it("only .woff without .woff2 and only latin-ext do not count", () => {
  fill(["jetbrains-mono-latin-400-normal-x.woff", "jetbrains-mono-latin-ext-400-normal-x.woff2"]);
  expect(missingFontFiles(dir)).toContain("jetbrains-mono-latin-400-normal");
  expect(missingFontFiles(dir)).toHaveLength(10);
});
