import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject, UIEventHandler } from "react";
import { OWNER_ID } from "@model-council/core/protocol";
import { draftPhase } from "@model-council/core/protocol";
import type { FailedAttempt, OwnerMessage, QuestionState, ResumeMark, SessionState, TurnRecord } from "@model-council/core/protocol";
import type { LiveText } from "../../shared/bridge.ts";
import { failureLabel, timeline } from "../../shared/timeline.ts";
import type { TimelineItem, WaitExpiry } from "../../shared/timeline.ts";
import { Icon } from "./icons.tsx";
import { formatWhen } from "./History.tsx";
import { useLanguage, useMessages } from "./language.tsx";
import { feed } from "../../shared/messages/session-feed.ts";
import { Avatar, OwnerAvatar, Who, STANCE, stanceWord, bareNameOf, chars, colorOf, draftInWork, linkify, nameOf, num } from "./session-ui.tsx";
import type { DraftTexts } from "./session-drafts.ts";
import { acceptedDrafts } from "./session-drafts.ts";
import type { DraftDone } from "@model-council/core/protocol";

export function isAtBottom(m: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= 24;
}

const ESC: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };

// Extracts the already received part of the "reasoning" string from an unfinished JSON response.
export function liveReasoning(raw: string): string {
  const m = /"reasoning"\s*:\s*"/.exec(typeof raw === "string" ? raw : "");
  if (!m) return "";
  const s = raw.slice(m.index + m[0].length);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') break;
    if (c !== "\\") { out += c; continue; }
    const e = s[i + 1];
    if (e === undefined) break; // a truncated `\`
    if (e === "u") {
      const hex = s.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break; // incomplete \uXX
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
    } else { out += ESC[e] ?? e; i++; }
  }
  return out;
}

export function liveTextFor(state: SessionState, live: LiveText | null): string | null {
  if (!live || state.currentTurn?.turn !== live.turn) return null;
  if (state.failures.some((f) => f.turn === live.turn && f.attempt === live.attempt)) return null;
  return liveReasoning(live.text) || null;
}

export interface FeedViewProps {
  state: SessionState; running: boolean; live: LiveText | null;
  unseen: number;
  onJump(): void;
  tail?: ReactNode;
  feedRef?: RefObject<HTMLDivElement | null>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  pending?: readonly PendingReply[]; // sent but not yet applied
  expired?: readonly WaitExpiry[];
  footer?: ReactNode; // block under the feed, after .session-more
  head?: ReactNode; // message above the feed, under the column header
  drafts?: DraftTexts; // texts of accepted drafts; without it the text is "loading"
}

export interface PendingReply { requestId: string; text: string; answerTo: string | null }

// The question status label is taken from the catalog at render time.
const QUESTION_STATUS = {
  open: { icon: "i-clock", tone: "warn" },
  answered: { icon: "i-check", tone: "info" },
  unanswered: { icon: "i-alert", tone: "muted" },
  replaced: { icon: "i-alert", tone: "muted" },
} as const satisfies Record<QuestionState["status"], { icon: string; tone: string }>;
const CLOSED_BY_OWNER = { icon: "i-alert", tone: "muted" } as const;
const ANSWER_SENT = { icon: "i-clock", tone: "warn" } as const;

function OwnerHead({ children }: { children: ReactNode }): ReactNode {
  const t = useMessages(feed);
  return <header className="session-turn__head"><OwnerAvatar /><span className="session-turn__name">{t.owner}</span>{children}</header>;
}

function OwnerCard({ state, m }: { state: SessionState; m: OwnerMessage }): ReactNode {
  const m2 = useMessages(feed);
  const dup = m.answers.length === 1 && m.answers[0]!.text === m.text; // `council say --answer` writes one text into both fields
  return (
    <article className="session-turn session-owner">
      <OwnerHead><span className="mono muted">{m.id}</span></OwnerHead>
      {m.answers.map((a) => {
        const q = state.questions.find((x) => x.id === a.questionId);
        return (
          <div className="session-answer" key={a.questionId}>
            <div className="session-quote">
              <span className="mono">{m2.answerTo(a.questionId)}</span>
              {q && <Who session={state.session} id={q.from} />}
              {q && <span>{q.text}</span>}
            </div>
            <p className="session-answer__text">{a.text}</p>
          </div>
        );
      })}
      {!dup && <p className="session-turn__text session-view__text">{linkify(m.text)}</p>}
    </article>
  );
}

