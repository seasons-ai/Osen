import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { getProcessLanguage, setProcessLanguage } from "@model-council/core/i18n";
import { Shell } from "./App.tsx";
import { LanguagePanel, nextLanguage } from "./LanguagePanel.tsx";
import { languageChoiceIgnored as choiceIgnored } from "../../shared/settings.ts";
import { LanguageProvider, applyLanguageView } from "./language.tsx";
import { initialUi, reduce } from "./store.ts";
import type { LanguageView } from "../../shared/bridge.ts";
import type { ReactNode } from "react";

const v = (language: "en" | "ru", locked = false, damaged = false): LanguageView => ({ language, source: locked ? "env" : damaged ? "default" : "file", locked, damaged });
const withLang = (view: LanguageView, node: ReactNode) => renderToStaticMarkup(<LanguageProvider initial={view}>{node}</LanguageProvider>);
const shellHtml = (view: LanguageView, version?: string) =>
  renderToStaticMarkup(<Shell state={reduce(initialUi(), { type: "error", message: "x" })} dispatch={() => {}} version={version} language={view.language} />);

afterEach(() => setProcessLanguage("ru"));

describe("shell by language", () => {
  it("en: rail labels, Close, mark instead of a letter, version name", () => {
    const h = shellHtml(v("en"), "1.0.0");
    for (const l of ["New", "History", "Settings"]) expect(h).toContain(`<span>${l}</span>`);
    expect(h).toContain('aria-label="Close"');
    expect(h).toMatch(/<div class="rail__brand" aria-hidden="true"><svg [^>]*aria-hidden="true" focusable="false">/);
    expect(h).toContain('title="App version"');
  });
  it("ru: previous labels, mark instead of a letter", () => {
    const h = shellHtml(v("ru"), "1.0.0");
    for (const l of ["Новое", "История", "Настройки"]) expect(h).toContain(`<span>${l}</span>`);
    expect(h).toContain('aria-label="Закрыть"');
    expect(h).toMatch(/<div class="rail__brand" aria-hidden="true"><svg [^>]*aria-hidden="true" focusable="false">/);
  });
});

describe("language block", () => {
  it("normal, ru in effect", () => {
    const h = withLang(v("ru"), <LanguagePanel />);
    expect(h).toContain('role="radiogroup" aria-label="Язык интерфейса"');
    expect(h).toMatch(/role="radio"[^>]*aria-checked="false"[^>]*tabindex="-1"[^>]*><span class="settings-lang__name">English/);
    expect(h).toMatch(/aria-checked="true"[^>]*tabindex="0"[^>]*><span class="settings-lang__name">Русский<\/span><span class="settings-lang__now"><svg class="icon icon--sm"><use href="#i-check"><\/use><\/svg> действующий/);
    expect(h).not.toContain("disabled");
    expect(h).toContain("Применяется сразу");
    expect(h).not.toContain("i-info");
  });
  it("locked, en in effect", () => {
    const h = withLang(v("en", true), <LanguagePanel />);
    expect(h.match(/ disabled=""/g)).toHaveLength(2);
    expect(h.match(/aria-disabled="true"/g)).toHaveLength(2);
    expect(h).toContain("English</span><span class=\"settings-lang__now\"><svg class=\"icon icon--sm\"><use href=\"#i-check\"></use></svg> current");
    expect(h).toContain("#i-info");
    expect(h).toContain("Set by the COUNCIL_LANG environment variable");
    expect(h).not.toContain("Applies immediately");
    expect(h).toContain(">Language</h2>");
  });
  it("heading and label in two languages", () => {
    expect(withLang(v("ru"), <LanguagePanel />)).toContain(">Язык</h2>");
    expect(withLang(v("en"), <LanguagePanel />)).toContain('aria-label="Interface language"');
  });
  it("without a representation — empty", () => {
    expect(renderToStaticMarkup(<LanguagePanel />)).toBe("");
  });
});

describe("choiceIgnored: the click on an option reaches setLanguage only when not ignored", () => {
  it("damaged file: the current language goes through", () => {
    expect(choiceIgnored(v("en", false, true), "en", false)).toBe(false);
    expect(choiceIgnored(v("en", false, true), "ru", false)).toBe(false);
  });
  it("healthy or missing file: the current language is dropped, the other goes through", () => {
    expect(choiceIgnored(v("en"), "en", false)).toBe(true);
    expect(choiceIgnored({ language: "en", source: "default", locked: false, damaged: false }, "en", false)).toBe(true);
    expect(choiceIgnored(v("en"), "ru", false)).toBe(false);
  });
  it("locked or busy: everything is dropped", () => {
    expect(choiceIgnored(v("en", true), "ru", false)).toBe(true);
    expect(choiceIgnored(v("en", false, true), "en", true)).toBe(true);
  });
});

describe("nextLanguage", () => {
  it("arrows wrap around, other keys are ignored", () => {
    expect(nextLanguage("en", "ArrowRight")).toBe("ru");
    expect(nextLanguage("ru", "ArrowRight")).toBe("en");
    expect(nextLanguage("en", "ArrowLeft")).toBe("ru");
    expect(nextLanguage("ru", "ArrowUp")).toBe("en");
    expect(nextLanguage("en", "ArrowDown")).toBe("ru");
    expect(nextLanguage("en", "Tab")).toBeNull();
    expect(nextLanguage("en", "Enter")).toBeNull();
  });
});

describe("applyLanguageView", () => {
  it("process language, lang and heading", () => {
    const doc = { documentElement: { lang: "en" }, title: "" };
    applyLanguageView(v("en"), doc);
    expect([getProcessLanguage(), doc.documentElement.lang, doc.title]).toEqual(["en", "en", "Osen"]);
    applyLanguageView(v("ru"), doc);
    expect([getProcessLanguage(), doc.documentElement.lang, doc.title]).toEqual(["ru", "ru", "Osen"]);
  });
});
