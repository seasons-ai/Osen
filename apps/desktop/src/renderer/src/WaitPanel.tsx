import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { JournalPartial } from "@model-council/core";
import type { SessionState } from "@model-council/core/protocol";
import { formatDate } from "@model-council/core/i18n";
import type { Language } from "@model-council/core/i18n";
import { panels } from "../../shared/messages/session-panels.ts";
import { formatWhen } from "./History.tsx";
import { Icon } from "./icons.tsx";
import { useLanguage, useMessages } from "./language.tsx";
import { sessionActions } from "./partial-actions.ts";

export function waitReasons(state: SessionState, language?: Language): string[] {
  const t = panels(language);
  const wait = state.waiting;
  if (wait === null) return [];
  return wait.reasons.map((reason) => reason === "round_boundary"
    ? t.pauseAfterRound(state.round)
    : wait.questionIds.length === 1 ? t.waitAnswerOne(wait.questionIds[0]!)
    : t.waitAnswerMany(wait.questionIds.join(", ")));
}

const CLOCK: Intl.DateTimeFormatOptions = { timeStyle: "medium" };
/** Wait deadline: today's — time with seconds, otherwise date and time as in "History". */
export function formatDeadline(iso: string, now: Date, language?: Language): string {
  const d = new Date(iso);
  return d.toDateString() === now.toDateString() ? formatDate(d, CLOCK, language) : formatWhen(iso, now, language);
}

export function formatLeft(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const tail = String(seconds % 60).padStart(2, "0");
  return minutes < 60 ? `${minutes}:${tail}` : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${tail}`;
}

export interface WaitPanelViewProps {
  state: SessionState; now: number; sending: boolean; error: string | null;
  confirming: boolean; stopping: boolean;
  blocked?: string | null; // the journal was not read to the end: the reason why the wait cannot be lifted and a message cannot be added
  onContinue(): void; onReply(): void;
  onStopAsk(): void; onStopCancel(): void; onStopConfirm(): void;
}

export function WaitPanelView({ state, now, sending, error, confirming, stopping, blocked = null, onContinue, onReply, onStopAsk, onStopCancel, onStopConfirm }: WaitPanelViewProps): ReactNode {
  const t = useMessages(panels);
  const language = useLanguage();
  const wait = state.waiting;
  if (wait === null) return null;
  return (
    <section className="session-wait" aria-label={t.waitLabel} data-tone="warn">
      <div className="session-wait__head">
        <Icon name="i-clock" size="sm" /><h2 className="session-wait__title">{t.waitTitle}</h2>
        <span className="session-wait__left mono" role="timer">{t.left(formatLeft(Date.parse(wait.deadline) - now))}</span>
      </div>
      <ul className="session-wait__reasons">{waitReasons(state, language).map((reason) => <li key={reason}>{reason}</li>)}</ul>
      <p className="session-wait__hint muted">
        {t.waitHint(formatDeadline(wait.deadline, new Date(now), language))}{wait.reasons.includes("owner_question") ? t.waitHintQuestions : ""}.
        {wait.reasons.includes("round_boundary") && t.waitHintRound}
      </p>
      {blocked !== null && <p className="session-wait__hint muted">{blocked}</p>}
      {error !== null && <div className="session-wait__error" data-tone="danger" role="alert"><Icon name="i-alert" size="sm" /> {error}</div>}
      <div className="session-wait__actions">
        <button type="button" className="btn btn--primary btn--sm" disabled={sending || stopping || blocked !== null} onClick={onContinue}>{sending ? t.continuing : t.continue}</button>
        <button type="button" className="btn btn--sm" disabled={stopping || blocked !== null} onClick={onReply}>{t.addMessage}</button>
        {confirming ? (
          <>
            <span className="muted">{t.endAsk}</span>
            <button type="button" className="btn btn--danger btn--sm" disabled={stopping} onClick={onStopConfirm}>{t.end}</button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={stopping} onClick={onStopCancel}>{t.cancel}</button>
          </>
        ) : <button type="button" className="btn btn--danger btn--sm" disabled={stopping} onClick={onStopAsk}>{t.end}</button>}
      </div>
    </section>
  );
}

type WaitGuard = { current: { waitId: string | null; sent: boolean } };

/** Success blocks a repeat until a new waitId; a refusal frees only its own request. */
export async function submitWait(
  call: (id: string, waitId: string) => Promise<{ requestId: string }>, id: string, waitId: string, guard: WaitGuard,
): Promise<{ ok: true } | { ok: false; error: string } | null> {
  if (guard.current.waitId !== waitId) guard.current = { waitId, sent: false };
  const request = guard.current;
  if (request.sent) return null;
  request.sent = true;
  try { await call(id, waitId); return { ok: true }; } catch (e) {
    request.sent = false;
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function WaitPanel({ id, state, confirming, stopping, onStopAsk, onStopCancel, onStopConfirm, onReply, onError, partial = null }: {
  partial?: JournalPartial | null;
  id: string; state: SessionState; confirming: boolean; stopping: boolean;
  onStopAsk(): void; onStopCancel(): void; onStopConfirm(): void; onReply(): void; onError?(error: string): void;
}): ReactNode {
  const waitId = state.waiting?.waitId ?? null;
  const guard = useRef({ waitId, sent: false });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  if (guard.current.waitId !== waitId) {
    guard.current = { waitId, sent: false };
    setSending(false); setError(null);
  }
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const language = useLanguage();
  const a = sessionActions({ status: "running", partial, waiting: true, hasVersion: false, finished: false, insufficientActive: false }, language);
  const blocked = a.continueWait ? null : a.reason;
  const resume = () => {
    if (waitId === null || blocked !== null || stopping || guard.current.sent) return;
    const request = guard.current;
    setSending(true); setError(null);
    void submitWait((i, w) => window.council.continueWait(i, w), id, waitId, guard).then((r) => {
      if (guard.current !== request || r === null || r.ok) return;
      setSending(false); setError(r.error); onError?.(r.error);
    });
  };
  return <WaitPanelView state={state} now={now} sending={sending} blocked={blocked} error={error} confirming={confirming} stopping={stopping}
    onContinue={resume} onReply={onReply} onStopAsk={onStopAsk} onStopCancel={onStopCancel} onStopConfirm={onStopConfirm} />;
}

export function WaitInterruptedNote({ state }: { state: SessionState }): ReactNode {
  const t = useMessages(panels);
  const language = useLanguage();
  if (state.waiting === null) return null;
  return (
    <div className="alert" data-tone="muted">
      <Icon name="i-clock" />
      <div><div className="alert__title">{t.interruptedTitle}</div>
        <div className="alert__text">{t.interruptedText(waitReasons(state, language).join("; "), formatDeadline(state.waiting.deadline, new Date(), language))}</div>
      </div>
    </div>
  );
}
