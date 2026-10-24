import { protocolMessages } from "../messages/protocol.ts";
import type { FailureKind, FinalStatus, OwnerWaitReason, Participant, Session, SessionEvent, SessionReplacement, Stance, Usage } from "./schema.ts";
import { MAX_CALLS_PER_TURN } from "./folder.ts";
import { sessionUsage } from "./usage.ts";

export type SessionStatus = "running" | FinalStatus;

export interface SolutionVersion { number: number; text: string; authorId: string; turn: number }

export interface QuestionState {
  id: string; from: string; to: string; text: string; turn: number;
  status: "open" | "answered" | "unanswered" | "replaced"; // replaced — the addressee was replaced on resume, the question closed without an answer
  answer: string | null;
}

// A replaced participant has status "dropped"; dropReason stays the previous departure reason and is null if they were replaced by an active one.
export interface ParticipantState { id: string; status: "active" | "dropped"; dropReason: string | null; replaces?: string; replacedBy?: string }

export interface TurnRecord {
  turn: number; round: number; participantId: string;
  stance: Stance; normalized: boolean; reasoning: string;
  version: number;      // number of the current version after the turn
  newVersion: boolean;  // the turn created this version (amend)
  questions: { id: string; to: string; text: string }[];
  answers: { questionId: string; text: string }[];
  attempts: number; usage: Usage; durationMs: number;
  filesRead?: { name: string; chars: number; shown: number }[];
}

export interface FailedAttempt {
  turn: number; round: number; participantId: string;
  attempt: number; kind: FailureKind; message: string; raw: string | null;
  usage?: Usage;
}

export interface DraftFailure { attempt: number; participantId: string; kind: FailureKind; message: string; usage?: Usage }

export interface DraftDone {
  participantId: string; attempts: number; durationMs: number; usage: Usage;
  chars: number; sha256: string; reasoning: string;
  usageIncomplete?: true; // an attempt with unknown usage is not in usage
  filesRead?: { name: string; chars: number; shown: number }[];
}

export interface DraftSlot {
  draftId: string;
  participantId: string;   // executor of the last attempt
  started: number;         // number of draft_attempt_started events of the slot
  failures: DraftFailure[];
  done: DraftDone | null;
}

export interface SessionFinish {
  status: FinalStatus; version: number | null; agreed: string[];
  objectors: { participantId: string; reasoning: string | null }[];
  reason: string | null;
  reasonCode: string | null;
}

export interface OwnerMessage {
  id: string; text: string; afterTurn: number; requestId: string;
  answers: { questionId: string; text: string }[];
}

export interface ResumeMark {
  ts: string;          // time of the session_resumed event
  maxRounds: number;   // new shared round limit
  addedRounds: number; // rounds added: maxRounds − number of fully completed rounds at the time of resume
  beforeTurn: number;  // turn number from which the new segment starts
  ownerMessagesBefore: number; // owner messages written before this resume: tells the resume's message from earlier ones with the same afterTurn
  replacements?: { oldParticipantId: string; newParticipantId: string }[]; // participant replacements on this resume; no key if there were none
}

export interface OwnerSelection {
  version: number;
  statusAtSelection: FinalStatus;
  note: string | null;
  ts: string; // time of the owner selection event
}

export interface OwnerWaitState {
  waitId: string;
  reasons: OwnerWaitReason[];
  questionIds: string[];   // owner questions being held
  afterTurn: number;
  deadline: string;        // absolute deadline from the start event
  startedAt: string;       // ts of the owner_wait_started event
}

