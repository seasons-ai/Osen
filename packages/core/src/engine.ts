import { randomUUID } from "node:crypto";
import { sha256Of, verifyMaterials } from "./materials.ts";
import type { CollectedMaterial } from "./materials.ts";
import { engineMessages } from "./messages/engine.ts";
import { finishMessages } from "./messages/finish.ts";
import { ParticipantCallError } from "./participants/driver.ts";
import type { ParticipantDriver } from "./participants/driver.ts";
import { buildDraftPrompt, buildTurnPrompt, draftsChars } from "./protocol/context.ts";
import type { DraftText } from "./protocol/context.ts";
import { FOLDER_LIMITS, folderStats, MAX_CALLS_PER_TURN, serveFiles } from "./protocol/folder.ts";
import type { FolderFile, ServedFile } from "./protocol/folder.ts";
import { applyEvent, foldEvents } from "./protocol/fold.ts";
import { buildCorrectionPrompt, parseDraftResponse, parseFileRequest, parseTurnResponse, truncateRaw } from "./protocol/parse.ts";
import { DRAFT_CONTEXT_LIMIT_REASON, INSUFFICIENT_ACTIVE_REASON_CODE, MAX_TURN_TIMEOUT_SEC, OWNER_WAIT_DEFAULT_SEC, SessionSchema, sessionLanguage, SYNTHESIZER_UNAVAILABLE_REASON, TOKEN_CAP_REASON } from "./protocol/schema.ts";
import type { FailureKind, FinalStatus, Limits, OwnerWaitReason, OwnerWaitSettings, Session, SessionEvent, SessionReplacement, Usage } from "./protocol/schema.ts";
import { activeParticipantIds, applyReplacements, currentVersion, draftIdOf, draftPhase, initialState, isConsensus, objectors, openOwnerQuestions, openQuestionsFor, OWNER_ID, resumePoint, slotHolder, slotRoster, tokenUsage, turnOrder } from "./protocol/state.ts";
import type { SessionState } from "./protocol/state.ts";
import { getProcessLanguage } from "./i18n/process-language.ts";
import type { Language } from "./i18n/language.ts";

export class SessionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionInputError";
  }
}

export interface SessionInput {
  topic: string;
  framing: string;
  participants: { name: string; providerId: string; model: string; role: string | null }[];
  limits: Limits;
  origin: Session["origin"];
  templateId?: string | null;
  materials?: readonly CollectedMaterial[];
  workspace?: readonly FolderFile[];
  ownerWait?: OwnerWaitSettings;
  /** The presence of the field enables the independent drafts phase. */
  drafts?: { synthesizerId?: string };
  /** Language of the requests to models; by default the active language at the moment of creation. Recorded in the session and not changed. */
  language?: Language;
}

/** Turn timer delay: setTimeout does not accept more than 2^31-1 ms (old journals could record more than the limit). */
export const turnTimerMs = (sec: number): number => Math.min(sec * 1000, 2147483647);

