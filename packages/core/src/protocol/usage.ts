import { DEFAULT_MODEL } from "../cli-agents/types.ts";
import type { SessionEvent, Usage } from "./schema.ts";
import type { Tariff, TariffSet, TariffState } from "./tariffs.ts";

/** Canonical usage record: the aggregate of a completed turn or draft, or a failure without an aggregate. */
export interface UsageRecord {
  ts: string;                 // ts of the canonical event
  providerId: string | null;  // null — provider not determined
  model: string | null;       // null — model of the record not determined
  usage: Usage;               // {} — usage not reported
  participantIds: string[];   // participants whose calls went into the record (no repeats)
}
/** Started call without a known outcome: its usage may exist but was not recorded. */
export interface OpenCall { ts: string; providerId: string | null }
export interface SessionUsage { records: UsageRecord[]; open: OpenCall[] }

/** Reason why a period record got no tariff estimate. */
export type EstimateSkip = "no_model" | "default_model" | "no_tariff" | "no_split";
/** Calculation by local tariffs; separate from the reported sums. */
export interface UsageEstimate {
  byCurrency: { currency: string; amount: number; records: number }[];
  skipped: Record<EstimateSkip, number>;
}
export interface UsageTotals {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  records: number;
  missing: { inputTokens: number; outputTokens: number; costUsd: number };
  openCalls: number;
  estimate: UsageEstimate | null;  // null — no applicable tariffs
}
export interface UsageGroup extends UsageTotals { providerId: string | null }
export interface UsageSummary {
  from: string; to: string;
  groups: UsageGroup[];
  total: UsageTotals;
  unreadable: number;
  truncated: number;
  tariffs: { state: TariffState; warnings: string[]; applied: Tariff[] };
}

const moscow = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" });

