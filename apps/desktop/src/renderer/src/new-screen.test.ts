import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The «New discussion» screen view per osen mockup (session-setup spec): screen styles are shared by the app and design/mockup.
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const files = ["design/mockup/screens/index.css", "apps/desktop/src/renderer/src/new-extra.css"];
const rules = (css: string) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]!.replace(/\s+/g, "") }));
const rule = (css: string, selector: string) => rules(css).filter((r) => r.selector === selector).at(-1)?.body ?? null;

describe("«New discussion» screen: osen styles", () => {
  it.each(files)("%s: hover does not change the background, participant color or glow", (path) => {
    for (const r of rules(read(path)).filter((r) => r.selector.includes(":hover"))) {
      expect(r.body, r.selector).not.toMatch(/box-shadow|--glow|color-mix|--bg-3|var\(--c\)/);
    }
    expect(read(path)).not.toContain(".index-card:has(.index-card__main:hover)");
  });

  it("template card: hover over the whole card — only the --text-decor frame", () => {
    expect(rule(read(files[0]!), ".index-card:hover")).toBe("border-color:var(--text-decor)");
  });

  it("service cards keep no background on hover", () => {
    expect(rule(read(files[0]!), ".index-page .card--dashed:hover")).toBe("background:transparent");
  });

  it("card fields 16 18 10, action row under the --line line, gap 4 and padding-top 6", () => {
    const css = read(files[0]!);
    expect(rule(css, ".index-card")).toMatch(/padding:(16px|var\(--sp-4\))18px10px/);
    const actions = rule(css, ".index-card__actions")!;
    expect(actions).toMatch(/border-top:(1px|var\(--border-w\))solidvar\(--line\)/);
    expect(actions).toMatch(/gap:(4px|var\(--sp-1\))(;|$)/);
    expect(actions).toContain("padding-top:6px");
    expect(actions).toContain("flex-wrap:wrap");
  });

  it("paddings 28/32/40, gaps 28 and 14, minmax(250px, 1fr) grid, mono labels --text-faint, glyphs --leaf", () => {
    const css = read(files[0]!);
    expect(rule(css, ".content--index")).toMatch(/padding:28px(32px|var\(--sp-6\))40px/);
    expect(rule(css, ".index-page")).toContain("gap:28px");
    expect(rule(css, ".index-section")).toContain("gap:14px");
    expect(rule(css, ".index-page .grid-cards")).toBe("grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px");
    for (const sel of [".index-topbar-meta", ".index-count"]) {
      expect(rule(css, sel), sel).toMatch(/font-size:(12px|var\(--fs-sm\))/);
      expect(rule(css, sel), sel).toContain("color:var(--text-faint)");
    }
    expect(rule(css, ".index-heading")).toContain("align-items:baseline");
    expect(rule(css, ".index-glyph")).toContain("color:var(--leaf)");
  });

  it("the design/mockup/index.html mockup is marked up as the app", () => {
    const html = read("design/mockup/index.html");
    expect(html).toContain('<main class="content content--index">');
    expect(html).toContain('class="mono index-topbar-meta"');
    expect(html).not.toContain('<span class="chip">2</span>');
    expect(html).not.toContain('<div class="row"><h2 class="section-title">');
    expect(html.match(/<span class="index-glyph" aria-hidden="true">[✎+]<\/span>/g)).toHaveLength(2);
    for (const block of html.match(/<p class="card__meta index-meta">[^]*?<\/p>/g) ?? []) expect(block).not.toContain("<svg");
    for (const block of html.match(/<p class="index-origin">[^]*?<\/p>/g) ?? []) expect(block).not.toContain("<svg");
    for (const block of html.match(/<div class="index-card__actions">[^]*?<\/div>/g) ?? []) {
      expect(block).not.toContain("<svg");
      expect(block).not.toContain("btn--sm");
    }
  });
});