export function createSession(
  input: SessionInput,
  options: { maxParticipants: number; id?: string; now?: () => Date },
): Session {
  const n = input.participants.length;
  const m = engineMessages();
  if (input.topic.trim().length === 0) throw new SessionInputError(m.topicRequired);
  if (n < 2) throw new SessionInputError(m.tooFewParticipants(n));
  if (n > options.maxParticipants) {
    throw new SessionInputError(m.tooManyParticipants(options.maxParticipants, n));
  }
  if (input.limits.turnTimeoutSec > MAX_TURN_TIMEOUT_SEC) throw new SessionInputError(m.turnTimeoutTooLong(MAX_TURN_TIMEOUT_SEC));
  const materials = input.materials ?? [];
  if (materials.length > 0) {
    const problems = verifyMaterials(materials, input.limits.materialsChars);
    if (problems.length > 0) throw new SessionInputError(problems.join("; "));
  }
  const workspace = input.workspace ?? [];
  const stats = folderStats(workspace);
  if (workspace.length > 0 && stats.chars > FOLDER_LIMITS.snapshotChars) {
    throw new SessionInputError(m.folderTooLarge(stats.chars, FOLDER_LIMITS.snapshotChars));
  }
  const w = input.ownerWait;
  const ownerWait = w && (w.pauseAfterRound === true || w.waitForOwner === true)
    ? {
        ...(w.pauseAfterRound === true ? { pauseAfterRound: true } : {}),
        ...(w.waitForOwner === true ? { waitForOwner: true } : {}),
        ...(w.timeoutSec !== undefined ? { timeoutSec: w.timeoutSec } : {}),
      }
    : undefined;
  let drafts: Session["drafts"];
  if (input.drafts) {
    const synthesizerId = input.drafts.synthesizerId ?? "p1";
    if (!/^p[1-9]\d*$/.test(synthesizerId) || Number(synthesizerId.slice(1)) > n) {
      throw new SessionInputError(m.synthesizerOutside(synthesizerId, n));
    }
    drafts = { enabled: true, synthesizerId };
  }
  const parsed = SessionSchema.safeParse({
    id: options.id ?? randomUUID(),
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    origin: input.origin,
    topic: input.topic,
    templateId: input.templateId ?? null,
    framing: input.framing,
    participants: input.participants.map((p, i) => ({ ...p, id: `p${i + 1}` })),
    ...(materials.length > 0
      ? { materials: materials.map((m) => ({ id: m.id, name: m.name, chars: m.chars, sha256: m.sha256 })) }
      : {}),
    ...(workspace.length > 0 ? { workspace: stats } : {}),
    limits: input.limits,
    ...(ownerWait ? { ownerWait } : {}),
    ...(drafts ? { drafts } : {}),
    language: input.language ?? getProcessLanguage(),
  });
  if (!parsed.success) throw new SessionInputError(parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data;
}

/** The ready set must match the session metadata. Throws SessionInputError. */
export function checkSessionMaterials(session: Session, materials: readonly CollectedMaterial[] | undefined): void {
  const set = materials ?? [];
  const meta = session.materials ?? [];
  const fail = (why: string): never => {
    throw new SessionInputError(engineMessages().materialsMismatch(why));
  };
  if (set.length !== meta.length) fail(engineMessages().materialsCount(meta.length, set.length));
  set.forEach((m, i) => {
    const e = meta[i]!;
    if (m.id !== e.id || m.name !== e.name || m.chars !== e.chars || m.sha256 !== e.sha256) {
      fail(engineMessages().materialDiffers(i + 1));
    }
  });
  if (set.length > 0) {
    const problems = verifyMaterials(set, session.limits.materialsChars);
    if (problems.length > 0) fail(problems.join("; "));
  }
}

/** The folder snapshot must match the session metadata. Throws SessionInputError. */
export function checkSessionWorkspace(session: Session, workspace: readonly FolderFile[] | undefined): void {
  const set = workspace ?? [];
  const meta = session.workspace;
  const fail = (why: string): never => {
    throw new SessionInputError(engineMessages().workspaceMismatch(why));
  };
  if (!meta) {
    if (set.length > 0) fail(engineMessages().workspaceNone(set.length));
    return;
  }
  const stats = folderStats(set);
  if (stats.files !== meta.files || stats.chars !== meta.chars) {
    fail(engineMessages().workspaceStats(meta.files, meta.chars, stats.files, stats.chars));
  }
}

export interface StreamChunk { participantId: string; turn: number; attempt: number; text: string }

export interface OwnerMessageRequest { requestId: string; text: string; questionId?: string }
/** Request to release the owner's wait: addressed to a specific wait. */
export interface OwnerReleaseRequest { requestId: string; releaseWaitId: string }
export type OwnerRequest = OwnerMessageRequest | OwnerReleaseRequest;
export function isOwnerRelease(r: OwnerRequest): r is OwnerReleaseRequest { return "releaseWaitId" in r; }

/** Queue of owner requests. The engine does not read files: the storage provides the implementation. */
export interface OwnerMessageSource {
  take(closing: boolean): OwnerRequest[]; // pending requests in acceptance order; closing — intake is closed until reopen()
  done(requestId: string): void;          // event written, the request can be removed
  reopen(): void;                         // accept requests again
}

/** Texts of accepted drafts. The engine neither reads nor writes files: the storage provides the implementation. */
export interface DraftStore {
  save(draftId: string, text: string): { chars: number; sha256: string }; // before the draft_completed event
  load(meta: { draftId: string; chars: number; sha256: string }): string; // text of an accepted draft from the previous segment
}

export interface RunSessionOptions {
  session: Session;
  drivers: Record<string, ParticipantDriver>;
  onEvent?: (event: SessionEvent, state: SessionState) => void;
  onChunk?: (chunk: StreamChunk) => void;
  signal?: AbortSignal;
  now?: () => Date;
  materials?: readonly CollectedMaterial[];
  workspace?: readonly FolderFile[];
  ownerMessages?: OwnerMessageSource;
  /** Draft text storage; memory by default. */
  draftStore?: DraftStore;
  /** Poll step of the queue and of the deadline during the owner's wait, ms. Default 200. */
  waitPollMs?: number;
  /** Sleep between wait steps; replaced in tests. By default a real timer, interruptible by a signal. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Resume: the full previous journal of this session and the new shared round limit. */
  resume?: {
    events: readonly SessionEvent[]; maxRounds: number; maxTotalTokens?: number | null;
    /** Replacements of departed or unavailable participants: the new one takes the old one's slot; the old one is no longer called. */
    replacements?: readonly SessionReplacement[];
    /** Owner message of the resume: written right after session_resumed, before the first turn or draft event. */
    ownerMessage?: { text: string; requestId: string };
  };
}

export interface SessionRun { events: SessionEvent[]; state: SessionState }

type CallOutcome =
  | { kind: "stopped" }
  | { kind: "failure"; failKind: "call_error" | "timeout"; message: string; retryable: boolean }
  | { kind: "text"; text: string; usage: Usage };

const USAGE_KEYS = ["inputTokens", "outputTokens", "costUsd"] as const;

type EventBody = SessionEvent extends infer E ? (E extends SessionEvent ? Omit<E, "seq" | "ts"> : never) : never;

export async function runSession(options: RunSessionOptions): Promise<SessionRun> {
  const { drivers, signal, resume } = options;
  const now = options.now ?? (() => new Date());
  for (const p of options.session.participants) {
    if (!drivers[p.id]) throw new SessionInputError(engineMessages().noDriver(p.id));
  }
  checkSessionMaterials(options.session, options.materials);
  checkSessionWorkspace(options.session, options.workspace);

  const events: SessionEvent[] = [];
  let state = resume ? foldEvents(resume.events) : initialState();
  if (resume && state.session?.id !== options.session.id) {
    throw new SessionInputError(engineMessages().foreignJournal);
  }
  // On resume the limits are taken from the fold: it has already substituted the new maxRounds.
  // let: after session_resumed with replacements the lineup is taken from the fold again.
  let session = state.session ?? options.session;
  if (resume?.replacements?.length) {
    // Drivers are needed by everyone who can be called after replacements; checked before the first event.
    for (const p of slotRoster(applyReplacements(state, resume.replacements).session!)) {
      if (!drivers[p.id]) throw new SessionInputError(engineMessages().noDriver(p.id));
    }
  }
  const memory = new Map<string, string>();
  const draftStore: DraftStore = options.draftStore ?? {
    save: (draftId, text) => (memory.set(draftId, text), { chars: text.length, sha256: sha256Of(text) }),
    load: ({ draftId }) => {
      const t = memory.get(draftId);
      if (t === undefined) throw new Error(engineMessages().noDraftText(draftId));
      return t;
    },
  };
  // Accepted drafts by draftId; before the first event on resume (a read failure exits without events).
  const accepted = new Map<string, DraftText>();
  for (const slot of state.drafts) {
    if (!slot.done) continue;
    const { participantId, chars, sha256, reasoning } = slot.done;
    accepted.set(slot.draftId, { draftId: slot.draftId, participantId, text: draftStore.load({ draftId: slot.draftId, chars, sha256 }), reasoning });
  }
  const draftTexts = (): DraftText[] =>
    slotRoster(session).map((p) => accepted.get(draftIdOf(session, p.id))).filter((d): d is DraftText => d !== undefined);
  let seq = resume ? state.lastSeq : 0;
  // The only place where events are created.
  const emit = (body: EventBody): void => {
    const event = { seq: ++seq, ts: now().toISOString(), ...body } as SessionEvent; // the only cast
    state = applyEvent(state, event);
    events.push(event);
    options.onEvent?.(event, state);
  };
  const finish = (status: FinalStatus, reason?: string, reasonCode?: string): SessionRun => {
    emit({
      type: "session_finished", status, version: currentVersion(state)?.number ?? null,
      agreed: state.agreed, objectors: objectors(state), ...(reason ? { reason } : {}),
      ...(reasonCode ? { reasonCode } : {}),
    });
    return { events, state };
  };

  async function callDriver(
    driver: ParticipantDriver, p: Session["participants"][number], prompt: string, turn: number, attempt: number,
    stream = true,
  ): Promise<CallOutcome> {
    const ctl = new AbortController();
    let timedOut = false;
    let over = false;
    const onOwnerAbort = () => ctl.abort();
    if (signal?.aborted) return { kind: "stopped" };
    signal?.addEventListener("abort", onOwnerAbort);
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, turnTimerMs(session.limits.turnTimeoutSec));
    const aborted = new Promise<"aborted">((resolve) => {
      ctl.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    try {
      const call = (async () => driver.call({
        participant: p, prompt, language: sessionLanguage(session), timeoutSec: session.limits.turnTimeoutSec, signal: ctl.signal,
        onChunk: (text) => {
          if (!stream || over || ctl.signal.aborted) return;
          options.onChunk?.({ participantId: p.id, turn, attempt, text });
        },
      }))(); // async wrapper: a synchronous throw from the driver also becomes a rejection
      call.catch(() => {}); // a promise that lost the race must not produce an unhandled rejection
      let result: Awaited<typeof call> | "aborted";
      try {
        result = await Promise.race([call, aborted]);
      } catch (err) {
        if (signal?.aborted) return { kind: "stopped" };
        if (timedOut) return { kind: "failure", failKind: "timeout", message: engineMessages().turnTimeout(session.limits.turnTimeoutSec), retryable: true };
        if (err instanceof ParticipantCallError) {
          return { kind: "failure", failKind: err.kind, message: err.message, retryable: err.retryable };
        }
        return { kind: "failure", failKind: "call_error", message: err instanceof Error ? err.message : String(err), retryable: true };
      }
      if (signal?.aborted) return { kind: "stopped" };
      if (result === "aborted" || timedOut) {
        return { kind: "failure", failKind: "timeout", message: engineMessages().turnTimeout(session.limits.turnTimeoutSec), retryable: true };
      }
      return { kind: "text", text: result.text, usage: result.usage };
    } finally {
      over = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOwnerAbort);
    }
  }

  const dropParticipant = (participantId: string, reason: string): void => {
    const open = openQuestionsFor(state, participantId);
    emit({ type: "participant_dropped", participantId, reason });
    for (const q of open) emit({ type: "question_closed", questionId: q.id, reason: "unanswered" });
  };

  const withDrafts = () => {
    const drafts = draftTexts();
    return drafts.length > 0 ? { drafts } : {};
  };

  // Returns true if the draft slot was interrupted by a stop.
  async function runDraft(p: Session["participants"][number]): Promise<boolean> {
    const driver = drivers[p.id]!;
    const startedAt = now().getTime();
    const draftId = draftIdOf(session, p.id);
    const slot = state.drafts.find((d) => d.draftId === draftId);
    let used = slot?.started ?? 0;
    // calls of the previous segments that answered with a file request: their usage goes into the slot's aggregate
    const servedBefore = state.usageEvents.filter((e) => e.type === "draft_files_served" && e.draftId === draftId);
    const lost = used > (slot?.failures.length ?? 0) + servedBefore.length; // previous-segment attempt with unknown usage
    const folder = options.workspace && options.workspace.length > 0 ? options.workspace : undefined;
    let base = buildDraftPrompt(session, p.id, options.materials, { folder });
    let prompt = base;
    let served: ServedFile[] | null = null;
    let retryUsed = false;
    let correctionUsed = false;
    const usage: Usage = {};
    const addUsage = (u: Usage) => {
      for (const k of USAGE_KEYS) if (u[k] !== undefined) usage[k] = (usage[k] ?? 0) + u[k];
    };
    for (const f of slot?.failures ?? []) if (f.usage) addUsage(f.usage);
    for (const e of servedBefore) if (e.type === "draft_files_served") addUsage(e.usage);
    const drop = (reason: string) => dropParticipant(p.id, reason);
    if (used >= MAX_CALLS_PER_TURN) return drop(engineMessages().dropDraftCalls), false;
    const failed = (kind: FailureKind, message: string, raw?: string, used2?: Usage) =>
      emit({
        type: "draft_attempt_failed", draftId, participantId: p.id, attempt: used, kind, message,
        ...(raw !== undefined ? { raw } : {}),
        ...(used2 && USAGE_KEYS.some((k) => used2[k] !== undefined) ? { usage: used2 } : {}),
      });

    for (;;) {
      used += 1;
      emit({ type: "draft_attempt_started", draftId, participantId: p.id, attempt: used });
      const out = await callDriver(driver, p, prompt, 0, used, false);
      if (out.kind === "stopped") return true;
      if (out.kind === "failure") {
        failed(out.failKind, out.message);
        if (!out.retryable) return drop(engineMessages().dropNonRetryable(out.message)), false;
        if (retryUsed) return drop(engineMessages().dropRetryFailed(out.message)), false;
        if (used >= MAX_CALLS_PER_TURN) return drop(engineMessages().dropDraftCallsWith(out.message)), false;
        retryUsed = true;
        continue;
      }
      addUsage(out.usage);
      if (folder && served === null && used < MAX_CALLS_PER_TURN) {
        const names = parseFileRequest(out.text);
        if (names !== null) {
          emit({ type: "draft_files_served", draftId, participantId: p.id, attempt: used, usage: out.usage });
          served = serveFiles(folder, names, sessionLanguage(session));
          base = buildDraftPrompt(session, p.id, options.materials, { folder, served });
          prompt = base;
          continue;
        }
      }
      const parsed = parseDraftResponse(out.text, sessionLanguage(session));
      if (!parsed.ok) {
        const message = parsed.errors.join("; ");
        failed("invalid_response", message, truncateRaw(out.text, sessionLanguage(session)), out.usage);
        if (correctionUsed) return drop(engineMessages().dropInvalidAfterCorrection(message)), false;
        if (used >= MAX_CALLS_PER_TURN) return drop(engineMessages().dropDraftCallsWith(message)), false;
        correctionUsed = true;
        prompt = buildCorrectionPrompt(base, out.text, parsed.errors, sessionLanguage(session));
        continue;
      }
      const { solution, reasoning } = parsed.draft;
      const meta = draftStore.save(draftId, solution);
      emit({
        type: "draft_completed", draftId, participantId: p.id, attempts: used,
        durationMs: Math.max(0, now().getTime() - startedAt), usage, chars: meta.chars, sha256: meta.sha256, reasoning,
        ...(lost ? { usageIncomplete: true as const } : {}),
        ...(served ? { filesRead: served.map(({ name, chars, shown }) => ({ name, chars, shown })) } : {}),
      });
      accepted.set(draftId, { draftId, participantId: p.id, text: solution, reasoning });
      return false;
    }
  }

  // Returns true if the turn was interrupted by a stop.
  async function runTurn(p: Session["participants"][number], turn: number, round: number): Promise<boolean> {
    const driver = drivers[p.id]!;
    const startedAt = now().getTime();
    emit({ type: "turn_started", turn, round, participantId: p.id });
    const folder = options.workspace && options.workspace.length > 0 ? options.workspace : undefined;
    let base = buildTurnPrompt(state, p.id, options.materials, { folder, ...withDrafts() });
    let prompt = base;
    let served: ServedFile[] | null = null;
    let attempt = 0;
    let retryUsed = false;
    let correctionUsed = false;
    const usage: Usage = {};
    const addUsage = (u: Usage) => {
      for (const k of USAGE_KEYS) if (u[k] !== undefined) usage[k] = (usage[k] ?? 0) + u[k];
    };
    const drop = (reason: string) => dropParticipant(p.id, reason);
    const failed = (kind: FailureKind, message: string, raw?: string, used?: Usage) =>
      emit({
        type: "turn_failed", turn, round, participantId: p.id, attempt, kind, message,
        ...(raw !== undefined ? { raw } : {}),
        ...(used && USAGE_KEYS.some((k) => used[k] !== undefined) ? { usage: used } : {}),
      });

    for (;;) {
      attempt += 1;
      const out = await callDriver(driver, p, prompt, turn, attempt);
      if (out.kind === "stopped") return true;
      if (out.kind === "failure") {
        failed(out.failKind, out.message);
        if (!out.retryable) return drop(engineMessages().dropNonRetryable(out.message)), false;
        if (retryUsed) return drop(engineMessages().dropRetryFailed(out.message)), false;
        if (attempt >= MAX_CALLS_PER_TURN) return drop(engineMessages().dropTurnCallsWith(out.message)), false;
        retryUsed = true;
        continue;
      }
      addUsage(out.usage);
      if (folder && served === null && attempt < MAX_CALLS_PER_TURN) {
        const names = parseFileRequest(out.text);
        if (names !== null) {
          emit({ type: "turn_files_served", turn, round, participantId: p.id, attempt, usage: out.usage });
          served = serveFiles(folder, names, sessionLanguage(session));
          base = buildTurnPrompt(state, p.id, options.materials, { folder, served, ...withDrafts() });
          prompt = base;
          continue;
        }
      }
      const parsed = parseTurnResponse(out.text, state, p.id);
      if (!parsed.ok) {
        const message = parsed.errors.join("; ");
        failed("invalid_response", message, truncateRaw(out.text, sessionLanguage(session)), out.usage);
        if (correctionUsed) return drop(engineMessages().dropInvalidAfterCorrection(message)), false;
        if (attempt >= MAX_CALLS_PER_TURN) return drop(engineMessages().dropTurnCallsWith(message)), false;
        correctionUsed = true;
        prompt = buildCorrectionPrompt(base, out.text, parsed.errors, sessionLanguage(session));
        continue;
      }
      const t = parsed.turn;
      const amend = t.stance === "amend" && t.solution !== null;
      const cur = currentVersion(state)?.number ?? null;
      const version = amend ? (cur ?? 0) + 1 : cur;
      if (version === null) throw new Error(engineMessages().invariantNoVersion);
      let next = state.questions.length;
      emit({
        type: "turn_completed", turn, round, participantId: p.id,
        stance: t.stance, normalized: t.normalized, reasoning: t.reasoning,
        solution: amend ? t.solution : null,
        version,
        questions: t.questions.map((q) => ({ id: `q${++next}`, to: q.to, text: q.text })),
        answers: t.answers,
        ...(served ? { filesRead: served.map(({ name, chars, shown }) => ({ name, chars, shown })) } : {}),
        attempts: attempt, usage, durationMs: Math.max(0, now().getTime() - startedAt),
      });
      for (const a of t.answers) emit({ type: "question_closed", questionId: a.questionId, reason: "answered" });
      return false;
    }
  }

  if (resume) {
    emit({
      type: "session_resumed", pid: process.pid, maxRounds: resume.maxRounds,
      ...(resume.maxTotalTokens !== undefined ? { maxTotalTokens: resume.maxTotalTokens } : {}),
      ...(resume.replacements?.length ? { replacements: [...resume.replacements] } : {}),
    });
    session = state.session ?? session; // lineup after replacements
  }
  else emit({ type: "session_created", session, pid: process.pid });
  const point = resume ? resumePoint(state) : { turn: 1, round: 1, index: 0 };
  let turn = point.turn - 1;
  if (resume?.ownerMessage) {
    emit({ type: "owner_message", id: `o${state.ownerMessages.length + 1}`, text: resume.ownerMessage.text, afterTurn: turn, requestId: resume.ownerMessage.requestId });
  }
  // A reply is applied once: a repeated reply is recognized by requestId in the state.
  const closeHeld = (ids: readonly string[]): void => {
    for (const id of ids) {
      if (openOwnerQuestions(state).some((q) => q.id === id)) emit({ type: "question_closed", questionId: id, reason: "unanswered" });
    }
  };
  const applyOwnerMessages = (closing: boolean): void => {
    const source = options.ownerMessages;
    if (!source) return;
    for (const m of source.take(closing)) {
      if (isOwnerRelease(m)) {
        const w = state.waiting;
        if (w && w.waitId === m.releaseWaitId && !state.appliedReleases.includes(m.requestId)) {
          closeHeld(w.questionIds);
          emit({ type: "owner_wait_finished", waitId: w.waitId, reason: "continued", requestId: m.requestId });
        }
        source.done(m.requestId);
        continue;
      }
      if (!state.ownerMessages.some((o) => o.requestId === m.requestId)) {
        const q = m.questionId === undefined ? undefined : state.questions.find((x) => x.id === m.questionId);
        const answers = q && q.to === OWNER_ID && q.status === "open" ? [{ questionId: q.id, text: m.text }] : null;
        emit({
          type: "owner_message", id: `o${state.ownerMessages.length + 1}`, text: m.text, afterTurn: turn, requestId: m.requestId,
          ...(answers ? { answers } : {}),
        });
        if (answers) {
          const qid = answers[0]!.questionId;
          emit({ type: "question_closed", questionId: qid, reason: "answered" });
          const w = state.waiting;
          if (w && w.questionIds.includes(qid)) {
            const questionIds = w.questionIds.filter((x) => x !== qid);
            const reasons = questionIds.length > 0 ? w.reasons : w.reasons.filter((r) => r !== "owner_question");
            if (reasons.length === 0) emit({ type: "owner_wait_finished", waitId: w.waitId, reason: "answered" });
            else emit({ type: "owner_wait_updated", waitId: w.waitId, reasons, questionIds });
          }
        }
      }
      source.done(m.requestId);
    }
  };
  const stopped = (): SessionRun => (applyOwnerMessages(true), finish("stopped"));
  const sleep = options.sleep ?? ((ms: number, sig?: AbortSignal) => new Promise<void>((resolve) => {
    if (sig?.aborted) return resolve();
    const done = () => { clearTimeout(timer); sig?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    sig?.addEventListener("abort", done);
  }));
  // Owner wait between turns. Returns true if it was interrupted by a stop.
  const waitForOwner = async (): Promise<boolean> => {
    while (state.waiting) {
      const w = state.waiting;
      if (signal?.aborted) {
        applyOwnerMessages(true);
        if (state.waiting) emit({ type: "owner_wait_finished", waitId: w.waitId, reason: "stopped" });
        return true;
      }
      applyOwnerMessages(false);
      if (state.waiting && now().getTime() >= new Date(state.waiting.deadline).getTime()) {
        closeHeld(state.waiting.questionIds);
        emit({ type: "owner_wait_finished", waitId: state.waiting.waitId, reason: "expired" });
      }
      if (state.waiting) await sleep(options.waitPollMs ?? 200, signal);
    }
    return false;
  };
  if (resume) {
    if (activeParticipantIds(state).length < 2) {
      applyOwnerMessages(true);
      return finish("failed", finishMessages().insufficientActive, INSUFFICIENT_ACTIVE_REASON_CODE);
    }
    if (isConsensus(state)) {
      applyOwnerMessages(true);
      if (isConsensus(state)) return finish("consensus");
      options.ownerMessages?.reopen();
    }
  }
  if (resume && state.waiting && await waitForOwner()) return finish("stopped");
  if (draftPhase(state) === "drafting") {
    const verdict = (): SessionRun | null => {
      const synth = session.drafts!.synthesizerId;
      const fail = (status: FinalStatus, reason: string, reasonCode?: string): SessionRun => (applyOwnerMessages(true), finish(status, reason, reasonCode));
      const active = activeParticipantIds(state);
      if (!active.includes(synth)) return fail("failed", SYNTHESIZER_UNAVAILABLE_REASON);
      if (active.length < 2) return fail("failed", finishMessages().insufficientActive, INSUFFICIENT_ACTIVE_REASON_CODE);
      if (draftsChars(draftTexts()) > session.limits.contextChars) return fail("failed", DRAFT_CONTEXT_LIMIT_REASON);
      const cap = state.session!.limits.maxTotalTokens;
      if (cap !== undefined && tokenUsage(state).total >= cap) return fail("stopped", TOKEN_CAP_REASON);
      return null;
    };
    for (const p of slotRoster(session)) {
      if (signal?.aborted) return stopped();
      const v = verdict();
      if (v) return v;
      if (!activeParticipantIds(state).includes(p.id)) continue;
      const slot = state.drafts.find((d) => d.draftId === draftIdOf(session, p.id));
      if (slot?.done) continue;
      // A slot exhausted by its predecessor: the replacement is not called and does not depart; the phase continues without this draft.
      if (slot && slot.started >= MAX_CALLS_PER_TURN && slot.participantId !== p.id) continue;
      if (await runDraft(p)) return stopped();
      applyOwnerMessages(false);
    }
    const v = verdict();
    if (v) return v;
    emit({ type: "drafts_finished" });
    applyOwnerMessages(false);
  }
  // While version 1 does not exist, a departed synthesizer ends the session: no other one is chosen.
  const synthLost = (): SessionRun | null => {
    if (!session.drafts || state.versions.length > 0) return null;
    if (activeParticipantIds(state).includes(session.drafts.synthesizerId)) return null;
    applyOwnerMessages(true);
    return finish("failed", SYNTHESIZER_UNAVAILABLE_REASON);
  };
  const lostBefore = synthLost();
  if (lostBefore) return lostBefore;
  const order = turnOrder(session);
  for (let round = point.round; round <= state.session!.limits.maxRounds; round++) {
    for (const [i, p] of order.entries()) {
      if (round === point.round && i < point.index) continue;
      if (signal?.aborted) return stopped();
      if (!activeParticipantIds(state).includes(p.id)) continue;
      for (const q of openOwnerQuestions(state)) {
        // the slot of the departed author is taken by the replacement: the question closes with its turn
        if (slotHolder(session, q.from) === p.id) emit({ type: "question_closed", questionId: q.id, reason: "unanswered" });
      }
      turn += 1;
      if (await runTurn(p, turn, round)) return stopped();
      applyOwnerMessages(false);
      const lostNow = synthLost();
      if (lostNow) return lostNow;
      if (activeParticipantIds(state).length < 2) {
        applyOwnerMessages(true);
        return finish("failed", finishMessages().insufficientActive, INSUFFICIENT_ACTIVE_REASON_CODE);
      }
      if (isConsensus(state)) {
        applyOwnerMessages(true);
        if (isConsensus(state)) return finish("consensus");
        options.ownerMessages?.reopen();
      }
      // The cap is taken from the state: on resume the fold has already applied the new value.
      const cap = state.session!.limits.maxTotalTokens;
      if (cap !== undefined && tokenUsage(state).total >= cap) {
        applyOwnerMessages(true);
        return finish("stopped", TOKEN_CAP_REASON);
      }
      const cfg = state.session!.ownerWait;
      const moreInRound = order.slice(i + 1).some((x) => activeParticipantIds(state).includes(x.id));
      const moreRounds = round < state.session!.limits.maxRounds;
      if (moreInRound || moreRounds) {
        const held = cfg?.waitForOwner ? openOwnerQuestions(state).map((q) => q.id) : [];
        const reasons: OwnerWaitReason[] = [];
        if (cfg?.pauseAfterRound && !moreInRound && moreRounds) reasons.push("round_boundary");
        if (held.length > 0) reasons.push("owner_question");
        if (reasons.length > 0) {
          emit({
            type: "owner_wait_started", waitId: `w${state.waitCount + 1}`, reasons, questionIds: held, afterTurn: turn,
            deadline: new Date(now().getTime() + (cfg?.timeoutSec ?? OWNER_WAIT_DEFAULT_SEC) * 1000).toISOString(),
          });
          if (await waitForOwner()) return finish("stopped");
        }
      }
    }
  }
  applyOwnerMessages(true);
  return finish("no_consensus");
}
