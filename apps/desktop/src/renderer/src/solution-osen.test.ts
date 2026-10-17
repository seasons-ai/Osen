import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// change 90: the upper panel of «Discussion» and the solution panel per osen mockup — rules of screens/session.css and markup of session.html.
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const css = read("design/mockup/screens/session.css");
const html = read("design/mockup/session.html");

function rule(src: string, selector: string): string | null {
  const bodies = [...src.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1]!.split(",").map((x) => x.trim()).includes(selector))
    .map((m) => m[2]!.trim());
  return bodies.length ? bodies.join(";") : null;
}

describe("solution panel per osen mockup", () => {
  it("meta label 82 px, active tab with a --text bar", () => {
    expect(rule(css, ".session-meta__label")).toMatch(/width:\s*82px/);
    expect(rule(css, '.solution-tabs .tab[aria-selected="true"]')).toMatch(/border-bottom:[^;]*var\(--text\)/);
  });
  it("--leaf comparison switch, mono counter, list 72ch", () => {
    expect(rule(css, ".solution-tools__toggle input")).toMatch(/accent-color:\s*var\(--leaf\)/);
    expect(rule(css, ".session-counter")).toMatch(/var\(--font-mono\)/);
    expect(rule(css, ".solution-list")).toMatch(/max-width:\s*72ch/);
  });
  it("toolbar row: label and hint shrink to a word, «Copy» does not wrap to a new line and does not overlap", () => {
    for (const s of [".solution-tools__toggle", ".solution-tools__hint"]) expect(rule(css, s)).toMatch(/flex:\s*1 1 0;\s*min-width:\s*min-content/);
  });
  it("comparison without fill, no old .session-vote", () => {
    expect(rule(css, ".diff-add")).not.toMatch(/color-mix/);
    expect(rule(css, ".diff-del")).not.toMatch(/color-mix/);
    expect(css).not.toMatch(/\.session-vote\s*[{>,]/);
  });
  it("mockup: «Stop» without btn--sm, labels without a colon", () => {
    expect(html).not.toMatch(/btn--danger btn--sm/);
    expect(html).not.toMatch(/Автор:|Согласны:|Возражает:/);
    expect(html).toMatch(/solution-list/);
  });
});
