import type { Language } from "@model-council/core/i18n";
import { session } from "./messages/session.ts";
import { currentVersion, objectors } from "@model-council/core/protocol";
import type { DraftDone, DraftFailure, FailedAttempt, FailureKind, OwnerMessage, ResumeMark, SessionFinish, SessionState, TurnRecord } from "@model-council/core/protocol";
import type { StoredStatus } from "@model-council/core";

export interface WaitExpiry { waitId: string; afterTurn: number; at: string }

export type TimelineItem =
  | { kind: "turn"; turn: TurnRecord }
  | { kind: "failure"; failure: FailedAttempt; retried: boolean } // after the attempt there was another attempt of the same turn, or the turn is finished
  | { kind: "dropped"; participantId: string; reason: string }
  | { kind: "owner"; message: OwnerMessage }
  | { kind: "resumed"; mark: ResumeMark } // before the first element with turn number >= mark.beforeTurn, and if there are none — at the end
  | { kind: "wait-expired"; mark: WaitExpiry }
  | { kind: "draft-phase" } // heading of the independent drafts section
  | { kind: "draft-failure"; draftId: string; failure: DraftFailure; retried: boolean } // after the attempt there was another slot attempt, or the slot is accepted
  | { kind: "draft"; draftId: string; done: DraftDone }
  | { kind: "draft-dropped"; participantId: string; reason: string }
  | { kind: "discussion-start"; synthesizerId: string };

export function failureLabel(kind: FailureKind, language?: Language): string {
  const t = session(language);
  return { call_error: t.failureCallError, timeout: t.failureTimeout, invalid_response: t.failureInvalidResponse }[kind];
}

export function timeline(state: SessionState): Exclude<TimelineItem, { kind: "wait-expired" }>[];
export function timeline(state: SessionState, expired: readonly WaitExpiry[] | undefined): TimelineItem[];
export function timeline(state: SessionState, expired: readonly WaitExpiry[] = []): TimelineItem[] {
  const numbers = [...new Set([...state.turns.map((t) => t.turn), ...state.failures.map((f) => f.turn)])].sort((a, b) => a - b);
  const items: TimelineItem[] = [];
  const drafts = state.session?.drafts;
  if (drafts) {
    items.push({ kind: "draft-phase" });
    const order = (id: string) => Number(id.slice(1));
    for (const slot of [...state.drafts].sort((a, b) => order(a.draftId) - order(b.draftId))) {
      [...slot.failures].sort((a, b) => a.attempt - b.attempt).forEach((failure) =>
        items.push({ kind: "draft-failure", draftId: slot.draftId, failure, retried: slot.done !== null || failure.attempt < slot.started }));
      if (slot.done) { items.push({ kind: "draft", draftId: slot.draftId, done: slot.done }); continue; }
      const p = state.participants.find((x) => x.id === slot.participantId);
      if (p?.status === "dropped" && !(p.replacedBy && p.dropReason === null)) items.push({ kind: "draft-dropped", participantId: p.id, reason: p.dropReason ?? session().reasonMissing });
    }
    if (state.draftsFinished) items.push({ kind: "discussion-start", synthesizerId: drafts.synthesizerId });
  }
  let mark = 0;
  let next = 0; // owner messages go in application order; afterTurn = N — after all elements of turn N
  // a message written at a resume (index >= ownerMessagesBefore) stands after that resume's divider
  const flushOwner = (before: number) => {
    for (; next < state.ownerMessages.length && state.ownerMessages[next]!.afterTurn < before && !(mark < state.resumes.length && next >= state.resumes[mark]!.ownerMessagesBefore); next++) items.push({ kind: "owner", message: state.ownerMessages[next]! });
  };
  let expiry = 0;
  // resume and deadline-expiry marks at one point of the feed go by event time; at equal time the resume goes first
  const flushMarks = (before: number) => {
    const batch: { at: number; item: TimelineItem }[] = [];
    for (; mark < state.resumes.length && state.resumes[mark]!.beforeTurn <= before; mark++) batch.push({ at: Date.parse(state.resumes[mark]!.ts), item: { kind: "resumed", mark: state.resumes[mark]! } });
    for (; expiry < expired.length && expired[expiry]!.afterTurn < before; expiry++) batch.push({ at: Date.parse(expired[expiry]!.at), item: { kind: "wait-expired", mark: expired[expiry]! } });
    items.push(...batch.sort((a, b) => a.at - b.at).map((x) => x.item));
  };
  for (const n of numbers) {
    flushOwner(n);
    flushMarks(n);
    flushOwner(n);
    const fails = state.failures.filter((f) => f.turn === n).sort((a, b) => a.attempt - b.attempt);
    const turn = state.turns.find((t) => t.turn === n);
    fails.forEach((failure, i) => items.push({ kind: "failure", failure, retried: turn !== undefined || i < fails.length - 1 }));
    if (turn) { items.push({ kind: "turn", turn }); continue; }
    const pid = fails[0]?.participantId;
    const p = state.participants.find((x) => x.id === pid);
    // dropout is shown after the participant's last turn among failures
    if (pid && p?.status === "dropped" && !(p.replacedBy && p.dropReason === null) && Math.max(...state.failures.filter((f) => f.participantId === pid).map((f) => f.turn)) === n) {
      items.push({ kind: "dropped", participantId: pid, reason: p.dropReason ?? session().reasonMissing });
    }
  }
  flushOwner(Infinity);
  flushMarks(Infinity);
  flushOwner(Infinity);
  return items;
}

// The participant's last finished turn — an objection to the current version.
export function isObjecting(state: SessionState, id: string): boolean {
  const last = state.turns.findLast((t) => t.participantId === id);
  return last?.stance === "object" && last.version === currentVersion(state)?.number;
}

// "Result" and export objectors: recorded at finish, without a finish — computed from the state;
// except "no consensus" — only those whose last turn objects to the current version.
export function objectingParticipants(state: SessionState, status: StoredStatus): SessionFinish["objectors"] {
  return (state.finish?.objectors ?? objectors(state)).filter((o) => status === "no_consensus" || isObjecting(state, o.participantId));
}
