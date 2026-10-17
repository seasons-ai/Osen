import { useEffect, useRef, useState } from "react";
import { moscowDay } from "@model-council/core/protocol";
import type { UsageSummary } from "@model-council/core/protocol";
import type { Language } from "@model-council/core/i18n";
import type { UsagePeriod } from "./store.ts";
import { formatDay, formatMonth } from "./usage-format.ts";

export type Days = { from: string; to: string };

// A period error is a code, the text comes from the catalog at render time: a language change redraws without a new request.
export type PeriodError = "both" | "order";

export function periodDays(period: UsagePeriod, now: Date): Days | { error: PeriodError } {
  const today = moscowDay(now);
  if (period.mode === "today") return { from: today, to: today };
  if (period.mode === "month") {
    const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${today.slice(0, 7)}-01`, to: `${today.slice(0, 7)}-${String(last).padStart(2, "0")}` };
  }
  if (!period.from || !period.to) return { error: "both" };
  if (period.from > period.to) return { error: "order" };
  return { from: period.from, to: period.to };
}

/** The label is computed from date strings, the system time zone does not take part. */
export function periodLabel(period: UsagePeriod, days: Days, language: Language): string {
  if (period.mode === "today") return formatDay(days.from, language);
  if (period.mode === "month") return formatMonth(days.from, language);
  return language === "ru" ? `${formatDay(days.from, language)}–${formatDay(days.to, language)}` : `${formatDay(days.from, language)} – ${formatDay(days.to, language)}`;
}

export type UsageGot = { from: string; to: string; summary: UsageSummary | null; error: string | null } | null;

/** The non-React part: request number, cutoff of a stale response, a refusal turns into text. */
export function usageLoader(call: (from: string, to: string) => Promise<UsageSummary>, apply: (got: UsageGot) => void) {
  let latest = 0;
  return {
    load(from: string, to: string): Promise<void> {
      const n = ++latest;
      return Promise.resolve().then(() => call(from, to)).then(
        (summary) => { if (n === latest) apply({ from, to, summary, error: null }); },
        (e) => { if (n === latest) apply({ from, to, summary: null, error: e instanceof Error ? e.message : String(e) }); },
      );
    },
    cancel(): void { latest++; },
  };
}

/** Request on mount, on date change and on every new `sessions` reference; the previous summary of the same period stays until the new one. */
export function useUsageSummary(days: Days | null, sessions: unknown): { summary: UsageSummary | null; error: string | null } {
  const [got, setGot] = useState<UsageGot>(null);
  const loader = useRef<ReturnType<typeof usageLoader> | null>(null);
  loader.current ??= usageLoader((f, t) => window.council.usageSummary(f, t), setGot);
  const from = days?.from, to = days?.to;
  useEffect(() => {
    const l = loader.current!;
    if (from === undefined || to === undefined) { l.cancel(); return; }
    void l.load(from, to);
    return () => l.cancel();
  }, [from, to, sessions]);
  if (!days || !got || got.from !== days.from || got.to !== days.to) return { summary: null, error: null };
  return { summary: got.summary, error: got.error };
}
