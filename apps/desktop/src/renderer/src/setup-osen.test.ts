import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// change 88: the «Session setup» view per osen mockup — rules of the shared screens/setup.css and setup-extra.css layer.
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const screen = "design/mockup/screens/setup.css";
const extra = "apps/desktop/src/renderer/src/setup-extra.css";

/** Declarations of all rules whose selector list contains the exact selector (including rules inside media queries). */
function rule(css: string, selector: string): string | null {
  const bodies = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1]!.split(",").map((x) => x.trim()).includes(selector))
    .map((m) => m[2]!.trim());
  return bodies.length ? bodies.join(";") : null;
}

describe("Session setup per osen mockup", () => {
  const css = read(screen);

  it("participants in one frame: .setup__list with a --line frame and --bg-2 background, .setup-p has no frame or background", () => {
    expect(rule(css, ".setup__list")).toMatch(/border:[^;]*var\(--line\)/);
    expect(rule(css, ".setup__list")).toMatch(/background:\s*var\(--bg-2\)/);
    expect(rule(css, ".setup__list")).toMatch(/border-radius:\s*var\(--r-lg\)/);
    const row = rule(css, ".setup-p")!;
    expect(row).toMatch(/background:\s*transparent/);
    expect(row).toMatch(/(^|;)\s*border:\s*0/);
    expect(row).toMatch(/border-bottom:[^;]*var\(--line\)/);
  });

  it("side column: one card no wider than 320 px, subsections via border-top, primary button 40 px", () => {
    expect(rule(css, ".setup__side")).toMatch(/max-width:\s*320px/);
    expect(rule(css, ".setup__side")).toMatch(/flex:\s*1 1 280px/);
    for (const sel of [".setup__side .setup-wait", ".setup__side .setup__block"]) expect(rule(css, sel), sel).toMatch(/border-top:[^;]*var\(--line\)/);
    expect(rule(css, ".setup__side .btn--primary")).toMatch(/min-height:\s*40px/);
    expect(rule(css, ".setup__cost")).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(rule(css, ".setup__estimate")).toMatch(/font-size:\s*var\(--fs-xl\)/);
    expect(rule(css, ".setup__estimate")).toMatch(/font-weight:\s*var\(--fw-bold\)/);
  });

  it("materials: dashed --line-strong, file drop — --leaf frame without fill, total and link mono", () => {
    expect(rule(css, ".setup-materials")).toMatch(/dashed var\(--line-strong\)/);
    const over = rule(css, '.setup-materials[data-drop="over"]')!;
    expect(over).toMatch(/border-color:\s*var\(--leaf\)/);
    expect(over).not.toMatch(/background/);
    expect(rule(css, ".setup-materials__total")).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(rule(css, ".setup-materials__url .input")).toMatch(/font-family:\s*var\(--font-mono\)/);
  });

  it.each([screen, extra])("%s without color-mix, box-shadow and --tint-alpha", (path) => {
    const text = read(path);
    for (const bad of ["color-mix(", "box-shadow", "--tint-alpha"]) expect(text, bad).not.toContain(bad);
  });
});