/** Date of the moment in Europe/Moscow, YYYY-MM-DD. */
export function moscowDay(ts: string | Date): string {
  const p = Object.fromEntries(moscow.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

type Entry = { idx: number; ts: string; providerId: string | null; model?: string | null; usage?: Usage; open?: boolean; ids?: string[] };

export function sessionUsage(events: readonly SessionEvent[]): SessionUsage {
  const owner = new Map<string, { providerId: string; model: string }>();
  for (const e of events) {
    if (e.type === "session_created") for (const p of e.session.participants) owner.set(p.id, { providerId: p.providerId, model: p.model });
    else if (e.type === "session_resumed") for (const r of e.replacements ?? []) owner.set(r.participant.id, { providerId: r.participant.providerId, model: r.participant.model });
  }
  const prov = (ids: string[]): { providerId: string | null; model: string | null } => {
    const s = new Set(ids.map((id) => owner.get(id)?.providerId ?? null));
    const pairs = new Set(ids.map((id) => { const o = owner.get(id); return o ? JSON.stringify([o.providerId, o.model]) : null; }));
    const one = [...pairs][0];
    return { providerId: s.size === 1 ? [...s][0]! : null, model: pairs.size === 1 && one ? owner.get(ids[0]!)!.model : null };
  };

  // failed — outcomes of attempts with usage: failures and calls that answered with a file request
  type Turn = { started: { idx: number; e: SessionEvent & { type: "turn_started" }; seg: number } | null; done: (SessionEvent & { type: "turn_completed" }) | null; doneIdx: number; failed: { idx: number; e: SessionEvent & { type: "turn_failed" | "turn_files_served" } }[] };
  type Draft = { started: { idx: number; e: SessionEvent & { type: "draft_attempt_started" } }[]; failed: { idx: number; e: SessionEvent & { type: "draft_attempt_failed" | "draft_files_served" } }[]; done: (SessionEvent & { type: "draft_completed" }) | null; doneIdx: number };
  const turns = new Map<string, Turn>();
  const drafts = new Map<string, Draft>();
  const drops: { idx: number; seg: number; pid: string }[] = [];
  let seg = 0;
  events.forEach((e, idx) => {
    if (e.type === "session_resumed") seg++;
    else if (e.type === "participant_dropped") drops.push({ idx, seg, pid: e.participantId });
    else if (e.type === "turn_started" || e.type === "turn_completed" || e.type === "turn_failed" || e.type === "turn_files_served") {
      const key = `${seg}:${e.turn}`;
      let t = turns.get(key);
      if (!t) turns.set(key, (t = { started: null, done: null, doneIdx: 0, failed: [] }));
      if (e.type === "turn_started") t.started = { idx, e, seg };
      else if (e.type === "turn_completed") { t.done = e; t.doneIdx = idx; }
      else t.failed.push({ idx, e });
    } else if (e.type === "draft_attempt_started" || e.type === "draft_attempt_failed" || e.type === "draft_files_served" || e.type === "draft_completed") {
      let d = drafts.get(e.draftId);
      if (!d) drafts.set(e.draftId, (d = { started: [], failed: [], done: null, doneIdx: 0 }));
      if (e.type === "draft_attempt_started") d.started.push({ idx, e });
      else if (e.type === "draft_attempt_failed" || e.type === "draft_files_served") d.failed.push({ idx, e });
      else { d.done = e; d.doneIdx = idx; }
    }
  });

  const out: Entry[] = [];
  for (const t of turns.values()) {
    if (t.done) {
      const ids = [t.done.participantId, ...t.failed.map((f) => f.e.participantId)];
      out.push({ idx: t.doneIdx, ts: t.done.ts, usage: t.done.usage, ids, ...prov(ids) });
      continue;
    }
    for (const f of t.failed) out.push({ idx: f.idx, ts: f.e.ts, usage: f.e.usage ?? {}, ids: [f.e.participantId], ...prov([f.e.participantId]) });
    // a file-request call did not leave a record in the journal before event 96: its attempt number is a gap below the maximum outcome
    const tried = new Set(t.failed.map((f) => f.e.attempt));
    const top = Math.max(0, ...tried);
    const first = t.started ?? t.failed[0];
    for (let a = 1; a < top; a++) {
      if (!tried.has(a) && first) {
        out.push({ idx: first.idx, ts: first.e.ts, ...prov([...(t.started ? [t.started.e.participantId] : []), ...t.failed.map((f) => f.e.participantId)]), open: true });
      }
    }
    const s = t.started;
    if (s && !drops.some((d) => d.seg === s.seg && d.idx > s.idx && d.pid === s.e.participantId)) {
      out.push({ idx: s.idx, ts: s.e.ts, ...prov([s.e.participantId]), open: true });
    }
  }
  for (const d of drafts.values()) {
    if (d.done) {
      const ids = [d.done.participantId, ...d.started.map((x) => x.e.participantId), ...d.failed.map((x) => x.e.participantId)];
      const who = prov(ids);
      out.push({ idx: d.doneIdx, ts: d.done.ts, usage: d.done.usage, ids, ...who });
      if (d.done.usageIncomplete === true) out.push({ idx: d.doneIdx, ts: d.done.ts, providerId: who.providerId, open: true });
      continue;
    }
    for (const f of d.failed) out.push({ idx: f.idx, ts: f.e.ts, usage: f.e.usage ?? {}, ids: [f.e.participantId], ...prov([f.e.participantId]) });
    for (const s of d.started) {
      if (!d.failed.some((f) => f.e.attempt === s.e.attempt)) out.push({ idx: s.idx, ts: s.e.ts, ...prov([s.e.participantId]), open: true });
    }
  }
  out.sort((a, b) => a.idx - b.idx);
  const res: SessionUsage = { records: [], open: [] };
  for (const o of out) {
    if (o.open) res.open.push({ ts: o.ts, providerId: o.providerId });
    else res.records.push({ ts: o.ts, providerId: o.providerId, model: o.model ?? null, usage: o.usage!, participantIds: [...new Set(o.ids)] });
  }
  return res;
}

const emptyEstimate = (): UsageEstimate => ({ byCurrency: [], skipped: { no_model: 0, default_model: 0, no_tariff: 0, no_split: 0 } });
const emptyTotals = (): UsageTotals => ({
  inputTokens: null, outputTokens: null, costUsd: null, records: 0,
  missing: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, openCalls: 0, estimate: null,
});
const FIELDS = ["inputTokens", "outputTokens", "costUsd"] as const;

export function summarizeUsage(
  sessions: readonly SessionUsage[], from: string, to: string,
  journals: { unreadable: number; truncated: number } = { unreadable: 0, truncated: 0 },
  tariffs: TariffSet = { state: "absent", tariffs: [], warnings: [] },
): UsageSummary {
  const inPeriod = (ts: string) => { const d = moscowDay(ts); return from <= d && d <= to; };
  const total = emptyTotals();
  const byProvider = new Map<string | null, UsageTotals>();
  const of = (id: string | null) => { let g = byProvider.get(id); if (!g) byProvider.set(id, (g = emptyTotals())); return g; };
  const priced = tariffs.tariffs.length > 0;
  const applied = new Map<Tariff, true>();
  for (const s of sessions) {
    for (const r of s.records) {
      if (!inPeriod(r.ts)) continue;
      // tariff estimate: the skip reason, or the sum in the tariff currency
      let skip: EstimateSkip | null = null, tariff: Tariff | undefined;
      if (r.providerId === null || r.model === null) skip = "no_model";
      else if (r.model === DEFAULT_MODEL) skip = "default_model";
      else if (!(tariff = tariffs.tariffs.find((t) => t.providerId === r.providerId && t.model === r.model))) skip = "no_tariff";
      else if (r.usage.inputTokens === undefined || r.usage.outputTokens === undefined) skip = "no_split";
      if (!skip && tariff) applied.set(tariff, true);
      for (const t of [total, of(r.providerId)]) {
        t.records += 1;
        for (const f of FIELDS) {
          const v = r.usage[f];
          if (v === undefined) t.missing[f] += 1;
          else t[f] = (t[f] ?? 0) + v;
        }
        if (!priced) continue;
        const est = (t.estimate ??= emptyEstimate());
        if (skip || !tariff) { est.skipped[skip!] += 1; continue; }
        let c = est.byCurrency.find((x) => x.currency === tariff!.currency);
        if (!c) { est.byCurrency.push((c = { currency: tariff.currency, amount: 0, records: 0 })); est.byCurrency.sort((a, b) => (a.currency < b.currency ? -1 : 1)); }
        c.amount += r.usage.inputTokens! * tariff.inputPerMillion / 1_000_000 + r.usage.outputTokens! * tariff.outputPerMillion / 1_000_000;
        c.records += 1;
      }
    }
    for (const o of s.open) {
      if (!inPeriod(o.ts)) continue;
      total.openCalls += 1;
      of(o.providerId).openCalls += 1;
    }
  }
  // a group without records of the period (only calls without an outcome) also gets an empty estimate
  if (priced) for (const t of [total, ...byProvider.values()]) t.estimate ??= emptyEstimate();
  const ids = [...byProvider.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0));
  const used = [...applied.keys()].sort((a, b) => (a.providerId !== b.providerId ? (a.providerId < b.providerId ? -1 : 1) : a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return {
    from, to, groups: ids.map((providerId) => ({ providerId, ...byProvider.get(providerId)! })), total, ...journals,
    tariffs: { state: tariffs.state, warnings: [...tariffs.warnings], applied: used },
  };
}
