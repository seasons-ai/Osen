import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import { settings } from "../../shared/messages/settings.ts";
import type { DefaultsValues, SettingsProvider } from "../../shared/settings.ts";
import { DefaultsPanel, addParticipant, modelOptions, withProvider } from "./DefaultsPanel.tsx";

const prov = (o: Partial<SettingsProvider> & Pick<SettingsProvider, "id" | "label">): SettingsProvider => ({
  kind: "cli", available: true, reason: null, warning: null, version: null, path: null, baseUrl: null, keyEnv: null, keySet: false,
  billing: "subscription", models: ["haiku", "opus"], defaultModel: "default", modelsSource: "owner", modelsReason: null, modelsAt: null, cli: null, ...o
});
const claude = prov({ id: "claude", label: "Claude Code" });
const codex = prov({ id: "codex", label: "Codex", models: ["m1"], defaultModel: null });
const broken = prov({ id: "broken", label: "Сломанный", available: false, models: [], defaultModel: null });
const providers = [claude, codex, broken];
const values = (o: Partial<DefaultsValues> = {}): DefaultsValues => ({
  maxRounds: 5, turnTimeoutSec: 300, contextChars: 24000, materialsChars: 80000, maxTotalTokens: null, maxParticipants: 8,
  participants: [{ providerId: "claude", model: "default" }, { providerId: "codex", model: "m1" }], ...o
});
const html = (o: { values?: DefaultsValues; providers?: SettingsProvider[]; dirty?: boolean; saving?: boolean; error?: string | null } = {}) =>
  renderToStaticMarkup(<DefaultsPanel values={o.values ?? values()} providers={o.providers ?? providers} configPath="/tmp/config.json"
    dirty={o.dirty ?? false} saving={o.saving ?? false} error={o.error ?? null} onChange={() => {}} onSave={() => {}} />);
const saveBtn = (h: string) => h.match(/<button[^>]*btn--primary[^>]*>/)![0];