export interface SessionState {
  session: Session | null;        // null until session_created
  pid: number | null;
  status: SessionStatus;
  versions: SolutionVersion[];    // in ascending number order; version texts live only here
  agreed: string[];               // participants agreeing with the current version, in session participant order
  questions: QuestionState[];     // all session questions in order of appearance
  participants: ParticipantState[];
  turns: TurnRecord[];            // completed turns only
  failures: FailedAttempt[];
  currentTurn: { turn: number; round: number; participantId: string } | null; // started, not finished
  lastStarted: { turn: number; round: number; participantId: string } | null; // last turn_started; not reset
  round: number;                  // round of the last turn_started; 0 while there were no turns
  finish: SessionFinish | null;
  ownerMessages: OwnerMessage[];  // owner messages in order of application
  resumes: ResumeMark[];          // session resumes in event order
  ownerSelection: OwnerSelection | null; // last owner selection; null if there was none
  waiting: OwnerWaitState | null; // active owner wait; null if there is none
  waitCount: number;              // how many waits were started in the session (next id is w${waitCount + 1})
  appliedReleases: string[];      // requestIds from owner_wait_finished: protection against repeated application
  drafts: DraftSlot[];            // independent-draft slots in order of first appearance of draftId
  draftsFinished: boolean;        // a drafts_finished event happened
  lastSeq: number;                // seq of the last applied event; 0 for the empty state
  usageEvents: SessionEvent[];    // usage events in journal order: input of sessionUsage for tokenUsage and sessionTotals
}

export function initialState(): SessionState {
  return {
    session: null, pid: null, status: "running", versions: [], agreed: [], questions: [],
    participants: [], turns: [], failures: [], currentTurn: null, lastStarted: null, round: 0, finish: null, ownerMessages: [], resumes: [], ownerSelection: null, waiting: null, waitCount: 0, appliedReleases: [], drafts: [], draftsFinished: false, lastSeq: 0, usageEvents: [],
  };
}

export function currentVersion(state: SessionState): SolutionVersion | null {
  return state.versions[state.versions.length - 1] ?? null;
}

export function activeParticipantIds(state: SessionState): string[] {
  return state.participants.filter((p) => p.status === "active").map((p) => p.id);
}

export type DraftPhase = "off" | "drafting" | "finished";

export function draftPhase(state: SessionState): DraftPhase {
  if (!state.session?.drafts) return "off";
  return state.draftsFinished ? "finished" : "drafting";
}

// Current occupant of a seat (slot) of a participant: follows the replacement chain forward; an un-replaced participant returns its own id.
export function slotHolder(session: Pick<Session, "participants">, id: string): string {
  let cur = id;
  for (let next = session.participants.find((p) => p.replaces === cur); next; next = session.participants.find((p) => p.replaces === cur)) cur = next.id;
  return cur;
}

// Slot position in session.participants: the position of the original participant of the replacement chain.
function slotIndex(session: Pick<Session, "participants">, id: string): number {
  let i = session.participants.findIndex((p) => p.id === id);
  for (let r = session.participants[i]?.replaces; r !== undefined; r = session.participants[i]?.replaces) i = session.participants.findIndex((p) => p.id === r);
  return i;
}

// Current occupants (without replaced ones) in slot order.
export function slotRoster(session: Pick<Session, "participants">): Participant[] {
  return session.participants
    .filter((p) => !session.participants.some((q) => q.replaces === p.id))
    .map((p) => ({ p, at: slotIndex(session, p.id) }))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.p);
}

// Replacements on resume: a pure function; versions, turns, drafts and usage do not change; agreement is reset.
export function applyReplacements(state: SessionState, replacements: readonly SessionReplacement[]): SessionState {
  if (state.session === null || replacements.length === 0) return state;
  const olds = new Set(replacements.map((r) => r.oldParticipantId));
  const newOf = new Map(replacements.map((r) => [r.oldParticipantId, r.participant.id]));
  return {
    ...state,
    session: { ...state.session, participants: [...state.session.participants, ...replacements.map((r) => ({ ...r.participant, replaces: r.oldParticipantId }))] },
    participants: [
      ...state.participants.map((p) => (olds.has(p.id) ? { ...p, status: "dropped" as const, replacedBy: newOf.get(p.id)! } : p)),
      ...replacements.map((r) => ({ id: r.participant.id, status: "active" as const, dropReason: null, replaces: r.oldParticipantId })),
    ],
    agreed: [],
    questions: state.questions.map((q) => (q.status === "open" && olds.has(q.to) ? { ...q, status: "replaced" as const } : q)),
  };
}

