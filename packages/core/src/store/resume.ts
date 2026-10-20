import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { runSession } from "../engine.ts";
import type { OwnerMessageRequest, RunSessionOptions, SessionRun } from "../engine.ts";
import { createCliDriver } from "../cli-agents/driver.ts";
import { DEFAULT_MODEL } from "../cli-agents/types.ts";
import { createHttpDriver } from "../http/driver.ts";
import type { CollectedMaterial } from "../materials.ts";
import { ParticipantCallError } from "../participants/driver.ts";
import type { ParticipantDriver } from "../participants/driver.ts";
import { createScriptedDriver, readScenario } from "../participants/scripted.ts";
import { folderStats } from "../protocol/folder.ts";
import type { FolderFile } from "../protocol/folder.ts";
import { INSUFFICIENT_ACTIVE_REASON_CODE, ReplacementSchema } from "../protocol/schema.ts";
import type { Participant, Session, SessionEvent, SessionReplacement } from "../protocol/schema.ts";
import { activeParticipantIds, applyReplacements, draftCallsLeft, draftIdOf, resumePoint, slotHolder, slotRoster, tokenUsage } from "../protocol/state.ts";
import type { ResumePoint, SessionState } from "../protocol/state.ts";
import type { Registry } from "../registry/config.ts";
import { inspectProvider } from "../registry/providers.ts";
import type { InspectDeps, ProviderInspection } from "../registry/providers.ts";
import { DraftSnapshotError, readDraftSnapshot, storedDraftStore } from "./draft-snapshots.ts";
import { envFilePath } from "./env.ts";
import { appendEvent, eventsPath, materialPath, readEvents, readWorkspaceSnapshot, resumeLockPath, stopRequestPath } from "./journal.ts";
import type { Logger } from "./log.ts";
import { discardOwnerRequests, openOwnerQueue } from "./owner-messages.ts";
import { tryPidLock } from "./pid-lock.ts";
import { watchStopRequest } from "./run.ts";
import { isProcessAlive, markRunningHere, partialNote, readSession, unmarkRunningHere } from "./sessions.ts";
import { resumeMessages } from "../messages/resume.ts";

export type ResumeRejection =
  | "not_found" | "consensus" | "failed" | "running" | "too_few_active" | "corrupted" | "newer_version"
  | "no_rounds_left" | "bad_rounds" | "token_cap" | "bad_token_cap" | "material" | "draft" | "synthesizer" | "participant" | "busy" | "replacement";

export class ResumeRejectedError extends Error {
  readonly reason: ResumeRejection;
  constructor(reason: ResumeRejection, message: string) {
    super(message);
    this.name = "ResumeRejectedError";
    this.reason = reason;
  }
}

/** A replacement requested by the owner: a departed or unavailable participant → a new one in its place. */
export interface ReplacementInput { participantId: string; providerId: string; model: string; name?: string }

export interface PlannedReplacement {
  oldParticipantId: string;
  participant: Participant;        // the new one: the next free identifier, the role of the former
  wasActive: boolean;              // the former was active (so it is unavailable — resumeDrivers checks this)
  dropReason: string | null;       // the former's reason for departure
}

export interface ResumePlan {
  id: string;
  session: Session;                // lineup after replacements (without replacements it matches state.session, with the last effective limit)
  state: SessionState;             // state before the resume (the former lineup)
  events: SessionEvent[];          // the full previous journal
  journalBytes: number;            // size of the journal file at planning time
  status: "interrupted" | "no_consensus" | "stopped" | "failed" | "consensus"; // failed — only the failure "fewer than two active", which a replacement can fix; consensus — only with an owner message
  replacements: PlannedReplacement[]; // [] — no replacements
  point: ResumePoint;             // on the state after replacements
  addedRounds: number;             // how many rounds are still to run, including the unfinished one
  maxRounds: number;               // new shared limit = point.completedRounds + addedRounds
  active: Participant[];           // future active participants in slot order
  draftCalls: number;              // remaining calls of the unfinished drafts phase for the future lineup; 0 without the phase or after it
  maxCalls: number;                // active.length × addedRounds × 3 + draftCalls
  materials: CollectedMaterial[];  // texts from snapshots, checked against the sha256 of the metadata; [] — no materials
  workspace?: FolderFile[];        // folder snapshot; absent for sessions without a folder
  spentTokens: number;             // tokenUsage(state).total at planning time
  tokenCap: number | null;         // effective cap after the resume; null — no cap
  maxTotalTokens?: number | null;  // what to write into session_resumed: set only when a change was requested
  message?: string;                // owner message written right after session_resumed; absent — none or blank
}

