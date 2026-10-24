import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Tariff, UsageGroup, UsageSummary, UsageTotals } from "@model-council/core/protocol";
import type { ReactElement, ReactNode } from "react";
import { LanguageProvider } from "./language.tsx";
import { UsagePanelView, selectMode, stepMode, usd } from "./UsagePanel.tsx";
import type { UsagePeriod } from "./store.ts";

const NOW = new Date("2026-10-09T10:00:00Z");
const T: UsagePeriod = { mode: "today", from: "", to: "" };
const totals = (o: Partial<UsageTotals> = {}): UsageTotals => ({ inputTokens: 10, outputTokens: 5, costUsd: 0.5, records: 2, missing: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, openCalls: 0, estimate: null, ...o });
const group = (providerId: string | null, o: Partial<UsageTotals> = {}): UsageGroup => ({ providerId, ...totals(o) });
const sum = (groups: UsageGroup[], total: UsageTotals = totals(), o: Partial<UsageSummary> = {}): UsageSummary => ({ from: "2026-10-09", to: "2026-10-09", groups, total, unreadable: 0, truncated: 0, tariffs: { state: "absent", warnings: [], applied: [] }, ...o });
const html = (summary: UsageSummary | null, o: { period?: UsagePeriod; error?: string | null } = {}) =>
  renderToStaticMarkup(<UsagePanelView period={o.period ?? T} now={NOW} summary={summary} error={o.error ?? null} onPeriod={() => {}} />);

