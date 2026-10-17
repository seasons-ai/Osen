import type { Limits, SessionEvent, SessionResumedEvent } from "./schema.ts";
import { OWNER_ID, applyReplacements, initialState, resumePoint } from "./state.ts";
import type { DraftSlot, SessionState } from "./state.ts";

// Events from which sessionUsage counts the session usage.
const USAGE_EVENTS = new Set<SessionEvent["type"]>([
  "session_created", "session_resumed", "participant_dropped", "turn_started", "turn_completed", "turn_failed", "turn_files_served",
  "draft_attempt_started", "draft_attempt_failed", "draft_files_served", "draft_completed",
]);

export function applyEvent(state: SessionState, event: SessionEvent): SessionState {
  const next = apply(state, event);
  return { ...next, lastSeq: event.seq, ...(USAGE_EVENTS.has(event.type) ? { usageEvents: [...next.usageEvents, event] } : {}) };
}

export function foldEvents(events: readonly SessionEvent[]): SessionState {
  return events.reduce(applyEvent, initialState());
}

function resumedLimits(limits: Limits, event: SessionResumedEvent): Limits {
  const { maxTotalTokens: _old, ...rest } = limits;
  const cap = event.maxTotalTokens === undefined ? _old : event.maxTotalTokens;
  return { ...rest, maxRounds: event.maxRounds, ...(cap != null ? { maxTotalTokens: cap } : {}) };
}

function withSlot(state: SessionState, draftId: string, participantId: string, change: (slot: DraftSlot) => DraftSlot): SessionState {
  const has = state.drafts.some((d) => d.draftId === draftId);
  const base = has ? state.drafts : [...state.drafts, { draftId, participantId, started: 0, failures: [], done: null }];
  return { ...state, drafts: base.map((d) => (d.draftId === draftId ? change(d) : d)) };
}

