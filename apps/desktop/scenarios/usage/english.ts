// English section of the usage and tariffs stands: what depends on the language and is available without a window, on the real data of the bridge answer.
// Numbers, period labels and the catalog are checked in both languages; sums, row order and periods do not depend on the language.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveLanguage } from "../../../../packages/core/src/index.ts";
import type { UsageSummary } from "../../../../packages/core/src/index.ts";
import type { Language } from "../../../../packages/core/src/i18n/index.ts";
import { usage } from "../../src/shared/messages/usage.ts";
import { formatCount, formatDay, formatMoney, formatPrice } from "../../src/renderer/src/usage-format.ts";
import { periodLabel } from "../../src/renderer/src/usage-summary.ts";

const parse = (s: string, l: Language): number => Number(l === "en" ? s.replace(/,/g, "") : s.replace(/\s/g, "").replace(",", "."));
const CYR = /[А-Яа-яЁё]/;

export function checkEnglish(dir: string, s: UsageSummary, ok: (text: string) => void): void {
  // Default language: without COUNCIL_LANG and without preferences.json — en.
  const defDir = join(dir, "lang-default");
  mkdirSync(defDir);
  const env = { ...process.env };
  delete env["COUNCIL_LANG"];
  const r = resolveLanguage(env, defDir);
  assert.deepEqual({ language: r.language, source: r.source }, { language: "en", source: "default" });

  const rows = [...s.groups, s.total];
  let numbers = 0;
  for (const l of ["en", "ru"] as const) {
    for (const g of rows) {
      for (const v of [g.inputTokens, g.outputTokens, g.records]) if (v !== null) { assert.equal(parse(formatCount(v, l), l), v, `${l}: ${v}`); numbers++; }
      if (g.costUsd !== null) {
        const t = formatMoney(g.costUsd, "$", l);
        if (g.costUsd > 0 && g.costUsd < 0.0001) assert.equal(t, l === "en" ? "< 0.0001 $" : "< 0,0001 $");
        else assert.ok(Math.abs(parse(t.replace(/ \$$/, ""), l) - g.costUsd) <= 0.5e-4, `${l}: ${t} ≠ ${g.costUsd}`);
        numbers++;
      }
      for (const e of g.estimate?.byCurrency ?? []) { assert.ok(Math.abs(parse(formatMoney(e.amount, e.currency, l).replace(/ \w+$/, ""), l) - e.amount) <= 0.5e-4); numbers++; }
    }
    for (const t of s.tariffs.applied) {
      assert.ok(Math.abs(parse(formatPrice(t.inputPerMillion, l), l) - t.inputPerMillion) <= 0.5e-6);
      assert.ok(Math.abs(parse(formatPrice(t.outputPerMillion, l), l) - t.outputPerMillion) <= 0.5e-6);
      numbers += 2;
    }
  }
  // Grouping and decimal separator per language on the real numbers of the answer.
  const big = rows.find((g) => (g.inputTokens ?? 0) >= 1000);
  if (big) {
    assert.match(formatCount(big.inputTokens!, "en"), /^\d{1,3}(,\d{3})+$/);
    assert.match(formatCount(big.inputTokens!, "ru"), /^\d{1,3}(\s\d{3})+$/);
  }
  assert.equal(formatCount(1000000, "en"), "1,000,000");
  assert.equal(formatMoney(0.5, "EUR", "en"), "0.5 EUR");
  assert.equal(formatMoney(0.5, "EUR", "ru"), "0,5 EUR");

  // Period labels: from the date strings, both forms.
  const days = { from: s.from, to: s.to };
  const [y, m, d] = [s.from.slice(0, 4), s.from.slice(5, 7), s.from.slice(8)];
  const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(m) - 1]!;
  assert.equal(periodLabel({ mode: "today", from: "", to: "" }, days, "en"), `${MONTH} ${Number(d)}, ${y}`);
  assert.equal(periodLabel({ mode: "today", from: "", to: "" }, days, "ru"), `${d}.${m}.${y}`);
  assert.equal(periodLabel({ mode: "month", from: "", to: "" }, days, "en"), `${MONTH} ${y}`);
  assert.equal(periodLabel({ mode: "range", from: "", to: "" }, days, "en"), `${formatDay(s.from, "en")} – ${formatDay(s.to, "en")}`);
  assert.equal(periodLabel({ mode: "range", from: "", to: "" }, days, "ru"), `${d}.${m}.${y}–${s.to.slice(8)}.${s.to.slice(5, 7)}.${s.to.slice(0, 4)}`);

  // Catalog: English without Cyrillic, number forms.
  const en = usage("en"), ru = usage("ru");
  for (const [k, v] of Object.entries(en)) if (typeof v === "string") assert.ok(!CYR.test(v), `en.${k} contains Cyrillic`);
  assert.deepEqual([en.total, en.unknown, en.estimated(1, 3), en.mixedProvider], ["Total", "unknown", "estimated 1 of 3", "provider not determined"]);
  assert.deepEqual([ru.total, ru.unknown, ru.estimated(1, 3), ru.mixedProvider], ["Всего", "неизвестно", "оценено 1 из 3", "провайдер не определён"]);
  assert.equal(en.warnUnreadable(1, "1"), "1 log was not read and is not counted (all history)");
  assert.equal(en.warnUnreadable(3, "3"), "3 logs were not read and are not counted (all history)");
  assert.equal(ru.warnUnreadable(5, "5"), "5 журналов не прочитаны и не учтены (вся история)");
  ok(`English section: default language en (without COUNCIL_LANG), ${numbers} numbers of the bridge answer checked in en and ru (groups, total, estimate, tariff prices), period labels and the catalog; sums do not depend on the language`);
}
