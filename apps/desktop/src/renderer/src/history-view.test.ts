import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The «History» view contract per osen mockup (change 92): structural rules live in design/mockup/screens/history.css,
// which the app also imports, and intermediate states — in design/mockup/history.html.
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const css = read("design/mockup/screens/history.css");
const page = read("design/mockup/history.html");

/** Body of the rule with the exact selector (the last one, if there are several). */
function rule(selector: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...css.matchAll(new RegExp(`(?:^|[}\\n])\\s*${esc}\\s*\\{([^}]*)\\}`, "g"))];
  return all.at(-1)?.[1] ?? null;
}

describe("History view per osen mockup: history.css", () => {
  it("in-progress row — left leaf bar without fill, glow or ::before", () => {
    const live = rule(".history-row--live");
    expect(live).toMatch(/border-left-color:\s*var\(--leaf\)/);
    expect(live).not.toMatch(/background|box-shadow|color-mix|glow/);
    expect(css).not.toContain(".history-row--live::before");
    expect(rule(".history-row")).toMatch(/border-left:\s*var\(--bar-w\) solid transparent/);
  });
  it("row columns per the mockup, 24 px avatars, second line mono 12 px --text-faint", () => {
    expect(rule(".history-row")).toMatch(/grid-template-columns:\s*190px minmax\(0,1fr\) auto auto 176px 32px 18px/);
    expect(rule(".history-people .avatar")).toMatch(/width:\s*24px;\s*height:\s*24px/);
    const size = rule(".history-size")!;
    expect(size).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(size).toMatch(/font-size:\s*var\(--fs-sm\)/);
    expect(size).toMatch(/color:\s*var\(--text-faint\)/);
    expect(size).toMatch(/white-space:\s*nowrap/);
  });
  it("filter capsules: the selected one by aria-checked — --text frame and text, not bold; no old rules", () => {
    const on = rule('.history-filter .pill[aria-checked="true"]')!;
    expect(on).toMatch(/border-color:\s*var\(--text\)/);
    expect(on).toMatch(/(^|;)\s*color:\s*var\(--text\)/);
    expect(on).not.toMatch(/font-weight/);
    expect(css).not.toContain(".history-filter__item");
    expect(css).not.toContain(".history-search-wrap > .icon");
  });
  it("usage summary: coverage label on the right mono, total — tbody row weight 500 without a border, tfoot is not styled", () => {
    const scope = rule(".usage__scope")!;
    expect(scope).toMatch(/margin-left:\s*auto/);
    expect(scope).toMatch(/font-size:\s*var\(--fs-sm\)/);
    expect(scope).toMatch(/color:\s*var\(--text-faint\)/);
    expect(rule(".usage__table tbody")).toMatch(/font-family:\s*var\(--font-mono\)/);
    const total = rule(".usage__row--total th,.usage__row--total td")!;
    expect(total).toMatch(/font-weight:\s*var\(--fw-medium\)/);
    expect(total).toMatch(/border-bottom:\s*0/);
    expect(css).not.toContain("tfoot");
    expect(rule(".usage__table thead th")).toMatch(/color:\s*var\(--text-faint\)/);
  });
  it("pinning and groups: pin of a pinned one — leaf, group label in lowercase", () => {
    expect(rule('.history-pin[aria-pressed="true"]')).toMatch(/color:\s*var\(--leaf\)/);
    expect(rule(".history-pinned")).toMatch(/color:\s*var\(--leaf\)/);
    expect(rule(".history-group")).not.toMatch(/uppercase/);
    expect(rule(".history-summary__live")).toMatch(/color:\s*var\(--leaf\)/);
  });
});

describe("History view per osen mockup: design/mockup/history.html", () => {
  it("filters — .pill without a check mark, search without a magnifier, total in tbody, avatars without participant color, second line mono", () => {
    expect(page).not.toContain("history-filter__item");
    expect(page.match(/class="pill"/g)!.length).toBeGreaterThan(0);
    expect(page).not.toMatch(/class="pill"><svg[^>]*><use href="#i-check"/);
    expect(page).not.toMatch(/history-search-wrap"><svg/);
    expect(page).not.toContain("<tfoot");
    expect(page.match(/<tr class="usage__row--total">/g)!.length).toBe(8);
    expect(page).not.toMatch(/history-people"><span class="avatar[^>]*data-p=/);
    expect(page).not.toContain('class="history-size muted"');
    expect(page.match(/class="history-size mono"/g)!.length).toBeGreaterThan(0);
  });
  it("coverage label — span.mono inside usage__head, session summary numbers — .mono, «running now» — .history-summary__live", () => {
    expect(page).not.toContain('<p class="muted usage__scope">');
    expect(page.match(/<span class="mono usage__scope">[^<]*время московское<\/span><\/div>/g)!.length).toBe(11);
    expect(page).toContain('<p class="muted history-summary"><span class="mono">8</span> сессий · <span class="history-summary__live"><span class="mono">1</span> идёт сейчас</span></p>');
    expect(page).toContain('<p class="muted history-summary">найдена <span class="mono">1</span> из <span class="mono">7</span> сессий</p>');
  });
});