const reject = (reason: ResumeRejection, message: string): never => {
  throw new ResumeRejectedError(reason, message);
};

/** Check of the replacement map and of the new participants: identifiers go in a row in slot order, not in input order. */
function planReplacements(id: string, state: SessionState, inputs: readonly ReplacementInput[]): PlannedReplacement[] {
  const session = state.session!;
  const m = resumeMessages();
  const bad = (message: string): never => reject("replacement", message);
  const seen = new Set<string>();
  for (const r of inputs) {
    if (seen.has(r.participantId)) bad(m.repDuplicate(id, r.participantId));
    seen.add(r.participantId);
    if (!session.participants.some((p) => p.id === r.participantId)) bad(m.repUnknown(id, r.participantId));
    const holder = slotHolder(session, r.participantId);
    if (holder !== r.participantId) bad(m.repAlready(id, r.participantId, holder));
    if (!r.providerId?.trim() || !r.model?.trim()) bad(m.repNeedModel(id, r.participantId));
  }
  const order = slotRoster(session).map((p) => p.id);
  return [...inputs].sort((a, b) => order.indexOf(a.participantId) - order.indexOf(b.participantId)).map((r, i) => {
    const old = session.participants.find((p) => p.id === r.participantId)!;
    const n = session.participants.length + 1 + i;
    const participant: Participant = { id: `p${n}`, name: r.name?.trim() || m.defaultName(n), providerId: r.providerId, model: r.model, role: old.role };
    const parsed = ReplacementSchema.safeParse({ oldParticipantId: old.id, participant });
    if (!parsed.success) bad(m.repRejected(id, old.id, parsed.error.issues.map((x) => x.message).join("; ")));
    const was = state.participants.find((p) => p.id === old.id);
    return { oldParticipantId: old.id, participant, wasActive: was?.status === "active", dropReason: was?.dropReason ?? null };
  });
}

