import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import { settings } from "../../shared/messages/settings.ts";
import type { ProviderInput } from "../../shared/settings.ts";
import { EMPTY_PROVIDER, ProviderForm } from "./ProviderForm.tsx";

const ENV = "/data/.env";
const html = (input: ProviderInput, o: { saving?: boolean; error?: string | null } = {}) =>
  renderToStaticMarkup(<ProviderForm input={input} envPath={ENV} saving={o.saving ?? false} error={o.error ?? null} onChange={() => {}} onSave={() => {}} onCancel={() => {}} />);
const save = (h: string) => h.match(/<button[^>]*btn--primary[^>]*>/)![0];
const cancel = (h: string) => h.match(/<button(?![^>]*btn--primary)[^>]*btn btn--sm[^>]*>/)![0];
const ok: ProviderInput = { id: null, label: "Локальный", baseUrl: "http://localhost:8787/v1", apiKeyEnv: "" };

describe("ProviderForm", () => {
  it("new provider: heading, three fields, .env path, empty form without reasons", () => {
    const h = html(EMPTY_PROVIDER);
    expect(h).toContain("Новый HTTP-провайдер");
    expect(h).toContain('<span class="chip">HTTP</span>');
    for (const t of ["Название", "Адрес", "Имя переменной ключа"]) expect(h).toContain(`<span class="field__label">${t}</span>`);
    expect(h).toContain('<span class="mono">/data/.env</span>');
    expect(save(h)).toContain("disabled");
    expect(h).not.toContain("setup__error");
  });

  it("edit: heading and values filled in", () => {
    const h = html({ id: "p1", label: "Мой", baseUrl: "https://a.b/v1", apiKeyEnv: "MY_KEY" });
    expect(h).toContain("Изменить провайдера");
    expect(h).toContain('value="Мой"');
    expect(h).toContain('value="https://a.b/v1"');
    expect(h).toContain('value="MY_KEY"');
    expect(save(h)).not.toContain("disabled");
  });

  it("valid input enables «Save»", () => {
    expect(save(html(ok))).not.toContain("disabled");
  });

  it.each(["ftp://x", "не адрес"])("invalid address %s: reason and block", (baseUrl) => {
    const h = html({ ...ok, baseUrl });
    expect(h).toContain("Адрес должен начинаться с http:// или https://");
    expect(save(h)).toContain("disabled");
  });

  it("invalid variable name: reason and block", () => {
    const h = html({ ...ok, apiKeyEnv: "test key" });
    expect(h).toContain("Имя переменной: заглавные латинские буквы");
    expect(save(h)).toContain("disabled");
  });

  it("saving: text and both buttons disabled", () => {
    const h = html(ok, { saving: true });
    expect(h).toContain("Сохраняю…");
    expect(save(h)).toContain("disabled");
    expect(cancel(h)).toContain("disabled");
  });

  it("error: alert, reason is escaped", () => {
    const h = html(ok, { error: "Сбой <b>x</b>" });
    expect(h).toContain('role="alert"');
    expect(h).toContain("Не удалось сохранить");
    expect(h).toContain("Сбой &lt;b&gt;x&lt;/b&gt;");
    expect(h).not.toContain("<b>");
  });

  it("exactly three inputs, no password", () => {
    const h = html(ok);
    expect(h.match(/<input/g)).toHaveLength(3);
    expect(h).not.toContain('type="password"');
  });
});

describe("ProviderForm: en", () => {
  afterEach(() => setProcessLanguage("ru"));
  const en = (input: ProviderInput, o: { saving?: boolean; error?: string | null } = {}) => { setProcessLanguage("en"); return html(input, o); };

  it("new form: heading, labels, hints, buttons", () => {
    const h = en(EMPTY_PROVIDER);
    for (const t of ["New HTTP provider", "Name", "Address", "Key variable name", "Save", "Cancel"]) expect(h).toContain(t);
    expect(h).toContain('<span class="field__label">Address</span>');
    expect(h).toContain('placeholder="For example, Local"');
    expect(h).toContain('placeholder="For example, OPENROUTER_API_KEY"');
    expect(h).toContain("Address of an OpenAI-compatible endpoint");
    expect(h).toContain('Optional. Put the key value into the file <span class="mono">/data/.env</span> — keys are not entered in the app.');
  });
  it("edit, save, error", () => {
    expect(en({ ...ok, id: "p1" })).toContain("Edit provider");
    expect(en(ok, { saving: true })).toContain("Saving…");
    expect(en(ok, { error: "boom" })).toContain("Could not save");
  });
  it("check refusal in en", () => {
    const h = en({ id: null, label: "", baseUrl: "ftp://x", apiKeyEnv: "" });
    expect(h).toContain(settings("en").baseUrlInvalid);
    expect(save(h)).toContain("disabled");
  });
});
