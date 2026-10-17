import { formatDate, formatNumber } from "@model-council/core/i18n";
import type { Language } from "@model-council/core/i18n";

// Formats of the "Usage" block by interface language; Intl takes the locale from the language, not a hardcoded one.
export const formatCount = (n: number, language: Language): string => formatNumber(n, undefined, language);

// A nonzero value below the rounding step must not look like a reported zero.
export const formatMoney = (n: number, currency: string, language: Language): string =>
  n > 0 && n < 0.0001 ? `< ${formatNumber(0.0001, { maximumFractionDigits: 4 }, language)} ${currency}` : `${formatNumber(n, { maximumFractionDigits: 4 }, language)} ${currency}`;

export const formatPrice = (n: number, language: Language): string => formatNumber(n, { maximumFractionDigits: 6 }, language);

// Days come as YYYY-MM-DD strings (Moscow days); via UTC the system time zone does not take part.
const utc = (d: string): Date => new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))));

export function formatDay(d: string, language: Language): string {
  if (language === "ru") return `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
  return formatDate(utc(d), { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }, language);
}

export const formatMonth = (d: string, language: Language): string =>
  `${formatDate(utc(d), { month: "long", timeZone: "UTC" }, language)} ${d.slice(0, 4)}`;
