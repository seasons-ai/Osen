import { useRef } from "react";
import type { ReactNode } from "react";
import type { SessionState } from "@model-council/core/protocol";
import type { JournalPartial, StoredStatus } from "@model-council/core";
import type { LiveText } from "../../shared/bridge.ts";
import type { WaitExpiry } from "../../shared/timeline.ts";
import { OWNER_ID } from "@model-council/core/protocol";
import { DroppedNotice, Feed } from "./Feed.tsx";
import type { DraftTexts } from "./session-drafts.ts";
import type { PendingReply } from "./Feed.tsx";
import { OwnerComposer } from "./OwnerComposer.tsx";
import { WaitInterruptedNote, WaitPanel } from "./WaitPanel.tsx";
import { Icon } from "./icons.tsx";
import { useLanguage, useMessages } from "./language.tsx";
import { feed } from "../../shared/messages/session-feed.ts";
import { ParticipantsPanel, RoundCounter } from "./Participants.tsx";
import { RESULT_HEAD, finalVersion } from "./Result.tsx";
import { failReason, spend, stoppedByCap } from "./session-ui.tsx";
import { SolutionPanel } from "./SolutionPanel.tsx";
import { partialView } from "../../shared/partial.ts";
import { StatusBadge } from "./StatusBadge.tsx";

export interface DiscussionProps {
  state: SessionState;
  status: StoredStatus; // "running" or the final status (the owner returned to the feed)
  live: LiveText | null;
  expired?: readonly WaitExpiry[];
  confirming: boolean; stopping: boolean;
  onStopAsk(): void; onStopCancel(): void; onStopConfirm(): void;
  onResult(): void;
  dropped?: readonly string[] | null; onDroppedClose?(): void; // texts of owner message requests dropped by the resume
  drafts?: DraftTexts;
  partial?: JournalPartial | null; // the journal was not read to the end
  id?: string; pending?: readonly PendingReply[]; onOwnerSent?(r: { requestId: string; text: string; answerTo: string | null }): void;
}

export function Discussion({ state, status, live, expired, confirming, stopping, onStopAsk, onStopCancel, onStopConfirm, onResult, id, pending, onOwnerSent, dropped, onDroppedClose, drafts, partial = null }: DiscussionProps): ReactNode {
  const t = useMessages(feed);
  const language = useLanguage();
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const waitPanel = status === "running" && state.waiting !== null && id !== undefined; // the wait panel asks for the stop confirmation itself
  const view = partialView(partial, language);
  const { session } = state;
  if (session === null) return null;
  const running = status === "running";
  const capStop = status === "stopped" && stoppedByCap(state);
  let tail: ReactNode = undefined;
  if (status !== "running" && view === null) {
    const sp = spend(state);
    // Tone and icon come from RESULT_HEAD; the title comes from the catalog.
    const titles = { consensus: t.titleConsensus, no_consensus: t.titleNoConsensus, stopped: t.titleStopped, failed: t.titleFailed, interrupted: t.titleInterrupted };
    const head = capStop ? { ...RESULT_HEAD[status], tone: "warn" as const, icon: "i-coins" as const, title: t.titleCapStop } : { ...RESULT_HEAD[status], title: titles[status] };
    const text = status === "consensus"
      ? t.consensusText(String(finalVersion(state)?.number ?? "—"))
      : capStop ? `${t.capText(sp.total, sp.cap)}${sp.incomplete ? t.incompleteSentence : ""}`
      : status === "failed" ? failReason(state, language) : null;
    tail = (
      <div className="alert" data-tone={head.tone}>
        <Icon name={head.icon} />
        <div><div className="alert__title">{head.title}</div>{text && <div className="alert__text">{text}</div>}</div>
        <div className="alert__actions"><button type="button" className="btn btn--primary btn--sm" onClick={onResult}>{t.toResult}</button></div>
      </div>
    );
  }
  // The field exists only for a running session; for a finished one with owner messages or questions — a caption, otherwise no block.
  let footer: ReactNode = undefined;
  if (running) {
    if (id !== undefined) footer = <>
      {state.waiting !== null && <WaitPanel id={id} state={state} partial={partial} confirming={confirming} stopping={stopping}
        onStopAsk={onStopAsk} onStopCancel={onStopCancel} onStopConfirm={onStopConfirm}
        onReply={() => { textRef.current?.focus(); textRef.current?.scrollIntoView({ block: "nearest" }); }} />}
      <OwnerComposer id={id} state={state} textRef={textRef} pending={pending} onSent={(r) => onOwnerSent?.(r)} partial={partial} />
    </>;
  } else if (state.ownerMessages.length > 0 || state.questions.some((q) => q.to === OWNER_ID)) {
    footer = <div className="session-owner-box"><p className="session-composer__closed muted"><Icon name="i-info" size="sm" /> {t.sessionClosed}</p></div>;
  }
  if (view === null && status === "interrupted" && state.waiting !== null) footer = <><WaitInterruptedNote state={state} />{footer}</>;
  return (
    <>
      <header className="topbar">
        <div className="session-titlebar">
          <h1 className="topbar__title session-view__topic" title={session.topic}>{session.topic}</h1>
          {view ? <span className="badge" data-tone="warn"><Icon name="i-alert" size="sm" />{view.badge}</span> : <StatusBadge status={status} tokenCap={capStop} />}
        </div>
        <div className="topbar__actions">
          <RoundCounter state={state} />
          {running && <button type="button" className="btn" disabled title={t.resultAfterFinish}>{t.toResult}</button>}
          {running && (!confirming || waitPanel) && (
            <button type="button" className="btn btn--danger" disabled={stopping} onClick={onStopAsk}>
              <Icon name="i-stop" size="sm" />{stopping ? t.stopping : t.stop}
            </button>
          )}
          {running && confirming && !waitPanel && (
            <>
              <span className="muted">{t.stopAsk}</span>
              <button type="button" className="btn btn--danger" onClick={onStopConfirm}>{t.stop}</button>
              <button type="button" className="btn btn--ghost" onClick={onStopCancel}>{t.keepGoing}</button>
            </>
          )}
          {!running && (
            <button type="button" className="btn btn--primary" onClick={onResult}>{t.toResult} <Icon name="i-chevron-right" size="sm" /></button>
          )}
        </div>
      </header>
      <main className="content content--flush">
        <div className="session-grid">
          <ParticipantsPanel state={state} running={running} />
          <Feed state={state} running={running} live={live} expired={expired} tail={tail} pending={running ? pending : undefined} footer={footer} drafts={drafts}
            head={<>
              {view && <div className="alert" data-tone={view.tone} role="status"><Icon name={view.icon} /><div className="alert__text">{view.message}</div></div>}
              {dropped && dropped.length > 0 ? <DroppedNotice texts={dropped} onClose={() => onDroppedClose?.()} /> : undefined}
            </>} />
          <SolutionPanel state={state} />
        </div>
      </main>
    </>
  );
}
