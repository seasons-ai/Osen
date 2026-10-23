import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setProcessLanguage } from "../i18n/process-language.ts";
import { collectMaterials } from "../materials.ts";
import { makeDocx, makePptx, makeXlsx, p, sp } from "./fixture.ts";

const SLOW = 120_000;
const WML = "application/vnd.openxmlformats-officedocument.wordprocessingml";
const SML = "application/vnd.openxmlformats-officedocument.spreadsheetml";
const PML = "application/vnd.openxmlformats-officedocument.presentationml";
type Kind = "docx" | "xlsx" | "pptx";
const VARIANTS: { kind: Kind; type: string }[] = [
  { kind: "docx", type: `${WML}.template.main+xml` }, { kind: "docx", type: "application/vnd.ms-word.template.macroEnabledTemplate.main+xml" },
  { kind: "xlsx", type: `${SML}.template.main+xml` }, { kind: "xlsx", type: "application/vnd.ms-excel.template.macroEnabled.main+xml" },
  { kind: "pptx", type: `${PML}.template.main+xml` }, { kind: "pptx", type: "application/vnd.ms-powerpoint.template.macroEnabled.main+xml" },
  { kind: "pptx", type: `${PML}.slideshow.main+xml` }, { kind: "pptx", type: "application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml" },
];
const NAMES = ["a.zip", "a.docx", "a.bin", "noext", "шаблон.zip", "документ"];
const SLIDES = [{ shapes: sp(["один"]) }, { shapes: sp(["два"]) }];
const SHEETS = [{ name: "План", rows: [["x", 1]] }];

// mulberry32: a seeded generator, the same sequence on every run
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const build = (kind: Kind, mainType: string | undefined, macro: boolean): Uint8Array =>
  kind === "docx" ? makeDocx({ body: p("текст"), mainType, macro }) : kind === "xlsx" ? makeXlsx({ sheets: SHEETS, mainType, macro }) : makePptx({ slides: SLIDES, mainType, macro });

let root: string;
beforeAll(() => { setProcessLanguage("ru"); root = realpathSync(mkdtempSync(join(tmpdir(), "ooxml-prop-"))); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("OOXML variants (seeded)", () => {
  it("any template or slideshow under any name is one material with the main-format text", () => {
    const next = rng(222);
    for (let i = 0; i < 32; i++) {
      const v = VARIANTS[Math.floor(next() * VARIANTS.length)]!;
      const name = NAMES[Math.floor(next() * NAMES.length)]!;
      const macro = next() < 0.5;
      const file = join(root, `${i}-${name}`);
      writeFileSync(file, build(v.kind, v.type, macro));
      const ref = join(root, `${i}-ref.${v.kind}`);
      writeFileSync(ref, build(v.kind, undefined, false));
      const got = collectMaterials([file], { materialsChars: 100_000, materialsIgnore: [] }).materials;
      const want = collectMaterials([ref], { materialsChars: 100_000, materialsIgnore: [] }).materials;
      expect(got, `${v.type} ${name} macro=${macro}`).toHaveLength(1);
      expect(got[0]!.text, `${v.type} ${name}`).toBe(want[0]!.text);
    }
  }, SLOW);
});
