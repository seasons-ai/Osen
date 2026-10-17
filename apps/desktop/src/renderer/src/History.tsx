import { useState } from "react";
import { formatDate, getProcessLanguage } from "@model-council/core/i18n";
import type { Language } from "@model-council/core/i18n";
import { history } from "../../shared/messages/history.ts";
import { session } from "../../shared/messages/session.ts";
import { partialView } from "../../shared/partial.ts";
import type { KeyboardEvent, ReactNode } from "react";
import type { HistoryItem } from "../../shared/bridge.ts";
import { Icon } from "./icons.tsx";
import type { IconName } from "./icons.tsx";
import { useLanguage } from "./language.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import type { HistoryFilter, UsagePeriod } from "./store.ts";
import { UsagePanel } from "./UsagePanel.tsx";

const originText = (t: ReturnType<typeof history>): Record<HistoryItem["origin"], string> => ({ desktop: t.originDesktop, cli: t.originCli, mcp: t.originMcp });
const ORIGIN_ICON: Record<HistoryItem["origin"], IconName> = { desktop: "i-spark", cli: "i-terminal", mcp: "i-cloud" };

const dayKey = (d: Date) => d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();

export function formatWhen(iso: string, now: Date, language: Language = getProcessLanguage()): string {
  const t = session(language);
  const d = new Date(iso);
  const hm = formatDate(d, { timeStyle: "short" }, language); // ru «09:05», en «9:05 AM»
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(d) === dayKey(now)) return t.today(hm);
  if (dayKey(d) === dayKey(yesterday)) return t.yesterday(hm);
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return `${formatDate(d, opts, language)}, ${hm}`;
}

function size(s: HistoryItem, language: Language): string {
  const t = history(language);
  const turns = t.turns(s.turns);
  return s.status === "running" ? t.sizeRunning(s.round, s.maxRounds, turns) : t.sizeDone(t.rounds(s.round), turns);
}

function summary(sessions: HistoryItem[], language: Language): string {
  const t = history(language);
  const live = sessions.filter((s) => s.status === "running").length;
  const total = t.sessions(sessions.length);
  return live ? t.summaryLive(total, live) : total;
}

// The catalog returns the summary as a ready string; per the mockup the numbers in it are monospace, and the "running now" part (after " · ") is leaf-colored.
export function summaryNodes(text: string): ReactNode {
  const digits = (part: string, key: string): ReactNode[] => part.split(/(\d+)/).map((piece, i) => (i % 2 ? <span key={`${key}${i}`} className="mono">{piece}</span> : piece));
  const [head, ...rest] = text.split(" · ");
  if (rest.length === 0) return digits(head!, "h");
  return <>{digits(head!, "h")}{" · "}<span className="history-summary__live">{digits(rest.join(" · "), "l")}</span></>;
}

const FILTER_VALUES: HistoryFilter["status"][] = ["all", "running", "consensus", "no_consensus", "stopped", "failed", "interrupted"];

function filterLabel(value: HistoryFilter["status"], language: Language): string {
  const t = history(language);
  return { all: t.filterAll, running: t.filterRunning, consensus: t.filterConsensus, no_consensus: t.filterNoConsensus, stopped: t.filterStopped, failed: t.filterFailed, interrupted: t.filterInterrupted }[value];
}

const isActive = (f: HistoryFilter) => f.query.trim() !== "" || f.status !== "all";

export function selectHistory(sessions: HistoryItem[], filter: HistoryFilter, language: Language = getProcessLanguage()): { pinned: HistoryItem[]; rest: HistoryItem[] } {
  const custom = history(language).customTopic;
  const q = filter.query.trim().toLocaleLowerCase(language);
  const out = { pinned: [] as HistoryItem[], rest: [] as HistoryItem[] };
  for (const s of sessions) {
    if (filter.status !== "all" && (s.status !== filter.status || (filter.status === "interrupted" && s.partial))) continue;
    if (q && !`${s.topic}\n${s.templateName ?? custom}`.toLocaleLowerCase(language).includes(q)) continue;
    (s.pinned ? out.pinned : out.rest).push(s);
  }
  return out;
}

