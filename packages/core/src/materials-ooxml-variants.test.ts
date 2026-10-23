import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "./i18n/process-language.ts";
import { collectMaterials, MaterialsError, type CollectOptions } from "./materials.ts";
import { makeDocx, makePptx, makeXlsx, makeZip, p, sp } from "./documents/fixture.ts";
import { KIND_FIXTURES } from "./documents/kind-fixtures.ts";

const SLOW = 60_000;
const opts: CollectOptions = { materialsChars: 100_000, materialsIgnore: [] };
const WML = "application/vnd.openxmlformats-officedocument.wordprocessingml";
const PML = "application/vnd.openxmlformats-officedocument.presentationml";
const DOTX = `${WML}.template.main+xml`;
const XLTX = "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml";
const PPSX = `${PML}.slideshow.main+xml`;
const XLSB_RU = "двоичная книга Excel (XLSB) — сохраните как XLSX";
const XLSB_EN = "Excel binary workbook (XLSB) — save it as XLSX";
const xlsb = KIND_FIXTURES.find((f) => f.name === "xlsb")!.bytes;

const docx = (mainType?: string) => makeDocx({ body: p("Первый абзац") + p("Второй"), mainType });
const slides = [{ shapes: sp(["один"]) }, { shapes: sp(["два"]) }];

let root: string;
beforeEach(() => { setProcessLanguage("ru"); root = realpathSync(mkdtempSync(join(tmpdir(), "ooxml-variants-"))); });
afterEach(() => { setProcessLanguage("ru"); rmSync(root, { recursive: true, force: true }); });

function put(rel: string, content: string | Uint8Array): string {
  const f = join(root, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, content);
  return f;
}
const refusal = (f: string): string => {
  try { collectMaterials([f], opts); } catch (e) { expect(e).toBeInstanceOf(MaterialsError); return (e as MaterialsError).message; }
  throw new Error("refusal expected");
};

describe("OOXML templates and slideshows as materials", () => {
  it("an explicit DOTX is one material equal to the DOCX with the same main part", () => {
    const tpl = collectMaterials([put("tpl.dotx", docx(DOTX))], opts).materials;
    const real = collectMaterials([put("real.docx", docx())], opts).materials;
    expect(tpl.map((m) => m.name)).toEqual(["tpl.dotx"]);
    expect(tpl[0]!.chars).toBe(real[0]!.chars);
    expect(tpl[0]!.sha256).toBe(real[0]!.sha256);
    expect(tpl[0]!.text).toContain("Первый абзац");
  }, SLOW);

  it("a folder with a.md, show.ppsx and tpl.xltx gives three text materials and no archive skip", () => {
    put("d/a.md", "заметка");
    put("d/show.ppsx", makePptx({ slides, mainType: PPSX }));
    put("d/tpl.xltx", makeXlsx({ sheets: [{ name: "План", rows: [["a", 1]] }], mainType: XLTX }));
    const set = collectMaterials([join(root, "d")], opts);
    expect(set.materials.map((m) => m.name).sort()).toEqual(["d/a.md", "d/show.ppsx", "d/tpl.xltx"]);
    expect(set.skipped).toEqual([]);
    expect(set.materials.find((m) => m.name === "d/show.ppsx")!.text).toMatch(/# 1[\s\S]*# 2/);
    expect(set.materials.find((m) => m.name === "d/tpl.xltx")!.text.startsWith("# План")).toBe(true);
  }, SLOW);

  it("a slideshow under .zip is a presentation, a plain ZIP named .ppsx is a folder", () => {
    const show = collectMaterials([put("show.zip", makePptx({ slides, mainType: PPSX }))], opts).materials;
    expect(show.map((m) => m.name)).toEqual(["show.zip"]);
    expect(show[0]!.text).toMatch(/# 1[\s\S]*# 2/);
    const pack = collectMaterials([put("pack.ppsx", makeZip([{ name: "a.md", data: "a" }]))], opts).materials;
    expect(pack.map((m) => m.name)).toEqual(["pack.ppsx/a.md"]);
  }, SLOW);

  it("an XLSB is refused with its kind reason, as .xlsb and as .zip, on ru and en", () => {
    for (const [lang, reason] of [["ru", XLSB_RU], ["en", XLSB_EN]] as const) {
      setProcessLanguage(lang);
      const a = put(`${lang}/bin.xlsb`, xlsb);
      const b = put(`${lang}/book.zip`, xlsb);
      expect(refusal(a)).toBe(`«${a}»: ${reason}`);
      expect(refusal(b)).toBe(`«${b}»: ${reason}`);
    }
  }, SLOW);

  it("an XLSB in a folder is skipped with the reason and none of its parts is read", () => {
    put("d/a.md", "a");
    put("d/bin.xlsb", xlsb);
    const set = collectMaterials([join(root, "d")], opts);
    expect(set.materials.map((m) => m.name)).toEqual(["d/a.md"]);
    expect(set.skipped).toEqual([{ name: "d/bin.xlsb", reason: XLSB_RU }]);
  }, SLOW);

  it("inside a ZIP: a template is read as text, an XLSB is skipped with its reason, nothing is a nested archive", () => {
    const tpl = docx(DOTX);
    const pack = put("pack.zip", makeZip([{ name: "a.md", data: "a" }, { name: "tpl.dotx", data: tpl }, { name: "bin.xlsb", data: xlsb }]));
    const set = collectMaterials([pack], opts);
    expect(set.materials.map((m) => m.name).sort()).toEqual(["pack.zip/a.md", "pack.zip/tpl.dotx"]);
    const alone = collectMaterials([put("tpl.dotx", tpl)], opts).materials[0]!;
    expect(set.materials.find((m) => m.name === "pack.zip/tpl.dotx")!.text).toBe(alone.text);
    expect(set.skipped).toEqual([{ name: "pack.zip/bin.xlsb", reason: XLSB_RU }]);
    expect(set.materials.some((m) => m.name.includes("[Content_Types]"))).toBe(false);
  }, SLOW);
});