function apply(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case "session_created":
      return {
        ...state,
        session: event.session,
        pid: event.pid,
        participants: event.session.participants.map((p) => ({ id: p.id, status: "active", dropReason: null })),
      };

    case "session_resumed": {
      const prev = event.replacements ? applyReplacements(state, event.replacements) : state;
      const point = prev.session ? resumePoint(prev) : null;
      return {
        ...prev,
        resumes: point
          ? [...prev.resumes, { ts: event.ts, maxRounds: event.maxRounds, addedRounds: event.maxRounds - point.completedRounds, beforeTurn: point.turn, ...(event.replacements ? { replacements: event.replacements.map((r) => ({ oldParticipantId: r.oldParticipantId, newParticipantId: r.participant.id })) } : {}) }]
          : prev.resumes,
        status: "running",
        finish: null,
        pid: event.pid,
        currentTurn: null,
        session: prev.session && { ...prev.session, limits: resumedLimits(prev.session.limits, event) },
      };
    }

    case "turn_started":
      return {
        ...state,
        currentTurn: { turn: event.turn, round: event.round, participantId: event.participantId },
        lastStarted: { turn: event.turn, round: event.round, participantId: event.participantId },
        round: event.round,
      };

    case "turn_completed": {
      const id = event.participantId;
      const order = state.session?.participants.map((p) => p.id) ?? [];
      let versions = state.versions;
      let agreed = state.agreed;
      if (event.stance === "amend") {
        versions = [...versions, { number: event.version, text: event.solution ?? "", authorId: id, turn: event.turn }];
        agreed = [id];
      } else if (event.stance === "agree") {
        const set = new Set([...agreed, id]);
        agreed = [...order.filter((p) => set.has(p)), ...[...set].filter((p) => !order.includes(p))];
      } else {
        agreed = agreed.filter((p) => p !== id);
      }
      const answers = new Map(event.answers.map((a) => [a.questionId, a.text]));
      const questions = [
        ...state.questions,
        ...event.questions.map((q) => ({
          id: q.id, from: id, to: q.to, text: q.text, turn: event.turn,
          status: "open" as const, answer: null as string | null,
        })),
      ].map((q) => (answers.has(q.id) ? { ...q, answer: answers.get(q.id)! } : q));
      return {
        ...state,
        turns: [
          ...state.turns,
          {
            turn: event.turn, round: event.round, participantId: id, stance: event.stance,
            normalized: event.normalized, reasoning: event.reasoning, version: event.version,
            newVersion: event.stance === "amend",
            questions: event.questions.map((q) => ({ ...q })),
            answers: event.answers.map((a) => ({ ...a })),
            attempts: event.attempts, usage: { ...event.usage }, durationMs: event.durationMs,
            ...(event.filesRead ? { filesRead: event.filesRead.map((f) => ({ ...f })) } : {}),
          },
        ],
        currentTurn: null,
        versions,
        agreed,
        questions,
      };
    }

    case "turn_failed":
      return {
        ...state,
        failures: [
          ...state.failures,
          {
            turn: event.turn, round: event.round, participantId: event.participantId,
            attempt: event.attempt, kind: event.kind, message: event.message, raw: event.raw ?? null,
            ...(event.usage ? { usage: event.usage } : {}),
          },
        ],
      };

    case "turn_files_served":
    case "draft_files_served":
      return state;

    case "participant_dropped":
      return {
        ...state,
        participants: state.participants.map((p) =>
          p.id === event.participantId ? { ...p, status: "dropped", dropReason: event.reason } : p),
        agreed: state.agreed.filter((p) => p !== event.participantId),
        currentTurn: state.currentTurn?.participantId === event.participantId ? null : state.currentTurn,
      };

    case "question_closed": {
      const toOwner = state.questions.some((q) => q.id === event.questionId && q.to === OWNER_ID);
      return {
        ...state,
        questions: state.questions.map((q) => (q.id === event.questionId ? { ...q, status: event.reason } : q)),
        agreed: toOwner ? [] : state.agreed,
      };
    }

    case "owner_message": {
      const answers = event.answers ?? [];
      return {
        ...state,
        ownerMessages: [
          ...state.ownerMessages,
          { id: event.id, text: event.text, afterTurn: event.afterTurn, requestId: event.requestId, answers: answers.map((a) => ({ ...a })) },
        ],
        questions: state.questions.map((q) => {
          const a = q.to === OWNER_ID ? answers.find((x) => x.questionId === q.id) : undefined;
          return a ? { ...q, answer: a.text } : q;
        }),
        agreed: [],
      };
    }

    case "owner_selected_version":
      return { ...state, ownerSelection: { version: event.version, statusAtSelection: event.statusAtSelection, note: event.note ?? null, ts: event.ts } };

    case "owner_wait_started":
      return {
        ...state,
        waiting: { waitId: event.waitId, reasons: event.reasons, questionIds: event.questionIds, afterTurn: event.afterTurn, deadline: event.deadline, startedAt: event.ts },
        waitCount: state.waitCount + 1,
      };

    case "owner_wait_updated":
      return state.waiting?.waitId === event.waitId
        ? { ...state, waiting: { ...state.waiting, reasons: event.reasons, questionIds: event.questionIds } }
        : state;

    case "owner_wait_finished":
      return {
        ...state,
        waiting: state.waiting?.waitId === event.waitId ? null : state.waiting,
        appliedReleases: event.requestId === undefined ? state.appliedReleases : [...state.appliedReleases, event.requestId],
      };

    case "draft_attempt_started":
      return withSlot(state, event.draftId, event.participantId, (d) => ({ ...d, started: d.started + 1, participantId: event.participantId }));

    case "draft_attempt_failed":
      return withSlot(state, event.draftId, event.participantId, (d) => ({
        ...d,
        failures: [...d.failures, {
          attempt: event.attempt, participantId: event.participantId, kind: event.kind, message: event.message,
          ...(event.usage ? { usage: event.usage } : {}),
        }],
      }));

    case "draft_completed":
      return withSlot(state, event.draftId, event.participantId, (d) => ({
        ...d,
        participantId: event.participantId,
        done: {
          participantId: event.participantId, attempts: event.attempts, durationMs: event.durationMs, usage: { ...event.usage },
          chars: event.chars, sha256: event.sha256, reasoning: event.reasoning,
          ...(event.usageIncomplete ? { usageIncomplete: true as const } : {}),
          ...(event.filesRead ? { filesRead: event.filesRead.map((x) => ({ ...x })) } : {}),
        },
      }));

    case "drafts_finished":
      return { ...state, draftsFinished: true };

    case "session_finished":
      return {
        ...state,
        waiting: null,
        status: event.status,
        finish: {
          status: event.status, version: event.version, agreed: event.agreed,
          objectors: event.objectors, reason: event.reason ?? null, reasonCode: event.reasonCode ?? null,
        },
        currentTurn: null,
      };
  }
}