/** All resume checks without side effects. Throws ResumeRejectedError. */
export function planResume(
  dataDir: string, id: string, options: { rounds?: number; maxTotalTokens?: number | null; isAlive?: (pid: number) => boolean; replacements?: readonly ReplacementInput[]; message?: string } = {},
): ResumePlan {
  const m = resumeMessages();
  const notFound = () => reject("not_found", m.notFound(id));
  const read = readEvents(dataDir, id);
  if (read === null) notFound();
  const { events, offset, size: journalBytes } = read!;
  const stored = readSession(dataDir, id, options.isAlive);
  if (stored === null) notFound();
  const { state, status } = stored!;
  if (read!.stopped === "newer_version") {
    reject("newer_version", m.newerVersion(id, partialNote({ reason: "newer_version", lastEvent: events.length })));
  }
  if (offset !== journalBytes) {
    reject("corrupted", m.corrupted(id, events.length));
  }
  if (status === "running") reject("running", m.running(id));
  const message = options.message?.trim() ? options.message : undefined;
  if (status === "consensus" && message === undefined) reject("consensus", m.consensus(id));
  if (status === "failed" && state.finish?.reasonCode !== INSUFFICIENT_ACTIVE_REASON_CODE) {
    reject("failed", m.failed(id));
  }
  const planned = planReplacements(id, state, options.replacements ?? []);
  const future = applyReplacements(state, planned.map(({ oldParticipantId, participant }) => ({ oldParticipantId, participant })));
  const session = future.session!;
  const futureActive = new Set(activeParticipantIds(future));
  const active = slotRoster(session).filter((p) => futureActive.has(p.id));
  if (active.length < 2) {
    const gone = slotRoster(session).filter((p) => !futureActive.has(p.id)).map((p) => p.id);
    reject("too_few_active", `${m.tooFewActive(id)}${gone.length ? m.replaceGone(gone.join(", ")) : ""}`);
  }
  // The synthesizer departed and there is no version 1: the engine would end the session with a failure at once — a plan with calls would be a deception.
  // The replacement does not inherit the synthesizer role.
  const synth = session.participants.find((p) => p.id === session.drafts?.synthesizerId);
  if (synth && future.versions.length === 0 && !active.includes(synth)) {
    reject("synthesizer", m.synthesizer(id, synth.id, synth.name));
  }
  const point = resumePoint(future);
  let addedRounds: number;
  if (options.rounds !== undefined) {
    addedRounds = options.rounds;
    if (!Number.isSafeInteger(addedRounds) || addedRounds < 1 || !Number.isSafeInteger(point.completedRounds + addedRounds)) {
      reject("bad_rounds", m.badRounds(id));
    }
  } else {
    addedRounds = session.limits.maxRounds - point.completedRounds;
    if (addedRounds <= 0) {
      reject("no_rounds_left", m.noRoundsLeft(id));
    }
  }
  const spentTokens = tokenUsage(state).total;
  const requested = options.maxTotalTokens;
  if (typeof requested === "number") {
    if (!Number.isSafeInteger(requested) || requested < 1) {
      reject("bad_token_cap", m.badTokenCap(id));
    }
    if (spentTokens >= requested) {
      reject("token_cap", m.tokenCapBelowSpent(id, requested, spentTokens));
    }
  } else if (requested === undefined && session.limits.maxTotalTokens !== undefined && spentTokens >= session.limits.maxTotalTokens) {
    reject("token_cap", m.tokenCapExhausted(id, session.limits.maxTotalTokens, spentTokens));
  }
  const tokenCap = requested === undefined ? session.limits.maxTotalTokens ?? null : requested;
  const materials: CollectedMaterial[] = (session.materials ?? []).map((m) => {
    let text: string;
    try {
      text = readFileSync(materialPath(dataDir, id, m.id), "utf8");
    } catch {
      return reject("material", resumeMessages().materialMissing(m.name));
    }
    if (createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex") !== m.sha256) {
      reject("material", resumeMessages().materialHash(m.name));
    }
    return { ...m, text };
  });
  let workspace: FolderFile[] | undefined;
  if (session.workspace) {
    workspace = readWorkspaceSnapshot(dataDir, id);
    const got = folderStats(workspace);
    if (got.files !== session.workspace.files || got.chars !== session.workspace.chars) {
      reject("material", m.workspaceMismatch(got.files, session.workspace.files, got.chars, session.workspace.chars));
    }
  }
  for (const slot of state.drafts) {
    if (!slot.done) continue;
    try {
      readDraftSnapshot(dataDir, id, { draftId: slot.draftId, chars: slot.done.chars, sha256: slot.done.sha256 });
    } catch (e) {
      if (!(e instanceof DraftSnapshotError)) throw e;
      reject("draft", m.draft(id, e.message));
    }
  }
  const draftCalls = draftCallsLeft(future);
  return {
    id, session, state, events, journalBytes, status: status as ResumePlan["status"], replacements: planned, point, addedRounds,
    maxRounds: point.completedRounds + addedRounds, active, draftCalls, maxCalls: active.length * addedRounds * 3 + draftCalls, materials,
    ...(workspace ? { workspace } : {}), spentTokens, tokenCap, ...(requested !== undefined ? { maxTotalTokens: requested } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

/**
 * How many scenario steps the participant has already used: attempts of its completed turns and the recorded failed attempts
 * of turns that were never completed (except the repeatable turn — it is replayed from the first step), plus already started
 * attempts of the participant's draft.
 */
// ponytail: if one turn was interrupted and repeated several times with recorded failed attempts, and then the participant departed on it, the steps are counted with a margin; the replacement's count includes the predecessor's draft attempts in the same slot (a repeated resume after a replacement in the drafts phase); scripted participants — for development only
export function scriptedStartStep(state: SessionState, participantId: string, point: ResumePoint): number {
  const done = new Set(state.turns.map((t) => t.turn));
  const completed = state.turns.filter((t) => t.participantId === participantId).reduce((n, t) => n + t.attempts, 0);
  const failed = state.failures.filter(
    (f) => f.participantId === participantId && !done.has(f.turn) && !(point.redo && f.turn === point.turn),
  ).length;
  const drafted = state.drafts.find((d) => d.draftId === draftIdOf(state.session!, participantId))?.started ?? 0;
  return completed + failed + drafted;
}

type Env = Record<string, string | undefined>;

export async function resumeDrivers(
  plan: ResumePlan,
  options: { registry: Registry; env: Env; dataDir: string; deps?: Partial<InspectDeps>;
    scenarioPath?: (model: string) => string | null },
): Promise<{ drivers: Record<string, ParticipantDriver>; warnings: string[]; unavailable: Record<string, string> }> {
  const { registry, env, dataDir, deps, scenarioPath } = options;
  const drivers: Record<string, ParticipantDriver> = {};
  const warnings: string[] = [];
  const unavailable: Record<string, string> = {};
  const inspected = new Map<string, ProviderInspection>();
  // plan.active — the future lineup after replacements
  const active = new Set(plan.active.map((p) => p.id));
  const fresh = new Map(plan.replacements.map((r) => [r.participant.id, r]));
  const fail = (p: Participant, why: string): never => {
    const r = fresh.get(p.id);
    return r ? reject("replacement", resumeMessages().replacementFail(r.oldParticipantId, p.id, p.name, why)) : reject("participant", resumeMessages().participantFail(p.id, p.name, why));
  };
  // The driver of one participant, or the reason why it cannot be built.
  const build = async (p: Participant, startStep: number): Promise<ParticipantDriver | string> => {
    if (p.providerId === "scripted") {
      const path = scenarioPath ? scenarioPath(p.model) : p.model;
      if (path === null) return resumeMessages().scenarioUnavailable(p.model);
      try {
        return createScriptedDriver(await readScenario(path), env, startStep);
      } catch (e) {
        return (e as Error).message;
      }
    }
    const provider = registry.providers.find((x) => x.id === p.providerId);
    if (!provider) return resumeMessages().providerMissing(p.providerId);
    if (fresh.has(p.id)) {
      const http = provider.kind === "openai-http";
      if (http && (!p.model || p.model === DEFAULT_MODEL)) return resumeMessages().needExplicitModel(p.providerId);
      if (!http && p.model.includes(":")) return resumeMessages().modelNoColon;
    }
    let found = inspected.get(p.providerId);
    if (!found) {
      found = await inspectProvider(provider, { env, withModels: false, deps, keyFile: envFilePath(dataDir) });
      inspected.set(p.providerId, found);
      if (found.status.warning) warnings.push(resumeMessages().providerWarning(p.providerId, found.status.warning));
    }
    if (!found.runtime && !found.http) return resumeMessages().providerUnavailable(p.providerId, String(found.status.reason));
    return found.runtime ? createCliDriver(found.runtime) : createHttpDriver(found.http!);
  };
  const limit = registry.defaults?.maxParticipants;
  if (plan.replacements.length && typeof limit === "number" && plan.active.length > limit) {
    reject("replacement", resumeMessages().repOverLimit(plan.id, plan.active.length, limit));
  }
  // Only a departed or unavailable participant can be replaced: a former active one must not be assembled.
  for (const r of plan.replacements.filter((x) => x.wasActive)) {
    const old = plan.session.participants.find((p) => p.id === r.oldParticipantId)!;
    const got = await build(old, 0);
    if (typeof got !== "string") {
      reject("replacement", resumeMessages().repStillAvailable(old.id, old.name));
    }
    unavailable[old.id] = got as string;
  }
  for (const p of plan.session.participants) {
    if (!active.has(p.id)) {
      drivers[p.id] = {
        call: async () => { throw new ParticipantCallError("call_error", resumeMessages().droppedOut(p.id), false); },
      };
      continue;
    }
    // A new participant starts the scenario from step 0; the steps of the former ones are counted from the state before the resume.
    const got = await build(p, fresh.has(p.id) ? 0 : scriptedStartStep(plan.state, p.id, plan.point));
    if (typeof got === "string") fail(p, got);
    drivers[p.id] = got as ParticipantDriver;
  }
  return { drivers, warnings, unavailable };
}

export interface ResumeRunOptions {
  dataDir: string; plan: ResumePlan; drivers: Record<string, ParticipantDriver>;
  signal?: AbortSignal; onEvent?: RunSessionOptions["onEvent"]; onChunk?: RunSessionOptions["onChunk"];
  logger?: Logger; stopPollMs?: number; isAlive?: (pid: number) => boolean;
  onAccepted?: (info: { droppedOwnerRequests: OwnerMessageRequest[] }) => void;
  revalidate?: () => Promise<unknown>; // repeated check under the lock, before any changes; its exception goes out as is
  now?: () => Date; waitPollMs?: number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

// The lock of the single executor: resume.lock with the pid; creating and removing a stale one — in pid-lock.ts.
export function acquireResumeLock(path: string, isAlive: (pid: number) => boolean): void {
  if (!tryPidLock(path, isAlive)) reject("busy", resumeMessages().busy);
}

export async function runResumedSession(options: ResumeRunOptions): Promise<SessionRun> {
  const { dataDir, plan, drivers, logger } = options;
  const id = plan.id;
  const lock = resumeLockPath(dataDir, id);
  acquireResumeLock(lock, options.isAlive ?? isProcessAlive);
  const own = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  markRunningHere(id);
  try {
    if (statSync(eventsPath(dataDir, id)).size !== plan.journalBytes) {
      reject("busy", resumeMessages().journalChanged(id));
    }
    await options.revalidate?.();
    rmSync(stopRequestPath(dataDir, id), { force: true });
    const applied = new Set(plan.state.ownerMessages.map((m) => m.requestId));
    const droppedOwnerRequests = discardOwnerRequests(dataDir, id, applied);
    options.onAccepted?.({ droppedOwnerRequests });
    const ownerMessages = openOwnerQueue(dataDir, id);
    logger?.info(`Session ${id} resumed: ${plan.addedRounds} more rounds, limit ${plan.maxRounds}, ${plan.tokenCap === null ? "no token cap" : `token cap ${plan.tokenCap}`}`);
    const signal = options.signal ? AbortSignal.any([options.signal, own.signal]) : own.signal;
    timer = watchStopRequest(stopRequestPath(dataDir, id), options.stopPollMs, () => own.abort());
    const run = await runSession({
      session: plan.session, drivers, materials: plan.materials, workspace: plan.workspace,
      resume: {
        events: plan.events, maxRounds: plan.maxRounds,
        ...(plan.replacements.length ? { replacements: plan.replacements.map(({ oldParticipantId, participant }): SessionReplacement => ({ oldParticipantId, participant })) } : {}),
        ...(plan.maxTotalTokens !== undefined ? { maxTotalTokens: plan.maxTotalTokens } : {}),
        // accepted under the lock of the single executor: no request file, so no protection against a repeat is needed
        ...(plan.message !== undefined ? { ownerMessage: { text: plan.message, requestId: `resume-${randomUUID()}` } } : {}),
      },
      ownerMessages, draftStore: storedDraftStore(dataDir, id), signal, onChunk: options.onChunk, now: options.now, waitPollMs: options.waitPollMs, sleep: options.sleep,
      onEvent: (e, s) => {
        appendEvent(dataDir, id, e);
        options.onEvent?.(e, s);
      },
    });
    logger?.info(`Session ${id} finished: ${run.state.finish?.status}`);
    return run;
  } catch (e) {
    logger?.error(`Session ${id} failed with an error`, e);
    throw e;
  } finally {
    clearInterval(timer);
    unmarkRunningHere(id);
    try { unlinkSync(lock); } catch { /* already removed */ }
  }
}
