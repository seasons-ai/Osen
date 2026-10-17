import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The «Summary» screen per osen mockup: rules of screens/result.css and markup of design/mockup/result.html.
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const css = read("design/mockup/screens/result.css");
const html = read("design/mockup/result.html");

/** Declarations of all rules whose selector list contains the exact selector. */
function rule(text: string, selector: string): string | null {
  const bodies = [...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1]!.split(",").map((x) => x.trim()).includes(selector))
    .map((m) => m[2]!.trim());
  return bodies.length ? bodies.join(";") : null;
}

describe("Summary per osen mockup: rules of result.css", () => {
  it("no box-shadow, glow or color-mix in .result-* rules", () => {
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.includes(".result-"));
    expect(rules.length).toBeGreaterThan(20);
    for (const m of rules) for (const bad of ["box-shadow", "glow", "color-mix("]) expect(m[0], bad).not.toContain(bad);
  });

  it("status: --line frame, --r-lg radius; 44 px icon with a 1.5 px frame without fill", () => {
    expect(rule(css, ".result-hero")).toMatch(/border:\s*var\(--border-w\) solid var\(--line\)/);
    expect(rule(css, ".result-hero")).toMatch(/border-radius:\s*var\(--r-lg\)/);
    const icon = rule(css, ".result-hero__icon")!;
    expect(icon).toMatch(/width:\s*var\(--avatar-size-lg\)/);
    expect(icon).toMatch(/border:\s*1\.5px solid var\(--c\)/);
    expect(icon).toMatch(/background:\s*transparent/);
    expect(rule(css, ".result-hero__when")).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(rule(css, ".result-hero__when")).toMatch(/margin-left:\s*auto/);
  });

  it("two flex columns with wrapping, cards 18×20", () => {
    expect(rule(css, ".result-cols")).toMatch(/display:\s*flex/);
    expect(rule(css, ".result-cols")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(css, ".result-main")).toMatch(/flex:\s*999 1 520px/);
    expect(rule(css, ".result-side")).toMatch(/flex:\s*1 1 300px/);
    expect(rule(css, ".result-side")).toMatch(/max-width:\s*380px/);
    expect(rule(css, ".result-cols .card")).toMatch(/padding:\s*18px 20px/);
  });

  it("quote: --line-strong bar without fill; decision list 68ch with a 10px gap", () => {
    const q = rule(css, ".result-quote")!;
    expect(q).toMatch(/border-left:\s*var\(--bar-w\) solid var\(--line-strong\)/);
    expect(q).not.toMatch(/background:\s*(?!transparent)/);
    const list = rule(css, ".result-list")!;
    expect(list).toMatch(/max-width:\s*68ch/);
    expect(list).toMatch(/gap:\s*10px/);
    expect(list).toMatch(/flex-direction:\s*column/);
  });

  it("statistics tiles: 12 px sans label, 20 px mono number", () => {
    expect(rule(css, ".result-stats .stat")).toMatch(/border:\s*var\(--border-w\) solid var\(--line\)/);
    const label = rule(css, ".result-stats .stat__label")!;
    expect(label).toMatch(/font-size:\s*var\(--fs-sm\)/);
    expect(label).toMatch(/font-family:\s*var\(--font-ui\)/);
    const value = rule(css, ".result-stats .stat__value")!;
    expect(value).toMatch(/font-size:\s*var\(--fs-2xl\)/);
    expect(value).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(css).not.toContain("result-stat-head");
  });

  it("owner choice: row with wrapping", () => {
    expect(rule(css, ".result-choice__row")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(css, ".result-choice textarea")).toMatch(/min-height:\s*36px/);
    // rows=1 gives 36 px only with a 20 px line and 7 px fields (the .textarea base: 8 px and --lh-body → 39 px)
    expect(rule(css, ".result-choice textarea")).toMatch(/padding:\s*7px 10px/);
    expect(rule(css, ".result-choice textarea")).toMatch(/line-height:\s*20px/);
  });

  it("a long model wraps inside the name and does not compress it", () => {
    expect(rule(css, ".result-person__name")).toMatch(/flex:\s*1/);
    expect(rule(css, ".result-person .tag")).toMatch(/max-width:\s*100%/);
    expect(rule(css, ".result-person .tag")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(css, ".result-author .tag")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("version chip — frame and text in the tone color", () => {
    const chip = rule(css, ".result-meta .chip[data-tone]")!;
    expect(chip).toMatch(/color:\s*var\(--c\)/);
    expect(chip).toMatch(/border-color:\s*var\(--c\)/);
  });
});

describe("Summary per osen mockup: markup of result.html", () => {
  const variants = [...new Set([...html.matchAll(/data-variant="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/)))];
  const buttons = [...html.matchAll(/<(?:button|a)\b[^>]*>[\s\S]*?<\/(?:button|a)>/g)].map((m) => m[0]);
  const visibleIn = (el: string, v: string) => {
    const attr = el.match(/^<[^>]*data-variant="([^"]*)"/);
    return !attr || attr[1]!.split(/\s+/).includes(v);
  };

  it("each variant has exactly one primary button — «Copy summary»", () => {
    expect(variants.length).toBeGreaterThanOrEqual(17);
    for (const v of variants) {
      const primary = buttons.filter((b) => /^<[^>]*class="[^"]*\bbtn--primary\b/.test(b) && visibleIn(b, v));
      expect(primary.length, v).toBe(1);
      expect(primary[0], v).toContain("Скопировать итог");
    }
  });

  it("buttons without btn--sm in the upper panel, «Continue» and «Accept version» are not primary", () => {
    const top = html.match(/<div class="topbar__actions">[\s\S]*?<\/div>/)![0];
    expect(top).not.toContain("btn--sm");
    for (const b of buttons.filter((x) => /Продолжить<|Принять версию</.test(x))) expect(b).not.toContain("btn--primary");
  });

  it("tiles without icons and result-stat-head, container without mono", () => {
    expect(html).not.toContain("result-stat-head");
    expect(html).not.toMatch(/class="stat-row result-stats mono/);
    for (const m of html.matchAll(/<div class="stat">([\s\S]*?)<\/div><\/div>/g)) expect(m[1]).not.toContain("<svg");
  });

  it("participant and quote have no data-p, model is .tag, date in the status", () => {
    expect(html).not.toMatch(/<(?:div|blockquote) class="result-(?:person|quote)" data-p/);
    expect(html).toContain('<span class="tag">');
    expect(html).toMatch(/<span class="result-hero__when mono">/);
  });

  it("decision — numbered list, note field in a single-line row", () => {
    expect(html).toContain('<ol class="result-list">');
    const row = html.match(/<div class="result-choice__row">[\s\S]*?<\/div>/)![0];
    const areas = row.match(/<textarea[^>]*>/g)!;
    expect(areas.length).toBeGreaterThan(0);
    for (const a of areas) expect(a).toContain('rows="1"');
  });
});
