import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import type { SettingsProvider, TestResult } from "../../shared/settings.ts";
import { TestPanel, canTest, reduceTest, testModels } from "./ProviderTest.tsx";
import type { TestState } from "./ProviderTest.tsx";

const prov = (o: Partial<SettingsProvider> = {}): SettingsProvider => ({
  id: "p", kind: "cli", label: "P", available: true, reason: null, warning: null, version: null, path: null,
  baseUrl: null, keyEnv: null, keySet: false, billing: "subscription", models: ["m1", "m2"], defaultModel: "dflt",
  modelsSource: "provider", modelsReason: null, modelsAt: null, cli: null, ...o,
});
const cliOnlyDefault = prov({ models: [] });
const httpNoModels = prov({ kind: "openai-http", models: [], defaultModel: null, billing: "paid" });
const off = prov({ available: false });
const noop = () => {};
const html = (p: SettingsProvider, s: TestState) => renderToStaticMarkup(TestPanel({ provider: p, state: s, dispatch: noop }));

describe("testModels / canTest", () => {
  it("list, then «default»", () => {
    expect(testModels(prov())).toEqual(["m1", "m2", "dflt"]);
    expect(testModels(cliOnlyDefault)).toEqual(["dflt"]);
    expect(testModels(httpNoModels)).toEqual([]);
  });
  it("canTest", () => {
    expect(canTest(prov())).toBe(true);
    expect(canTest(cliOnlyDefault)).toBe(true);
    expect(canTest(httpNoModels)).toBe(false);
    expect(canTest(off)).toBe(false);
  });
});

describe("reduceTest", () => {
  const p = prov();
  const idle: TestState = { phase: "idle" };
  it("ask -> confirm with the first model, the call is not started", () => {
    expect(reduceTest(idle, { type: "ask" }, p)).toEqual({ phase: "confirm", model: "m1" });
  });
  it("ask with canTest === false does not change the state", () => {
    expect(reduceTest(idle, { type: "ask" }, off)).toBe(idle);
    expect(reduceTest(idle, { type: "ask" }, httpNoModels)).toBe(idle);
  });
  it("cancel, start, result", () => {
    const c: TestState = { phase: "confirm", model: "m2" };
    expect(reduceTest(c, { type: "cancel" }, p)).toEqual(idle);
    const r = reduceTest(c, { type: "run" }, p);
    expect(r).toEqual({ phase: "running", model: "m2" });
    const done = reduceTest(r, { type: "result", result: { ok: true, ms: 5 } }, p);
    expect(done).toEqual({ phase: "done", model: "m2", result: { ok: true, ms: 5 } });
    expect(reduceTest(done, { type: "cancel" }, p)).toEqual(idle);
    expect(reduceTest(done, { type: "ask" }, p)).toEqual({ phase: "confirm", model: "m1" });
  });
  it("model change: allowed and not allowed", () => {
    const c: TestState = { phase: "confirm", model: "m1" };
    expect(reduceTest(c, { type: "model", model: "dflt" }, p)).toEqual({ phase: "confirm", model: "dflt" });
    expect(reduceTest(c, { type: "model", model: "zzz" }, p)).toBe(c);
  });
  it("cannot leave running", () => {
    const r: TestState = { phase: "running", model: "m1" };
    for (const a of [{ type: "cancel" }, { type: "ask" }, { type: "run" }, { type: "model", model: "m2" }] as const) {
      expect(reduceTest(r, a, p)).toBe(r);
    }
  });
});

describe("TestPanel", () => {
  const confirm: TestState = { phase: "confirm", model: "m1" };
  it("idle is empty", () => expect(html(prov(), { phase: "idle" })).toBe(""));
  it.each([
    ["subscription", "Проверочный вызов расходует подписку"],
    ["paid", "Проверочный вызов оплачивается"],
    ["free", "Проверочный вызов<"],
  ] as const)("подтверждение для %s", (billing, title) => {
    const h = html(prov({ billing }), confirm);
    expect(h).toContain(title);
    expect(h).toContain('data-tone="info"');
    expect(h).toContain('<span class="tag">m1</span>');
    expect(h).toContain("Выполнить вызов");
    expect(h).toContain("Отмена");
    expect(h).toContain("Вызов ещё не начат.");
    expect(h).not.toContain("самой дешёвой");
    expect(h.includes("не оплачивается")).toBe(billing === "free");
  });
  it("select with several models and none with one", () => {
    const h = html(prov(), confirm);
    expect(h).toContain('aria-label="Модель проверки"');
    expect(h).toContain(">по умолчанию</option>");
    expect(html(cliOnlyDefault, { phase: "confirm", model: "dflt" })).not.toContain("<select");
  });
  it("«default» instead of the defaultModel value", () => {
    const h = html(cliOnlyDefault, { phase: "confirm", model: "dflt" });
    expect(h).toContain('<span class="tag">по умолчанию</span>');
    expect(h).not.toContain(">dflt<");
  });
  it("running without buttons", () => {
    const h = html(prov(), { phase: "running", model: "m1" });
    expect(h).toContain("Идёт проверочный вызов");
    expect(h).toContain("Ждём ответа…");
    expect(h).not.toContain("<button");
  });
  it("success: time 1.2 s", () => {
    const h = html(prov(), { phase: "done", model: "m1", result: { ok: true, ms: 1234 } });
    expect(h).toContain("Провайдер ответил");
    expect(h).toContain('data-tone="ok"');
    expect(h).toContain("время ответа 1,2 с.");
    expect(h).toContain("Закрыть");
  });
  it("refusal: full reason and escaped", () => {
    const reason = "Отказ авторизации (HTTP 401): проверьте значение переменной TEST_KEY в файле /tmp/x/.env";
    const h = html(prov(), { phase: "done", model: "m1", result: { ok: false, reason } });
    expect(h).toContain("Проверка не прошла");
    expect(h).toContain('data-tone="danger"');
    expect(h).toContain(reason);
    const e = html(prov(), { phase: "done", model: "m1", result: { ok: false, reason: "a <b>x</b>" } });
    expect(e).toContain("a &lt;b&gt;x&lt;/b&gt;");
    expect(e).not.toContain("<b>");
  });
});
const tags = (h: string) => [...h.matchAll(/<([a-z0-9]+)/g)].map((m) => m[1]);

