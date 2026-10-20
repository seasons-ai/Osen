import { useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SessionState } from "@model-council/core/protocol";
import type { StoredStatus } from "@model-council/core";
import type { HistoryItem, LiveText, ResumeView } from "../../shared/bridge.ts";
import type { WaitExpiry } from "../../shared/timeline.ts";
import { panels } from "../../shared/messages/session-panels.ts";
import { Discussion } from "./Discussion.tsx";
import type { PendingReply } from "./Feed.tsx";
import { useMessages } from "./language.tsx";
import { deleteFinishedDraft, hasOwnerDraft, readDraft } from "./OwnerComposer.tsx";
import { useSessionDrafts } from "./session-drafts.ts";
import { chosenVersion } from "../../shared/final-version.ts";
import { Result, ResumePanel, finalVersion, openResume } from "./Result.tsx";
import type { ResultProps, ResultStatus } from "./Result.tsx";

/** The open resume panel: every successful request gives a new number, and the panel is recreated with a fresh view. */
export const openedPanel = (prev: { view: ResumeView; n: number } | null, view: ResumeView): { view: ResumeView; n: number } => ({ view, n: (prev?.n ?? 0) + 1 });

export function sessionStatus(state: SessionState, item: HistoryItem | null): StoredStatus | "loading" {
  if (state.session === null) return "loading";
  if (state.finish !== null) return state.status;
  if (item?.status === "interrupted") return "interrupted";
  // History already knows about the finish, but the finish event has not been read yet.
  if (item && item.status !== "running") return "loading";
  return "running";
}

/** Numbers of session segments (`state.resumes.length`) in which a confirmation is open and a stop is requested; null — not open and not requested. */
export interface StopMarks { confirming: number | null; stopping: number | null }
export type StopAction = { type: "ask" | "cancel" | "confirm" | "failed"; segment: number };
export const noStop: StopMarks = { confirming: null, stopping: null };

export function stopMarks(m: StopMarks, a: StopAction): StopMarks {
  switch (a.type) {
    case "ask": return { ...m, confirming: a.segment };
    case "cancel": return { ...m, confirming: null };
    case "confirm": return { confirming: null, stopping: a.segment };
    // A refusal clears only its own stop: a late refusal of a previous segment does not touch the new one.
    case "failed": return m.stopping === a.segment ? { ...m, stopping: null } : m;
  }
}

/** Flags apply only in the segment where they were set: a session resume does not inherit them. */
export const stopFlags = (m: StopMarks, segment: number): { confirming: boolean; stopping: boolean } =>
  ({ confirming: m.confirming === segment, stopping: m.stopping === segment });

/** At the finish (from "running" or "loading" to a final status) stay on the feed when the owner has an unfinished message; null — no finish. */
export const feedAtFinish = (prev: StoredStatus | "loading", next: StoredStatus | "loading", id: string): boolean | null =>
  (prev === "running" || prev === "loading") && next !== "running" && next !== "loading" ? hasOwnerDraft(id) : null;

