import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import { settings } from "../../shared/messages/settings.ts";
import type { SettingsProvider } from "../../shared/settings.ts";
import { ProviderModels, modelsAfterAdd, modelsAfterRemove, modelsSourceText } from "./ProviderModels.tsx";

const now = new Date(2026, 9, 8, 15, 0);
const prov = (o: Partial<SettingsProvider> = {}): SettingsProvider => ({
  id: "router", kind: "openai-http", label: "OpenRouter", available: true, reason: null, warning: null, version: null, path: null,
  baseUrl: "https://x/v1", keyEnv: "K", keySet: true, billing: "paid", models: ["m1", "m2"], ownerModels: [], defaultModel: "def",
  modelsSource: "provider", modelsReason: null, modelsAt: new Date(2026, 9, 8, 11, 30).toISOString(), cli: null, ...o
});
const html = (p: SettingsProvider, o: { draft?: string; busy?: boolean } = {}) =>
  renderToStaticMarkup(<ProviderModels provider={p} now={now} draft={o.draft ?? ""} busy={o.busy ?? false}
    onDraft={() => {}} onAdd={() => {}} onRemove={() => {}} onRefresh={() => {}} onReset={() => {}} />);
const hm = (d: Date) => new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit" }).format(d);
const addBtn = (h: string) => h.match(/<button[^>]*>(?:(?!<\/button>).)*Добавить модель<\/button>/)![0];
const mainBtn = (h: string) => h.match(/<button[^>]*btn--ghost[^>]*>(?:(?!<\/button>).)*<\/button>/)![0];

describe("ProviderModels", () => {
  it("provider: today, refresh button, no delete buttons", () => {
    const h = html(prov());
    expect(h).toContain(`перечень получен сегодня в ${hm(new Date(2026, 9, 8, 11, 30))}`);
    expect(h).toContain("Обновить модели");
    expect(h).toContain('<span class="tag">m1</span><span class="tag">m2</span>');
    expect(h).toContain('<span class="settings-models__source">перечень получен сегодня');
    expect(h).not.toContain('class="chip"');
    expect(h).not.toContain("Убрать модель");
  });

  it("provider: another day and no time", () => {
    const d = new Date(2026, 9, 5, 9, 5);
    expect(html(prov({ modelsAt: d.toISOString() }))).toContain(`перечень получен ${new Intl.DateTimeFormat("ru", { day: "numeric", month: "long" }).format(d)} в ${hm(d)}`);
    expect(modelsSourceText(prov({ modelsAt: null }), now)).toBe("перечень получен от провайдера");
  });

  it("unconfirmed: reason after the colon, no delete buttons", () => {
    const h = html(prov({ modelsSource: "unconfirmed", modelsReason: "ответ без списка" }));
    expect(h).toContain("перечень не подтверждён: ответ без списка");
    expect(h).toContain("Обновить модели");
    expect(h).not.toContain("Убрать модель");
    expect(modelsSourceText(prov({ modelsSource: "unconfirmed" }), now)).toBe("перечень не подтверждён");
  });

  it("unavailable: reason as is, no chips, manual add in place", () => {
    const h = html(prov({ modelsSource: "unavailable", modelsReason: "нет ключа", models: [], modelsAt: null }));
    expect(h).toContain("нет ключа");
    expect(h).not.toContain('class="tag"');
    expect(h.match(/class="settings-models"/g)).toHaveLength(1);
    expect(h).toContain('aria-label="Модель вручную"');
    expect(h).toContain("Добавить модель");
    expect(modelsSourceText(prov({ modelsSource: "unavailable" }), now)).toBe("перечень моделей недоступен");
  });

  it("busy: both buttons disabled, text «Refreshing…»", () => {
    const h = html(prov(), { busy: true, draft: "new" });
    expect(mainBtn(h)).toContain("disabled");
    expect(mainBtn(h)).toContain("Обновляю…");
    expect(addBtn(h)).toContain("disabled");
  });

  it("add button: disabled when empty and on repeat, enabled when new", () => {
    expect(addBtn(html(prov()))).toContain("disabled");
    expect(addBtn(html(prov(), { draft: "m1" }))).toContain("disabled");
    expect(addBtn(html(prov(), { draft: "new" }))).not.toContain("disabled");
    expect(html(prov(), { draft: "new" })).toContain('value="new"');
  });

  it("Ручная модель не отключает обновление: refresh stays, remove only on added models", () => {
    const h = html(prov({ ownerModels: ["m2"] }));
    expect(h).toContain("Обновить модели");
    expect(h).toContain("Убрать добавленные модели");
    expect(h).toContain('aria-label="Убрать модель m2"');
    expect(h).not.toContain('aria-label="Убрать модель m1"');
    expect(html(prov())).not.toContain("Убрать добавленные модели");
    expect(html(prov())).not.toContain("Убрать модель");
  });

  it("modelsAfterAdd and modelsAfterRemove", () => {
    const p = prov();
    expect(modelsAfterAdd(p, "")).toBeNull();
    expect(modelsAfterAdd(p, "   ")).toBeNull();
    expect(modelsAfterAdd(p, " m1 ")).toBeNull();
    expect(modelsAfterAdd(p, "def")).toBeNull();
    expect(modelsAfterAdd(p, " new ")).toEqual(["new"]);
    const q = prov({ ownerModels: ["m2"] });
    expect(modelsAfterAdd(q, "new")).toEqual(["m2", "new"]);
    expect(modelsAfterRemove(q, "m2")).toEqual([]);
  });

  it("name with < is escaped", () => {
    const h = html(prov({ models: ["a<b>"] }));
    expect(h).toContain("a&lt;b&gt;");
    expect(h).not.toContain("a<b>");
  });
});
const tags = (h: string) => [...h.matchAll(/<([a-z0-9]+)/g)].map((m) => m[1]);