describe("DefaultsPanel", () => {
  it("valid values: fields, participants, path, Save enabled by dirty", () => {
    const h = html();
    for (const t of ["Лимит кругов", "Таймаут хода, с", "Объём контекста, знаков", "Объём материалов, знаков", "Сколько знаков приложенных файлов можно передать участникам одной сессии", "Участников не больше"]) expect(h).toContain(t);
    expect(h).toContain('value="300"');
    expect(h).toContain('value="24000"');
    expect(h).toContain('value="80000"');
    expect(h).toContain('<span class="stepper__value">5</span>');
    expect(h).toContain('codex · <span class="tag">m1</span>');
    expect(h).toContain('<div class="participant__name">Claude Code</div>');
    expect(h).toContain('<div class="participant__name">Codex (m1)</div>');
    expect(h).toContain('<span class="mono">/tmp/config.json</span>');
    expect(h).not.toContain("setup__error");
    expect(saveBtn(h)).toContain("disabled");
    expect(saveBtn(html({ dirty: true }))).not.toContain("disabled");
  });

  it("one participant: reason, Save disabled", () => {
    const h = html({ values: values({ participants: [{ providerId: "claude", model: "default" }] }), dirty: true });
    expect(h).toContain("Нужно не меньше двух участников");
    expect(saveBtn(h)).toContain("disabled");
  });

  it("number out of bounds: reason next to the field, Save disabled", () => {
    const h = html({ values: values({ turnTimeoutSec: 5 }), dirty: true });
    expect(h).toContain("Целое число от 10 до 3600");
    expect(saveBtn(h)).toContain("disabled");
  });

  it("material volume out of bounds: reason next to the field, Save disabled", () => {
    const h = html({ values: values({ materialsChars: 999 }), dirty: true });
    expect(h).toContain("Целое число от 1000 до 1000000");
    expect(saveBtn(h)).toContain("disabled");
  });

  it("zero is shown as an empty string", () => {
    expect(html({ values: values({ turnTimeoutSec: 0 }) })).toContain('<input class="input" inputMode="numeric" value=""');
  });

  it("bounds of the rounds limit stepper", () => {
    const low = html({ values: values({ maxRounds: 1, maxParticipants: 5 }) });
    expect(low).toMatch(/<button[^>]*aria-label="Меньше" disabled=""/);
    expect(low).not.toMatch(/aria-label="Больше" disabled/);
    const high = html({ values: values({ maxRounds: 20, maxParticipants: 5 }) });
    expect(high).toMatch(/aria-label="Больше" disabled=""/);
    expect(high.match(/aria-label="Меньше"[^>]*>/)![0]).not.toContain("disabled");
  });

  it("Add disabled at maxParticipants and without providers", () => {
    const add = (h: string) => h.match(/<button[^>]*btn btn--sm"[^>]*>/)![0];
    expect(add(html({ values: values({ maxParticipants: 2 }) }))).toContain("disabled");
    expect(add(html({ providers: [] }))).toContain("disabled");
    expect(add(html())).not.toContain("disabled");
  });

  it("unavailable provider, unknown provider, «default»", () => {
    const h = html({ values: values({ participants: [{ providerId: "claude", model: "default" }, { providerId: "ghost", model: "x" }] }) });
    expect(h).toContain("Сломанный — недоступен");
    expect(h).toContain('<option value="ghost" selected="">ghost</option>');
    expect(h).toContain('claude · <span class="tag">по умолчанию</span>');
    expect(h).toContain(">по умолчанию</option>");
  });

  it("saving and error", () => {
    const h = html({ saving: true, dirty: true, error: "Диск полон" });
    expect(h).toContain("Сохраняю…");
    expect(saveBtn(h)).toContain("disabled");
    expect(h).toContain('role="alert"');
    expect(h).toContain("Не удалось сохранить");
    expect(h).toContain("Диск полон");
  });
});

describe("pure functions", () => {
  it("modelOptions", () => {
    expect(modelOptions(claude)).toEqual(["default", "haiku", "opus"]);
    expect(modelOptions(codex)).toEqual(["m1"]);
    expect(modelOptions(undefined)).toEqual([]);
  });

  it("addParticipant: an available one is preferred, without providers — no changes", () => {
    const v = values();
    const copy = structuredClone(v);
    const a = addParticipant(v, [broken, codex]);
    expect(a.participants.at(-1)).toEqual({ providerId: "codex", model: "m1" });
    expect(a.participants).toHaveLength(3);
    expect(addParticipant(v, [broken]).participants.at(-1)).toEqual({ providerId: "broken", model: "" });
    expect(addParticipant(v, [])).toEqual(v);
    expect(v).toEqual(copy);
  });

  it("withProvider: model reset, input unchanged", () => {
    const v = values();
    const copy = structuredClone(v);
    const w = withProvider(v, 1, "claude", providers);
    expect(w.participants[1]).toEqual({ providerId: "claude", model: "default" });
    expect(w.participants[0]).toEqual(v.participants[0]);
    expect(withProvider(v, 0, "broken", providers).participants[0]?.model).toBe("");
    expect(v).toEqual(copy);
  });
});

describe("DefaultsPanel: token ceiling", () => {
  it("field after «Material volume, characters»; null — empty and placeholder, no errors", () => {
    const h = html({ dirty: true });
    expect(h.indexOf("Объём материалов, знаков")).toBeLessThan(h.indexOf("Потолок токенов на сессию"));
    expect(h).toContain('placeholder="без потолка" value=""');
    expect(h).toContain("Пусто — без потолка; сумма входных и выходных токенов всех вызовов моделей, включая неудачные попытки");
    expect(h).not.toContain("setup__error");
    expect(saveBtn(h)).not.toContain("disabled");
  });
  it("the hint names all model calls and failed attempts, not «all turns» (en, ru)", () => {
    const cases = [["en", ["Empty means no cap", "all model calls", "failed attempts"], "all turns"], ["ru", ["Пусто — без потолка", "всех вызовов моделей", "неудачные попытки"], "всех ходов"]] as const;
    try {
      for (const [lang, has, not] of cases) {
        setProcessLanguage(lang);
        const h = html({ dirty: true });
        for (const x of has) expect(h).toContain(x);
        expect(h).not.toContain(not);
      }
    } finally { setProcessLanguage("ru"); }
  });
  it("50000 is shown as is", () => {
    expect(html({ values: values({ maxTotalTokens: 50000 }) })).toContain('placeholder="без потолка" value="50000"');
  });
  it("0: value «0», error at the field, Save disabled", () => {
    const h = html({ values: values({ maxTotalTokens: 0 }), dirty: true });
    expect(h).toContain('placeholder="без потолка" value="0"');
    expect(h).toContain("Нужно целое число от 1");
    expect(saveBtn(h)).toContain("disabled");
  });
});
const tags = (h: string) => [...h.matchAll(/<([a-z0-9]+)/g)].map((m) => m[1]);

afterEach(() => setProcessLanguage("ru"));

describe("DefaultsPanel: English", () => {
  it("labels, hints, placeholder, aria-label", () => {
    setProcessLanguage("en");
    const h = html({ values: values({ participants: [{ providerId: "claude", model: "default" }, { providerId: "local", model: "" }] }),
      providers: [claude, prov({ id: "local", label: "Локальный", models: [], defaultModel: null }), broken], dirty: true });
    const t = settings("en");
    for (const x of [t.defaultsTitle, t.defaultsNote, t.limits, t.maxRounds, t.maxRoundsHint, t.turnTimeout, t.turnTimeoutHint, t.contextChars, t.contextCharsHint,
      t.materialsChars, t.materialsCharsHint, t.tokenCap, t.tokenCapHint, t.maxParticipants, t.maxParticipantsHint, t.defaultParticipants,
      t.add, t.save, t.settingsFile, t.noModels, t.optionUnavailable("Сломанный"), "Локальный"]) expect(h).toContain(x);
    expect(html()).toContain("at least two");
    expect(h).toContain('placeholder="no cap"');
    expect(h).toContain('claude · <span class="tag">default</span>');
    expect(h).toContain('<div class="participant__meta">local</div>');
    expect(h).toContain(">default</option>");
    for (const l of ["Less", "More", "Provider", "Model", "Remove"]) expect(h).toContain(`aria-label="${l}"`);
    const s = html({ saving: true, dirty: true, error: "Диск полон" });
    expect(s).toContain("Saving…");
    expect(s).toContain("Could not save");
    expect(s).toContain("Диск полон");
  });
  it("number out of bounds: reason in the selected language", () => {
    setProcessLanguage("en");
    expect(html({ values: values({ turnTimeoutSec: 5 }), dirty: true })).toContain(settings("en").intRange(10, 3600));
  });
  it("token ceiling 0: reason in English", () => {
    setProcessLanguage("en");
    expect(html({ values: values({ maxTotalTokens: 0 }), dirty: true })).toContain("An integer of 1 or more is required");
  });
  it("the lineup does not depend on the language", () => {
    const o = { values: values({ turnTimeoutSec: 5, participants: [{ providerId: "claude", model: "default" }] }), dirty: true, error: "e" };
    const ru = tags(html(o));
    setProcessLanguage("en");
    expect(tags(html(o))).toEqual(ru);
  });
});