// Left/right arrows cycle; any other key — null.
export function stepStatus(cur: HistoryFilter["status"], key: string): HistoryFilter["status"] | null {
  const d = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
  if (!d) return null;
  const i = FILTER_VALUES.indexOf(cur);
  return FILTER_VALUES[(i + d + FILTER_VALUES.length) % FILTER_VALUES.length]!;
}

function noResultsText(f: HistoryFilter, language: Language): string {
  const t = history(language);
  const q = f.query.trim();
  const st = f.status === "all" ? null : filterLabel(f.status, language);
  return q && st ? t.noResultsBoth(q, st) : q ? t.noResultsQuery(q) : t.noResultsStatus(st!);
}

// Pinning without optimism: a row's view changes only from the list that came from main; while the call runs, the row button is busy.
export async function runPin(
  set: (id: string, pinned: boolean) => Promise<void>,
  id: string, pinned: boolean,
  setBusy: (update: (b: ReadonlySet<string>) => ReadonlySet<string>) => void,
  onError: (message: string) => void
): Promise<void> {
  setBusy((b) => new Set(b).add(id));
  try {
    await set(id, pinned);
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e));
  } finally {
    setBusy((b) => { const n = new Set(b); n.delete(id); return n; });
  }
}

function Row({ s, now, language, busy, onOpen, onPin }: { s: HistoryItem; now: Date; language: Language; busy: boolean; onOpen(id: string): void; onPin(id: string, pinned: boolean): void }): ReactNode {
  const t = history(language);
  const label = s.pinned ? t.unpin : t.pin;
  const pv = partialView(s.partial, language);
  return (
    <div className={`list__row history-row${s.status === "running" ? " history-row--live" : ""}${s.pinned ? " history-row--pinned" : ""}`}>
      <div>
        {pv ? <span className="badge" data-tone={pv.tone}><Icon name={pv.icon} size="sm" />{pv.badge}</span> : <StatusBadge status={s.status} tokenCap={s.tokenCapStop} />}
        {s.tokenCapStop && s.tokensIncomplete && <div className="muted">{t.usageIncomplete}</div>}
      </div>
      <div className="history-topic">
        <button type="button" className="history-topic__title history-open" title={s.topic} onClick={() => onOpen(s.id)}>{s.topic}</button>
        <div className="history-topic__tpl muted">
          {s.pinned && <span className="history-pinned"><Icon name="i-pin" size="sm" />{t.pinnedMark}</span>}
          {s.templateName ?? t.customTopic}
        </div>
      </div>
      <div className="history-people">
        {s.participants.map((p, i) => (
          <span key={p.id} className={p.dropped ? "avatar avatar--off" : "avatar"} title={p.name}>{i + 1}</span>
        ))}
      </div>
      <div><span className="chip"><Icon name={ORIGIN_ICON[s.origin]} size="sm" />{originText(t)[s.origin]}</span></div>
      <div>
        <div className="history-when mono">{formatWhen(s.createdAt, now, language)}</div>
        <div className="history-size mono">{size(s, language)}</div>
        {pv && <div className="history-size mono">{pv.mark}</div>}
      </div>
      <button type="button" className="history-pin" aria-pressed={s.pinned} aria-label={label} title={label} disabled={busy} onClick={() => onPin(s.id, !s.pinned)}>
        <Icon name="i-pin" />
      </button>
      <Icon name="i-chevron-right" />
    </div>
  );
}

function Group({ title, items, now, language, busy, onOpen, onPin }: { title: string | null; items: HistoryItem[]; now: Date; language: Language; busy: ReadonlySet<string>; onOpen(id: string): void; onPin(id: string, pinned: boolean): void }): ReactNode {
  return (
    <>
      {title && <h2 className="history-group">{title}</h2>}
      <div className="list">{items.map((s) => <Row key={s.id} s={s} now={now} language={language} busy={busy.has(s.id)} onOpen={onOpen} onPin={onPin} />)}</div>
    </>
  );
}

