import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// change 93: the «Settings» and «Template editor» view per osen mockup — rules of screens/settings.css, template-editor.css and settings-extra.css.
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const screen = "design/mockup/screens/settings.css";
const editor = "design/mockup/screens/template-editor.css";
const extra = "apps/desktop/src/renderer/src/settings-extra.css";

/** Declarations of all rules whose selector list contains the exact selector (including rules inside media queries). */
function rule(css: string, selector: string): string | null {
  const bodies = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1]!.split(",").map((x) => x.trim()).includes(selector))
    .map((m) => m[2]!.trim());
  return bodies.length ? bodies.join(";") : null;
}

describe("Settings screen view per osen mockup", () => {
  const css = read(screen);

  it("card grid: auto-fill from 380 px, not two columns", () => {
    expect(rule(css, ".settings-grid")).toMatch(/grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(380px,\s*1fr\)\)/);
  });

  it("selected language: --text frame without fill, «active» in --info color", () => {
    const on = rule(css, '.settings-lang__opt[aria-checked="true"]')!;
    expect(on).toMatch(/border-color:\s*var\(--text\)/);
    expect(on).not.toMatch(/background/);
    expect(rule(css, ".settings-lang__now")).toMatch(/color:\s*var\(--info\)/);
  });

  it("tabs 38/14 px, active — --text with a 2 px bar, inactive — --text-faint", () => {
    const tab = rule(css, ".settings-tabs .tab")!;
    expect(tab).toMatch(/min-height:\s*38px/);
    expect(tab).toMatch(/font-size:\s*var\(--fs-md\)/);
    expect(tab).toMatch(/color:\s*var\(--text-faint\)/);
    const on = rule(css, '.settings-tabs .tab[aria-selected="true"]')!;
    expect(on).toMatch(/color:\s*var\(--text\)/);
    expect(on).toMatch(/border-bottom:\s*var\(--bar-w\) solid var\(--text\)/);
  });

  it("property labels in lowercase style, catalogs do not change", () => {
    expect(rule(css, ".settings-info dt")).toMatch(/text-transform:\s*lowercase/);
  });

  it("«list received…» — mono 12 px --text-faint", () => {
    const src = rule(css, ".settings-models__source")!;
    expect(src).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(src).toMatch(/font-size:\s*var\(--fs-sm\)/);
    expect(src).toMatch(/color:\s*var\(--text-faint\)/);
  });

  it.each([screen, editor, extra])("%s without color-mix, box-shadow (except none) and --tint-alpha", (path) => {
    const text = read(path);
    for (const bad of ["color-mix(", "--tint-alpha"]) expect(text, bad).not.toContain(bad);
    for (const m of text.matchAll(/box-shadow:\s*([^;}]+)/g)) expect(m[1]!.trim()).toBe("none");
  });
});

describe("Template editor view in osen style", () => {
  const css = read(editor);

  it("the temporary layout freeze from change 88 is removed", () => {
    expect(css).not.toContain(".setup:has(.tpl-limits)");
  });

  it.each([".tpl-role-item", ".tpl-role-wrap"])("role row %s in the list frame: fields 10×14, separator --line", (sel) => {
    const row = rule(css, sel)!;
    expect(row).toMatch(/padding:\s*10px 14px/);
    expect(row).toMatch(/border-bottom:[^;]*var\(--line\)/);
  });
});
