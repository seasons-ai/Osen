import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { currentVersion, draftPhase, DRAFT_CONTEXT_LIMIT_REASON, INSUFFICIENT_ACTIVE_REASON_CODE, objectors, OWNER_ID, partialNote, readAcceptedDrafts, readSession, requestStop, sessionTotals, slotRoster, StopRejectedError, SYNTHESIZER_UNAVAILABLE_REASON, tokenUsage } from "@model-council/core";
import type { FinalStatus, OwnerWaitReason, Stance, StoredSession, StoredStatus } from "@model-council/core";
import { defineTool, ToolError } from "./context.ts";
import type { ToolContext } from "./context.ts";
import { mcpMessages } from "./messages.ts";

export const WAIT_CAP_SEC = 50;
// ponytail: the executor notices a stop request once per 500 ms and then aborts the participant's current call; 15 s with a margin
const STOP_WAIT_MS = 15000;

export interface StatusView {
  sessionId: string;
  status: StoredStatus;
  statusText: string;
  journal: { reason: "newer_version" | "corrupted"; lastEvent: number } | null;
  topic: string;
  materials: { names: string[]; chars: number };
  folder: { files: number; chars: number } | null;
  filesRead: { turn: number; participantId: string; name: string; chars: number; shown: number }[];
  round: number; maxRounds: number;
  turns: number;
  maxTotalTokens: number | null;
  tokens: { input: number; output: number; total: number; incomplete: boolean };
  participants: { id: string; name: string; state: "active" | "dropped"; lastStance: Stance | null; dropReason?: string; replaces?: string; replacedBy?: string }[];
  agreed: string[];
  openQuestions: number;
  ownerQuestions: { id: string; authorId: string; author: string; text: string; turn: number }[];
  waiting: { waitId: string; reasons: OwnerWaitReason[]; questionIds: string[]; deadline: string } | null;
  ownerMessages: { requestId: string; afterTurn: number; answered: string[] }[];
  solution: { version: number; authorId: string; text: string } | null;
  drafts: null | { phase: "drafting" | "finished"; synthesizerId: string; accepted: number; total: number; items: { draftId: string; participantId: string; attempts: number; chars: number; reasoning: string; text: string | null; error?: string }[] };
  reason?: string | null;
  reasonCode?: string | null;
  reasonText?: string;
  objectors?: { participantId: string; name: string; reasoning: string | null }[];
  ownerSelection?: { version: number; text: string; note: string | null; selectedAt: string; statusAtSelection: FinalStatus };
  stats?: { rounds: number; turns: number; drafts: number; durationMs: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
}

// the server's own explanations of reasons; the synthesizer identifier exists only for a reason from finish.reason
function ownReasonText(key: string, synthesizerId: string | null): string | undefined {
  const m = mcpMessages();
  if (key === SYNTHESIZER_UNAVAILABLE_REASON) return synthesizerId === null ? m.reasonSynthesizerBare : m.reasonSynthesizer(synthesizerId);
  if (key === INSUFFICIENT_ACTIVE_REASON_CODE) return m.reasonInsufficient;
  if (key === DRAFT_CONTEXT_LIMIT_REASON) return m.reasonDraftContext;
  return undefined;
}

// the journal was not read in full: for a session without a result the state is undefined, for the others a note is added to the result text
function withJournalNote(text: string, status: StoredStatus, partial: StoredSession["partial"]): string {
  if (partial === null) return text;
  const note = partialNote(partial);
  if (partial.reason === "newer_version" && (status === "running" || status === "interrupted")) return mcpMessages().journalUndefined(note);
  return `${text} · ${note}`;
}

const replaceLinks = (s?: { replaces?: string; replacedBy?: string }) => ({ ...(s?.replaces ? { replaces: s.replaces } : {}), ...(s?.replacedBy ? { replacedBy: s.replacedBy } : {}) });

export function statusView(stored: StoredSession, dataDir: string): StatusView {
  const { state, status } = stored;
  const session = state.session!;
  const name = (id: string) => session.participants.find((p) => p.id === id)?.name ?? id;
  const version = currentVersion(state);
  const usage = tokenUsage(state);
  const phase = draftPhase(state);
  const items = phase === "off" ? [] : readAcceptedDrafts(dataDir, stored.id, state);
  const view: StatusView = {
    sessionId: stored.id,
    status,
    statusText: withJournalNote(status === "running" && state.waiting !== null ? mcpMessages().statusRunningWaiting : status === "running" && phase === "drafting" ? mcpMessages().statusDrafting(items.length, slotRoster(session).length) : mcpMessages().statusText(status), status, stored.partial),
    journal: stored.partial === null ? null : { reason: stored.partial.reason, lastEvent: stored.partial.lastEvent },
    topic: session.topic,
    materials: { names: (session.materials ?? []).map((m) => m.name), chars: (session.materials ?? []).reduce((a, m) => a + m.chars, 0) },
    folder: session.workspace ? { files: session.workspace.files, chars: session.workspace.chars } : null,
    filesRead: state.turns.flatMap((t) => (t.filesRead ?? []).filter((f) => f.shown > 0).map((f) => ({ turn: t.turn, participantId: t.participantId, name: f.name, chars: f.chars, shown: f.shown }))),
    round: state.round,
    maxRounds: session.limits.maxRounds,
    turns: state.turns.length,
    maxTotalTokens: session.limits.maxTotalTokens ?? null,
    tokens: { input: usage.inputTokens, output: usage.outputTokens, total: usage.total, incomplete: usage.incomplete },
    participants: session.participants.map((p) => {
      const ps = state.participants.find((s) => s.id === p.id);
      return {
        id: p.id,
        name: p.name,
        state: ps?.status ?? "active",
        lastStance: state.turns.findLast((t) => t.participantId === p.id)?.stance ?? null,
        ...(ps?.dropReason ? { dropReason: ps.dropReason } : {}),
        ...replaceLinks(ps),
      };
    }),
    agreed: state.agreed,
    openQuestions: state.questions.filter((q) => q.status === "open").length,
    ownerQuestions: state.questions
      .filter((q) => q.to === OWNER_ID && q.status === "open")
      .map((q) => ({ id: q.id, authorId: q.from, author: name(q.from), text: q.text, turn: q.turn })),
    waiting: state.waiting && { waitId: state.waiting.waitId, reasons: state.waiting.reasons, questionIds: state.waiting.questionIds, deadline: state.waiting.deadline },
    ownerMessages: state.ownerMessages.map((m) => ({ requestId: m.requestId, afterTurn: m.afterTurn, answered: m.answers.map((a) => a.questionId) })),
    solution: version && { version: version.number, authorId: version.authorId, text: version.text },
    drafts: phase === "off" ? null : { phase, synthesizerId: session.drafts!.synthesizerId, accepted: items.length, total: slotRoster(session).length, items },
  };
  const sel = state.ownerSelection;
  if (sel !== null) {
    view.ownerSelection = {
      version: sel.version,
      text: state.versions.find((v) => v.number === sel.version)?.text ?? "",
      note: sel.note,
      selectedAt: sel.ts,
      statusAtSelection: sel.statusAtSelection,
    };
  }
  if (status === "running") return view;
  view.reason = state.finish?.reason ?? null;
  view.reasonCode = state.finish?.reasonCode ?? null;
  const codeText = view.reasonCode ? ownReasonText(view.reasonCode, null) : undefined;
  const reasonText = codeText ?? (view.reason ? ownReasonText(view.reason, session.drafts?.synthesizerId ?? "") : undefined);
  if (reasonText !== undefined) view.reasonText = reasonText;
  view.objectors = (state.finish?.objectors ?? objectors(state)).map((o) => ({ participantId: o.participantId, name: name(o.participantId), reasoning: o.reasoning }));
  const totals = sessionTotals(state);
  view.stats = { rounds: state.round, turns: totals.turns, drafts: totals.drafts, durationMs: totals.durationMs, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, costUsd: totals.costUsd };
  return view;
}

export function load(ctx: ToolContext, id: string): StoredSession {
  let s: StoredSession | null = null;
  try {
    s = readSession(ctx.dataDir, id);
  } catch {
    // an invalid identifier — the same "not found"
  }
  if (s === null) throw new ToolError(mcpMessages().sessionNotFound(id));
  return s;
}

// label of what wakes council_status with waitSec: status, turns, owner messages, questions and waiting
const signature = ({ status, state }: StoredSession): string => JSON.stringify([
  status, state.turns.length, state.ownerMessages.length,
  state.questions.map((q) => `${q.id}:${q.status}`),
  state.waiting && [state.waiting.waitId, state.waiting.reasons, state.waiting.questionIds],
  state.drafts.filter((d) => d.done).length, state.draftsFinished,
]);

const nap = (ctx: ToolContext, ms: number) => sleep(ms, undefined, { signal: ctx.shutdown }).catch(() => {});

export const councilStatus = defineTool({
  name: "council_status",
  get description() { return mcpMessages().statusDesc; },
  get inputSchema() {
    const m = mcpMessages();
    return {
      sessionId: z.string().describe(m.fSessionId),
      waitSec: z.number().optional().describe(m.statusFWaitSec(WAIT_CAP_SEC)),
    };
  },
  async run(ctx, { sessionId, waitSec }) {
    let cur = load(ctx, sessionId);
    const requested = waitSec ?? 0;
    if (!Number.isFinite(requested) || requested < 0) throw new ToolError(mcpMessages().waitSecInvalid);
    const applied = Math.min(requested, WAIT_CAP_SEC);
    let changed = false;
    if (cur.status === "running" && applied > 0) {
      const before = signature(cur);
      const until = Date.now() + applied * 1000;
      while (!ctx.shutdown.aborted && Date.now() < until) {
        await nap(ctx, Math.min(ctx.pollMs ?? 250, Math.max(until - Date.now(), 0)));
        cur = load(ctx, sessionId);
        if (signature(cur) !== before) { changed = true; break; }
      }
    }
    return { ...statusView(cur, ctx.dataDir), wait: { requestedSec: requested, appliedSec: applied, truncated: requested > WAIT_CAP_SEC, changed } };
  },
});

export const councilStop = defineTool({
  name: "council_stop",
  get description() { return mcpMessages().stopDesc; },
  get inputSchema() { return { sessionId: z.string().describe(mcpMessages().fSessionId) }; },
  async run(ctx, { sessionId }) {
    load(ctx, sessionId);
    try {
      requestStop(ctx.dataDir, sessionId);
    } catch (e) {
      if (!(e instanceof StopRejectedError)) throw e;
      if (e.reason === "not_found") throw new ToolError(mcpMessages().sessionNotFound(sessionId));
      const v = statusView(load(ctx, sessionId), ctx.dataDir);
      const m = mcpMessages();
      return { ...v, message: e.reason === "finished" ? m.stopFinished(v.statusText) : v.journal?.reason === "newer_version" ? m.stopNotDone(v.statusText) : m.stopInterrupted };
    }
    ctx.logger.info(`Stop requested for session ${sessionId}`);
    const until = Date.now() + STOP_WAIT_MS;
    let cur = load(ctx, sessionId);
    while (cur.status === "running" && !ctx.shutdown.aborted && Date.now() < until) {
      await nap(ctx, ctx.pollMs ?? 250);
      cur = load(ctx, sessionId);
    }
    const message = cur.status === "running" ? mcpMessages().stopRequestedPending : mcpMessages().stopDone;
    return { ...statusView(cur, ctx.dataDir), message };
  },
});
