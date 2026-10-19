import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const cssIn = (dir: string) => readdirSync(join(root, dir)).filter((name) => name.endsWith(".css")).map((name) => `${dir}/${name}`);

const tokensPath = "design/mockup-osen/brand/tokens.css";
const pages = ["index", "setup", "template-editor", "session", "result", "history", "settings", "styleguide"];
const osenPages = ["index", "setup", "session", "result", "history", "settings", "styleguide"];
const styles = ["design/mockup/components.css", ...cssIn("design/mockup/screens"), ...cssIn("apps/desktop/src/renderer/src")];
const oldPalette = ["#22e3ff", "#3dff9a", "#7aa8ff", "#ff5578", "#ffc53d"];

// Theme blocks: ":root" (the default, «Осень») and every [data-theme="<id>"], each as name → value.
const themeBlocks = new Map(
  [...read(tokensPath).matchAll(/(?::root|\[data-theme="(\w+)"\])\s*\{([\s\S]*?)\n\}/g)].map((m) => [
    m[1] ?? ":root",
    Object.fromEntries([...m[2]!.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((v) => [v[1]!, v[2]!.trim()])),
  ]),
);
const tokens = themeBlocks.get(":root")!;

function luminance(hex: string) {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe("osen tokens", () => {
  it("the app and all mockup pages include brand/tokens.css", () => {
    expect(read("apps/desktop/src/renderer/src/main.tsx")).toContain(`design/mockup-osen/brand/tokens.css"`);
    for (const page of pages) expect(read(`design/mockup/${page}.html`), page).toContain(`href="../mockup-osen/brand/tokens.css"`);
    for (const page of osenPages) expect(read(`design/mockup-osen/${page}.html`), page).toContain(`<link rel="stylesheet" href="brand/tokens.css">`);
  });

  it("the old design/mockup/tokens.css does not exist", () => {
    expect(existsSync(join(root, "design/mockup/tokens.css"))).toBe(false);
  });

  it.each(styles)("%s without glow, pulsing and --text-decor on text", (path) => {
    const css = read(path);
    expect(css.match(/(box|text)-shadow:[^;}]*--glow/g) ?? []).toEqual([]);
    expect(css).not.toContain("pulse-glow");
    expect(css.match(/(^|[;{\s])color:\s*var\(--text-decor\)/g) ?? []).toEqual([]);
  });

  it.each([...styles, tokensPath])("%s without the old neon palette", (path) => {
    const css = read(path).toLowerCase();
    for (const hex of oldPalette) expect(css, hex).not.toContain(hex);
  });

  const pairs = [
    ...["--text", "--text-dim"].flatMap((text) => ["--bg-0", "--bg-1", "--bg-2", "--bg-3", "--bg-inset"].map((bg) => [text, bg])),
    ...["--bg-0", "--bg-1", "--bg-2", "--bg-inset"].map((bg) => ["--text-faint", bg]),
  ];
  // Hover paints the list row in --bg-3, where --text-faint gives 4.16:1; the template card does not change the background on hover (change 87).
  it.each([
    ["design/mockup/components.css", ".list__row:hover .muted"],
    ["design/mockup/components.css", ".card--interactive:hover .card__meta"],
  ])("%s: подписи %s — --text-dim", (path, selector) => {
    const rules = [...read(path).matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1]!.split(",").map((s) => s.trim()).includes(selector));
    expect(rules.map((m) => m[2]).join(";")).toMatch(/color:\s*var\(--text-dim\)/);
  });

  it.each(pairs)("contrast %s on %s not below 4.5:1", (text, bg) => {
    const [fg, back] = [tokens[text], tokens[bg]];
    if (!fg || !back) throw new Error(`нет ${text} или ${bg} в ${tokensPath}`);
    expect(contrast(fg, back)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("osen themes", () => {
  const themes = ["osen", "tuman", "len", "inei", "pergament"];
  const isColor = (value: string): boolean => /^#[0-9a-f]{6}$/i.test(value) || /^var\((--[a-z0-9-]+)\)$/.test(value) && isColor(tokens[/^var\((--[a-z0-9-]+)\)$/.exec(value)![1]!] ?? "");
  const colorNames = Object.keys(tokens).filter((name) => isColor(tokens[name]!));

  it("tokens.css has exactly the five theme blocks", () => {
    expect([...themeBlocks.keys()]).toEqual([":root", ...themes]);
  });

  it.each(themes)("theme %s sets every color variable of :root", (theme) => {
    const block = themeBlocks.get(theme) ?? {};
    expect(colorNames.filter((name) => !(name in block))).toEqual([]);
  });

  it("the osen block repeats the colors of :root", () => {
    const block = themeBlocks.get("osen")!;
    expect(Object.fromEntries(colorNames.map((name) => [name, block[name]]))).toEqual(Object.fromEntries(colorNames.map((name) => [name, tokens[name]])));
  });

  const foregrounds = ["--text", "--text-dim", "--text-faint", "--leaf", "--rain", "--ok", "--warn", "--danger"];
  const surfaces = ["--bg-0", "--bg-1", "--bg-2", "--bg-3", "--bg-inset"];
  // The only allowed pair below 4.5:1: captions on a hovered row in «Осень»; components switch them to --text-dim there (change 87).
  const exception = "osen --text-faint on --bg-3";
  it.each(themes)("contrast of theme %s not below 4.5:1", (theme) => {
    const block = themeBlocks.get(theme)!;
    const pairs = [...foregrounds.flatMap((fg) => surfaces.map((bg) => [fg, bg])), ["--text-on-accent", "--leaf"]];
    const low = pairs
      .map(([fg, bg]) => ({ name: `${theme} ${fg} on ${bg}`, ratio: contrast(block[fg!]!, block[bg!]!) }))
      .filter((p) => p.ratio < 4.5 && p.name !== exception)
      .map((p) => `${p.name}: ${p.ratio.toFixed(2)}:1`);
    expect(low.join("\n")).toBe("");
  });
});
