import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import type { SettingsProvider } from "../../shared/settings.ts";
import { ProviderCard } from "./ProviderCard.tsx";

const base: SettingsProvider = {
  id: "p", kind: "cli", label: "Claude Code", available: true, reason: null, warning: null, version: "2.1.288", path: "/opt/homebrew/bin/claude",
  baseUrl: null, keyEnv: null, keySet: false, billing: "subscription", models: [], defaultModel: null, modelsSource: "provider", modelsReason: null, modelsAt: null
};
const http = (o: Partial<SettingsProvider> = {}): SettingsProvider => ({
  ...base, kind: "openai-http", label: "OpenRouter", version: null, path: null, baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", keySet: true, billing: "paid", ...o
});
type Over = { busy?: boolean; deleting?: boolean; canTest?: boolean; models?: ReactNode; test?: ReactNode | null };
const html = (provider: SettingsProvider, o: Over = {}) =>
  renderToStaticMarkup(
    <ProviderCard provider={provider} envPath="/data/.env" busy={o.busy ?? false} deleting={o.deleting ?? false} canTest={o.canTest ?? true}
      models={o.models ?? null} test={o.test ?? null} onTest={() => {}} onRecheck={() => {}} onEdit={() => {}} onAskDelete={() => {}} onDelete={() => {}} onCancelDelete={() => {}} />
  );