interface ViewProps {
  sessions: HistoryItem[] | null;
  filter: HistoryFilter;
  busy: ReadonlySet<string>;
  onFilter(filter: HistoryFilter): void;
  onOpen(id: string): void;
  onPin(id: string, pinned: boolean): void;
  onNew(): void;
  language?: Language; // the effective language; without it — the process language (render without a provider)
  usage?: ReactNode; // usage summary: the first element of the "has sessions" block
}

export function HistoryView({ sessions, filter, busy, onFilter, onOpen, onPin, onNew, usage, language = getProcessLanguage() }: ViewProps): ReactNode {
  const t = history(language);
  const now = new Date();
  const sel = sessions && selectHistory(sessions, filter, language);
  const found = sel ? sel.pinned.length + sel.rest.length : 0;
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const next = stepStatus(filter.status, e.key);
    if (!next) return;
    e.preventDefault();
    onFilter({ ...filter, status: next });
    (e.currentTarget.parentElement?.children[FILTER_VALUES.indexOf(next)] as HTMLElement | undefined)?.focus();
  };
  return (
    <>
      <header className="topbar">
        <h1 className="topbar__title">{t.title}</h1>
        <div className="topbar__actions">
          <button type="button" className="btn btn--primary btn--sm" onClick={onNew}><Icon name="i-plus" size="sm" />{t.newDiscussion}</button>
        </div>
      </header>
      <main className="content">
        {sessions && sessions.length === 0 && (
          <div className="empty">
            <Icon name="i-history" size="xl" />
            <h2>{t.emptyTitle}</h2>
            <p>{t.emptyBody}</p>
            <button type="button" className="btn btn--primary" onClick={onNew}><Icon name="i-plus" />{t.newDiscussion}</button>
          </div>
        )}
        {sessions && sel && sessions.length > 0 && (
          <>
            {usage}
            <p className="muted history-summary">{summaryNodes(isActive(filter) ? t.found(found, sessions.length) : summary(sessions, language))}</p>
            <div className="history-tools">
              <div className="history-search-wrap">
                <input type="search" className="input history-search" placeholder={t.searchLabel} aria-label={t.searchLabel} value={filter.query} onChange={(e) => onFilter({ ...filter, query: e.target.value })} />
              </div>
              <div className="history-filter" role="radiogroup" aria-label={t.statusLabel}>
                {FILTER_VALUES.map((value) => {
                  const on = value === filter.status;
                  return (
                    <button key={value} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} className="pill" onClick={() => onFilter({ ...filter, status: value })} onKeyDown={onKey}>
                      {filterLabel(value, language)}
                    </button>
                  );
                })}
              </div>
            </div>
            {found === 0 ? (
              <div className="empty">
                <Icon name="i-search" size="xl" />
                <h2>{t.nothingFound}</h2>
                <p>{noResultsText(filter, language)}</p>
                <button type="button" className="btn" onClick={() => onFilter({ query: "", status: "all" })}>{t.reset}</button>
              </div>
            ) : (
              <>
                {sel.pinned.length > 0 && <Group title={t.groupPinned} items={sel.pinned} now={now} language={language} busy={busy} onOpen={onOpen} onPin={onPin} />}
                {sel.rest.length > 0 && <Group title={sel.pinned.length > 0 ? t.groupOthers : null} items={sel.rest} now={now} language={language} busy={busy} onOpen={onOpen} onPin={onPin} />}
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}

export function History({ sessions, filter, onFilter, onOpen, onNew, onError, usagePeriod, onUsagePeriod }: Omit<ViewProps, "busy" | "onPin" | "usage"> & { onError(message: string): void; usagePeriod: UsagePeriod; onUsagePeriod(p: UsagePeriod): void }): ReactNode {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const language = useLanguage();
  return <HistoryView language={language} sessions={sessions} filter={filter} busy={busy} onFilter={onFilter} onOpen={onOpen} usage={<UsagePanel period={usagePeriod} sessions={sessions} onPeriod={onUsagePeriod} />} onNew={onNew} onPin={(id, pinned) => { void runPin((i, p) => window.council.setPinned(i, p), id, pinned, setBusy, onError); }} />;
}