/** An accepted resume: the draft is deleted only when a message went into the engine (sent); the feed of the same session opens. */
export function resumeAccepted(id: string, texts: readonly string[], sent: boolean): { feed: true; dropped: string[] | null } {
  if (sent) deleteFinishedDraft(id);
  return { feed: true, dropped: texts.length > 0 ? [...texts] : null };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function SessionScreen({ id, item, state, live, pending, expired, onOwnerSent, onNew, onError, onRerun }: {
  id: string; item: HistoryItem | null; state: SessionState; live: LiveText | null;
  pending?: readonly PendingReply[]; onOwnerSent?(r: { requestId: string; text: string; answerTo: string | null }): void;
  expired?: readonly WaitExpiry[];
  onNew(): void; onError(message: string): void; onRerun?(withDecision: boolean): Promise<void> | void;
}): ReactNode {
  const [feed, setFeed] = useState(() => hasOwnerDraft(id)); // a finished session with a saved draft opens on the feed
  const [prevStatus, setPrevStatus] = useState<StoredStatus | "loading" | null>(null);
  const [marks, dispatch] = useReducer(stopMarks, noStop);
  const [rerunBusy, setRerunBusy] = useState(false);
  const [notice, setNotice] = useState<ResultProps["notice"]>(null);
  const [resume, setResume] = useState<{ view: ResumeView; n: number } | null>(null); // the open resume panel
  const [opening, setOpening] = useState(false);
  const [draftAtOpen, setDraftAtOpen] = useState(""); // the saved draft text captured when the panel is opened
  const [dropped, setDropped] = useState<string[] | null>(null); // owner message requests dropped by the resume; lives while the screen is open
  const openGuard = useRef(false);
  const status = sessionStatus(state, item);
  const drafts = useSessionDrafts(id, state);
  const t = useMessages(panels);
  // Adjusted during render so that the result is never flashed; the composer has already written the draft to the map.
  if (prevStatus !== status) {
    setPrevStatus(status);
    const f = prevStatus === null ? null : feedAtFinish(prevStatus, status, id);
    if (f !== null) setFeed(f);
  }

  if (status === "loading") {
    return (
      <>
        <header className="topbar"><h1 className="topbar__title">{item?.topic ?? t.sessionTitle}</h1></header>
        <main className="content"><p className="muted">{t.loading}</p></main>
      </>
    );
  }
  // A repeated click is ignored while the bridge is awaited; success leaves the page, a failure is shown by App
  const rerun = (withDecision: boolean) => {
    if (rerunBusy || !onRerun) return;
    setRerunBusy(true);
    Promise.resolve(onRerun(withDecision)).finally(() => setRerunBusy(false));
  };
  const open = () => {
    setOpening(true);
    setDraftAtOpen(readDraft(id)?.text ?? "");
    void openResume((i) => window.council.resumeOptions(i), id, openGuard).then((r) => {
      setOpening(false);
      if (r === null) return;
      if (r.ok) { setNotice(null); setResume((prev) => openedPanel(prev, r.value)); } else setNotice({ tone: "danger", text: r.error });
    });
  };
  if (status !== "running" && !feed) {
    const copy = () => {
      window.council.copyText(finalVersion(state)!.text).then(
        () => setNotice({ tone: "ok", text: t.copiedNotice(finalVersion(state)!.number) }),
        (e) => setNotice({ tone: "danger", text: message(e) }),
      );
    };
    const copyChoice = () => {
      const v = chosenVersion(state);
      if (!v) return;
      window.council.copyText(v.text).then(
        () => setNotice({ tone: "ok", text: t.copiedChoiceNotice(v.number) }),
        (e) => setNotice({ tone: "danger", text: message(e) }),
      );
    };
    const exportMd = () => {
      window.council.exportSession(id).then(
        (r) => setNotice(r ? { tone: "ok", text: t.fileSaved(r.path) } : null), // null — the owner closed the picker window
        (e) => setNotice({ tone: "danger", text: message(e) }),
      );
    };
    const panel = resume && (
      <ResumePanel key={resume.n} id={id} session={state.session} view={resume.view} message={draftAtOpen} onCancel={() => setResume(null)}
        onResumed={(texts, sent) => { const r = resumeAccepted(id, texts, sent); setResume(null); setFeed(r.feed); setDropped(r.dropped); }} />
    );
    return <Result id={id} state={state} status={status as ResultStatus} notice={notice} partial={item?.partial ?? null} when={item?.createdAt} onCopy={copy} onCopyChoice={copyChoice} onExport={exportMd} onFeed={() => setFeed(true)} onNew={onNew} onResume={open} resuming={opening} panel={panel}
      onRerun={() => rerun(false)} onContinue={() => rerun(true)} rerunBusy={rerunBusy} />;
  }
  const segment = state.resumes.length;
  const { confirming, stopping } = stopFlags(marks, segment);
  const stop = () => {
    dispatch({ type: "confirm", segment });
    // Success switches nothing: the screen moves to the result on the finish event.
    window.council.stopSession(id).catch((e) => { dispatch({ type: "failed", segment }); onError(message(e)); });
  };
  return (
    <Discussion
      id={id} drafts={drafts} pending={pending} onOwnerSent={onOwnerSent}
      state={state} status={status} live={live} expired={expired} confirming={confirming} stopping={stopping}
      onStopAsk={() => dispatch({ type: "ask", segment })} onStopCancel={() => dispatch({ type: "cancel", segment })} onStopConfirm={stop}
      partial={item?.partial ?? null} onResult={() => setFeed(false)} onResumeDraft={() => { setFeed(false); open(); }} dropped={dropped} onDroppedClose={() => setDropped(null)}
    />
  );
}
