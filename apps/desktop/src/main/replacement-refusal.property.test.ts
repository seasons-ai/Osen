import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { setProcessLanguage } from "@model-council/core/i18n";
import { nameReplacements, resumeScenarioPath } from "./resume.ts";

// Own seeded generator: fast-check is not used.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEGMENTS = ["Desktop", "Мозговой штурм", "packages", "core", "scenarios", "dropout", "a b", "«x»", "it's", "v1.2", "..x", "ё", "p3.json"];
const FILES = ["p3.json", "сценарий.json", "a b.json", "x", ".hidden", "«q».json", "dropout"];

// Absolute path: the root is the home folder, the project folder or "/"; the file name sometimes coincides with one of the folders; sometimes a trailing "/".
function generate(seed: number): string {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const roots = [homedir(), process.cwd(), ""];
  const dirs = Array.from({ length: Math.floor(rnd() * 6) }, () => pick(SEGMENTS));
  const file = rnd() < 0.2 && dirs.length ? pick(dirs) : pick(FILES);
  return `${pick(roots)}/${[...dirs, file].join("/")}${rnd() < 0.1 ? "/" : ""}`;
}

describe("A replacement refusal from the window does not repeat a file system path", () => {
  afterEach(() => { setProcessLanguage("ru"); });
  const providers = [{ id: "scripted", label: "Сценарный", defaultModel: null }];
  // The catalog answers any name, even an absolute path: the refusal must come from the path check itself.
  const sp = resumeScenarioPath(() => "/catalog/hit.json");

  for (const lang of ["en", "ru"] as const) {
    it(`${lang}: 300 absolute paths — the refusal has the file name, no path and no parent folder`, () => {
      setProcessLanguage(lang);
      for (let seed = 1; seed <= 300; seed++) {
        const model = generate(seed);
        let message = "";
        try { nameReplacements([{ participantId: "p2", providerId: "scripted", model }], [], providers, sp); } catch (e) { message = (e as Error).message; }
        const where = `зерно ${seed}, путь ${model}`;
        expect(message, where).not.toBe("");
        expect(message, where).not.toContain(model);
        expect(message, where).not.toContain(dirname(model) === "/" ? model : `${dirname(model)}/`);
        expect(message, where).not.toContain(homedir());
        expect(message, where).toContain(basename(model));
      }
    });
  }
});
