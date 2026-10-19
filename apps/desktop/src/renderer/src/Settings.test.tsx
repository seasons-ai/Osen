import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LANGUAGE, setProcessLanguage } from "@model-council/core/i18n";
import { LanguageProvider } from "./language.tsx";
import type { DefaultsValues, SettingsProvider, SettingsView } from "../../shared/settings.ts";
import { settings } from "../../shared/messages/settings.ts";
import { EMPTY_PROVIDER } from "./ProviderForm.tsx";
import { SettingsScreen, initialSettings, isDirty, reduceSettings } from "./Settings.tsx";
import type { SettingsAction, SettingsState } from "./Settings.tsx";

const prov = (o: Partial<SettingsProvider> = {}): SettingsProvider => ({
  id: "p", kind: "cli", label: "P", available: true, reason: null, warning: null, version: null, path: null,
  baseUrl: null, keyEnv: null, keySet: false, billing: "subscription", models: ["m1"], defaultModel: "dflt",
  modelsSource: "provider", modelsReason: null, modelsAt: null, ...o,
});
const http = (o: Partial<SettingsProvider> = {}) =>
  prov({ id: "h", kind: "openai-http", label: "H", baseUrl: "http://x/v1", keyEnv: "H_KEY", keySet: true, billing: "paid", ...o });
const defs = (o: Partial<DefaultsValues> = {}): DefaultsValues => ({
  maxRounds: 5, turnTimeoutSec: 300, contextChars: 24000, materialsChars: 60000, maxTotalTokens: null, maxParticipants: 8,
  participants: [{ providerId: "p", model: "m1" }, { providerId: "h", model: "m1" }], ...o,
});
const view = (o: Partial<SettingsView> = {}): SettingsView => ({
  configPath: "/cfg/config.json", envPath: "/cfg/.env", registryError: null, providers: [prov(), http()], defaults: defs(), ...o,
});
const loaded = (o: Partial<SettingsView> = {}, s: Partial<SettingsState> = {}): SettingsState =>
  ({ ...reduceSettings(initialSettings(), { type: "view", view: view(o) }), ...s });
const html = (s: SettingsState) => renderToStaticMarkup(SettingsScreen({ state: s, now: new Date("2026-01-01T12:00:00") }));
const run = (s: SettingsState, ...a: SettingsAction[]) => a.reduce(reduceSettings, s);