afterEach(() => setProcessLanguage("ru"));

describe("TestPanel: English", () => {
  const confirm: TestState = { phase: "confirm", model: "m1" };
  const done = (result: TestResult): TestState => ({ phase: "done", model: "m1", result });
  it("1234 ms: 1.2 s in en and the ru format of the same value", () => {
    const s = done({ ok: true, ms: 1234 });
    expect(html(prov(), s)).toContain("время ответа 1,2 с.");
    setProcessLanguage("en");
    expect(html(prov(), s)).toContain("response time 1.2 s.");
  });
  it("rounding boundaries of seconds: the old toFixed(1) arithmetic", () => {
    for (const [ms, ru, en] of [[150, "0,1 с", "0.1 s"], [1150, "1,1 с", "1.1 s"]] as const) {
      const s = done({ ok: true, ms });
      setProcessLanguage("ru");
      expect(html(prov(), s)).toContain(`<div class="alert__text">Модель <span class="tag">m1</span>, время ответа ${ru}.</div>`);
      setProcessLanguage("en");
      expect(html(prov(), s)).toContain(`<div class="alert__text">Model: <span class="tag">m1</span>, response time ${en}.</div>`);
    }
  });
  it.each([
    ["subscription", "The test call uses your subscription"],
    ["paid", "The test call is paid"],
    ["free", "Test call<"],
  ] as const)("подтверждение для %s", (billing, title) => {
    setProcessLanguage("en");
    const h = html(prov({ billing }), confirm);
    expect(h).toContain(title);
    expect(h).toContain('<div class="alert__text">The test call makes one call. Model: <span class="tag">m1</span>. The call has not started yet.');
    expect(h).toContain("Run call");
    expect(h).toContain("Cancel");
    expect(h).toContain('aria-label="Test model"');
    expect(h).toContain(">default</option>");
    expect(h.includes("The provider has no key set: the call is not paid.")).toBe(billing === "free");
  });
  it("default is shown as default", () => {
    setProcessLanguage("en");
    const h = html(cliOnlyDefault, { phase: "confirm", model: "dflt" });
    expect(h).toContain('<span class="tag">default</span>');
    expect(h).toContain('Model: <span class="tag">default</span>. The call has not started yet.</div>');
  });
  it("running, success, refusal", () => {
    setProcessLanguage("en");
    const r = html(prov(), { phase: "running", model: "m1" });
    expect(r).toContain("Test call in progress");
    expect(r).toContain('<div class="alert__text">Model: <span class="tag">m1</span>. Waiting for the answer…</div>');
    const ok = html(prov(), done({ ok: true, ms: 50 }));
    expect(ok).toContain("Provider answered");
    expect(ok).toContain('<div class="alert__text">Model: <span class="tag">m1</span>, response time 0.1 s.</div>');
    expect(ok).toContain("Close");
    const bad = html(prov(), done({ ok: false, reason: "Отказ 401" }));
    expect(bad).toContain("Test failed");
    expect(bad).toContain("Отказ 401");
    expect(bad).toContain("Close");
  });
  it("the lineup does not depend on the language", () => {
    const states: TestState[] = [confirm, { phase: "running", model: "m1" }, done({ ok: true, ms: 1 }), done({ ok: false, reason: "x" })];
    for (const billing of ["subscription", "free"] as const) for (const s of states) {
      setProcessLanguage("ru");
      const ru = tags(html(prov({ billing }), s));
      setProcessLanguage("en");
      expect(tags(html(prov({ billing }), s))).toEqual(ru);
    }
  });
});