export function draftIdOf(session: Session, participantId: string): string {
  return `d${slotIndex(session, participantId) + 1}`;
}

// How many model calls the drafts phase may still need (upper bound).
export function draftCallsLeft(state: SessionState): number {
  if (draftPhase(state) !== "drafting" || state.session === null) return 0;
  const session = state.session;
  return activeParticipantIds(state).reduce((sum, id) => {
    const slot = state.drafts.find((d) => d.draftId === draftIdOf(session, id));
    return sum + (slot?.done ? 0 : Math.max(0, MAX_CALLS_PER_TURN - (slot?.started ?? 0)));
  }, 0);
}

// Regular turn queue: the participant list, with drafts shifted so the synthesizer goes first.
export function turnOrder(session: Session): Participant[] {
  const roster = slotRoster(session);
  if (!session.drafts) return roster;
  const holder = slotHolder(session, session.drafts.synthesizerId);
  const i = Math.max(0, roster.findIndex((p) => p.id === holder));
  return [...roster.slice(i), ...roster.slice(0, i)];
}

export function maxCallsBound(participants: number, rounds: number, drafts: boolean): number {
  return participants * (rounds + (drafts ? 1 : 0)) * MAX_CALLS_PER_TURN;
}

export function openQuestionsFor(state: SessionState, participantId: string): QuestionState[] {
  return state.questions.filter((q) => q.status === "open" && q.to === participantId);
}

export const OWNER_ID = "owner";

export function openOwnerQuestions(state: SessionState): QuestionState[] {
  return state.questions.filter((q) => q.status === "open" && q.to === OWNER_ID);
}

export function isConsensus(state: SessionState): boolean {
  const active = activeParticipantIds(state);
  return (
    currentVersion(state) !== null &&
    active.length >= 2 &&
    active.every((id) => state.agreed.includes(id)) &&
    !state.questions.some((q) => q.status === "open")
  );
}

export function objectors(state: SessionState): { participantId: string; reasoning: string | null }[] {
  return activeParticipantIds(state)
    .filter((id) => !state.agreed.includes(id))
    .map((id) => ({
      participantId: id,
      reasoning: state.turns.findLast((t) => t.participantId === id)?.reasoning ?? null,
    }));
}

export interface ResumePoint {
  turn: number;            // turn number to continue from
  round: number;           // its round
  index: number;           // position of the participant in turnOrder(session) from which the queue continues in this round
  redo: boolean;           // true — a started but unfinished turn is repeated
  completedRounds: number; // fully completed rounds
}

export function resumePoint(state: SessionState): ResumePoint {
  if (state.session === null) throw new Error(protocolMessages().resumePointNoSession);
  const ls = state.lastStarted;
  if (ls === null) return { turn: 1, round: 1, index: 0, redo: false, completedRounds: 0 };
  const order = turnOrder(state.session).map((p) => p.id);
  const active = new Set(activeParticipantIds(state));
  const holder = slotHolder(state.session, ls.participantId);
  const pos = order.indexOf(holder);
  const unfinished = !state.turns.some((t) => t.turn === ls.turn);
  if (unfinished && active.has(ls.participantId)) {
    return { turn: ls.turn, round: ls.round, index: pos, redo: true, completedRounds: ls.round - 1 };
  }
  // a participant replaced with an active one mid-turn: the new one takes the slot in the same round, the interrupted turn is not repeated
  if (unfinished && holder !== ls.participantId && active.has(holder) && state.participants.find((p) => p.id === ls.participantId)?.dropReason === null) {
    return { turn: ls.turn + 1, round: ls.round, index: pos, redo: false, completedRounds: ls.round - 1 };
  }
  const next = order.findIndex((id, i) => i > pos && active.has(id));
  return next >= 0
    ? { turn: ls.turn + 1, round: ls.round, index: next, redo: false, completedRounds: ls.round - 1 }
    : { turn: ls.turn + 1, round: ls.round + 1, index: 0, redo: false, completedRounds: ls.round };
}

