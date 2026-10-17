import { Fragment } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { moscowDay } from "@model-council/core/protocol";
import type { UsageSummary, UsageTotals } from "@model-council/core/protocol";
import { Icon } from "./icons.tsx";
import type { UsagePeriod } from "./store.ts";
import { usage } from "../../shared/messages/usage.ts";
import { useLanguage, useMessages } from "./language.tsx";
import { formatCount, formatDay, formatMoney, formatPrice } from "./usage-format.ts";
import { periodDays, periodLabel, useUsageSummary } from "./usage-summary.ts";
import type { Language } from "@model-council/core/i18n";

const MODES: { value: UsagePeriod["mode"]; label: "today" | "month" | "range" }[] = [
  { value: "today", label: "today" },
  { value: "month", label: "month" },
  { value: "range", label: "range" }
];

// Arrows cycle; any other key — null.
export function stepMode(cur: UsagePeriod["mode"], key: string): UsagePeriod["mode"] | null {
  const d = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
  if (!d) return null;
  const i = MODES.findIndex((m) => m.value === cur);
  return MODES[(i + d + MODES.length) % MODES.length]!.value;
}

/** Switching to "Range" with empty dates fills in today's Moscow date so the period is valid right away. */
export function selectMode(period: UsagePeriod, mode: UsagePeriod["mode"], now: Date): UsagePeriod {
  if (mode !== "range") return { ...period, mode };
  const today = moscowDay(now);
  return { mode, from: period.from || today, to: period.to || today };
}

// A nonzero value below the rounding step must not look like a reported zero.
export const usd = (n: number, language: Language) => formatMoney(n, "$", language);

type M = ReturnType<typeof usage>;
interface Fmt { m: M; language: Language }

function Estimate({ t, f }: { t: UsageTotals; f: Fmt }): ReactNode {
  const by = t.estimate?.byCurrency ?? [];
  if (by.length === 0) return <td className="mono usage__unknown">{f.m.unknown}</td>;
  const done = by.reduce((a, c) => a + c.records, 0);
  return (
    <td className="mono">
      {by.map((c, i) => <Fragment key={c.currency}>{i > 0 && " "}<span className="usage__money">{formatMoney(c.amount, c.currency, f.language)}</span></Fragment>)}
      {done < t.records && <> <span className="usage__partial">{f.m.estimated(done, t.records)}</span></>}
    </td>
  );
}

function Cell({ value, missing, records, fmt, f }: { value: number | null; missing: number; records: number; fmt(n: number): string; f: Fmt }): ReactNode {
  if (value === null) return <td className="mono usage__unknown">{f.m.unknown}</td>;
  return (
    <td className="mono">
      {fmt(value)}
      {missing > 0 && <> <span className="usage__partial">{f.m.missing(missing, records)}</span></>}
    </td>
  );
}

function Values({ t, est, f }: { t: UsageTotals; est: boolean; f: Fmt }): ReactNode {
  const num = (n: number) => formatCount(n, f.language);
  return (
    <>
      <Cell value={t.inputTokens} missing={t.missing.inputTokens} records={t.records} fmt={num} f={f} />
      <Cell value={t.outputTokens} missing={t.missing.outputTokens} records={t.records} fmt={num} f={f} />
      <Cell value={t.costUsd} missing={t.missing.costUsd} records={t.records} fmt={(n) => usd(n, f.language)} f={f} />
      {est && <Estimate t={t} f={f} />}
      <td className="mono">{num(t.records)}</td>
    </>
  );
}

export function usageWarnings(s: UsageSummary, language: Language): string[] {
  const m = usage(language);
  const c = (n: number) => formatCount(n, language);
  const out: string[] = [];
  const open = s.total.openCalls;
  if (open > 0) out.push(m.warnOpen(open, c(open)));
  if (s.unreadable > 0) out.push(m.warnUnreadable(s.unreadable, c(s.unreadable)));
  if (s.truncated > 0) out.push(m.warnTruncated(s.truncated, c(s.truncated)));
  const mixed = s.groups.find((g) => g.providerId === null)?.records ?? 0;
  if (mixed > 0) out.push(m.warnMixed(mixed, c(mixed)));
  const sk = s.total.estimate?.skipped;
  const n = sk ? sk.no_model + sk.default_model + sk.no_tariff + sk.no_split : 0;
  if (sk && n > 0) {
    const parts = ([[m.skipNoModel, sk.no_model], [m.skipDefaultModel, sk.default_model], [m.skipNoTariff, sk.no_tariff], [m.skipNoSplit, sk.no_split]] as const)
      .filter(([, k]) => k > 0).map(([l, k]) => m.skipPart(l, c(k)));
    out.push(m.warnSkipped(n, c(n), parts.join("; ")));
  }
  for (const w of s.tariffs.warnings) out.push(m.tariffsWarning(w));
  return out;
}

