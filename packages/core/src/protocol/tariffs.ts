import { formatList } from "../i18n/format.ts";
import { protocolMessages } from "../messages/protocol.ts";
export interface Tariff {
  providerId: string;
  model: string;
  /** Origin of the price, trimmed at the edges. */
  source: string;
  /** Date of the price, YYYY-MM-DD. */
  asOf: string;
  /** Three uppercase Latin letters. */
  currency: string;
  inputPerMillion: number;
  outputPerMillion: number;
}
export type TariffState = "absent" | "loaded" | "unreadable";
export interface TariffSet { state: TariffState; tariffs: Tariff[]; warnings: string[] }

export const TARIFFS_FILE = "tariffs.json";

const KNOWN = ["providerId", "model", "source", "asOf", "currency", "inputPerMillion", "outputPerMillion"];

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
const price = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
function isDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Checks a record: returns the tariff or a list of problems. */
function checkEntry(raw: unknown): Tariff | string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [protocolMessages().entryObject];
  const r = raw as Record<string, unknown>;
  const m = protocolMessages();
  const bad: string[] = [];
  if (!nonEmpty(r.providerId)) bad.push(`providerId: ${m.entryNonEmpty}`);
  if (!nonEmpty(r.model)) bad.push(`model: ${m.entryNonEmpty}`);
  const source = typeof r.source === "string" ? r.source.trim() : "";
  if (source === "" || source.length > 500) bad.push(`source: ${m.entrySource}`);
  if (!isDate(r.asOf)) bad.push(`asOf: ${m.entryDate}`);
  if (typeof r.currency !== "string" || !/^[A-Z]{3}$/.test(r.currency)) bad.push(`currency: ${m.entryCurrency}`);
  if (!price(r.inputPerMillion)) bad.push(`inputPerMillion: ${m.entryPrice}`);
  if (!price(r.outputPerMillion)) bad.push(`outputPerMillion: ${m.entryPrice}`);
  for (const k of Object.keys(r).filter((k) => !KNOWN.includes(k)).sort()) bad.push(`${k}: ${m.entryUnknownField}`);
  if (bad.length > 0) return bad;
  return {
    providerId: r.providerId as string, model: r.model as string, source, asOf: r.asOf as string,
    currency: r.currency as string, inputPerMillion: r.inputPerMillion as number, outputPerMillion: r.outputPerMillion as number,
  };
}

/** Parses the file text. Never throws. */
export function parseTariffs(text: string): TariffSet {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { state: "unreadable", tariffs: [], warnings: [protocolMessages().tariffsNotJson(TARIFFS_FILE)] };
  }
  const entries = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>).tariffs : undefined;
  if (!Array.isArray(entries)) {
    return { state: "unreadable", tariffs: [], warnings: [protocolMessages().tariffsBadShape(TARIFFS_FILE)] };
  }
  const warnings: string[] = [];
  const valid: { n: number; t: Tariff }[] = [];
  entries.forEach((raw, i) => {
    const r = checkEntry(raw);
    if (Array.isArray(r)) warnings.push(protocolMessages().tariffsEntryRejected(TARIFFS_FILE, i + 1, r.join("; ")));
    else valid.push({ n: i + 1, t: r });
  });
  const groups = new Map<string, { n: number; t: Tariff }[]>();
  for (const v of valid) {
    const key = JSON.stringify([v.t.providerId, v.t.model]);
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  const dup = new Set<number>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.forEach((v) => dup.add(v.n));
    warnings.push(protocolMessages().tariffsDuplicates(TARIFFS_FILE, formatList(g.map((v) => String(v.n))), g[0]!.t.providerId, g[0]!.t.model));
  }
  return { state: "loaded", tariffs: valid.filter((v) => !dup.has(v.n)).map((v) => v.t), warnings };
}