function PendingCard({ r }: { r: PendingReply }): ReactNode {
  const t = useMessages(feed);
  return (
    <article className="session-turn session-owner session-owner--pending">
      <OwnerHead>
        <span className="badge" data-tone="warn"><Icon name="i-clock" size="sm" /> {t.pendingWait}</span>
        {r.answerTo !== null && <span className="chip mono">{t.answerTo(r.answerTo)}</span>}
      </OwnerHead>
      <p className="session-turn__text session-view__text">{linkify(r.text)}</p>
    </article>
  );
}

function TurnHead({ state, turn, id, badge, chip }: { state: SessionState; turn: number; id: string; badge: ReactNode; chip?: ReactNode }): ReactNode {
  const t = useMessages(feed);
  const language = useLanguage();
  return (
    <header className="session-turn__head">
      <Avatar n={num(state.session, id)} />
      <span className="session-turn__name">{bareNameOf(state.session, id, language)}</span>
      <span className="mono muted">{t.turn(turn)}</span>
      {badge}{chip}
    </header>
  );
}

function TurnCard({ state, t, sent }: { state: SessionState; t: TurnRecord; sent: ReadonlySet<string | null> }): ReactNode {
  const m = useMessages(feed);
  const language = useLanguage();
  const st = STANCE[t.stance];
  const toOwner = t.questions.filter((q) => q.to === OWNER_ID);
  return (
    <article className="session-turn" data-p={colorOf(num(state.session, t.participantId))}>
      <TurnHead state={state} turn={t.turn} id={t.participantId}
        badge={<span className="badge" data-tone={st.tone}><Icon name={st.icon} size="sm" /> {stanceWord(t.stance, language)}</span>}
        chip={<>
          {t.newVersion && <span className="chip mono">{m.version(t.version)}</span>}
          {toOwner.map((q) => <span className="badge" data-tone="warn" key={q.id}><Icon name="i-question" size="sm" /> {m.questionToOwner(q.id)}</span>)}
        </>} />
      {t.answers.map((a) => {
        const q = state.questions.find((x) => x.id === a.questionId);
        return (
          <div className="session-answer" key={a.questionId}>
            <div className="session-quote">
              <span className="mono">{m.answerTo(a.questionId)}</span>
              {q && <Who session={state.session} id={q.from} />}
              {q && <span>{q.text}</span>}
            </div>
            <p className="session-answer__text">{a.text}</p>
          </div>
        );
      })}
      <p className="session-turn__text session-view__text">{linkify(t.reasoning)}</p>
      {t.filesRead && t.filesRead.length > 0 && <span className="mono muted session-turn__read">{m.readFiles(t.filesRead.map((f) => f.name).join(", "))}</span>}
      {t.questions.map((q) => {
        const status = state.questions.find((x) => x.id === q.id)?.status ?? "open";
        const qs = q.to === OWNER_ID && status === "unanswered" ? CLOSED_BY_OWNER : status === "open" && sent.has(q.id) ? ANSWER_SENT : QUESTION_STATUS[status];
        const word = qs === CLOSED_BY_OWNER ? m.qClosedByOwner : qs === ANSWER_SENT ? m.qAnswerSent : { open: m.qOpen, answered: m.qAnswered, unanswered: m.qUnanswered, replaced: m.qReplaced }[status];
        return (
          <div className="session-question" key={q.id}>
            <div className="session-question__head">
              <span className="mono">{m.questionHead(q.id)}</span>
              <Who session={state.session} id={q.to} />
              <span className="badge" data-tone={qs.tone}><Icon name={qs.icon} size="sm" /> {word}</span>
            </div>
            <p className="session-question__text">{q.text}</p>
          </div>
        );
      })}
    </article>
  );
}