afterEach(() => setProcessLanguage("ru"));

describe("ProviderModels: English", () => {
  const en = (fn: () => void) => { setProcessLanguage("en"); fn(); };
  it("modelsSourceText: today and another day", () => en(() => {
    expect(modelsSourceText(prov({ modelsAt: new Date(2026, 9, 8, 14, 5).toISOString() }), now)).toMatch(/^list received today at 2:05\sPM$/);
    expect(modelsSourceText(prov({ modelsAt: new Date(2026, 9, 12, 14, 5).toISOString() }), now)).toMatch(/^list received October 12 at 2:05\sPM$/);
  }));
  it("modelsSourceText: other sources", () => en(() => {
    expect(modelsSourceText(prov({ modelsAt: null }), now)).toBe("list received from the provider");
    expect(modelsSourceText(prov({ modelsSource: "unconfirmed" }), now)).toBe("list not confirmed");
    expect(modelsSourceText(prov({ modelsSource: "unconfirmed", modelsReason: "ответ без списка" }), now)).toBe("list not confirmed: ответ без списка");
    expect(modelsSourceText(prov({ modelsSource: "unavailable", modelsReason: "нет ключа" }), now)).toBe("нет ключа");
    expect(modelsSourceText(prov({ modelsSource: "unavailable" }), now)).toBe("the model list is unavailable");
  }));
  it("ru: single-digit hour with a zero", () => {
    expect(modelsSourceText(prov({ modelsAt: new Date(2026, 9, 8, 9, 5).toISOString() }), now)).toBe("перечень получен сегодня в 09:05");
  });
  it("component", () => en(() => {
    const h = html(prov());
    expect(h).toContain("Refresh models");
    expect(h).toContain('placeholder="Model name"');
    expect(h).toContain("Add model");
    expect(html(prov())).not.toContain("Remove added models");
    const own = html(prov({ models: ["m1", "gpt-x"], ownerModels: ["gpt-x"] }));
    expect(own).toContain("Remove added models");
    expect(own).toContain("Refresh models");
    expect(own).toContain('aria-label="Remove model gpt-x"');
    expect(own).not.toContain('aria-label="Remove model m1"');
    expect(html(prov(), { busy: true })).toContain("Refreshing…");
  }));
  it("the lineup does not depend on the language", () => {
    for (const p of [prov(), prov({ ownerModels: ["m1"] })]) {
      const ru = tags(html(p));
      setProcessLanguage("en");
      expect(tags(html(p))).toEqual(ru);
      setProcessLanguage("ru");
    }
    expect(settings("en").removeModel("m")).toBe("Remove model m");
  });
});
