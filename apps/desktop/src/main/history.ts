import type { Logger } from "@model-council/core";
import { listSessions, OWNER_ID, readSession, TOKEN_CAP_REASON, tokenUsage } from "@model-council/core";
import type { HistoryItem } from "../shared/bridge.ts";
import type { AttentionSnapshot } from "./attention-notify.ts";

// ponytail: each session journal is read twice (listSessions and readSession); ceiling — hundreds of sessions with polling every 2 s; upgrade — cache by journal mtime or move round/turns/maxRounds into SessionSummary in core
export function historyItems(
  dataDir: string, templateTitles: ReadonlyMap<string, string>, pinned: ReadonlySet<string>, onUnreadable?: (id: string, error: unknown) => void,
): HistoryItem[] {
  return historyRead(dataDir, templateTitles, pinned, onUnreadable).items;
}

/** Record of an unreadable journal for polling "History" every 2 s: one line per session and reason, not per poll. */
export function unreadableJournalLog(logger: Logger): (id: string, error: unknown) => void {
  const seen = new Set<string>();
  return (id, e) => {
    const key = `${id}\0${(e as NodeJS.ErrnoException)?.code ?? String(e)}`;
    if (seen.has(key)) return;
    seen.add(key);
    logger.error(`Session journal ${id} not read`, e);
  };
}

/** An unreadable journal does not empty "History": the session is skipped, the reason goes to onUnreadable (app log). */
export function historyRead(
  dataDir: string, templateTitles: ReadonlyMap<string, string>, pinned: ReadonlySet<string>, onUnreadable?: (id: string, error: unknown) => void,
): { items: HistoryItem[]; attention: AttentionSnapshot[] } {
  const out: HistoryItem[] = [];
  const attention: AttentionSnapshot[] = [];
  for (const s of listSessions(dataDir, undefined, onUnreadable)) {
    let full;
    try {
      full = readSession(dataDir, s.id); // the journal may have become unreadable between the two reads
    } catch (e) {
      onUnreadable?.(s.id, e);
      continue;
    }
    if (full === null) continue;
    const { session, round, turns, participants } = full.state;
    if (session === null) continue;
    const dropped = new Set(participants.filter((p) => p.status === "dropped").map((p) => p.id));
    out.push({
      id: s.id,
      topic: s.topic,
      createdAt: s.createdAt,
      origin: s.origin,
      status: s.status,
      templateName: session.templateId === null ? null : (templateTitles.get(session.templateId) ?? session.templateId),
      participants: s.participants.map((p) => ({ id: p.id, name: p.name, model: p.model, dropped: dropped.has(p.id) })),
      round,
      maxRounds: session.limits.maxRounds,
      turns: turns.length,
      pinned: pinned.has(s.id),
      tokenCapStop: full.status === "stopped" && full.state.finish?.reason === TOKEN_CAP_REASON,
      tokensIncomplete: tokenUsage(full.state).incomplete,
      partial: s.partial,
    });
    const w = full.state.waiting;
    attention.push({
      id: s.id,
      status: s.status,
      ownerQuestionIds: full.state.questions.filter((q) => q.to === OWNER_ID).map((q) => q.id),
      wait: w === null ? null : { waitId: w.waitId, reasons: w.reasons, questionIds: w.questionIds },
    });
  }
  return { items: out, attention };
}

export function startHistoryPolling(opts: {
  read(): HistoryItem[];
  emit(items: HistoryItem[]): void;
  onError(e: unknown): void;
  intervalMs?: number;
}): { refresh(): void; stop(): void } {
  let last: string | null = null;
  let lastError: string | null = null;
  const pass = () => {
    try {
      const items = opts.read();
      lastError = null;
      const json = JSON.stringify(items);
      if (json === last) return;
      last = json;
      opts.emit(items);
    } catch (e) {
      const key = e instanceof Error ? e.message : String(e);
      if (key === lastError) return;
      lastError = key;
      opts.onError(e);
    }
  };
  const timer = setInterval(pass, opts.intervalMs ?? 2000);
  pass();
  return { refresh: pass, stop: () => clearInterval(timer) };
}