const btn = (h: string, text: string) => h.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${text}</button>`))?.[0] ?? "";

describe("ProviderCard", () => {
  it("CLI found", () => {
    const h = html(base);
    expect(h).toContain('<span class="badge" data-tone="ok">');
    expect(h).toContain("доступен");
    expect(h).toContain('<dt>Версия</dt><dd><span class="mono">2.1.288</span></dd>');
    expect(h).toContain('<dt>Команда</dt><dd><span class="mono">/opt/homebrew/bin/claude</span></dd>');
    expect(h).toContain('<dd><span class="chip">расходует подписку</span></dd>');
    expect(btn(h, "Проверить")).not.toBe("");
    expect(h).toContain('<div class="settings-card__head"><h3 class="settings-card__name">Claude Code</h3><span class="chip mono">CLI</span>');
    expect(h).toContain('<dl class="kv settings-info">');
    expect(h).not.toContain("Изменить");
    expect(h).not.toContain("Удалить");
  });

  it("CLI not found", () => {
    const h = html({ ...base, available: false, reason: "Команда codex не найдена", version: null, path: null });
    expect(h).toContain('<span class="badge" data-tone="danger">');
    expect(h).toContain("недоступен");
    expect(h).toContain('data-tone="danger" role="alert"');
    expect(h).toContain("Команда codex не найдена");
    expect(btn(h, "Проверить заново")).not.toBe("");
    expect(h).not.toContain("<dt>Версия</dt>");
    expect(h).not.toContain("<dt>Команда</dt>");
    expect(h).toContain("<dt>Расход</dt>");
  });

  it("version newer than the verified one", () => {
    const h = html({ ...base, warning: "Проверено на 2.0–2.1, найдена 2.5" });
    expect(h).toContain('<div class="alert" data-tone="warn">');
    expect(h).toContain("Версия новее проверенной");
    expect(h).toContain("Проверено на 2.0–2.1, найдена 2.5");
    expect(h).toContain('data-tone="ok"');
  });

  it("HTTP with a key", () => {
    const h = html(http());
    expect(h).toContain('<dt>Адрес</dt><dd><span class="mono">https://openrouter.ai/api/v1</span></dd>');
    expect(h).toContain('<dd><span class="mono">OPENROUTER_API_KEY</span><span class="badge" data-tone="ok">');
    expect(h).toContain('<span class="chip mono">HTTP</span>');
    expect(h).toContain("ключ задан");
    expect(h).toContain("оплачивается");
    expect(btn(h, "Проверить")).not.toBe("");
    expect(btn(h, "Изменить")).not.toBe("");
    expect(btn(h, "Удалить")).not.toBe("");
  });

  it("HTTP without a key", () => {
    const h = html(http({ available: false, keySet: false, reason: "нет ключа" }));
    expect(h.match(/data-tone="warn"><svg[^>]*><use href="#i-alert"><\/use><\/svg> ключ не задан/g)).toHaveLength(2);
    expect(h).toContain('<div class="alert__title">Ключ не задан</div>');
    expect(h).toContain('<span class="mono">OPENROUTER_API_KEY</span> в файл <span class="mono">/data/.env</span>');
    expect(btn(h, "Проверить заново")).not.toBe("");
  });

  it("HTTP without a key variable", () => {
    const h = html(http({ keyEnv: null, billing: "free" }));
    expect(h).toContain('<span class="muted">не требуется</span>');
    expect(h).not.toContain("<dt>Расход</dt>");
  });

  it("HTTP unavailable for another reason", () => {
    const h = html(http({ available: false, reason: "Эндпоинт не отвечает" }));
    expect(h).toContain('<span class="badge" data-tone="danger">');
    expect(h).toContain("Эндпоинт не отвечает");
    expect(h).toContain("Провайдер недоступен");
  });

  it("delete confirmation", () => {
    const h = html(http(), { deleting: true });
    expect(h).toContain("Удалить провайдера «OpenRouter»?");
    expect(btn(h, "Удалить")).toContain("btn--danger");
    expect(btn(h, "Отмена")).not.toBe("");
    expect(h).not.toContain("settings-actions");
  });

  it("check panel", () => {
    const h = html(base, { test: <div id="panel">ПАНЕЛЬ</div> });
    expect(h).toContain('<div id="panel">ПАНЕЛЬ</div>');
    expect(h).not.toContain("settings-actions");
  });

  it("busy and canTest", () => {
    const h = html(http(), { busy: true });
    for (const t of ["Проверить", "Изменить", "Удалить"]) expect(btn(h, t)).toContain("disabled");
    expect(btn(html(http(), { canTest: false }), "Проверить")).toContain("disabled");
    expect(btn(html(http()), "Проверить")).not.toContain("disabled");
  });

  it("models node", () => {
    expect(html(base, { models: <div id="m">МОДЕЛИ</div> })).toContain('<div id="m">МОДЕЛИ</div>');
  });

  it("no input fields, the name is escaped", () => {
    const h = html({ ...base, label: "<b>x</b>" });
    expect(h).not.toContain("<input");
    expect(h).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(h).not.toContain("<b>");
  });
});

describe("ProviderCard: en", () => {
  afterEach(() => setProcessLanguage("ru"));
  const en = (p: SettingsProvider, o: Over = {}) => { setProcessLanguage("en"); return html(p, o); };

  it("CLI available", () => {
    const h = en(base);
    for (const t of ["available", "Version", "Command", "Billing", "uses subscription", "Test"]) expect(h).toContain(t);
  });
  it("HTTP with a key", () => {
    const h = en(http());
    for (const t of ["Address", "Key", "key set", "paid", "Edit", "Delete"]) expect(h).toContain(t);
  });
  it("key not set: a phrase with the variable name and path", () => {
    const h = en(http({ available: false, keySet: false }));
    expect(h).toContain("key not set");
    expect(h).toContain('Put the value of the variable <span class="mono">OPENROUTER_API_KEY</span> into the file <span class="mono">/data/.env</span> and press “Check again”.');
    expect(h).toContain("Check again");
  });
  it("unavailable: reason as is", () => {
    const h = en(base_down());
    expect(h).toContain("Provider unavailable");
    expect(h).toContain("Не найден");
  });
  it("version warning", () => {
    expect(en({ ...base, warning: "w" })).toContain("Version newer than tested");
  });
  it("must not be caught by hard-coded ru", () => {
    const miss = en(http({ available: false, keySet: false }));
    expect(miss).toMatch(/<span class="badge" data-tone="warn">.*key not set<\/span><\/div>/);
    expect(miss).toContain("<div class=\"alert__title\">Key not set</div>");
    expect(en(http({ keyEnv: null }))).toContain("not required");
    const d = en(http(), { deleting: true });
    expect(d).toContain("It will be removed from the registry and from the default participants. Past sessions with it stay in history.");
    expect(btn(d, "Delete")).toContain("btn--danger");
  });
  it("delete confirmation", () => {
    const h = en(http(), { deleting: true });
    expect(h).toContain("Delete provider “OpenRouter”?");
    expect(h).toContain("Cancel");
  });
});
const base_down = (): SettingsProvider => ({ ...base, available: false, reason: "Не найден" });