describe("UsagePanel", () => {
  it("unknown and reported zero are told apart in one table", () => {
    const h = html(sum([group("a", { costUsd: null }), group("scripted", { inputTokens: 0, outputTokens: 0, costUsd: 0 })]));
    expect(h).toContain('<td class="mono usage__unknown">неизвестно</td>');
    expect(h).toMatch(/<td class="mono">0<\/td>/);
    expect(h).toContain("0 $</td>");
    expect(h).toContain('class="usage__table"');
  });
  it("incompleteness mark on the number", () => {
    const h = html(sum([group("local", { inputTokens: 5600, records: 4, missing: { inputTokens: 1, outputTokens: 0, costUsd: 0 } })]));
    expect(h).toContain("неполно: нет у 1 из 4");
    expect(html(sum([group("a")]))).not.toContain("неполно");
  });
  it("a group without a provider: class and explanation", () => {
    const h = html(sum([group("a"), group(null)]));
    expect(h).toContain('class="usage__row--mixed"');
    expect(h).toContain("провайдер не определён");
    expect(h).toContain("в одной записи вызовы разных провайдеров или участник вне состава сессии");
  });
  it.each([
    [1, "1 вызов без исхода: его расход не записан"],
    [2, "2 вызова без исхода: их расход не записан"],
    [5, "5 вызовов без исхода: их расход не записан"]
  ])("предупреждение о вызовах без исхода (%i)", (n, text) => expect(html(sum([group("a")], totals({ openCalls: n })))).toContain(text));
  it.each([
    [1, "1 журнал не прочитан и не учтён (вся история)"],
    [2, "2 журнала не прочитаны и не учтены (вся история)"],
    [5, "5 журналов не прочитаны и не учтены (вся история)"]
  ])("предупреждение о нечитаемых журналах (%i)", (n, text) => expect(html(sum([group("a")], totals(), { unreadable: n }))).toContain(text));
  it.each([
    [1, "1 журнал прочитан не до конца: учтено читаемое начало (вся история)"],
    [2, "2 журнала прочитаны не до конца: учтено читаемое начало (вся история)"],
    [5, "5 журналов прочитаны не до конца: учтено читаемое начало (вся история)"]
  ])("предупреждение об оборванных журналах (%i)", (n, text) => expect(html(sum([group("a")], totals(), { truncated: n }))).toContain(text));
  it.each([
    [1, "Распределение по провайдерам неполное: 1 запись без определённого провайдера"],
    [2, "Распределение по провайдерам неполное: 2 записи без определённого провайдера"],
    [5, "Распределение по провайдерам неполное: 5 записей без определённого провайдера"]
  ])("предупреждение о группе без провайдера (%i)", (n, text) => expect(html(sum([group(null, { records: n })]))).toContain(text));
  it("without items the warnings list is not rendered", () => expect(html(sum([group("a")]))).not.toContain("usage__warnings"));
  it("label and note", () => {
    const h = html(sum([group("a")]));
    expect(h).toContain("09.10.2026 · вся история за период · время московское");
    expect(h).toContain("usage__note");
  });
  it("empty period: message and warnings about the journals", () => {
    const h = html(sum([], totals({ inputTokens: null, outputTokens: null, costUsd: null, records: 0 }), { unreadable: 1 }));
    expect(h).toContain("За период расход не записан.");
    expect(h).not.toContain("<table");
    expect(h).toContain("1 журнал не прочитан");
  });
  it("the summary has not arrived yet", () => expect(html(null)).toContain("Считаю…"));
  it("request error", () => {
    const h = html(null, { error: "сбой" });
    expect(h).toContain('<p class="usage__error" role="alert">Сводку не удалось получить: сбой.</p>');
    expect(h).not.toContain("<table");
  });
  it("request error: exactly one period at the end with any text", () => {
    expect(html(null, { error: "Начало периода позже конца." })).toContain("получить: Начало периода позже конца.</p>");
    expect(html(null, { error: "сбой" })).toContain("получить: сбой.</p>");
  });
  it("a small cost does not look like zero", () => {
    expect([0, 0.00004, 0.0001, 0.421].map((n) => usd(n, "ru"))).toEqual(["0 $", "< 0,0001 $", "0,0001 $", "0,421 $"]);
    expect(html(sum([group("a", { costUsd: 0.00004 })]))).toContain("&lt; 0,0001 $");
  });
  it("range error: alert, without table and label, field values kept", () => {
    const h = html(sum([group("a")]), { period: { mode: "range", from: "2026-10-09", to: "2026-10-08" } });
    expect(h).toContain('<p class="usage__error" role="alert">Начало периода позже конца.</p>');
    expect(h).not.toContain("<table");
    expect(h).not.toContain("usage__scope");
    expect(h).toContain('value="2026-10-09"');
    expect(h).toContain('value="2026-10-08"');
  });
  it("date fields only in «Range» mode", () => {
    expect(html(null)).not.toContain('type="date"');
    expect(html(null, { period: { mode: "range", from: "2026-10-08", to: "2026-10-09" } })).toContain('aria-label="Конец периода"');
  });
  it("selected period: .pill capsule with aria-checked and tabIndex, without a check mark", () => {
    const h = html(null, { period: { mode: "month", from: "", to: "" } });
    expect(h).toMatch(/aria-checked="true" tabindex="0" class="pill">Месяц/);
    expect(h).not.toContain("#i-check");
    expect(h).not.toContain("history-filter__item");
    expect(h.match(/tabindex="-1"/g)).toHaveLength(2);
  });
  it("coverage label — span.mono on the right in the header, from the catalog; the «Total» row is the last row of tbody, no tfoot", () => {
    const h = html(sum([group("claude"), group("codex")]));
    expect(h).toMatch(/<div class="usage__head">.*<span class="mono usage__scope">09\.10\.2026 · вся история за период · время московское<\/span><\/div>/);
    expect(h).not.toContain("<tfoot");
    expect(h).not.toContain('<p class="muted usage__scope">');
    const rows = h.match(/<tr[^>]*>/g)!;
    expect(rows).toHaveLength(4); // thead + 2 providers + total
    expect(rows.at(-1)).toBe('<tr class="usage__row--total">');
    expect(h).toMatch(/<tr class="usage__row--total"><th scope="row">Всего<\/th><td class="mono">10<\/td>.*<\/tr><\/tbody><\/table>/);
  });
  it("keyboard step wraps around", () => {
    expect(stepMode("today", "ArrowRight")).toBe("month");
    expect(stepMode("today", "ArrowLeft")).toBe("range");
    expect(stepMode("range", "ArrowDown")).toBe("today");
    expect(stepMode("today", "ArrowUp")).toBe("range");
    expect(stepMode("today", "a")).toBeNull();
  });
  it("switching to «Range» substitutes the Moscow date, typed input is not overwritten", () => {
    expect(selectMode(T, "range", new Date("2026-10-08T21:30:00Z"))).toEqual({ mode: "range", from: "2026-10-09", to: "2026-10-09" });
    expect(selectMode({ mode: "month", from: "2026-10-01", to: "" }, "range", NOW)).toEqual({ mode: "range", from: "2026-10-01", to: "2026-10-09" });
    expect(selectMode({ mode: "range", from: "a", to: "b" }, "today", NOW)).toEqual({ mode: "today", from: "a", to: "b" });
  });
  it("click on «Range» calls onPeriod with the substituted dates", () => {
    const got: UsagePeriod[] = [];
    // The component with hooks is called inside rendering; the element tree is taken from its result.
    let tree: ReactNode = null;
    const Probe = () => (tree = UsagePanelView({ period: T, now: NOW, summary: null, error: null, onPeriod: (p) => got.push(p) }));
    renderToStaticMarkup(<Probe />);
    const buttons: ReactElement<{ role?: string; onClick?: () => void; children?: ReactNode }>[] = [];
    const walk = (n: ReactNode) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (n && typeof n === "object" && "props" in n) {
        const el = n as ReactElement<{ role?: string; onClick?: () => void; children?: ReactNode }>;
        if (el.props.role === "radio") buttons.push(el);
        walk(el.props.children);
      }
    };
    walk(tree);
    buttons[2]!.props.onClick!();
    expect(got).toEqual([{ mode: "range", from: "2026-10-09", to: "2026-10-09" }]);
  });
});