describe("SettingsScreen", () => {
  it("loading", () => {
    expect(html(initialSettings())).toContain("Проверяю провайдеров…");
  });
  it("loading error", () => {
    const h = html(run(initialSettings(), { type: "loadFailed", message: "сбой моста" }));
    expect(h).toContain("Не удалось открыть настройки");
    expect(h).toContain("сбой моста");
    expect(h).toContain("Проверить заново");
  });
  it("corrupted registry", () => {
    const h = html(loaded({ registryError: "поле providers: не массив", providers: [], defaults: null }));
    expect(h).toContain("Ошибка в файле настроек");
    expect(h).toContain("поле providers: не массив");
    expect(h).toContain("/cfg/config.json");
    expect(h).toContain("Приложение не исправляет этот файл само");
    expect(h).toContain("Проверить заново");
    expect(h).toContain(">Подключения<");
    expect(h).not.toContain("settings-card");
  });
  it("all available: cards, no banner", () => {
    const h = html(loaded());
    expect(h.match(/<article class="card settings-card/g)).toHaveLength(2);
    expect(h).not.toContain("settings-banner");
    expect(h).toContain('aria-selected="true">Провайдеры');
  });
  it("unavailable: declension and reasons", () => {
    const one = html(loaded({ providers: [prov({ available: false, reason: "лимит" }), http()] }));
    expect(one).toContain("1 провайдер недоступен");
    expect(one).toContain("P — лимит. Сессии с этими участниками не запустятся.");
    const two = html(loaded({ providers: [prov({ available: false, reason: "лимит" }), http({ available: false, keySet: false, reason: "r" })] }));
    expect(two).toContain("2 провайдера недоступны");
    expect(two).toContain("P — лимит; H — ключ не задан.");
    const five = html(loaded({ providers: [1, 2, 3, 4, 5].map((i) => prov({ id: `p${i}`, available: false, reason: "r" })) }));
    expect(five).toContain("5 провайдеров недоступны");
  });
  it("new provider form at the end of the grid, button disabled", () => {
    const h = html(run(loaded(), { type: "openForm", provider: null }));
    expect(h).toContain("settings-form");
    expect(h.indexOf("settings-form")).toBeGreaterThan(h.lastIndexOf('class="card settings-card"'));
    expect(h).toMatch(/disabled=""[^>]*><svg[^>]*><use href="#i-plus"><\/use><\/svg> Добавить HTTP-провайдер/);
  });
  it("edit form instead of the card", () => {
    const h = html(run(loaded(), { type: "openForm", provider: http() }));
    expect(h.match(/<article class="card settings-card/g)).toHaveLength(2);
    expect(h).toContain("settings-form");
    expect(h).not.toContain("<h3 class=\"settings-card__name\">H</h3>");
  });
  it("delete confirmation in the right card", () => {
    const h = html(run(loaded(), { type: "askDelete", id: "h" }));
    expect(h).toContain("Удалить провайдера «H»?");
    expect(h).not.toContain("Удалить провайдера «P»?");
  });
  it("confirm check panel: without a button row", () => {
    const s = run(loaded(), { type: "test", id: "p", action: { type: "ask" } });
    const h = html(s);
    expect(h).toContain("Проверочный вызов расходует подписку");
    expect(h).toContain("Вызов ещё не начат");
    expect(h.match(/settings-actions/g)).toHaveLength(1);
  });
  it("actionError", () => {
    const h = html(run(loaded(), { type: "begin", id: "p" }, { type: "fail", id: "p", message: "диск полон" }));
    expect(h).toContain("Действие не выполнено");
    expect(h).toContain("диск полон");
  });
  it("«Default» tab", () => {
    const h = html(run(loaded(), { type: "tab", tab: "defaults" }));
    expect(h).toContain('aria-selected="true">По умолчанию');
    expect(h).toContain("/cfg/config.json");
    expect(h).not.toContain("settings-card");
  });
  it("rechecking disables the buttons", () => {
    const h = html(run(loaded(), { type: "recheck" }));
    expect(h).toContain("Проверяю…");
    expect(h).not.toContain("Обновить модели");
    expect(h).toContain("Обновляю…");
  });
});

describe("reduceSettings", () => {
  it("a new view resets the errors, busy, and clears the records of vanished providers", () => {
    let s = loaded();
    s = run(s, { type: "askDelete", id: "h" }, { type: "draft", id: "h", text: "x" }, { type: "test", id: "h", action: { type: "ask" } },
      { type: "begin", id: "p" }, { type: "fail", id: "p", message: "e" }, { type: "begin", id: "h" }, { type: "recheck" });
    expect(s.busy).toEqual({ h: true });
    s = run(s, { type: "view", view: view({ providers: [prov()] }) });
    expect(s.view!.providers).toHaveLength(1);
    expect(s.actionError).toBeNull();
    expect(s.loadError).toBeNull();
    expect(s.rechecking).toBe(false);
    expect(s.busy).toEqual({});
    expect(s.drafts).toEqual({});
    expect(s.tests).toEqual({});
    expect(s.deleting).toBeNull();
  });
  it("deleting stays if the provider is in place", () => {
    expect(run(loaded(), { type: "askDelete", id: "h" }, { type: "view", view: view() }).deleting).toBe("h");
  });
  it("default draft: replaced without edits, kept with edits", () => {
    const fresh = view({ defaults: defs({ maxRounds: 7 }) });
    expect(run(loaded(), { type: "view", view: fresh }).defaults!.draft.maxRounds).toBe(7);
    const edited = run(loaded(), { type: "defaultsChange", draft: defs({ maxRounds: 9 }) });
    expect(isDirty(edited)).toBe(true);
    const next = run(edited, { type: "view", view: fresh });
    expect(next.defaults!.draft.maxRounds).toBe(9);
    expect(next.view!.defaults!.maxRounds).toBe(7);
  });
  it("isDirty", () => {
    expect(isDirty(initialSettings())).toBe(false);
    expect(isDirty(loaded())).toBe(false);
    expect(isDirty(run(loaded(), { type: "defaultsChange", draft: defs({ maxRounds: 2 }) }))).toBe(true);
  });
  it("one provider is replaced, busy is cleared", () => {
    const s = run(loaded(), { type: "begin", id: "h" }, { type: "provider", provider: http({ models: ["a", "b"] }) });
    expect(s.view!.providers[1]!.models).toEqual(["a", "b"]);
    expect(s.view!.providers[0]!.models).toEqual(["m1"]);
    expect(s.busy).toEqual({});
  });
  it("tab", () => {
    expect(run(loaded(), { type: "tab", tab: "defaults" }).tab).toBe("defaults");
  });
  it("form: open, edit, cancel, close, success", () => {
    let s = run(loaded(), { type: "openForm", provider: null });
    expect(s.form!.input).toEqual(EMPTY_PROVIDER);
    s = run(s, { type: "formClose" });
    expect(s.form).toBeNull();
    s = run(s, { type: "openForm", provider: http({ keyEnv: null }) });
    expect(s.form!.input).toEqual({ id: "h", label: "H", baseUrl: "http://x/v1", apiKeyEnv: "" });
    s = run(s, { type: "formChange", input: { ...s.form!.input, label: "Z" } }, { type: "formSaving" });
    expect(s.form).toMatchObject({ saving: true, input: { label: "Z" } });
    s = run(s, { type: "formFailed", message: "занято" });
    expect(s.form).toMatchObject({ saving: false, error: "занято" });
    s = run(s, { type: "formSaved", view: view({ providers: [prov()] }) });
    expect(s.form).toBeNull();
    expect(s.view!.providers).toHaveLength(1);
  });
  it("delete: opening closes the check, cancel", () => {
    let s = run(loaded(), { type: "test", id: "p", action: { type: "ask" } });
    expect(s.tests["p"]!.phase).toBe("confirm");
    s = run(s, { type: "askDelete", id: "p" });
    expect(s.deleting).toBe("p");
    expect(s.tests["p"]).toBeUndefined();
    expect(run(s, { type: "cancelDelete" }).deleting).toBeNull();
  });
  it("model draft and clearing after adding", () => {
    let s = run(loaded(), { type: "draft", id: "p", text: "new" }, { type: "draft", id: "h", text: "o" });
    expect(s.drafts).toEqual({ p: "new", h: "o" });
    s = run(s, { type: "view", view: view(), clearDraft: "p" });
    expect(s.drafts).toEqual({ h: "o" });
  });
  it("begin / fail", () => {
    let s = run(loaded(), { type: "fail", id: "x", message: "старая" }, { type: "begin", id: "p" });
    expect(s.busy).toEqual({ p: true });
    expect(s.actionError).toBeNull();
    s = run(s, { type: "fail", id: "p", message: "отказ" });
    expect(s.busy).toEqual({});
    expect(s.actionError).toBe("отказ");
  });
  it("the check panel goes through reduceTest", () => {
    let s = run(loaded(), { type: "test", id: "p", action: { type: "run" } });
    expect(s.tests["p"]!.phase).toBe("idle");
    s = run(s, { type: "test", id: "p", action: { type: "ask" } }, { type: "test", id: "p", action: { type: "run" } });
    expect(s.tests["p"]).toEqual({ phase: "running", model: "m1" });
    s = run(s, { type: "test", id: "p", action: { type: "result", result: { ok: true, ms: 5 } } });
    expect(s.tests["p"]!.phase).toBe("done");
    expect(run(s, { type: "test", id: "zzz", action: { type: "ask" } })).toBe(s);
  });
  it("default values: edit, save, cancel, success", () => {
    let s = run(loaded(), { type: "defaultsChange", draft: defs({ maxRounds: 3 }) }, { type: "defaultsSaving" });
    expect(s.defaults!.saving).toBe(true);
    s = run(s, { type: "defaultsFailed", message: "нельзя" });
    expect(s.defaults).toMatchObject({ saving: false, error: "нельзя" });
    s = run(s, { type: "defaultsSaving" }, { type: "defaultsSaved", view: view({ defaults: defs({ maxRounds: 3 }) }) });
    expect(s.defaults).toMatchObject({ saving: false, error: null });
    expect(s.defaults!.draft.maxRounds).toBe(3);
    expect(isDirty(s)).toBe(false);
  });
  it("load refusal and «Check again»", () => {
    const s = run(initialSettings(), { type: "recheck" }, { type: "loadFailed", message: "нет" });
    expect(s).toMatchObject({ loadError: "нет", rechecking: false });
  });
});

describe("SettingsScreen: language", () => {
  afterEach(() => setProcessLanguage("ru"));
  const en = <T,>(f: () => T): T => { setProcessLanguage("en"); return f(); };
  const down = (n: number) => Array.from({ length: n }, (_, i) => prov({ id: `d${i}`, label: `D${i}`, available: false, reason: "no binary" }));
  const cyr = /[А-Яа-яЁё]/;

  it("en: tabs, heading, buttons; no Cyrillic", () => {
    const state = loaded({ providers: [prov(), http(), prov({ id: "u", label: "U", available: false, reason: "no binary" }), http({ id: "k", label: "K", keySet: false })] });
    expect(DEFAULT_LANGUAGE).toBe("en");
    setProcessLanguage(DEFAULT_LANGUAGE);
    const h = html(state);
    for (const t of ["Providers", "Defaults", "Add HTTP provider", "Check again"]) expect(h).toContain(t);
    expect(h).toContain('<h1 class="topbar__title">Settings</h1>');
    expect(h).not.toMatch(cyr);
  });

  it.each([
    [1, "1 provider unavailable", "1 провайдер недоступен"],
    [2, "2 providers unavailable", "2 провайдера недоступны"],
    [5, "5 providers unavailable", "5 провайдеров недоступны"],
  ])("множественное число: %i", (n, enText, ruText) => {
    const state = loaded({ providers: down(n) });
    expect(en(() => html(state))).toContain(enText);
    setProcessLanguage("ru");
    expect(html(state)).toContain(ruText);
  });

  it("owner's texts are not translated", () => {
    const h = en(() => html(loaded({ providers: [http({ label: "Локальный" })] })));
    expect(h).toContain("Локальный");
    expect(h).toContain("Providers");
    expect(h).toContain("key set");
  });

  it("switching language keeps what was typed", () => {
    const input = { id: null, label: "Локальный", baseUrl: "http://127.0.0.1:8787/v1", apiKeyEnv: "" };
    const state = loaded({}, { form: { input, saving: false, error: null } });
    const e = en(() => html(state));
    setProcessLanguage("ru");
    const r = html(state);
    for (const h of [e, r]) { expect(h).toContain('value="Локальный"'); expect(h).toContain('value="http://127.0.0.1:8787/v1"'); }
    expect(e).toContain(">Name<"); expect(e).toContain(">Save<");
    expect(r).toContain(">Название<"); expect(r).toContain(">Сохранить<");
  });

  it("the lineup does not depend on the language", () => {
    const tags = (h: string) => [...h.matchAll(/<([a-z0-9]+)/g)].map((m) => m[1]).join(",");
    const states = [
      loaded({ providers: [prov(), http(), ...down(2)] }),
      loaded({}, { tab: "defaults" }),
      loaded({ registryError: "bad json" }),
    ];
    for (const s of states) {
      const e = en(() => html(s));
      setProcessLanguage("ru");
      expect(tags(e)).toBe(tags(html(s)));
    }
  });

  it("error screens in en", () => {
    expect(en(() => html({ ...initialSettings(), loadError: "boom" }))).toContain("Could not open settings");
    expect(en(() => html(loaded({ registryError: "bad" })))).toContain("Error in the settings file");
    expect(en(() => html(loaded({}, { actionError: "x" })))).toContain("Action failed");
  });

  it("language from the context when the process language is ru", () => {
    const input = { id: null, label: "Локальный", baseUrl: "http://127.0.0.1:8787/v1", apiKeyEnv: "" };
    const state = loaded({}, { form: { input, saving: false, error: null } });
    const ctx = (language: "en" | "ru") => renderToStaticMarkup(
      <LanguageProvider initial={{ language, source: "file", locked: false }}>
        <SettingsScreen state={state} now={new Date("2026-01-01T12:00:00")} />
      </LanguageProvider>);
    const e = ctx("en");
    for (const t of ["Providers", "Defaults", ">Settings<", ">Name<", ">Address<", ">Save<"]) expect(e).toContain(t);
    const r = ctx("ru");
    for (const t of ["Провайдеры", "По умолчанию", ">Настройки<", ">Название<", ">Адрес<", ">Сохранить<"]) expect(r).toContain(t);
    for (const h of [e, r]) { expect(h).toContain('value="Локальный"'); expect(h).toContain('value="http://127.0.0.1:8787/v1"'); }
  });

  it("en: labels that must not be caught by hard-coded ru", () => {
    expect(en(() => html(loaded({}, { rechecking: true })))).toContain("Checking…");
    expect(en(() => html({ ...initialSettings(), loadError: "boom" }))).toContain("Check again");
    expect(en(() => html(initialSettings()))).toContain("Checking providers…");
    const h = en(() => html(loaded({ registryError: "bad" })));
    expect(h).toContain('File: <span class="mono">/cfg/config.json</span>');
    expect(h).toContain("The app does not fix this file itself. Correct it by hand and press “Check again”.");
    expect(en(() => html(loaded({ providers: [http({ available: false, keySet: false })] })))).toContain("— key not set.");
  });
});

describe("Connections tab in SettingsScreen", () => {
  const withLang = (s: SettingsState) => renderToStaticMarkup(
    <LanguageProvider initial={{ language: "ru", source: "file", locked: false }}>
      <SettingsScreen state={s} now={new Date("2026-01-01T12:00:00")} />
    </LanguageProvider>);
  it("tab button is third and selecting it renders the tab", () => {
    const h = html(loaded({}, { tab: "connections" }));
    expect(h).toContain('aria-selected="true">Подключения');
    expect(h.indexOf(">Провайдеры<")).toBeLessThan(h.indexOf(">По умолчанию<"));
    expect(h.indexOf(">По умолчанию<")).toBeLessThan(h.indexOf(">Подключения<"));
  });
  it("tab works with a registry error, providers tab keeps the alert", () => {
    const bad = { registryError: "поле providers: не массив", providers: [], defaults: null };
    const on = withLang(loaded(bad, { tab: "connections" }));
    expect(on).toContain('role="tab"');
    expect(on).not.toContain("Ошибка в файле настроек");
    expect(on).toContain("Язык интерфейса");
    const off = withLang(loaded(bad));
    expect(off).toContain("Ошибка в файле настроек");
    expect(off).toContain("Подключения");
  });
  it("tab works with a load error, language block stays", () => {
    const s = { ...run(initialSettings(), { type: "loadFailed", message: "сбой моста" }), tab: "connections" as const };
    const on = withLang(s);
    expect(on).toContain('role="tab"');
    expect(on).not.toContain("Не удалось открыть настройки");
    expect(on).toContain("Язык интерфейса");
    expect(withLang({ ...s, tab: "providers" })).toContain("Не удалось открыть настройки");
  });
});