function Tariffs({ summary, f }: { summary: UsageSummary; f: Fmt }): ReactNode {
  const { state, applied } = summary.tariffs;
  const { m, language } = f;
  if (state === "absent") return <p className="muted usage__tariffs-off">{m.tariffsOff}</p>;
  return (
    <div className="usage__tariffs">
      {applied.length > 0 && (
        <>
          <h3 className="usage__subtitle">{m.tariffsTitle}</h3>
          <ul className="usage__tariff-list">
            {applied.map((t) => <li key={`${t.providerId}\n${t.model}`}><span className="mono">{t.providerId} · {t.model}</span> — {m.tariffPrices(formatPrice(t.inputPerMillion, language), formatPrice(t.outputPerMillion, language), t.currency)} · {m.tariffSource} <span className="usage__source">{t.source}</span> · {m.tariffAsOf} {formatDay(t.asOf, language)}</li>)}
          </ul>
        </>
      )}
      <p className="muted usage__estimate-note">{m.estimateNote}</p>
    </div>
  );
}

function Table({ summary, f }: { summary: UsageSummary; f: Fmt }): ReactNode {
  const est = summary.tariffs.state !== "absent";
  const { m } = f;
  return (
    <div className="usage__scroll">
      <table className="usage__table">
        <thead><tr><th scope="col">{m.colProvider}</th><th scope="col">{m.colInput}</th><th scope="col">{m.colOutput}</th><th scope="col">{m.colCost}</th>{est && <th scope="col">{m.colEstimate}</th>}<th scope="col">{m.colRecords}</th></tr></thead>
        <tbody>
          {summary.groups.map((g) => g.providerId === null ? (
            <tr key="" className="usage__row--mixed">
              <th scope="row">{m.mixedProvider}<div className="muted usage__why">{m.mixedWhy}</div></th>
              <Values t={g} est={est} f={f} />
            </tr>
          ) : (
            <tr key={g.providerId}><th scope="row" className="mono">{g.providerId}</th><Values t={g} est={est} f={f} /></tr>
          ))}
          <tr className="usage__row--total"><th scope="row">{m.total}</th><Values t={summary.total} est={est} f={f} /></tr>
        </tbody>
      </table>
    </div>
  );
}

interface ViewProps { period: UsagePeriod; now: Date; summary: UsageSummary | null; error: string | null; onPeriod(p: UsagePeriod): void }

export function UsagePanelView({ period, now, summary, error, onPeriod }: ViewProps): ReactNode {
  const m = useMessages(usage);
  const language = useLanguage();
  const f: Fmt = { m, language };
  const days = periodDays(period, now);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const next = stepMode(period.mode, e.key);
    if (!next) return;
    e.preventDefault();
    onPeriod(selectMode(period, next, now));
    (e.currentTarget.parentElement?.children[MODES.findIndex((x) => x.value === next)] as HTMLElement | undefined)?.focus();
  };
  const warnings = summary ? usageWarnings(summary, language) : [];
  const empty = summary !== null && summary.total.records === 0 && summary.total.openCalls === 0;
  return (
    <section className="usage" aria-label={m.section}>
      <div className="usage__head">
        <h2 className="usage__title">{m.title}</h2>
        <div className="history-filter usage__period" role="radiogroup" aria-label={m.periodGroup}>
          {MODES.map((x) => {
            const on = x.value === period.mode;
            return (
              <button key={x.value} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} className="pill" onClick={() => onPeriod(selectMode(period, x.value, now))} onKeyDown={onKey}>
                {m[x.label]}
              </button>
            );
          })}
        </div>
        {period.mode === "range" && (
          <div className="usage__range">
            <input type="date" className="input usage__date" aria-label={m.fromLabel} value={period.from} onChange={(e) => onPeriod({ ...period, from: e.target.value })} />
            <span className="muted">—</span>
            <input type="date" className="input usage__date" aria-label={m.toLabel} value={period.to} onChange={(e) => onPeriod({ ...period, to: e.target.value })} />
          </div>
        )}
        {!("error" in days) && <span className="mono usage__scope">{m.scope(periodLabel(period, days, language))}</span>}
      </div>
      {"error" in days ? (
        <p className="usage__error" role="alert">{days.error === "both" ? m.periodBoth : m.periodOrder}</p>
      ) : (
        <>
          {error !== null ? <p className="usage__error" role="alert">{m.summaryFailed(error.replace(/\.+$/, ""))}</p>
            : summary === null ? <p className="muted usage__empty">{m.loading}</p>
            : empty ? <p className="muted usage__empty">{m.noUsage}</p>
            : <><Table summary={summary} f={f} /><Tariffs summary={summary} f={f} /></>}
          {warnings.length > 0 && (
            <ul className="usage__warnings">{warnings.map((w) => <li key={w}><Icon name="i-alert" size="sm" />{w}</li>)}</ul>
          )}
        </>
      )}
      <p className="muted usage__note">{m.note}</p>
    </section>
  );
}

export function UsagePanel({ period, sessions, onPeriod }: { period: UsagePeriod; sessions: unknown; onPeriod(p: UsagePeriod): void }): ReactNode {
  const now = new Date();
  const days = periodDays(period, now);
  const { summary, error } = useUsageSummary("error" in days ? null : days, sessions);
  return <UsagePanelView period={period} now={now} summary={summary} error={error} onPeriod={onPeriod} />;
}