describe("UsagePanel: tariff estimate", () => {
  const est = (byCurrency: { currency: string; amount: number; records: number }[], skipped: Partial<Record<"no_model" | "default_model" | "no_tariff" | "no_split", number>> = {}) => ({ byCurrency, skipped: { no_model: 0, default_model: 0, no_tariff: 0, no_split: 0, ...skipped } });
  const tar = (o: Partial<Tariff> = {}): Tariff => ({ providerId: "local-llm", model: "qwen3-coder", source: "https://example.test/pricing", asOf: "2026-10-09", currency: "USD", inputPerMillion: 2, outputPerMillion: 4, ...o });
  const loaded = (o: Partial<UsageSummary["tariffs"]> = {}): Partial<UsageSummary> => ({ tariffs: { state: "loaded", warnings: [], applied: [], ...o } });
  const th = '<th scope="col">Оценка по тарифу</th>';
  const rows = (h: string) => [...h.matchAll(/<tr(?: class="usage__row--total")?>(.*?)<\/tr>/g)].map((m) => m[1]!).filter((r) => !r.includes("<th scope=\"col\""));

  it("no tariffs: no column, there is a row and 5 cells", () => {
    const h = html(sum([group("a")]));
    expect(h).toContain("Сообщено провайдером, USD");
    expect(h).not.toContain(th);
    expect(h).toContain('<p class="muted usage__tariffs-off">Оценка по тарифу неизвестна: тарифы не заданы (файл tariffs.json в папке данных).</p>');
    expect(h).not.toContain('usage__tariffs"');
    for (const r of rows(h)) expect((r.match(/<t[hd][ >]/g) ?? []).length).toBe(5);
  });
  it("without a table there is neither a row nor a tariff block", () => {
    const empty = html(sum([], totals({ records: 0, inputTokens: null, outputTokens: null, costUsd: null })));
    for (const h of [html(null), empty, html(null, { error: "сбой" })]) { expect(h).not.toContain("usage__tariffs-off"); expect(h).not.toContain('usage__tariffs"'); }
  });
  it("both costs in one row, 6 cells", () => {
    const g = group("a", { costUsd: 3, records: 1, estimate: est([{ currency: "USD", amount: 4, records: 1 }]) });
    const h = html(sum([g], g, loaded()));
    expect(h).toContain("3 $");
    expect(h).toContain('<span class="usage__money">4 USD</span>');
    expect(h).not.toContain("оценено");
    for (const r of rows(h)) expect((r.match(/<t[hd][ >]/g) ?? []).length).toBe(6);
  });
  it("partial coverage", () => {
    const g = group("a", { records: 3, estimate: est([{ currency: "USD", amount: 4, records: 1 }]) });
    expect(html(sum([g], g, loaded()))).toContain('<span class="usage__partial">оценено 1 из 3</span>');
  });
  it("different currencies are not added up", () => {
    const g = group("a", { records: 2, estimate: est([{ currency: "EUR", amount: 0.5, records: 1 }, { currency: "USD", amount: 4, records: 1 }]) });
    const h = html(sum([g], g, loaded()));
    expect(h).toContain('<span class="usage__money">0,5 EUR</span> <span class="usage__money">4 USD</span>');
    expect(h).not.toContain("4,5");
  });
  it("the total has an estimate, the group is empty: unknown", () => {
    const h = html(sum([group("a", { estimate: est([]) })], totals({ estimate: est([{ currency: "USD", amount: 1, records: 2 }]) }), loaded()));
    expect(rows(h)[0]).toContain('<td class="mono usage__unknown">неизвестно</td><td class="mono">2</td>');
    expect(rows(h)[1]).toContain('usage__money">1 USD');
  });
  it("tariffs file not parsed", () => {
    const h = html(sum([group("a")], totals(), { tariffs: { state: "unreadable", warnings: ["tariffs.json: не JSON"], applied: [] } }));
    expect(h).toContain(th);
    for (const r of rows(h)) expect(r).toContain('<td class="mono usage__unknown">неизвестно</td><td class="mono">2</td>');
    expect(h).toContain("Тарифы: tariffs.json: не JSON");
    const block = h.slice(h.indexOf('usage__tariffs"'), h.indexOf("usage__warnings"));
    expect(block).toContain("usage__estimate-note");
    expect(block).not.toContain("Тарифы оценки");
  });
  it("reasons for skips", () => {
    const w = (e: ReturnType<typeof est> | null) => html(sum([group("a")], totals({ estimate: e }), loaded()));
    expect(w(est([], { default_model: 7, no_tariff: 1, no_split: 1 }))).toContain("9 записей без оценки по тарифу: модель «default», фактическая неизвестна — 7; нет тарифа для модели — 1; нет входных или выходных токенов — 1");
    expect(w(est([], { no_model: 1 }))).toContain("1 запись без оценки по тарифу: модель записи не определена — 1");
    expect(w(est([], { no_tariff: 2 }))).toContain("2 записи без оценки по тарифу: нет тарифа для модели — 2");
    expect(w(est([], { no_tariff: 2 }))).not.toContain("default");
    expect(w(est([]))).not.toContain("без оценки по тарифу");
    expect(w(null)).not.toContain("без оценки по тарифу");
  });
  it("tariff list", () => {
    const h = html(sum([group("a")], totals(), loaded({ applied: [tar(), tar({ providerId: "eu", model: "m", currency: "EUR", inputPerMillion: 1.5, source: "<script>alert(1)</script>" })] })));
    expect(h).toContain("Тарифы оценки");
    expect(h).toContain('<span class="mono">local-llm · qwen3-coder</span> — вход 2 USD, выход 4 USD за 1 млн токенов · источник: <span class="usage__source">https://example.test/pricing</span> · цена на 09.10.2026');
    expect(h).toContain("вход 1,5 EUR");
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
  });
  it("small sum and reported zero", () => {
    const small = group("a", { estimate: est([{ currency: "USD", amount: 0.00001, records: 2 }]) });
    expect(html(sum([small], small, loaded()))).toContain("&lt; 0,0001 USD");
    const zero = group("a", { estimate: est([{ currency: "USD", amount: 0, records: 2 }]) });
    const h = html(sum([zero], zero, loaded()));
    expect(h).toContain('usage__money">0 USD');
    expect(rows(h)[0]).not.toContain("неизвестно");
  });
  it("availability and absence of new controls", () => {
    const g = group("a", { estimate: est([{ currency: "USD", amount: 1, records: 2 }]) });
    const h = html(sum([g], g, loaded({ applied: [tar()] })));
    expect(h.match(/<th(?![a-z])[^>]*>/g)!.every((t) => t.includes('scope="col"') || t.includes('scope="row"'))).toBe(true);
    for (const r of rows(h)) expect(r.startsWith('<th scope="row"')).toBe(true);
    expect(h.match(/<button/g)).toHaveLength(3);
    expect(h).not.toContain("<a ");
    expect(h).not.toContain("<input");
  });
});