type FailItem = Extract<TimelineItem, { kind: "failure" | "dropped" | "draft-failure" | "draft-dropped" }>;
const isFail = (it: TimelineItem): it is FailItem => it.kind === "failure" || it.kind === "dropped" || it.kind === "draft-failure" || it.kind === "draft-dropped";

function Fails({ state, items }: { state: SessionState; items: FailItem[] }): ReactNode {
  const t = useMessages(feed);
  const language = useLanguage();
  return (
    <div className="session-fails">
      {items.map((it, i) => {
        if (it.kind === "dropped" || it.kind === "draft-dropped") {
          return <div className="session-fail" data-tone="warn" key={i}><Icon name="i-user-off" /><span>{t.droppedOut(nameOf(state.session, it.participantId, language), it.reason)}</span></div>;
        }
        const f = it.failure;
        const where = it.kind === "draft-failure" ? t.whereDraft : t.whereTurn((f as FailedAttempt).turn);
        return (
          <div className="session-fail" data-tone={it.retried ? "warn" : "danger"} key={i}>
            <Icon name="i-alert" />
            <span>{where} · {nameOf(state.session, f.participantId, language)} · {t.attempt(f.attempt, failureLabel(f.kind, language), f.message)}{it.retried ? `${f.message.endsWith(".") ? "" : "."} ${t.retried}` : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ResumedMark({ mark, state }: { mark: ResumeMark; state?: SessionState }): ReactNode {
  const t = useMessages(feed);
  const language = useLanguage();
  const separator = (
    <div className="feed-resumed" role="separator">
      <Icon name="i-play" size="sm" /><span>{t.resumed(t.rounds(mark.addedRounds))}</span>
      <span className="feed-resumed__when mono">{formatWhen(mark.ts, new Date(), language)}</span>
    </div>
  );
  if (!mark.replacements?.length || !state) return separator;
  return (
    <>
      {separator}
      <div className="feed-replaced">
        {mark.replacements.map((r) => {
          const dropReason = state.participants.find((x) => x.id === r.oldParticipantId)?.dropReason;
          return (
            <div className="feed-replaced__line" key={r.oldParticipantId}>
              <Icon name="i-loop" size="sm" /><span>{t.replaced} </span>
              <Who session={state.session} id={r.oldParticipantId} /><span> → </span><Who session={state.session} id={r.newParticipantId} />
              <span className="muted"> · {typeof dropReason === "string" ? t.droppedOutShort(dropReason) : t.wasUnavailable}</span>
            </div>
          );
        })}
        <div className="feed-replaced__line muted"><Icon name="i-info" size="sm" /><span>{t.agreementsReset}</span></div>
      </div>
    </>
  );
}

export function WaitExpiredMark({ mark }: { mark: WaitExpiry }): ReactNode {
  const t = useMessages(feed);
  const language = useLanguage();
  return (
    <div className="feed-resumed" role="separator">
      <Icon name="i-clock" size="sm" /><span>{t.waitExpired}</span>
      <span className="feed-resumed__when mono">{formatWhen(mark.at, new Date(), language)}</span>
    </div>
  );
}

/** Message about owner messages dropped by the resume before they were applied. */
export function DroppedNotice({ texts, onClose }: { texts: readonly string[]; onClose(): void }): ReactNode {
  const t = useMessages(feed);
  const title = t.removedRequests(texts.length);
  return (
    <div className="alert feed-dropped" data-tone="warn" role="status">
      <Icon name="i-info" />
      <div className="alert__text">
        <strong>{title}</strong>
        <ul className="feed-dropped__list">{texts.map((t, i) => <li key={i}>{t}</li>)}</ul>
        <span className="muted">{t.notApplied}</span>
      </div>
      <button type="button" className="btn btn--ghost btn--sm feed-dropped__close" aria-label={t.dismiss} onClick={onClose}><Icon name="i-x" size="sm" /></button>
    </div>
  );
}

function DraftCard({ state, draftId, done, texts }: { state: SessionState; draftId: string; done: DraftDone; texts: DraftTexts | undefined }): ReactNode {
  const t = useMessages(feed);
  const language = useLanguage();
  const n = num(state.session, done.participantId);
  const v = texts?.byId.get(draftId);
  const body: ReactNode = v ? (v.text !== null ? <p className="session-turn__text session-view__text">{linkify(v.text)}</p> : <Unavailable why={v.error} />)
    : texts && texts.error !== null ? <Unavailable why={texts.error} /> : <span className="muted">{t.draftLoading}</span>;
  return (
    <article className="session-turn session-draft" data-p={colorOf(n)}>
      <header className="session-turn__head">
        <Avatar n={n} />
        <span className="session-turn__name">{bareNameOf(state.session, done.participantId, language)}</span>
        <span className="badge" data-tone="info"><Icon name="i-doc" size="sm" /> {t.draftBadge}</span>
        {done.attempts > 1 && <span className="chip mono">{t.attempts(done.attempts)}</span>}
        <span className="chip mono">{chars(done.chars, language)}</span>
      </header>
      <p className="session-turn__text session-view__text">{linkify(done.reasoning)}</p>
      {done.filesRead && done.filesRead.length > 0 && <span className="mono muted session-turn__read">{t.readFiles(done.filesRead.map((f) => f.name).join(", "))}</span>}
      <details className="disclosure session-draft__text" open>
        <summary>{t.draftText}</summary>
        {body}
      </details>
    </article>
  );
}

function Unavailable({ why }: { why: string | null }): ReactNode {
  const t = useMessages(feed);
  return <div className="session-fail" data-tone="warn"><Icon name="i-alert" /><span>{t.textUnavailable(why ?? t.reasonMissing)}</span></div>;
}

export function DiscussionStartMark({ state, synthesizerId }: { state: SessionState; synthesizerId: string }): ReactNode {
  const t = useMessages(feed);
  const language = useLanguage();
  return (
    <div className="alert feed-start" data-tone="info" role="separator">
      <Icon name="i-play" /><div className="alert__text">{t.discussionStarted(num(state.session, synthesizerId), bareNameOf(state.session, synthesizerId, language))}</div>
    </div>
  );
}

export function FeedView({ state, running, live, unseen, onJump, tail, feedRef, onScroll, pending = [], expired, footer, head, drafts }: FeedViewProps): ReactNode {
  const t = useMessages(feed);
  const language = useLanguage();
  if (!state.session) return null;
  const items = timeline(state, expired);
  const sent = new Set(running ? pending.map((r) => r.answerTo) : []); // questions with a sent but not yet applied answer
  const cur = running ? state.currentTurn : null;
  const text = cur ? liveTextFor(state, live) : null;
  const body: ReactNode[] = [];
  let round = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.kind === "owner") { body.push(<OwnerCard key={`o${it.message.id}`} state={state} m={it.message} />); continue; }
    if (it.kind === "resumed") { body.push(<ResumedMark key={`m${it.mark.beforeTurn}-${it.mark.ts}`} mark={it.mark} state={state} />); continue; }
    if (it.kind === "wait-expired") { body.push(<WaitExpiredMark key={it.mark.waitId} mark={it.mark} />); continue; }
    if (it.kind === "draft-phase") { body.push(<div className="session-round session-phase" key="draft-phase">{t.draftsPhase} <span className="muted">{t.draftsPhaseNote}</span></div>); continue; }
    if (it.kind === "draft") { body.push(<DraftCard key={`d${it.draftId}`} state={state} draftId={it.draftId} done={it.done} texts={drafts} />); continue; }
    if (it.kind === "discussion-start") { body.push(<DiscussionStartMark key="discussion-start" state={state} synthesizerId={it.synthesizerId} />); continue; }
    const r = it.kind === "turn" ? it.turn.round : it.kind === "failure" ? it.failure.round : round;
    if (r !== round) { round = r; body.push(<div className="session-round" key={`r${r}`}>{t.roundHeader(r)}</div>); }
    if (it.kind === "turn") { body.push(<TurnCard key={`t${it.turn.turn}`} state={state} t={it.turn} sent={sent} />); continue; }
    const group: FailItem[] = [it as FailItem];
    for (let n = items[i + 1]; n && isFail(n); n = items[i + 1]) { group.push(n); i++; }
    body.push(<Fails key={it.kind === "draft-failure" ? `f${it.draftId}-${it.failure.attempt}` : `f${i}`} state={state} items={group} />);
  }
  if (cur) {
    body.push(
      <article className="session-turn session-turn--live" data-p={colorOf(num(state.session, cur.participantId))} key="live">
        <TurnHead state={state} turn={cur.turn} id={cur.participantId}
          badge={<span className="badge" data-tone="accent"><span className="dots"><i /></span> {t.thinking}</span>} />
        <p className="session-turn__text session-view__text">{text ?? ""}<span className="session-cursor" aria-hidden="true">▍</span></p>
        {text !== null && <span className="muted">{t.liveNote}</span>}
      </article>,
    );
  }
  if (running && draftPhase(state) === "drafting") {
    for (const d of state.drafts) {
      if (!draftInWork(state, d)) continue;
      body.push(
        <article className="session-turn session-turn--live session-draft" data-p={colorOf(num(state.session, d.participantId))} key={`live-${d.draftId}`}>
          <header className="session-turn__head">
            <Avatar n={num(state.session, d.participantId)} />
            <span className="session-turn__name">{bareNameOf(state.session, d.participantId, language)}</span>
            <span className="badge" data-tone="accent"><span className="dots"><i /></span> {t.writingDraft}</span>
          </header>
        </article>,
      );
    }
  }
  if (running) {
    const applied = new Set(state.ownerMessages.map((m) => m.requestId));
    for (const r of pending) if (!applied.has(r.requestId)) body.push(<PendingCard key={`p${r.requestId}`} r={r} />);
  }
  return (
    <section className="session-col" aria-label={t.feedLabel}>
      <div className="session-col__head"><span className="eyebrow">{t.feedLabel}</span></div>
      {head}
      <div className="session-feed scroll-y" ref={feedRef} onScroll={onScroll}>
        {body}
        {tail}
        {body.length === 0 && !tail && <p className="muted">{t.noTurns}</p>}
      </div>
      {unseen > 0 && (
        <div className="session-more">
          <button type="button" className="btn btn--sm" onClick={onJump}><Icon name="i-chevron-down" size="sm" /> {t.newTurns(unseen)}</button>
        </div>
      )}
      {footer}
    </section>
  );
}

export function Feed({ state, running, live, tail, pending, expired, footer, head, drafts }: { state: SessionState; running: boolean; live: LiveText | null; tail?: ReactNode; pending?: readonly PendingReply[]; expired?: readonly WaitExpiry[]; footer?: ReactNode; head?: ReactNode; drafts?: DraftTexts }): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true); // whether the owner was at the bottom before the last change
  const total = state.turns.length + acceptedDrafts(state);
  const [seen, setSeen] = useState(0);

  // After every render: any content growth is scrolled to before the deferred scroll event
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) { el.scrollTop = el.scrollHeight; if (seen !== total) setSeen(total); }
  });

  const onScroll: UIEventHandler<HTMLDivElement> = (e) => {
    atBottom.current = isAtBottom(e.currentTarget);
    if (atBottom.current) setSeen(total);
  };
  const onJump = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setSeen(total);
  };
  return <FeedView state={state} running={running} live={live} unseen={Math.max(0, total - seen)} onJump={onJump} tail={tail} pending={pending} expired={expired} footer={footer} head={head} drafts={drafts} feedRef={ref} onScroll={onScroll} />;
}