export interface SessionTotals {
  turns: number;                 // completed regular turns
  drafts: number;                // accepted drafts
  durationMs: number;            // sum of durationMs of completed turns and accepted drafts
  inputTokens: number | null;    // sum of reported values only; null — nobody reported
  outputTokens: number | null;
  costUsd: number | null;
  incomplete: boolean;           // there is a call without an outcome, or the metric is not reported by all usage records
  tokensFrom: string[];          // participants of records that reported input or output tokens
  costFrom: string[];            // participants of records that reported cost
  costIncomplete: boolean;       // cost is not reported by all records, or there is a call without an outcome
}

// Sums are taken from sessionUsage records: the same sum as in "History".
export function sessionTotals(state: SessionState): SessionTotals {
  const slots = state.drafts.filter((d) => d.done !== null);
  const { records, open } = sessionUsage(state.usageEvents);
  const sum = (pick: (u: Usage) => number | undefined): { total: number | null; partial: boolean } => {
    const known = records.map((r) => pick(r.usage)).filter((v): v is number => typeof v === "number");
    return { total: known.length ? known.reduce((a, b) => a + b, 0) : null, partial: known.length > 0 && known.length < records.length };
  };
  const i = sum((u) => u.inputTokens), o = sum((u) => u.outputTokens), c = sum((u) => u.costUsd);
  // participant order of the session, then the others (replacements) in order of appearance
  const order = state.session?.participants.map((p) => p.id) ?? [];
  const from = (has: (u: Usage) => boolean): string[] => {
    const ids = new Set(records.filter((r) => has(r.usage)).flatMap((r) => r.participantIds));
    return [...order.filter((id) => ids.has(id)), ...[...ids].filter((id) => !order.includes(id))];
  };
  return {
    turns: state.turns.length,
    drafts: slots.length,
    durationMs: state.turns.reduce((a, t) => a + t.durationMs, 0) + slots.reduce((a, d) => a + d.done!.durationMs, 0),
    inputTokens: i.total, outputTokens: o.total, costUsd: c.total,
    incomplete: i.partial || o.partial || c.partial || open.length > 0,
    tokensFrom: from((u) => u.inputTokens !== undefined || u.outputTokens !== undefined),
    costFrom: from((u) => u.costUsd !== undefined),
    // costUsd = null for records without cost: the tile does not show it, and the flag is not used then
    costIncomplete: c.partial || (c.total !== null && open.length > 0),
  };
}

export interface TokenUsage { inputTokens: number; outputTokens: number; total: number; incomplete: boolean }

// Calls running right now: the current turn, or in the drafts phase the latest draft attempt without an outcome
// (the engine runs drafts one at a time, so an older attempt without an outcome is lost, not running).
// currentTurn is set exactly while its turn_started is the one open entry of sessionUsage.
function runningCalls(state: SessionState): number {
  if (state.currentTurn !== null) return 1;
  if (draftPhase(state) !== "drafting") return 0;
  const ev = state.usageEvents;
  const i = ev.findLastIndex((e) => e.type === "draft_attempt_started");
  const s = ev[i];
  if (s?.type !== "draft_attempt_started") return 0;
  const ended = ev.slice(i + 1).some((e) => (e.type === "draft_completed" || e.type === "draft_attempt_failed" || e.type === "draft_files_served") && e.draftId === s.draftId);
  return ended ? 0 : 1;
}

// Sum of reported session tokens by sessionUsage records; cost is not included.
// Incomplete if there is a call without an outcome or a record without input and output tokens.
// live: calls running right now do not make the sum incomplete (a lost call, such as a gap in attempts, still does).
export function tokenUsage(state: SessionState, opts: { live?: boolean } = {}): TokenUsage {
  const { records, open } = sessionUsage(state.usageEvents);
  let inputTokens = 0, outputTokens = 0, incomplete = open.length > (opts.live ? runningCalls(state) : 0);
  for (const { usage: u } of records) {
    inputTokens += u.inputTokens ?? 0;
    outputTokens += u.outputTokens ?? 0;
    if (u.inputTokens === undefined && u.outputTokens === undefined) incomplete = true;
  }
  return { inputTokens, outputTokens, total: inputTokens + outputTokens, incomplete };
}