// English view and language switch with the summary shown: the data is the same, labels are new.
describe("UsagePanel: English", () => {
  const view = (language: "en" | "ru") => ({ language, source: "file" as const, locked: false, damaged: false });
  const htmlIn = (language: "en" | "ru", summary: UsageSummary | null, o: { period?: UsagePeriod; error?: string | null } = {}) =>
    renderToStaticMarkup(<LanguageProvider initial={view(language)}><UsagePanelView period={o.period ?? T} now={NOW} summary={summary} error={o.error ?? null} onPeriod={() => {}} /></LanguageProvider>);
  const est = (byCurrency: { currency: string; amount: number; records: number }[]) => ({ byCurrency, skipped: { no_model: 0, default_model: 0, no_tariff: 0, no_split: 0 } });
  const tariffs = { state: "loaded" as const, warnings: ["tariffs.json: не JSON"], applied: [{ providerId: "eu", model: "m", source: "https://example.test", asOf: "2026-10-08", currency: "EUR", inputPerMillion: 1.5, outputPerMillion: 3 }] };
  const rich = (): UsageSummary => {
    const a = group("a", { inputTokens: 1000000, costUsd: 3, records: 3, estimate: est([{ currency: "EUR", amount: 0.5, records: 1 }]) });
    const tiny = group("b", { costUsd: 0.00001, records: 1, estimate: est([]) });
    return sum([a, tiny, group(null, { records: 2 })], totals({ records: 6, openCalls: 1 }), { tariffs, unreadable: 3 });
  };

  it("labels, numbers, money, period", () => {
    const h = htmlIn("en", rich());
    for (const t of ["Total", "unknown", "estimated 1 of 3", "provider not determined", "Tariff estimate", "Input tokens", "Records", "Estimate tariffs", "1,000,000", "3 $", "0.5 EUR", "&lt; 0.0001 $", "Tariffs: tariffs.json: не JSON", "price as of October 8, 2026", "input 1.5 EUR, output 3 EUR per 1M tokens", "October 9, 2026 · all history for the period · Moscow time", "1 call without outcome", "3 logs were not read"]) expect(h).toContain(t);
    expect(h).not.toMatch(/Всего|неизвестно|Считаю|Расход/);
  });
  it("periods and errors in English", () => {
    expect(htmlIn("en", null, { period: { mode: "month", from: "", to: "" } })).toContain("October 2026");
    expect(htmlIn("en", null, { period: { mode: "range", from: "2026-10-08", to: "2026-10-09" } })).toContain("October 8, 2026 – October 9, 2026");
    const h = htmlIn("en", sum([group("a")]), { period: { mode: "range", from: "2026-10-09", to: "2026-10-08" } });
    expect(h).toContain('role="alert">The start of the period is later than its end.</p>');
    expect(h).toContain('value="2026-10-09"');
    expect(htmlIn("en", null, { period: { mode: "range", from: "", to: "2026-10-08" } })).toContain("Enter both dates of the period.");
    expect(htmlIn("en", null, { error: "boom." })).toContain("Could not get the summary: boom.</p>");
    expect(htmlIn("en", null)).toContain("Counting…");
    expect(htmlIn("en", sum([], totals({ records: 0 })))).toContain("No usage recorded for the period.");
  });
  it("English forms in the warnings", () => {
    expect(htmlIn("en", sum([group("a")], totals({ openCalls: 2 }), { unreadable: 1, truncated: 3 }))).toMatch(/2 calls without outcome.*1 log was not read.*3 logs were read only partially/);
    expect(htmlIn("en", sum([group(null, { records: 1 })]))).toContain("1 record without a determined provider");
  });
  it("switching language with the summary shown: the same data, new labels", () => {
    const s = rich();
    const en = htmlIn("en", s), ru = htmlIn("ru", s);
    expect(ru).toContain("Всего");
    expect(ru).toMatch(/1\s000\s000/);
    expect(ru).toContain("0,5 EUR");
    expect(en).not.toContain("Всего");
    const nums = (h: string) => (h.match(/usage__money/g) ?? []).length;
    expect(nums(en)).toBe(nums(ru));
    expect(en.match(/<tr[ >]/g)).toHaveLength(ru.match(/<tr[ >]/g)!.length);
  });
});
