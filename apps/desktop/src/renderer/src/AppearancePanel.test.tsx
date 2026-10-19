import { isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import type { AppearanceView, BridgeEvent } from "../../shared/bridge.ts";
import { shell } from "../../shared/messages/shell.ts";
import { AppearancePanel, AppearanceSection, LIGHT_THEMES, MODES, followAppearance, themeChoice } from "./AppearancePanel.tsx";
import { nextOption } from "./LanguagePanel.tsx";
import { LanguageProvider } from "./language.tsx";
import { SettingsScreen, initialSettings, reduceSettings } from "./Settings.tsx";
import type { LanguageView } from "../../shared/bridge.ts";

const lang = (language: "en" | "ru"): LanguageView => ({ language, source: "file", locked: false });
const av = (o: Partial<AppearanceView> = {}): AppearanceView => ({ mode: "dark", lightTheme: "tuman", theme: "osen", ...o });
const html = (view: AppearanceView, language: "en" | "ru" = "ru", error: string | null = null) =>
  renderToStaticMarkup(<LanguageProvider initial={lang(language)}><AppearanceSection view={view} error={error} onChoose={() => {}} /></LanguageProvider>);

afterEach(() => setProcessLanguage("ru"));

describe("Раздел «Оформление» на экране «Настройки»", () => {
  it("appearance section sits right after the language block, outside Body, and survives a config.json error", () => {
    const failed = reduceSettings(initialSettings(), { type: "loadFailed", message: "config.json broken" });
    const main = (SettingsScreen({ state: failed, now: new Date() }) as ReactElement<{ children: ReactNode }>).props.children as unknown;
    const header = (main as ReactElement<{ children: ReactNode }>[]);
    const kids = ((header as unknown as ReactElement<{ children: ReactNode[] }>[])[1] as ReactElement<{ children: ReactNode[] }>).props.children;
    const names = (kids as ReactNode[]).filter(isValidElement).map((e) => (e.type as { name: string }).name);
    expect(names).toEqual(["LanguagePanel", "AppearancePanel", "Body"]);
    expect(names.indexOf("AppearancePanel")).toBeLessThan(names.indexOf("Body"));
  });

  it("without a view the panel renders nothing", () => {
    expect(renderToStaticMarkup(<AppearancePanel />)).toBe("");
  });

  it("default view: now Osen, Dark checked, Mist selected with text, each preview carries its own data-theme", () => {
    const h = html(av());
    expect(h).toContain(`сейчас: <span class="mono">Осень</span>`);
    expect(h).toMatch(/aria-checked="true"[^>]*tabindex="0"[^>]*>Тёмная</);
    expect(h).toMatch(/aria-checked="false"[^>]*tabindex="-1"[^>]*>Светлая</);
    expect(h).toContain('role="radiogroup" aria-labelledby="appearance-mode-label"');
    for (const id of LIGHT_THEMES) expect(h).toContain(`class="theme-prev" data-theme="${id}" aria-hidden="true"`);
    expect(h.match(/aria-checked="true"/g)).toHaveLength(2);
    expect(h).toMatch(/aria-checked="true"[^>]*tabindex="0"[^>]*><span class="theme-prev" data-theme="tuman"/);
    expect(h).toContain("✓ выбрана");
    expect(h).toContain("Тёмная тема «Осень». Если выбрать светлую тему ниже, режим переключится сам.");
    expect(h).not.toContain("style=");
    expect(h).not.toContain('role="alert"');
  });

  it("mode hints follow the selected mode", () => {
    expect(html(av({ mode: "system" }))).toContain("Следует настройке macOS: днём светлая тема ниже, вечером «Осень».");
    expect(html(av({ mode: "light", theme: "inei", lightTheme: "inei" }))).toContain("Светлая тема — та, что выбрана ниже.");
  });

  it("an appearance event with a new theme changes «now» without owner actions; other events are ignored", async () => {
    let listener: (e: BridgeEvent) => void = () => {};
    const seen: AppearanceView[] = [];
    const off = () => {};
    const council = { appearance: () => Promise.resolve(av()), subscribe: vi.fn((l: (e: BridgeEvent) => void) => { listener = l; return off; }) };
    expect(followAppearance(council, (v) => seen.push(v))).toBe(off);
    await Promise.resolve();
    listener({ type: "appearance", view: av({ mode: "system", lightTheme: "len", theme: "len" }) });
    listener({ type: "error", message: "x" });
    expect(seen.map((v) => v.theme)).toEqual(["osen", "len"]);
    expect(html(seen[1]!)).toContain(`сейчас: <span class="mono">Лён</span>`);
  });

  it("failed write: the alert shows the reason and the marks stay on the previous choice", () => {
    const h = html(av(), "ru", "Тема не сохранена: нет доступа на запись appearance.json (EACCES)");
    expect(h).toMatch(/role="alert"[\s\S]*Тема не сохранена: нет доступа на запись appearance.json \(EACCES\)/);
    expect(h).toMatch(/aria-checked="true"[^>]*tabindex="0"[^>]*>Тёмная</);
  });
});

describe("Выбор светлой темы в тёмном режиме", () => {
  it("dark mode: a card click is one call that also switches the mode to light", () => {
    expect(themeChoice(av({ mode: "dark" }), "len")).toEqual({ mode: "light", lightTheme: "len" });
  });
  it("system and light modes: only the light theme is sent, no mode", () => {
    const sys = themeChoice(av({ mode: "system" }), "pergament");
    expect(sys).toEqual({ lightTheme: "pergament" });
    expect("mode" in sys).toBe(false);
    expect(themeChoice(av({ mode: "light" }), "inei")).toEqual({ lightTheme: "inei" });
  });
});

describe("Раздел «Оформление» на выбранном языке", () => {
  it("switching the language changes every label of the section at once", () => {
    const ru = html(av({ mode: "system" }), "ru");
    const en = html(av({ mode: "system" }), "en");
    for (const s of ["Оформление", "Режим", "Тёмная", "Светлая", "Как в системе", "Светлая тема", "Туман", "Лён", "Иней", "Пергамент", "✓ выбрана", "● идёт", "Начать"]) { expect(ru).toContain(s); expect(en).not.toContain(s); }
    for (const s of ["Appearance", "Mode", "Dark", "Light", "Match system", "Light theme", "Mist", "Linen", "Frost", "Parchment", "✓ selected", "● running", "Start", "Warm paper. Default.", "Follows macOS: the light theme below by day, “Osen” at night."]) { expect(en).toContain(s); expect(ru).not.toContain(s); }
    expect(html(av(), "en")).toContain(`now: <span class="mono">Osen</span>`);
  });
  it("catalog has the same keys in both languages and non-empty strings", () => {
    expect(Object.keys(shell("en")).sort()).toEqual(Object.keys(shell("ru")).sort());
    for (const k of ["appearanceHeading", "appearanceSelected", "themeOsen", "themePergamentDesc", "previewStart"] as const) {
      expect(shell("en")[k].length).toBeGreaterThan(0);
      expect(shell("ru")[k]).not.toBe(shell("en")[k]);
    }
    expect(shell("en").appearanceNow).toBe("now:");
    expect(shell("ru").appearanceNow).toBe("сейчас:");
  });
});

describe("Раздел «Оформление» с клавиатуры", () => {
  const ARROWS = [["ArrowRight", 1], ["ArrowDown", 1], ["ArrowLeft", -1], ["ArrowUp", -1]] as const;
  it.each([["modes", MODES], ["light themes", LIGHT_THEMES]] as const)("arrows cycle through %s: result is option (i + sum of steps) mod n", (_n, options) => {
    const n = options.length;
    // every sequence of length 0..2n over {forward, back}; ArrowDown/ArrowUp are checked below to mirror these two
    const dirs = [["ArrowRight", 1], ["ArrowLeft", -1]] as const;
    for (let i = 0; i < n; i++) {
      for (let len = 0; len <= 2 * n; len++) {
        for (let mask = 0; mask < 2 ** len; mask++) {
          let cur = options[i]!;
          let sum = 0;
          for (let b = 0; b < len; b++) {
            const [key, step] = dirs[(mask >> b) & 1]!;
            cur = nextOption(options, cur, key)!;
            sum += step;
          }
          expect(cur).toBe(options[(((i + sum) % n) + n) % n]);
        }
      }
    }
  });
  it("ArrowDown/ArrowUp mirror ArrowRight/ArrowLeft, other keys return null", () => {
    for (const [key, step] of ARROWS) expect(nextOption(MODES, "dark", key)).toBe(MODES[(step + 3) % 3]);
    for (const k of ["Tab", "Enter", " ", "Escape"]) expect(nextOption(MODES, "dark", k)).toBeNull();
  });
  it("options are native buttons with roving tabIndex, so Tab enters the group once and Enter/Space click", () => {
    const h = html(av({ mode: "light", lightTheme: "inei" }));
    expect(h.match(/tabindex="0"/g)).toHaveLength(2);
    expect(h.match(/tabindex="-1"/g)).toHaveLength(5);
    expect(h.match(/<button type="button" role="radio"/g)).toHaveLength(7);
  });
});
