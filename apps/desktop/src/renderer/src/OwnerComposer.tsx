import { useState } from "react";
import type { FormEvent, ReactNode, RefObject } from "react";
import { openOwnerQuestions } from "@model-council/core/protocol";
import type { QuestionState, Session, SessionState } from "@model-council/core/protocol";
import type { JournalPartial } from "@model-council/core";
import { sessionActions } from "./partial-actions.ts";
import { useLanguage, useMessages } from "./language.tsx";
import type { PendingReply } from "./Feed.tsx";
import { panels } from "../../shared/messages/session-panels.ts";
import { Icon } from "./icons.tsx";
import { Who } from "./session-ui.tsx";

export type SendResult = { ok: true; requestId: string } | { ok: false; error: string };

/** Sending a message through the bridge; a bridge refusal becomes a ready message for the field. */
export function sendOwner(
  send: (id: string, text: string, answerTo?: string) => Promise<{ requestId: string }>,
  id: string, text: string, answerTo: string | null,
): Promise<SendResult> {
  return send(id, text, answerTo ?? undefined).then(
    (r): SendResult => ({ ok: true, requestId: r.requestId }),
    (e: unknown): SendResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
}

export interface OwnerComposerViewProps {
  textRef?: RefObject<HTMLTextAreaElement | null>;
  session: Session | null; questions: readonly QuestionState[];
  text: string; answerTo: string | null; error: string | null; sending: boolean;
  blocked?: string | null; // the journal was not read to the end: the reason why a message and an answer are unavailable
  onText(text: string): void; onAnswer(id: string): void; onCancelAnswer(): void; onSubmit(): void;
}

export function OwnerComposerView({ session, questions, text, answerTo, error, sending, blocked = null, onText, onAnswer, onCancelAnswer, onSubmit, textRef }: OwnerComposerViewProps): ReactNode {
  const t = useMessages(panels);
  return (
    <div className="session-owner-box">
      {questions.length > 0 && (
        <div className="session-owner-questions">
          <div className="eyebrow">{t.questionsForYou}</div>
          {questions.map((q) => (
            <div key={q.id} className="session-owner-q" data-tone="warn">
              <div className="session-owner-q__head"><span className="mono">{q.id}</span><Who session={session} id={q.from} /></div>
              <p className="session-owner-q__text">{q.text}</p>
              <button type="button" className="btn btn--sm" disabled={blocked !== null} onClick={() => onAnswer(q.id)}>{t.answer}</button>
            </div>
          ))}
        </div>
      )}
      <form className="session-composer" onSubmit={(e: FormEvent) => { e.preventDefault(); onSubmit(); }}>
        <label className="field">
          <span className="field__label">{answerTo === null ? t.ownerMessage : t.answerTo(answerTo)}</span>
          <textarea ref={textRef} className="textarea" rows={2} value={text} disabled={blocked !== null} placeholder={t.messagePlaceholder} onChange={(e) => onText(e.target.value)} />
        </label>
        {error !== null && <div className="session-composer__error" data-tone="danger" role="alert"><Icon name="i-alert" size="sm" /> {error}</div>}
        <div className="session-composer__row">
          <span className="field__hint">{blocked ?? t.messageHint}</span>
          {answerTo !== null && <button type="button" className="btn btn--ghost btn--sm" onClick={onCancelAnswer}>{t.cancelAnswer}</button>}
          <button type="submit" className="btn btn--primary" disabled={sending || blocked !== null || text.trim() === ""}>{t.send}</button>
        </div>
      </form>
    </div>
  );
}

// Unsent message per session: the screen unmounts when leaving for another section (e.g. "Settings" to change the language).
// ponytail: lives in window memory until sent; move to the store if another screen needs the draft
const drafts = new Map<string, { text: string; answerTo: string | null }>();
export function saveDraft(id: string, draft: { text: string; answerTo: string | null } | null): void {
  if (draft === null || (draft.text === "" && draft.answerTo === null)) drafts.delete(id);
  else drafts.set(id, draft);
}

export function OwnerComposer({ id, state, onSent, textRef, pending = [], partial = null }: { partial?: JournalPartial | null; id: string; state: SessionState; textRef?: RefObject<HTMLTextAreaElement | null>; pending?: readonly PendingReply[]; onSent(r: { requestId: string; text: string; answerTo: string | null }): void }): ReactNode {
  const [text, setText] = useState(() => drafts.get(id)?.text ?? "");
  const [answerTo, setAnswerTo] = useState<string | null>(() => drafts.get(id)?.answerTo ?? null);
  saveDraft(id, { text, answerTo });
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const language = useLanguage();
  const a = sessionActions({ status: "running", partial, waiting: state.waiting !== null, hasVersion: false, finished: false, insufficientActive: false }, language);
  const blocked = a.reply && a.answer ? null : a.reason;
  const submit = () => {
    if (sending || blocked !== null || text.trim() === "") return;
    setSending(true);
    const sent = { text, answerTo };
    void sendOwner((i, t, a) => window.council.sendOwnerMessage(i, t, a), id, text, answerTo).then((r) => {
      setSending(false);
      if (!r.ok) return setError(r.error);
      saveDraft(id, null); // the composer may already be unmounted by the finish: the sent text must not stay as a draft
      setText(""); setAnswerTo(null); setError(null);
      onSent({ requestId: r.requestId, ...sent });
    });
  };
  return (
    <OwnerComposerView
      session={state.session} questions={openOwnerQuestions(state).filter((q) => !pending.some((r) => r.answerTo === q.id))} text={text} answerTo={answerTo} error={error} sending={sending} blocked={blocked} textRef={textRef}
      onText={setText} onAnswer={setAnswerTo} onCancelAnswer={() => setAnswerTo(null)} onSubmit={submit}
    />
  );
}

export const hasOwnerDraft = (id: string): boolean => (drafts.get(id)?.text.trim() ?? "") !== "";
export const readDraft = (id: string): { text: string; answerTo: string | null } | null => drafts.get(id) ?? null;
/** Edits in the field of a finished session: only the text, the answer binding is gone. */
export const saveFinishedText = (id: string, text: string): void => saveDraft(id, { text, answerTo: null });
export const deleteFinishedDraft = (id: string): void => saveDraft(id, null);

export function copyDraft(copy: (text: string) => Promise<unknown>, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return copy(text).then(
    () => ({ ok: true as const }),
    (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
  );
}

export function FinishedDraftView({ text, copied, error, onText, onCopy, onDelete, onResume }: {
  text: string; copied: boolean; error: string | null; onText(text: string): void; onCopy(): void; onDelete(): void;
  onResume?(): void; // only for a session that can be continued; opens the resume panel, starts nothing
}): ReactNode {
  const t = useMessages(panels);
  return (
    <div className="session-owner-box">
      <div className="session-composer" data-state="finished-draft">
        <label className="field">
          <span className="field__label">{t.draftLabel}</span>
          <textarea className="textarea" rows={2} value={text} onChange={(e) => onText(e.target.value)} />
        </label>
        <div className="session-composer__row">
          <span className="field__hint">{t.draftSaved}</span>
          <button type="button" className="btn btn--sm" onClick={onCopy}>{t.copyDraft}</button>
          {onResume && <button type="button" className="btn btn--sm" disabled={text.trim() === ""} onClick={onResume}>{t.resumeWithDraft}</button>}
          <button type="button" className="btn btn--ghost btn--sm" onClick={onDelete}>{t.deleteDraft}</button>
        </div>
        {copied && <div className="field__hint" role="status" data-tone="ok">{t.draftCopied}</div>}
        {error !== null && <div className="session-composer__error" data-tone="danger" role="alert"><Icon name="i-alert" size="sm" /> {error}</div>}
      </div>
    </div>
  );
}

/** The unfinished message under the feed of a finished session: kept in the window, no sending. After deleting it shows `fallback`. */
export function FinishedDraft({ id, fallback, onResume }: { id: string; fallback: ReactNode; onResume?(text: string): void }): ReactNode {
  const [text, setText] = useState(() => { const t = drafts.get(id)?.text ?? ""; saveFinishedText(id, t); return t; });
  const [deleted, setDeleted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (deleted) return fallback;
  return (
    <FinishedDraftView text={text} copied={copied} error={error}
      onText={(v) => { setText(v); saveFinishedText(id, v); setCopied(false); }}
      onCopy={() => void copyDraft((v) => window.council.copyText(v), text).then((r) => { setCopied(r.ok); setError(r.ok ? null : r.error); })}
      onDelete={() => { deleteFinishedDraft(id); setDeleted(true); }}
      onResume={onResume && (() => onResume(text))} />
  );
}
