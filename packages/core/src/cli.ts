import { parseArgs } from "node:util";
import { accessSync, constants, existsSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createSession, SessionInputError } from "./engine.ts";
import { cliMessages } from "./messages/cli.ts";
import { providerMessages } from "./messages/providers.ts";
import { doctorJson, JSON_COMMANDS, lineupsJson, listJson, providersJson, showJson, statusJson, templatesJson } from "./cli-json.ts";
import { resumeMessages } from "./messages/resume.ts";
import { attachedFolderPrefixes, collectSessionMaterials, MaterialsError } from "./materials.ts";
import type { MaterialSet } from "./materials.ts";
import { collectSessionMaterialsWithUrls, collectUrlMaterials } from "./url/collect.ts";
import type { UrlTransport } from "./url/fetch.ts";
import { formatSource, readMaterialSources, SOURCES_FILE } from "./store/material-sources.ts";
import type { MaterialSource } from "./store/material-sources.ts";
import { loadPreparedMaterials, PreparedMaterialsError, savePreparedMaterials } from "./store/prepared-materials.ts";
import { buildMaterialsPreview } from "./protocol/context.ts";
import { getProcessLanguage } from "./i18n/process-language.ts";
import { BUILTIN_TEMPLATES_DIR, loadTemplates, templateSessionInput, UnknownTemplateError, userTemplatesDir } from "./templates/templates.ts";
import { createScriptedDriver, readScenario, ScriptedUnavailableError } from "./participants/scripted.ts";
import type { ParticipantDriver } from "./participants/driver.ts";
import { DRAFT_CONTEXT_LIMIT_REASON, INSUFFICIENT_ACTIVE_REASON_CODE, MAX_TURN_TIMEOUT_SEC, OWNER_WAIT_DEFAULT_SEC, OWNER_WAIT_MAX_SEC, SYNTHESIZER_UNAVAILABLE_REASON, TOKEN_CAP_REASON } from "./protocol/schema.ts";
import type { SessionEvent } from "./protocol/schema.ts";
import { createCliDriver } from "./cli-agents/driver.ts";
import { resetDiscoveryCache } from "./cli-agents/discovery.ts";
import { npmReleases, npmSource } from "./cli-agents/npm-source.ts";
import { candidatesJson, checkCandidates } from "./cli-agents/candidates.ts";
import type { ReleaseSource } from "./cli-agents/candidates.ts";
import { installPin, listPins, rollbackPin, usePin } from "./cli-agents/pins.ts";
import { checkMaxCalls, formatPlan, planAcceptance, runAcceptance } from "./cli-agents/acceptance.ts";
import { acceptanceMessages } from "./messages/acceptance.ts";
import type { PackageSource } from "./cli-agents/pins.ts";
import { loadVerifiedRecord } from "./cli-agents/verified-record.ts";
import type { VerifiedEntry, VerifiedRecord } from "./cli-agents/verified-record.ts";
import { createHttpDriver } from "./http/driver.ts";
import { CLI_AGENTS, DEFAULT_MODEL } from "./cli-agents/types.ts";
import { FOLDER_LIMITS, folderStats } from "./protocol/folder.ts";
import { finishReasonText } from "./protocol/finish-reason.ts";
import type { FolderFile } from "./protocol/folder.ts";
import { applyEvent } from "./protocol/fold.ts";
import { currentVersion, draftPhase, initialState, maxCallsBound, OWNER_ID, sessionTotals, slotRoster, tokenUsage } from "./protocol/state.ts";
import { sessionUsage } from "./protocol/usage.ts";
import type { SessionState } from "./protocol/state.ts";
import { DataDirError, ensureDataDir, prepareDataDir } from "./store/data-dir.ts";
import { envFilePath } from "./store/env.ts";
import { readEvents, SessionExistsError } from "./store/journal.ts";
import { LaunchFileError, launchAcceptedPath, readLaunchFile } from "./store/launch.ts";
import type { LaunchResumePayload } from "./store/launch.ts";
import { createLogger } from "./store/log.ts";
import type { Logger } from "./store/log.ts";
import { runStoredSession } from "./store/run.ts";
import { configPath, logRegistryLoaded, readRegistry, RegistryError } from "./registry/config.ts";
import type { Provider, Registry } from "./registry/config.ts";
import { checkLineup } from "./registry/lineup-check.ts";
import { LineupsError, readLineups, saveLineup } from "./registry/lineups.ts";
import { ensureRegistry, inspectProvider, inspectProviders } from "./registry/providers.ts";
import type { InspectDeps, ProviderStatus } from "./registry/providers.ts";
import { DraftSnapshotError, readDraftSnapshot } from "./store/draft-snapshots.ts";
import { listSessions, partialNote, readSession, requestStop, StopRejectedError } from "./store/sessions.ts";
import type { JournalPartial, StoredStatus } from "./store/sessions.ts";
import { OwnerMessageRejectedError, OwnerReleaseRejectedError, requestOwnerMessage, requestOwnerRelease } from "./store/owner-messages.ts";
import type { ReplacementInput } from "./store/resume.ts";
import { planResume, ResumeRejectedError, resumeDrivers, runResumedSession } from "./store/resume.ts";
import type { ResumePlan } from "./store/resume.ts";

export const EXIT = { consensus: 0, internal: 1, usage: 2, no_consensus: 3, stopped: 4, failed: 5 } as const;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  chunk?: (text: string) => void; // text appearing during the turn
  inspectDeps?: Partial<InspectDeps>; // for tests: replacement of the CLI search and inspection
  builtinTemplatesDir?: string; // for tests and packaging: the folder of built-in templates
  urlTransport?: UrlTransport; // for the stand and tests: replacement of DNS and of the connection
  urlWorker?: string; // for packaging: path of the HTML text extraction worker
  appVersion?: string; // application version, passed by the entry point (doctor)
  processVersions?: Partial<NodeJS.ProcessVersions>; // for tests: replacement of process.versions (doctor)
  cliPin?: { source?: PackageSource; record?: VerifiedRecord; releases?: ReleaseSource; builtin?: readonly VerifiedEntry[]; inspectLimits?: { timeoutMs?: number; maxBytes?: number } }; // for the stand and tests: shorter limits for the help and capability reads of cli accept (never set by the production entry), replacement of the package source, of the verified-versions record (cli install, use, list), of the release source and of the built-in record (cli candidates)
}

export const help = (): string => cliMessages().help;

class UsageError extends Error {}

const RUN_FLAGS = ["topic", "participant", "max-rounds", "framing", "turn-timeout", "context-chars", "template", "attach", "include", "no-ignore", "url", "preview-materials", "prepared-materials", "materials-chars", "pause-after-round", "wait-for-owner", "owner-wait-sec", "lineup", "drafts", "synthesizer"] as const;

const intFlag = (name: string, value: string | undefined, max?: number): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  const valid = /^\d+$/.test(value.trim()) && n >= 1 && Number.isSafeInteger(n);
  if (max !== undefined && (!valid || n > max)) throw new UsageError(cliMessages().intRange(name, 1, max));
  if (!valid) throw new UsageError(cliMessages().intRequired(name));
  return n;
};

const waitReason = (r: string, ids: string[], withIds: boolean) =>
  r === "round_boundary" ? cliMessages().waitRoundBoundary : cliMessages().waitQuestion(withIds ? ids.join(", ") : "");
const waitReasons = (rs: string[], ids: string[], withIds = true) => rs.map((r) => waitReason(r, ids, withIds)).join("; ");
const waitDone = (reason: "continued" | "answered" | "expired" | "stopped") => {
  const t = cliMessages();
  return { continued: t.waitContinued, answered: t.waitAnswered, expired: t.waitExpired, stopped: t.waitStopped }[reason];
};

const participantName = (provider: Provider | undefined, model: string, index: number) =>
  !provider ? resumeMessages().defaultName(index + 1) : model === DEFAULT_MODEL ? provider.label : `${provider.label} (${model})`;

interface Part { name: string; providerId: string; model: string; provider?: Provider }

function parseParticipant(raw: string, index: number, registry: Registry): Part {
  const t = cliMessages();
  const m = /^(?:([^=:]+)=)?([^:]+)(?::(.+))?$/.exec(raw);
  if (!m) throw new UsageError(t.badEntry(raw));
  const [, name, id, model] = m as unknown as [string, string | undefined, string, string | undefined];
  if (id === "scripted") {
    if (!model) throw new UsageError(t.scriptedNeedsPath(raw));
    return { name: name?.trim() || participantName(undefined, model, index), providerId: "scripted", model };
  }
  const provider = registry.providers.find((p) => p.id === id);
  if (!provider) {
    const known = registry.providers.map((p) => p.id).join(", ") || t.noProvidersWord;
    throw new UsageError(t.unknownProvider(id, known));
  }
  const http = provider.kind === "openai-http";
  if (http && (!model || model === DEFAULT_MODEL)) throw new UsageError(t.httpNeedsModel(raw, id));
  if (!http && model?.includes(":")) throw new UsageError(t.modelNoColons(raw));
  const m2 = model ?? DEFAULT_MODEL;
  return { name: name?.trim() || participantName(provider, m2, index), providerId: id, model: m2, provider };
}

interface MaterialsView { materials: MaterialSet["materials"]; workspace: FolderFile[]; skipped: MaterialSet["skipped"]; left: { name: string; reason: string }[]; sources: MaterialSource[] }

// --include: a filesystem path inside the attached folder, or a name from the section "Excluded by rules" (starts with the folder name)
export function includePaths(given: readonly string[], attach: readonly string[], cwd: string = process.cwd()): string[] {
  const roots = [...new Set(attach.map((a) => resolve(cwd, a)))];
  return given.map((g) => {
    // an ambiguous name is rejected before parsing, relative to the current folder: otherwise the returned folder would depend on where the command is run from
    const named = roots.filter((r) => g.startsWith(`${basename(r)}/`));
    if (named.length > 1) throw new UsageError(cliMessages().includeAmbiguous(g));
    const abs = resolve(cwd, g);
    if (roots.some((r) => abs.startsWith(r + sep))) return abs;
    if (named.length === 1) return join(dirname(named[0]!), g);
    // a name with the suffix of a same-named folder: "proj (2)/out/" — by the printed name
    for (const [r, p] of attachedFolderPrefixes(roots)) if (g.startsWith(`${p}/`)) return join(r, g.slice(p.length + 1));
    return abs;
  });
}

// Materials summary: texts are not printed, links only in a safe form
function printMaterials(io: CliIo, log: Logger, set: MaterialsView, limit: number) {
  const t = cliMessages();
  const total = set.materials.reduce((n, m) => n + m.chars, 0);
  log.info(`Materials: ${set.materials.length}, size ${total}, folder files ${set.workspace.length}, not in the initial set ${set.left.length}, skipped ${set.skipped.length}, links ${set.sources.length}`);
  io.stdout(t.materials(set.materials.length, total, limit));
  if (set.workspace.length) {
    io.stdout(t.folderSnapshot(folderStats(set.workspace).files, folderStats(set.workspace).chars, FOLDER_LIMITS.snapshotChars));
  }
  if (set.left.length) {
    io.stdout(t.leftOut(set.left.length));
    set.left.slice(0, 20).forEach((s) => io.stdout(`  ${s.name} — ${s.reason}`));
    if (set.left.length > 20) io.stdout(t.andMore(set.left.length - 20));
  }
  // a record with excludedPath is an exclusion by a .gitignore rule; the rest are ordinary skips
  const ruled = set.skipped.filter((s) => s.excludedPath !== undefined);
  const other = set.skipped.filter((s) => s.excludedPath === undefined);
  if (ruled.length) {
    io.stdout(t.excludedByRules(ruled.length));
    ruled.forEach((s) => io.stdout(`  ${s.name} — ${s.reason}`));
  }
  if (other.length) {
    io.stdout(t.skipped(other.length));
    other.forEach((s) => io.stdout(`  ${s.name} — ${s.reason}`));
  }
  if (set.sources.length) {
    io.stdout(t.linkSources(set.sources.length));
    set.sources.forEach((s) => io.stdout(`  ${formatSource(s)}`));
  }
}

// usage line after a turn; the cap and the accumulated tokens are taken from the state for this turn
function spendLine(state: SessionState): string {
  const t = cliMessages(), u = tokenUsage(state), cap = state.session?.limits.maxTotalTokens;
  if (!sessionUsage(state.usageEvents).records.some((r) => r.usage.inputTokens !== undefined || r.usage.outputTokens !== undefined)) {
    return t.spendNoTokens(cap);
  }
  const note = u.incomplete ? t.spendIncompleteNote : "";
  return cap !== undefined ? t.spendOfCap(u.total, cap, note) : t.spendNoCap(u.total, note);
}

type DraftText = (meta: { draftId: string; chars: number; sha256: string }) => string | null;

const filesReadLine = (files: { name: string; chars: number; shown: number }[]) => {
  const t = cliMessages();
  return t.filesRead(files.map((f) => `${f.name} — ${f.shown === f.chars ? t.fileChars(f.chars) : t.fileCharsOf(f.shown, f.chars)}`).join("; "));
};

const snapshotReader = (dataDir: string, id: string): DraftText => (meta) => {
  try {
    return readDraftSnapshot(dataDir, id, meta);
  } catch (e) {
    if (e instanceof DraftSnapshotError) return null;
    throw e;
  }
};

function formatEvent(e: SessionEvent, state: SessionState, sessionId?: string, spend = false, draftText?: DraftText): string[] {
  const t = cliMessages();
  const nameOf = (id: string) => state.session?.participants.find((p) => p.id === id)?.name ?? id;
  switch (e.type) {
    case "session_created":
      return [
        t.sessionHeader(e.session.id, e.session.participants.length, e.session.limits.maxRounds),
        t.topic(e.session.topic),
        ...(e.session.templateId !== null ? [t.template(e.session.templateId)] : []),
      ];
    case "turn_completed": {
      const notes = (e.stance === "amend" ? t.toVersion(e.version) : "") +
        (e.normalized ? t.normalized : "");
      const out = ["", t.turn(e.turn, e.round, e.participantId, nameOf(e.participantId), e.stance, notes), t.reasoning(e.reasoning)];
      if (e.filesRead?.length) out.push(filesReadLine(e.filesRead));
      if (e.answers.length) out.push(t.answers, ...e.answers.map((a) => `  ${a.questionId}: ${a.text}`));
      const toParticipants = e.questions.filter((q) => q.to !== OWNER_ID);
      if (toParticipants.length) out.push(t.questions, ...toParticipants.map((q) => `  ${q.id} → ${q.to}: ${q.text}`));
      for (const q of e.questions.filter((x) => x.to === OWNER_ID)) {
        out.push(t.ownerQuestion(q.id, e.participantId, nameOf(e.participantId), q.text));
        if (sessionId !== undefined) out.push(t.answerHint(sessionId, q.id));
      }
      if (spend) out.push(spendLine(state));
      return out;
    }
    case "turn_failed":
      return [t.turnFailed(e.turn, e.participantId, nameOf(e.participantId), e.attempt, e.kind, e.message)];
    case "draft_completed": {
      const out = ["", t.draft(e.participantId, nameOf(e.participantId), e.attempts, e.chars), t.rationale(e.reasoning)];
      if (e.filesRead?.length) out.push(filesReadLine(e.filesRead));
      out.push(t.draftTextLabel, draftText?.({ draftId: e.draftId, chars: e.chars, sha256: e.sha256 }) ?? t.draftTextUnavailable);
      if (spend) out.push(spendLine(state));
      return out;
    }
    case "draft_attempt_failed":
      return [t.draftFailed(e.participantId, nameOf(e.participantId), e.attempt, e.kind, e.message)];
    case "drafts_finished": {
      const synth = state.session?.drafts?.synthesizerId ?? "";
      return ["", t.draftsFinished(state.drafts.filter((d) => d.done).length, state.session ? slotRoster(state.session).length : 0, synth, nameOf(synth))];
    }
    case "participant_dropped":
      return [t.dropped(e.participantId, nameOf(e.participantId), e.reason)];
    case "session_resumed":
      return [
        t.resumed(e.maxRounds, e.maxTotalTokens === undefined ? "" : e.maxTotalTokens === null ? t.resumedCapRemoved : t.resumedCap(e.maxTotalTokens)),
        ...(e.replacements ?? []).map((r) => t.replacementLine(r.oldParticipantId, r.participant.id, r.participant.name)),
      ];
    case "owner_message":
      return ["", t.ownerMessage(e.id, e.afterTurn, e.answers ? e.answers.map((a) => a.questionId).join(", ") : ""), e.text];
    case "owner_selected_version":
      return ["", t.ownerSelected(e.version, statusText(e.statusAtSelection)), ...(e.note ? [t.note(e.note)] : [])];
    case "owner_wait_started": {
      const out = ["", t.waitStarted(e.waitId, waitReasons(e.reasons, e.questionIds), e.deadline)];
      if (sessionId !== undefined) {
        out.push(t.continueHint(sessionId));
        if (e.questionIds[0] !== undefined) out.push(t.answerHint(sessionId, e.questionIds[0]));
      }
      return out;
    }
    case "owner_wait_updated":
      return [t.waitUpdated(e.waitId, waitReasons(e.reasons, e.questionIds))];
    case "owner_wait_finished":
      return [t.waitFinished(e.waitId, waitDone(e.reason))];
    case "question_closed":
      return e.reason === "unanswered" ? [t.questionUnanswered(e.questionId)] : [];
    default:
      return [];
  }
}

function formatSummary(state: SessionState, show = false): string[] {
  const t = cliMessages();
  const f = state.finish!;
  const v = currentVersion(state);
  const out = ["", t.summary(f.status)];
  const cap = state.session?.limits.maxTotalTokens, usage = tokenUsage(state);
  const synth = state.session?.drafts?.synthesizerId ?? "";
  const synthName = state.session?.participants.find((p) => p.id === synth)?.name ?? synth;
  if (f.reason === TOKEN_CAP_REASON) {
    out.push(show ? t.reasonCoded(f.reason, t.tokenCapCode) : t.tokenCapReason(usage.total, cap));
  } else if (f.reason === SYNTHESIZER_UNAVAILABLE_REASON) {
    const text = t.synthUnavailable(synth, synthName);
    out.push(show ? t.reasonCoded(f.reason, text) : t.reason(text));
  } else if (f.reason === DRAFT_CONTEXT_LIMIT_REASON) {
    const chars = state.drafts.reduce((n, d) => n + (d.done ? d.done.chars + d.done.reasoning.length : 0), 0);
    const text = t.draftsTooLong(chars, state.session?.limits.contextChars);
    out.push(show ? t.reasonCoded(f.reason, text) : t.reason(text));
  } else {
    const reasonText = finishReasonText(f);
    if (reasonText) out.push(t.reason(reasonText));
    if (f.reasonCode === INSUFFICIENT_ACTIVE_REASON_CODE) out.push(t.canReplace(state.session?.id ?? "<id>"));
    if (cap !== undefined && usage.incomplete) out.push(t.tokensIncomplete(cap));
  }
  if (v) out.push(t.versionBy(v.number, v.authorId));
  out.push(t.agreed(f.agreed.length ? f.agreed.join(", ") : t.none));
  if (f.objectors.length) {
    out.push(t.objectors);
    for (const o of f.objectors) {
      const name = state.session?.participants.find((p) => p.id === o.participantId)?.name ?? o.participantId;
      out.push(`  ${o.participantId} «${name}»: ${o.reasoning ?? t.silent}`);
    }
  }
  out.push("", ...(v ? [t.decision, v.text] : [t.noDecision]));
  return out;
}

const statusText = (status: string) => (status === "running" ? cliMessages().running : status);

/** A session of a newer version without an outcome: "running" and "interrupted" are not asserted by pid. */
const undetermined = (status: StoredStatus, partial: JournalPartial | null) =>
  partial?.reason === "newer_version" && (status === "running" || status === "interrupted");

/** Status for output: the outcome or "state not determined", then a note about a partly read journal. */
function statusLabel(status: StoredStatus, partial: JournalPartial | null): string {
  const text = undetermined(status, partial) ? cliMessages().undetermined : statusText(status);
  return partial === null ? text : `${text} · ${partialNote(partial)}`;
}

function formatStatus(id: string, status: StoredStatus, partial: JournalPartial | null, state: SessionState, now: number): string[] {
  const t = cliMessages();
  const out = [t.statusLine(id, statusLabel(status, partial)), ...(partial?.reason === "newer_version" ? [t.updateAdvice] : []), t.roundOf(state.round, state.session!.limits.maxRounds, state.turns.length)];
  const info = out.length - 1;
  if (draftPhase(state) === "drafting") {
    out[info] = t.draftsPhase(state.drafts.filter((d) => d.done).length, slotRoster(state.session!).length, state.session!.drafts!.synthesizerId);
  }
  const w = state.waiting;
  if (w === null) return [...out, t.noWait];
  out.push(t.waitLine(w.waitId, waitReasons(w.reasons, w.questionIds, false)));
  for (const qid of w.questionIds) {
    const q = state.questions.find((x) => x.id === qid);
    const name = q ? (state.session!.participants.find((p) => p.id === q.from)?.name ?? q.from) : "";
    out.push(`  ${qid} · ${q ? `${q.from} «${name}»: ${q.text}` : t.questionNotFound}`);
  }
  const left = Math.ceil((Date.parse(w.deadline) - now) / 1000);
  out.push(t.deadline(w.deadline, left));
  if (undetermined(status, partial)) return out;
  if (status === "running") {
    out.push(t.continueHint(id));
    if (w.questionIds[0] !== undefined) out.push(t.answerHint(id, w.questionIds[0]));
  } else if (status === "interrupted") out.push(t.executorDown(id));
  return out;
}

function formatShow(events: SessionEvent[], status: StoredStatus, partial: JournalPartial | null, draftText?: DraftText): string[] {
  const t = cliMessages();
  let state = initialState();
  const out: string[] = [];
  for (const e of events) {
    state = applyEvent(state, e);
    out.push(...formatEvent(e, state, undefined, false, draftText));
  }
  out.push(t.showStatus(statusLabel(status, partial)));
  if (partial?.reason === "newer_version") out.push(t.updateAdvice);
  if (state.finish !== null) out.push(...formatSummary(state, true));
  else {
    const v = currentVersion(state);
    if (v) out.push(t.currentVersion(v.number, v.authorId), v.text);
    out.push(t.agreed(state.agreed.length ? state.agreed.join(", ") : t.none));
    const w = state.waiting;
    if (w !== null) out.push(t.waitUntil(w.waitId, waitReasons(w.reasons, w.questionIds), w.deadline));
    if (draftPhase(state) === "drafting") out.push(t.draftsRunning(state.drafts.filter((d) => d.done).length, slotRoster(state.session!).length));
    const ct = state.currentTurn;
    if (ct) out.push(t.currentTurn(ct.turn, ct.round, ct.participantId));
  }
  const sel = state.ownerSelection;
  if (sel !== null) {
    out.push("", t.ownerChoice(sel.version), t.chosenAt(sel.ts, statusText(sel.statusAtSelection)));
    if (sel.note) out.push(t.note(sel.note));
    out.push(t.versionText(sel.version), state.versions.find((v) => v.number === sel.version)?.text ?? "");
  }
  const tot = sessionTotals(state);
  out.push(
    t.totals(tot.turns, tot.drafts > 0 ? t.totalsDrafts(tot.drafts) : "", (tot.durationMs / 1000).toFixed(1)) +
    (tot.inputTokens !== null || tot.outputTokens !== null ? t.totalsTokens(String(tot.inputTokens ?? "?"), String(tot.outputTokens ?? "?")) : "") +
    (tot.costUsd !== null ? t.totalsCost(tot.costUsd.toFixed(4)) : "") +
    (state.session?.limits.maxTotalTokens !== undefined ? t.totalsCap(state.session.limits.maxTotalTokens) : "") +
    (tot.incomplete ? t.totalsIncomplete : ""),
  );
  return out;
}

/** Check under the lock of the single executor: the deadline is the last action before any write, after the slow re-check of replacements. */
// ponytail: the writes after this check take milliseconds and the server waits one poll step (100 ms) past the deadline; a stall longer than that leaves an accepted resume behind a timeout answer, add a cancel marker in launch/ if it ever shows up
export function resumeRevalidator(plan: ResumePlan, driverOptions: Parameters<typeof resumeDrivers>[1], deadline: string, now: () => number = Date.now): () => Promise<void> {
  return async () => {
    if (plan.replacements.length) await resumeDrivers(plan, driverOptions);
    if (now() > Date.parse(deadline)) throw new ResumeRejectedError("launch_expired", cliMessages().launchExpired(deadline));
  };
}

/** Resume kind of the launch file. A refusal before acceptance is one JSON line `{code, message}` first on stderr, for the MCP server to read. */
async function runPreparedResume(p: LaunchResumePayload, file: string, dataDir: string, io: CliIo, log: Logger, fail: (message: string) => number): Promise<number> {
  const id = p.sessionId;
  try {
    await ensureRegistry(dataDir, { env: io.env, deps: io.inspectDeps });
    const registry = readRegistry(dataDir);
    const plan = planResume(dataDir, id, {
      ...(p.rounds !== undefined ? { rounds: p.rounds } : {}),
      ...(p.maxTotalTokens !== undefined ? { maxTotalTokens: p.maxTotalTokens } : {}),
      ...(p.replacements ? { replacements: p.replacements } : {}),
      ...(p.message !== undefined ? { message: p.message } : {}),
    });
    if (plan.journalBytes !== p.journalBytes) throw new ResumeRejectedError("stale_plan", resumeMessages().journalChanged(id));
    const driverOptions = { registry, env: io.env, dataDir, deps: io.inspectDeps, scenarioPath: (model: string) => p.scenarios[model] ?? null };
    const { drivers } = await resumeDrivers(plan, driverOptions);
    log.info(`Prepared resume: session ${id}`);
    const run = await runResumedSession({
      dataDir, plan, drivers, signal: io.signal, logger: log,
      revalidate: resumeRevalidator(plan, driverOptions, p.deadline),
      onAccepted: ({ droppedOwnerRequests }) => {
        const path = launchAcceptedPath(file);
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ droppedOwnerRequests: droppedOwnerRequests.map((r) => ({ requestId: r.requestId, text: r.text, questionId: r.questionId ?? null })) }), { mode: 0o600 });
        renameSync(tmp, path);
      },
    });
    log.info(`Prepared resumed session finished: ${run.state.finish!.status}`);
    return EXIT[run.state.finish!.status];
  } catch (e) {
    if (e instanceof ResumeRejectedError) {
      log.error("Prepared resume rejected", `${e.reason}: ${e.message}`);
      io.stderr(JSON.stringify({ code: e.reason, message: e.message }));
      return EXIT.usage;
    }
    if (e instanceof RegistryError) return fail(e.message);
    throw e;
  }
}

/** Internal command: runs a session prepared by the MCP server from a launch file (not listed in help). */
async function runPrepared(file: string, dataDir: string, io: CliIo, log: Logger): Promise<number> {
  const t = cliMessages();
  const fail = (message: string) => { log.error("Prepared start failed", message); io.stderr(t.error(message)); return EXIT.usage; };
  let payload;
  try {
    payload = readLaunchFile(file);
  } catch (e) {
    if (e instanceof LaunchFileError) return fail(e.message);
    throw e;
  }
  if (payload.kind === "resume") return runPreparedResume(payload, file, dataDir, io, log, fail);
  const { session, materials, workspace } = payload;
  try {
    let registry: Registry | undefined;
    if (session.participants.some((p) => p.providerId !== "scripted")) {
      await ensureRegistry(dataDir, { env: io.env, deps: io.inspectDeps });
      registry = readRegistry(dataDir);
    }
    const drivers: Record<string, ParticipantDriver> = {};
    for (const p of session.participants) {
      if (p.providerId === "scripted") {
        const path = payload.scenarios[p.id];
        if (path === undefined) return fail(t.launchInvalid(file, `scenarios.${p.id}: missing`));
        drivers[p.id] = createScriptedDriver(await readScenario(path), io.env);
        continue;
      }
      const provider = registry!.providers.find((x) => x.id === p.providerId);
      if (!provider) return fail(t.unknownProvider(p.providerId, registry!.providers.map((x) => x.id).join(", ")));
      const found = await inspectProvider(provider, { env: io.env, withModels: false, deps: io.inspectDeps, keyFile: envFilePath(dataDir), dataDir });
      if (!found.runtime && !found.http) { log.error("Provider unavailable", p.providerId); io.stderr(t.providerUnavailable(p.providerId, String(found.status.reason))); return EXIT.usage; }
      drivers[p.id] = found.runtime ? createCliDriver(found.runtime) : createHttpDriver(found.http!);
    }
    // the provider checks above can outlast the deadline: the server has already answered with a timeout
    if (Date.now() > Date.parse(payload.deadline)) return fail(t.launchExpired(payload.deadline));
    log.info(`Prepared start: session ${session.id}`);
    const { state } = await runStoredSession({
      session, drivers, materials, ...(workspace?.length ? { workspace } : {}), signal: io.signal, dataDir, logger: log,
    });
    log.info(`Prepared session finished: ${state.finish!.status}`);
    return EXIT[state.finish!.status];
  } catch (e) {
    if (e instanceof ScriptedUnavailableError || e instanceof SessionExistsError || e instanceof ResumeRejectedError || e instanceof RegistryError) return fail(e.message);
    throw e;
  }
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  // the language is set by the entry point before main is called and does not change until the call ends
  const t = cliMessages();
  const usageFail = (message: string) => {
    io.stderr(`${t.error(message)}\n\n${t.help}`);
    return EXIT.usage;
  };
  let logger: Logger | undefined;
  try {
    let values, positionals: string[];
    try {
      ({ values, positionals } = parseArgs({
        args: argv,
        strict: true,
        allowPositionals: true,
        options: {
          help: { type: "boolean" },
          json: { type: "boolean" },
          topic: { type: "string" },
          participant: { type: "string", multiple: true },
          "max-rounds": { type: "string" },
          framing: { type: "string" },
          "turn-timeout": { type: "string" },
          "context-chars": { type: "string" },
          template: { type: "string" },
          lineup: { type: "string" },
          "from-session": { type: "string" },
          attach: { type: "string", multiple: true },
          include: { type: "string", multiple: true },
          "no-ignore": { type: "boolean" },
          url: { type: "string", multiple: true },
          "preview-materials": { type: "boolean" },
          "prepared-materials": { type: "string" },
          "materials-chars": { type: "string" },
          "pause-after-round": { type: "boolean" },
          "wait-for-owner": { type: "boolean" },
          "owner-wait-sec": { type: "string" },
          answer: { type: "string" },
          rounds: { type: "string" },
          replace: { type: "string", multiple: true },
          message: { type: "string", multiple: true },
          "max-tokens": { type: "string" },
          "no-max-tokens": { type: "boolean" },
          drafts: { type: "boolean" },
          synthesizer: { type: "string" },
          version: { type: "string" },
          candidate: { type: "boolean" },
          agent: { type: "string" },
          model: { type: "string" },
          "max-calls": { type: "string" },
          "save-fixture": { type: "string" },
        },
      }));
    } catch (e) {
      return usageFail(e instanceof Error ? e.message : String(e));
    }
    if (values.help) {
      io.stdout(t.help);
      return EXIT.consensus;
    }

    const [cmd = "run", ...rest] = positionals;
    if (values.answer !== undefined && cmd !== "say") return usageFail(t.answerOnlySay);
    if (!["run", "providers", "list", "show", "stop", "say", "status", "continue", "resume", "home", "templates", "lineups", "doctor", "run-prepared", "cli"].includes(cmd)) return usageFail(t.unknownCommand(cmd));
    if (values.agent !== undefined && !(cmd === "cli" && rest[0] === "candidates")) return usageFail(t.agentOnlyCandidates);
    // flags of cli accept: refused for every other command; the sub-command check below refuses them for the other cli subcommands
    const acceptFlag = values.model !== undefined ? "--model" : values["max-calls"] !== undefined ? "--max-calls" : values["save-fixture"] !== undefined ? "--save-fixture" : undefined;
    if (cmd !== "cli" && (values.version !== undefined || values.candidate)) return usageFail(values.version !== undefined ? t.cliFlagOnlyCli("--version") : t.cliFlagOnlyInstallAccept("--candidate"));
    if (cmd !== "cli" && acceptFlag) return usageFail(t.cliFlagOnlyAccept(acceptFlag));
    if (values.json) {
      const jsonCmd = cmd === "lineups" && rest.length ? "lineups save" : cmd === "cli" && rest[0] === "candidates" ? "cli candidates" : cmd;
      if (!JSON_COMMANDS.includes(jsonCmd)) return usageFail(t.jsonNotSupported(jsonCmd));
    }
    if (cmd === "run" && positionals.length) return usageFail(t.unknownCommand(cmd));
    if (cmd === "home" || cmd === "list" || cmd === "providers" || cmd === "templates" || cmd === "doctor") {
      if (rest.length) return usageFail(t.noArgs(cmd));
    } else if (cmd === "cli") {
      const [sub = "", ...args] = rest;
      const usages: Record<string, string> = { install: "<agent> [--version <X>] [--candidate]", use: "<agent> <version>", rollback: "<agent>", accept: "<agent> <version> [--candidate] [--model <id>] [--max-calls <N>] [--save-fixture <folder>]" };
      const need = { install: 1, list: 0, use: 2, rollback: 1, candidates: 0, accept: 2 }[sub];
      if (!rest.length) return usageFail(t.cliUsage);
      if (need === undefined) return usageFail(t.cliUnknownSub(sub));
      const rejected = values.version !== undefined && sub !== "install" ? "--version"
        : values.candidate && sub !== "install" && sub !== "accept" ? "--candidate"
        : acceptFlag && sub !== "accept" ? acceptFlag : undefined;
      if (rejected) return usageFail(t.cliFlagNotAllowed(rejected, sub));
      const allowed = sub === "candidates" ? ["agent", "json"] : sub === "accept" ? ["candidate", "model", "max-calls", "save-fixture"] : ["version", "candidate"];
      if (Object.entries(values).some(([k, v]) => v !== undefined && v !== false && !allowed.includes(k))) return usageFail(t.cliUsage);
      if (values.agent !== undefined && !(CLI_AGENTS as readonly string[]).includes(values.agent)) return usageFail(t.cliUnknownAgent(values.agent, CLI_AGENTS.join(", ")));
      if (args.length !== need) return usageFail(sub === "list" || sub === "candidates" ? t.noArgs(`cli ${sub}`) : t.cliWrongArgs(sub, usages[sub]!));
      if (need > 0 && !(CLI_AGENTS as readonly string[]).includes(args[0]!)) return usageFail(t.cliUnknownAgent(args[0]!, CLI_AGENTS.join(", ")));
      if (sub === "accept") {
        const maxCalls = values["max-calls"];
        if (maxCalls !== undefined && !(/^\d+$/.test(maxCalls) && Number(maxCalls) >= 1)) return usageFail(t.maxCallsRange(maxCalls));
        if (values.model !== undefined && !values.model.trim()) return usageFail(t.flagNeedsValue("--model"));
        if (values["save-fixture"] !== undefined && !values["save-fixture"].trim()) return usageFail(t.flagNeedsValue("--save-fixture"));
      }
    } else if (cmd === "lineups") {
      if (rest.length && !(rest[0] === "save" && rest.length === 2)) return usageFail(t.lineupsUsage);
      if (rest.length && values["from-session"] === undefined) return usageFail(t.lineupsSaveNeedsSession);
    } else if (cmd === "run-prepared") {
      if (rest.length !== 1) return usageFail(t.launchUsage);
      if (Object.values(values).some((v) => v !== undefined)) return usageFail(t.launchUsage);
    } else if (cmd === "say") {
      if (rest.length !== 2) return usageFail(t.sayArgs);
    } else if (cmd !== "run" && rest.length !== 1) {
      return usageFail(t.oneArg(cmd));
    }
    if (cmd === "resume") {
      const bad = RUN_FLAGS.find((f) => values[f] !== undefined);
      if (bad) return usageFail(t.resumeFlag(bad));
    } else if (values.rounds !== undefined) {
      return usageFail(t.roundsOnlyResume);
    } else if (values.replace !== undefined) {
      return usageFail(t.replaceOnlyResume);
    } else if (values.message !== undefined) {
      return usageFail(t.messageOnlyResume);
    }
    if (values.message !== undefined) {
      if (values.message.length > 1) return usageFail(t.messageRepeated);
      if (!values.message[0]!.trim()) return usageFail(t.messageNeedsText);
    }
    const urlFlags = values.url !== undefined || values["preview-materials"] !== undefined || values["prepared-materials"] !== undefined || values.include !== undefined || values["no-ignore"] !== undefined;
    if (urlFlags && cmd !== "run") return usageFail(t.urlFlagsOnlyRun);
    if (values.include !== undefined) {
      if (values["no-ignore"]) return usageFail(t.includeNoIgnore);
      if (values.include.some((i) => !i.trim())) return usageFail(t.includeNeedsPath);
      if (!values.attach?.length && values["prepared-materials"] === undefined) return usageFail(t.includeNeedsAttach);
    }
    if (values.url?.some((u) => !u.trim())) return usageFail(t.urlNeedsAddress);
    const prepared = values["prepared-materials"], preview = values["preview-materials"];
    if (prepared !== undefined) {
      if (!prepared.trim()) return usageFail(t.preparedNeedsId);
      if (values.attach !== undefined || values.url !== undefined) return usageFail(t.preparedWithAttach);
      if (values.include !== undefined || values["no-ignore"]) return usageFail(t.preparedWithInclude);
      if (values["materials-chars"] !== undefined) return usageFail(t.preparedWithChars);
      if (preview) return usageFail(t.preparedWithPreview);
    }
    if (preview) {
      if (!values.attach?.length && !values.url?.length) return usageFail(t.previewNeedsInput);
      const other = [...RUN_FLAGS, "max-tokens", "no-max-tokens"].find((f) => !["attach", "include", "no-ignore", "url", "materials-chars", "preview-materials"].includes(f) && (values as Record<string, unknown>)[f] !== undefined);
      if (other) return usageFail(t.previewFlag(other));
    }
    if (values.synthesizer !== undefined && !values.drafts) return usageFail(t.synthNeedsDrafts);
    if ((values.drafts || values.synthesizer !== undefined) && cmd !== "run") return usageFail(t.draftsOnlyRun);
    if (values["from-session"] !== undefined && !(cmd === "lineups" && rest.length)) return usageFail(t.fromSessionOnlySave);
    if (values.lineup !== undefined) {
      if (cmd !== "run" && cmd !== "resume") return usageFail(t.lineupOnlyRun);
      if (values.participant?.length) return usageFail(t.lineupWithParticipant);
      if (!values.lineup.trim()) return usageFail(t.lineupNeedsId);
    }
    const tokenFlags = values["max-tokens"] !== undefined || values["no-max-tokens"] !== undefined;
    if (tokenFlags && cmd !== "run" && cmd !== "resume") return usageFail(t.tokenFlagsOnlyRun);
    if (values["max-tokens"] !== undefined && values["no-max-tokens"]) return usageFail(t.tokenFlagsConflict);
    const waitFlags = (["pause-after-round", "wait-for-owner", "owner-wait-sec"] as const).some((f) => values[f] !== undefined);
    if (waitFlags && cmd !== "run" && cmd !== "resume") return usageFail(t.waitFlagsOnlyRun);
    const waitSecRaw = values["owner-wait-sec"];
    let waitSec: number | undefined;
    if (waitSecRaw !== undefined && cmd === "run") {
      waitSec = Number(waitSecRaw);
      if (!/^\d+$/.test(waitSecRaw.trim()) || waitSec < 1 || waitSec > OWNER_WAIT_MAX_SEC) return usageFail(t.waitSecRange(OWNER_WAIT_MAX_SEC));
      if (!values["pause-after-round"] && !values["wait-for-owner"]) return usageFail(t.waitSecNeedsMode);
    }
    let rounds: number | undefined, maxTokens: number | undefined;
    try {
      rounds = intFlag("--rounds", values.rounds);
      maxTokens = intFlag("--max-tokens", values["max-tokens"]);
    } catch (e) {
      return usageFail(e instanceof Error ? e.message : String(e));
    }
    if (cmd === "home") {
      try {
        io.stdout(prepareDataDir(io.env));
      } catch (e) {
        if (!(e instanceof DataDirError)) throw e;
        io.stderr(t.error(e.message));
        return EXIT.internal;
      }
      return EXIT.consensus;
    }

    let dataDir: string;
    let dataDirExisted = false;
    try {
      const prepared = prepareDataDir(io.env);
      if (cmd === "doctor") dataDirExisted = existsSync(prepared);
      dataDir = ensureDataDir(prepared);
    } catch (e) {
      if (!(e instanceof DataDirError)) throw e;
      io.stderr(t.error(e.message));
      return EXIT.internal;
    }
    const log = (logger = createLogger(dataDir, "cli", io.env));
    log.info(`Start: council ${cmd}`);
    const argFail = (message: string, withHelp = true) => {
      log.error("Argument error", message);
      if (withHelp) return usageFail(message);
      io.stderr(message);
      return EXIT.usage;
    };
    const code = await (async (): Promise<number> => {
      let registry: Registry | undefined, registryState: "created" | "exists" = "exists";
      if (cmd === "run-prepared") return runPrepared(rest[0]!, dataDir, io, log);
      if (cmd === "cli") {
        if (rest[0] === "candidates") {
          const pm = providerMessages();
          const agents = values.agent ? [values.agent as (typeof CLI_AGENTS)[number]] : CLI_AGENTS;
          // SIGTERM and SIGHUP stop the check like Ctrl+C, so the install is killed and its prefix removed.
          const ctl = new AbortController();
          const stop = () => ctl.abort();
          process.on("SIGTERM", stop);
          process.on("SIGHUP", stop);
          let report;
          try {
            report = await checkCandidates(dataDir, agents, { releases: io.cliPin?.releases ?? npmReleases(io.env), source: io.cliPin?.source ?? npmSource(io.env), builtin: io.cliPin?.builtin, env: io.env, signal: io.signal ? AbortSignal.any([io.signal, ctl.signal]) : ctl.signal, osenVersion: io.appVersion });
          } finally {
            process.off("SIGTERM", stop);
            process.off("SIGHUP", stop);
          }
          if (report.interrupted) {
            io.stderr(t.candidatesInterrupted(report.candidates.filter((c) => c.recorded)));
            return EXIT.internal;
          }
          const violationText = (v: { code: string; name: string }) => v.code === "missing_flag" ? pm.violationMissingFlag(v.name) : v.code === "missing_feature" ? pm.violationMissingFeature(v.name)
            : v.code === "features_unread" ? pm.violationFeaturesUnread : v.code === "help_unread" ? pm.violationHelpUnread(v.name) : pm.violationVersionUnparsed;
          if (values.json) io.stdout(JSON.stringify(candidatesJson(report)));
          else {
            for (const agent of agents) {
              const base = report.bases[agent];
              if (base === undefined) continue;
              io.stdout(`${t.candidatesHeader(agent, base)}`);
              const mine = report.candidates.filter((c) => c.agent === agent);
              if (!mine.length && !report.failures.some((f) => f.agent === agent)) io.stdout(`  ${t.candidatesNone}`);
              for (const c of mine) {
                const label = c.status === "ok" ? t.candidatesFits : c.status === "violates" ? t.candidatesViolates : t.candidatesAlreadyRecorded;
                io.stdout(`  ${c.version}  ${label}${c.status === "ok" && !c.recorded ? ` (${t.candidatesNotRecorded})` : ""}`);
                for (const v of c.violations) io.stdout(`    ${violationText(v)}`);
              }
            }
          }
          for (const f of report.failures) io.stderr(f.reason);
          return report.code;
        }
        // the only place that may install a pinned CLI: an explicit command
        const [sub, agent, version] = rest as [string, string, string];
        const record = io.cliPin?.record ?? loadVerifiedRecord(dataDir);
        if (sub === "accept") {
          // only the explicit accept command calls models; without --max-calls it prints the plan and makes no call
          const planned = await planAcceptance(dataDir, agent, version, { candidate: values.candidate, model: values.model }, { record });
          if (!planned.ok) {
            io.stderr(`${planned.text}\n`);
            return planned.code;
          }
          if (values["max-calls"] === undefined) {
            io.stdout(`${formatPlan(planned.plan)}\n`);
            return EXIT.usage;
          }
          const refusal = checkMaxCalls(planned.plan, Number(values["max-calls"]));
          if (refusal !== undefined) {
            io.stderr(`${refusal}\n`);
            return EXIT.usage;
          }
          let probeNo = 0;
          // Closing the terminal (SIGHUP) or SIGTERM must not leave a probe running and spending a call: stop it like SIGINT does.
          const ctl = new AbortController();
          const stop = () => ctl.abort();
          process.on("SIGTERM", stop);
          process.on("SIGHUP", stop);
          let outcome;
          try {
            outcome = await runAcceptance(dataDir, planned.plan, {
              env: io.env,
              language: getProcessLanguage(),
              signal: io.signal ? AbortSignal.any([io.signal, ctl.signal]) : ctl.signal,
              ...(values["save-fixture"] !== undefined ? { saveFixture: resolve(values["save-fixture"]) } : {}),
              osenVersion: io.appVersion,
              ...(io.cliPin?.inspectLimits ? { inspectLimits: io.cliPin.inspectLimits } : {}),
              onProbe: (o) => io.stdout(`${acceptanceMessages().probeLine(++probeNo, acceptanceMessages().probeName(o.probe), o.ok ? undefined : o.reason ?? "")}\n`),
            });
          } finally {
            process.off("SIGTERM", stop);
            process.off("SIGHUP", stop);
          }
          if (outcome.fixtureError) io.stderr(`${outcome.fixtureError}\n`);
          if (outcome.fixture) io.stdout(`${outcome.fixture}\n`);
          (outcome.code === 0 ? io.stdout : io.stderr)(`${outcome.text}\n`);
          return outcome.code;
        }
        const r = sub === "install" ? await installPin(dataDir, agent, { version: values.version, candidate: values.candidate }, { source: io.cliPin?.source ?? npmSource(io.env), record })
          : sub === "use" ? usePin(dataDir, agent, version, { record })
          : sub === "rollback" ? rollbackPin(dataDir, agent, {})
          : listPins(dataDir, record);
        if (r.ok && (sub === "use" || sub === "rollback")) resetDiscoveryCache();
        (r.ok ? io.stdout : io.stderr)(`${r.text}\n`);
        return r.code;
      }
      if (cmd === "run" || cmd === "providers" || cmd === "resume" || cmd === "doctor") {
        try {
          registryState = await ensureRegistry(dataDir, { env: io.env, deps: io.inspectDeps });
          registry = readRegistry(dataDir);
          logRegistryLoaded(log, dataDir, registry);
        } catch (e) {
          if (!(e instanceof RegistryError)) throw e;
          log.error("Registry error", e.message);
          io.stderr(t.error(e.message));
          return EXIT.usage;
        }
      }
      // lines of one provider; the warning goes to stdout (providers) or stderr (doctor)
      const printProvider = (s: ProviderStatus, warn: (text: string) => void) => {
        const isHttp = s.kind === "openai-http";
        io.stdout([`${s.id}  ${s.kind}  ${s.available ? t.available : t.unavailable(s.reason ?? "")}`, s.version && t.version(s.version), s.path ?? s.baseUrl].filter(Boolean).join("  "));
        if (s.verified) io.stdout(t.verified(s.verified.level, s.verified.checkedAt));
        if (s.warning) warn(t.providerWarning(s.warning));
        if (isHttp) io.stdout(s.keyEnv ? t.key(s.keyEnv, !!s.keySet) : t.keyNotRequired);
        io.stdout(t.models(isHttp ? (s.models.length ? s.models.join(", ") : t.modelsManual(s.id)) : [DEFAULT_MODEL, ...s.models].join(", ")));
        if (!s.modelsConfirmed && s.modelsReason) io.stdout(t.modelsUnconfirmed(s.modelsReason));
      };
      if (cmd === "doctor") {
        const found = await inspectProviders(registry!, { env: io.env, deps: io.inspectDeps, keyFile: envFilePath(dataDir), dataDir });
        const statuses = found.map((f) => f.status);
        statuses.forEach((s) => { if (s.warning) io.stderr(t.providerWarning(s.warning)); });
        const versions = io.processVersions ?? process.versions;
        let writable = true;
        try { accessSync(dataDir, constants.W_OK); } catch { writable = false; }
        const facts = {
          execPath: process.execPath, entry: process.argv[1] ?? null, version: io.appVersion ?? null,
          mode: versions.electron ? "packaged" as const : "node" as const, node: versions.node ?? null,
          language: getProcessLanguage(),
          dataDir: { path: dataDir, exists: dataDirExisted, writable },
          config: { path: configPath(dataDir), created: registryState === "created" },
          providers: statuses,
        };
        if (values.json) {
          io.stdout(JSON.stringify(doctorJson(facts)));
          return EXIT.consensus;
        }
        io.stdout(t.doctorBinary(facts.execPath, facts.entry ?? t.unknown));
        io.stdout(t.doctorVersion(facts.version ?? t.unknown));
        io.stdout(facts.mode === "packaged" ? t.doctorRuntimePackaged(facts.node ?? t.unknown) : t.doctorRuntimeNode(facts.node ?? t.unknown));
        io.stdout(t.doctorLanguage(facts.language));
        io.stdout(t.doctorDataDir(dataDir, facts.dataDir.exists, writable));
        io.stdout(t.doctorConfig(facts.config.path, facts.config.created));
        io.stdout(t.doctorProviders(statuses.length));
        statuses.forEach((s) => printProvider(s, () => {}));
        return EXIT.consensus;
      }
      if (cmd === "providers") {
        if (values.json) {
          const all = await inspectProviders(registry!, { env: io.env, deps: io.inspectDeps, keyFile: envFilePath(dataDir), dataDir });
          all.forEach(({ status: s }) => { if (s.warning) io.stderr(t.providerWarning(s.warning)); });
          io.stdout(JSON.stringify(providersJson(all.map((f) => f.status))));
          return EXIT.consensus;
        }
        if (!registry!.providers.length) {
          io.stdout(t.noProviders(configPath(dataDir)));
          return EXIT.consensus;
        }
        for (const { status: s } of await inspectProviders(registry!, { env: io.env, deps: io.inspectDeps, keyFile: envFilePath(dataDir), dataDir })) {
          printProvider(s, io.stdout);
        }
        return EXIT.consensus;
      }
      const catalog = () => loadTemplates({ builtinDir: io.builtinTemplatesDir ?? BUILTIN_TEMPLATES_DIR, userDir: userTemplatesDir(dataDir) });
      const sourceText = (src: string) => (src === "user" ? t.userSource : t.builtinSource);
      if (cmd === "templates") {
        const c = catalog();
        if (values.json) {
          io.stdout(JSON.stringify(templatesJson(c)));
          return EXIT.consensus;
        }
        if (!c.templates.length) io.stdout(t.noTemplates);
        for (const tp of c.templates) io.stdout(`${tp.id}  ${tp.category}  ${tp.title}  ${sourceText(tp.source)}`);
        if (c.errors.length) {
          io.stdout(t.loadErrors);
          for (const er of c.errors) io.stdout(`  ${er.file} (${sourceText(er.source)}): ${er.reason}`);
        }
        return EXIT.consensus;
      }
      if (cmd === "lineups") {
        try {
          if (!rest.length) {
            const all = readLineups(dataDir);
            if (values.json) {
              io.stdout(JSON.stringify(lineupsJson(all)));
              return EXIT.consensus;
            }
            if (!all.length) io.stdout(t.noLineups);
            for (const l of all) {
              io.stdout(`${l.id}  ${l.name}`);
              l.participants.forEach((p, i) => io.stdout(`  ${i + 1}. ${p.providerId}:${p.model}${p.role !== null ? ` — ${p.role}` : ""}`));
            }
            return EXIT.consensus;
          }
          const id = values["from-session"]!;
          const s = readSession(dataDir, id);
          if (s === null) return argFail(t.sessionNotFoundOrDamaged(id), false);
          const l = await saveLineup(dataDir, { name: rest[1]!, participants: slotRoster(s.state.session!).map((p) => ({ providerId: p.providerId, model: p.model, role: p.role })) });
          io.stdout(t.lineupSaved(l.id, l.name, l.participants.length));
          io.stdout(t.lineupRun(l.id));
          return EXIT.consensus;
        } catch (e) {
          if (e instanceof LineupsError) return argFail(e.message, false);
          throw e;
        }
      }
      if (cmd === "list") {
        const all = listSessions(dataDir, undefined, (id, e) => {
          const reason = (e as NodeJS.ErrnoException)?.code ?? (e instanceof Error ? e.message : String(e));
          log.error("Session journal not read", `${id}: ${reason}`);
          io.stderr(t.sessionNotRead(id, reason));
        });
        if (values.json) {
          io.stdout(JSON.stringify(listJson(all)));
          return EXIT.consensus;
        }
        if (!all.length) io.stdout(t.noSessions);
        for (const s of all) {
          const tp = s.topic.replace(/\s*[\r\n]+\s*/g, " ");
          io.stdout(`${s.id}  ${s.createdAt}  ${statusLabel(s.status, s.partial)}  ${s.origin}  ${tp.length > 60 ? `${tp.slice(0, 60)}…` : tp}`);
        }
        if (all.some((s) => s.partial?.reason === "newer_version")) io.stdout(t.updateAdvice);
        return EXIT.consensus;
      }
      if (cmd === "show") {
        const id = rest[0]!;
        const s = readSession(dataDir, id);
        if (s === null) return argFail(t.sessionNotFound(id), false);
        if (values.json) {
          io.stdout(JSON.stringify(showJson(id, s.status, s.partial, s.state)));
          return EXIT.consensus;
        }
        formatShow(readEvents(dataDir, id)?.events ?? [], s.status, s.partial, snapshotReader(dataDir, id)).forEach((l) => io.stdout(l));
        return EXIT.consensus;
      }
      if (cmd === "stop") {
        const id = rest[0]!;
        try {
          requestStop(dataDir, id);
        } catch (e) {
          if (e instanceof StopRejectedError) return argFail(e.message, false);
          throw e;
        }
        io.stdout(t.stopRequested(id));
        return EXIT.consensus;
      }

      if (cmd === "status") {
        const id = rest[0]!;
        const s = readSession(dataDir, id);
        if (s === null) return argFail(t.sessionNotFound(id), false);
        if (values.json) {
          io.stdout(JSON.stringify(statusJson(id, s.status, s.partial, s.state)));
          return EXIT.consensus;
        }
        formatStatus(id, s.status, s.partial, s.state, Date.now()).forEach((l) => io.stdout(l));
        return EXIT.consensus;
      }
      if (cmd === "continue") {
        const id = rest[0]!;
        let waitId: string;
        try {
          ({ waitId } = requestOwnerRelease(dataDir, id));
        } catch (e) {
          if (e instanceof OwnerReleaseRejectedError) return argFail(e.message, false);
          const message = e instanceof Error ? e.message : String(e);
          log.error("Failed to write the request", e);
          io.stderr(t.requestWriteFailed(message));
          return EXIT.internal;
        }
        io.stdout(t.continueRequested(id, waitId));
        return EXIT.consensus;
      }
      if (cmd === "say") {
        const id = rest[0]!;
        try {
          requestOwnerMessage(dataDir, id, rest[1]!, values.answer === undefined ? {} : { questionId: values.answer });
        } catch (e) {
          if (e instanceof OwnerMessageRejectedError) return argFail(e.message, false);
          const message = e instanceof Error ? e.message : String(e);
          log.error("Failed to write the message", e);
          io.stderr(t.messageWriteFailed(message));
          return EXIT.internal;
        }
        io.stdout(values.answer === undefined
          ? t.messageRequested(id)
          : t.answerRequested(values.answer, id));
        return EXIT.consensus;
      }

      if (cmd === "resume") {
        const id = rest[0]!;
        let replacements: ReplacementInput[];
        try {
          replacements = (values.replace ?? []).map((raw) => {
            const eq = raw.indexOf("=");
            const pid = raw.slice(0, eq), record = raw.slice(eq + 1);
            if (eq < 0 || !/^p[1-9]\d*$/.test(pid) || !record.trim()) throw new UsageError(t.replaceFormat(raw));
            const part = parseParticipant(record, 0, registry!);
            // the default name of registry providers does not depend on the number; for scripted ones the core gives it ("Participant N" by the new identifier)
            const named = /^[^=:]+=/.test(record) || part.providerId !== "scripted";
            return { participantId: pid, providerId: part.providerId, model: part.model, ...(named ? { name: part.name } : {}) };
          });
        } catch (e) {
          if (e instanceof UsageError) return argFail(e.message);
          throw e;
        }
        let run;
        try {
          const plan = planResume(dataDir, id, {
            rounds, ...(maxTokens !== undefined ? { maxTotalTokens: maxTokens } : values["no-max-tokens"] ? { maxTotalTokens: null } : {}),
            ...(replacements.length ? { replacements } : {}),
            ...(values.message ? { message: values.message[0]! } : {}),
          });
          const driverOptions = { registry: registry!, env: io.env, dataDir, deps: io.inspectDeps };
          const { drivers, warnings, unavailable } = await resumeDrivers(plan, driverOptions);
          warnings.forEach((w) => io.stderr(t.warning(w)));
          io.stdout(t.resumePlan(id, plan.addedRounds, plan.maxRounds, plan.maxCalls, plan.active.length, plan.draftCalls));
          const src = readMaterialSources(dataDir, id);
          if (src === null) io.stdout(t.linkSourcesUnreadable(SOURCES_FILE));
          else if (src.length) {
            io.stdout(t.linkSources(src.length));
            src.forEach((s) => io.stdout(`  ${formatSource(s)}`));
          }
          if (plan.replacements.length) {
            for (const r of plan.replacements) {
              const old = plan.session.participants.find((p) => p.id === r.oldParticipantId)!, n = r.participant;
              const why = r.wasActive ? t.replacementWhyUnavailable(String(unavailable[old.id])) : t.replacementWhyDropped(String(r.dropReason));
              io.stdout(t.replacement(old.id, old.name, n.id, n.name, n.providerId, n.model, why));
            }
            io.stdout(t.agreementsReset);
            io.stdout(t.activeLineup(plan.active.map((p) => `${p.id} «${p.name}»`).join(", ")));
          }
          const w = plan.state.waiting;
          if (w !== null) {
            io.stdout(Date.parse(w.deadline) > Date.now()
              ? t.waitContinues(w.waitId, w.deadline, id)
              : t.waitExpiredResume(w.waitId));
          }
          if (plan.tokenCap !== null || values["no-max-tokens"]) io.stdout(t.tokenCapResume(String(plan.tokenCap ?? t.noCap), plan.spentTokens));
          let streamed = false;
          run = await runResumedSession({
            dataDir, plan, drivers, signal: io.signal, logger: log,
            ...(plan.replacements.length ? { revalidate: () => resumeDrivers(plan, driverOptions) } : {}),
            onAccepted: ({ droppedOwnerRequests: dropped }) => {
              if (!dropped.length) return;
              io.stdout(t.droppedRequests(dropped.length, id));
              dropped.forEach((r) => io.stdout(`  ${r.text}`));
            },
            onChunk: io.chunk && ((c) => { streamed = true; io.chunk!(c.text); }),
            onEvent: (e, s) => {
              if (streamed) { io.chunk?.("\n"); streamed = false; }
              formatEvent(e, s, id, true, snapshotReader(dataDir, id)).forEach((l) => io.stdout(l));
            },
          });
        } catch (e) {
          if (!(e instanceof ResumeRejectedError)) throw e;
          log.error("Resume rejected", e.reason);
          io.stderr(t.error(e.message));
          if (e.reason === "consensus") io.stderr(t.consensusNeedsMessage(id));
          return EXIT.usage;
        }
        formatSummary(run.state).forEach((l) => io.stdout(l));
        return EXIT[run.state.finish!.status];
      }

      const reg = registry!;
      const urlOptions = { ...(io.urlTransport ? { transport: io.urlTransport } : {}), ...(io.urlWorker ? { worker: io.urlWorker } : {}) };
      const collectOptions = (materialsChars: number) => ({
        materialsChars, materialsIgnore: reg.defaults.materialsIgnore,
        ...(values["no-ignore"] ? { gitignore: false } : {}),
        ...(values.include ? { include: includePaths(values.include, values.attach ?? []) } : {}),
      });
      if (values["preview-materials"]) {
        try {
          const limit = intFlag("--materials-chars", values["materials-chars"]) ?? reg.defaults.materialsChars;
          const urls = await collectUrlMaterials(values.url ?? [], urlOptions);
          const set = collectSessionMaterialsWithUrls(values.attach ?? [], collectOptions(limit), urls);
          const saved = savePreparedMaterials(dataDir, { materials: set.materials, workspace: set.workspace, skipped: set.skipped, left: set.left, materialsChars: limit, stamp: "cli", sources: set.sources });
          const view = buildMaterialsPreview({ language: getProcessLanguage(), materials: set.materials, workspace: set.workspace, skipped: set.skipped, left: set.left });
          printMaterials(io, log, set, limit);
          io.stdout("");
          if (view.initial !== null) io.stdout(view.initial);
          if (view.manifest !== null) io.stdout(view.manifest);
          io.stdout("");
          io.stdout(t.preparedSaved(saved.id));
          io.stdout(t.preparedRun(saved.id));
          log.info(`Materials preview: set ${saved.id}`);
          return EXIT.consensus;
        } catch (e) {
          if (e instanceof UsageError) return argFail(e.message);
          if (e instanceof MaterialsError) return argFail(t.materialsRejected(e.reasons.map((r) => `  ${r}`).join("\n")), false);
          if (e instanceof PreparedMaterialsError) return argFail(t.preparedNotCreated(e.message), false);
          throw e;
        }
      }
      let session, drivers: Record<string, ParticipantDriver>, materials: MaterialSet["materials"] | undefined, workspace: FolderFile[] = [], sources: MaterialSource[] = [];
      try {
        if (!values.topic?.trim()) throw new UsageError(t.topicRequired);
        if (values.template !== undefined && !values.template.trim()) throw new UsageError(t.templateNeedsId);
        const preparedSet = prepared !== undefined ? loadPreparedMaterials(dataDir, prepared) : undefined;
        const limits = {
          maxRounds: intFlag("--max-rounds", values["max-rounds"]),
          turnTimeoutSec: intFlag("--turn-timeout", values["turn-timeout"], MAX_TURN_TIMEOUT_SEC),
          contextChars: intFlag("--context-chars", values["context-chars"]),
          materialsChars: preparedSet ? preparedSet.materialsChars : intFlag("--materials-chars", values["materials-chars"]),
          maxTotalTokens: maxTokens,
        };
        const runtimes = new Map<string, Awaited<ReturnType<typeof inspectProvider>>>();
        let parts: Part[], lineupRoles: (string | null)[] | undefined;
        if (values.lineup !== undefined) {
          const id = values.lineup;
          const lineup = readLineups(dataDir).find((l) => l.id === id);
          if (!lineup) return argFail(t.lineupNotFound(id), false);
          const used = reg.providers.filter((p) => lineup.participants.some((x) => x.providerId === p.id));
          const inspected = await Promise.all(used.map((p) => inspectProvider(p, { env: io.env, deps: io.inspectDeps, keyFile: envFilePath(dataDir), dataDir })));
          for (const f of inspected) {
            runtimes.set(f.status.id, f);
            if (f.status.warning) io.stderr(t.providerWarn(f.status.id, f.status.warning));
          }
          const check = checkLineup(lineup, {
            registry: reg, statuses: inspected.map((f) => f.status),
            scripted: io.env.COUNCIL_DEV === "1" ? (model) => (existsSync(model) ? null : t.scenarioNotFound(model)) : null,
          });
          check.participants.forEach((p, i) => {
            if (p.modelNote) io.stderr(t.positionWarn(i + 1, p.providerId, p.model, p.modelNote));
          });
          if (!check.available) {
            log.error("Lineup unavailable", check.id);
            io.stderr([t.lineupUnavailable(check.name), ...check.participants.flatMap((p, i) => (p.available ? [] : [`  ${i + 1}. ${p.providerId}:${p.model} — ${p.reason}`]))].join("\n"));
            return EXIT.usage;
          }
          parts = lineup.participants.map((p, i) => {
            const provider = reg.providers.find((x) => x.id === p.providerId);
            return { name: participantName(provider, p.model, i), providerId: p.providerId, model: p.model, ...(provider ? { provider } : {}) };
          });
          lineupRoles = lineup.participants.map((p) => p.role);
          io.stdout(t.lineup(lineup.name, lineup.id));
        } else {
          const raws = values.participant ?? reg.defaults.participants.map((p) => `${p.providerId}:${p.model}`);
          if (!raws.length) {
            throw new UsageError(t.noParticipants(configPath(dataDir)));
          }
          parts = raws.map((r, i) => parseParticipant(r, i, reg));
        }
        if (values.attach?.some((a) => !a.trim())) throw new UsageError(t.attachNeedsPath);
        const input = templateSessionInput({
          catalog: catalog(), templateId: values.template, topic: values.topic, origin: "cli",
          participants: parts.map((p) => ({ name: p.name, providerId: p.providerId, model: p.model })),
          limits, defaults: reg.defaults, framing: values.framing, noTokenCap: values["no-max-tokens"],
        });
        if (lineupRoles) input.participants.forEach((p, i) => { p.role = lineupRoles[i]!; });
        if (values.drafts) input.drafts = { ...(values.synthesizer !== undefined ? { synthesizerId: values.synthesizer } : {}) };
        if (values["pause-after-round"] || values["wait-for-owner"]) {
          input.ownerWait = {
            ...(values["pause-after-round"] ? { pauseAfterRound: true } : {}),
            ...(values["wait-for-owner"] ? { waitForOwner: true } : {}),
            ...(waitSec !== undefined ? { timeoutSec: waitSec } : {}),
          };
        }
        if (preparedSet) {
          io.stdout(t.preparedSet(preparedSet.id));
          printMaterials(io, log, preparedSet, preparedSet.materialsChars);
          ({ materials, workspace, sources } = preparedSet);
        } else if (values.attach?.length || values.url?.length) {
          const limit = input.limits.materialsChars!;
          const urls = await collectUrlMaterials(values.url ?? [], urlOptions);
          const set = collectSessionMaterialsWithUrls(values.attach ?? [], collectOptions(limit), urls);
          printMaterials(io, log, set, limit);
          ({ materials, workspace, sources } = set);
        }
        session = createSession({ ...input, ...(materials ? { materials } : {}), ...(workspace.length ? { workspace } : {}) }, { maxParticipants: reg.defaults.maxParticipants });
        drivers = {};
        for (const [i, p] of parts.entries()) {
          if (!p.provider) {
            const scenario = await readScenario(p.model).catch((e: Error) => { throw new UsageError(e.message); });
            drivers[`p${i + 1}`] = createScriptedDriver(scenario, io.env);
            continue;
          }
          let found = runtimes.get(p.providerId);
          if (!found) {
            found = await inspectProvider(p.provider, { env: io.env, withModels: false, deps: io.inspectDeps, keyFile: envFilePath(dataDir), dataDir });
            runtimes.set(p.providerId, found);
            if (found.status.warning) io.stderr(t.providerWarn(p.providerId, found.status.warning));
          }
          if (!found.runtime && !found.http) {
            log.error("Provider unavailable", p.providerId);
            io.stderr(t.providerUnavailable(p.providerId, String(found.status.reason)));
            return EXIT.usage;
          }
          drivers[`p${i + 1}`] = found.runtime ? createCliDriver(found.runtime) : createHttpDriver(found.http!);
        }
      } catch (e) {
        if (e instanceof UsageError || e instanceof SessionInputError || e instanceof ScriptedUnavailableError) {
          return argFail(e.message);
        }
        if (e instanceof LineupsError) return argFail(e.message, false);
        if (e instanceof MaterialsError) return argFail(t.materialsRejected(e.reasons.map((r) => `  ${r}`).join("\n")), false);
        if (e instanceof PreparedMaterialsError) return argFail(t.preparedNotAccepted(e.message), false);
        if (e instanceof UnknownTemplateError) return argFail(t.templatesHint(e.message));
        throw e;
      }

      const cap = session.limits.maxTotalTokens;
      const capLine = cap !== undefined ? t.capLine(cap, maxTokens === undefined) : values["no-max-tokens"] ? t.capNone : undefined;
      let streamed = false;
      const { state } = await runStoredSession({
        session, drivers, materials, ...(workspace.length ? { workspace } : {}), ...(sources.length ? { sources } : {}), signal: io.signal, dataDir, logger: log,
        onChunk: io.chunk && ((c) => { streamed = true; io.chunk!(c.text); }),
        onEvent: (e, s) => {
          if (streamed) { io.chunk?.("\n"); streamed = false; }
          formatEvent(e, s, session.id, true, snapshotReader(dataDir, session.id)).forEach((l) => io.stdout(l));
          if (e.type === "session_created" && capLine) io.stdout(capLine);
          if (e.type === "session_created" && session.drafts) {
            const synth = session.drafts.synthesizerId, name = session.participants.find((p) => p.id === synth)?.name ?? synth;
            io.stdout(t.draftsExperiment(synth, name, values.synthesizer === undefined, maxCallsBound(session.participants.length, session.limits.maxRounds, true), session.participants.length, session.limits.maxRounds));
          }
          if (e.type === "session_created" && session.ownerWait) {
            const w = session.ownerWait;
            const modes = [w.pauseAfterRound && t.waitModePause, w.waitForOwner && t.waitModeAnswer].filter(Boolean).join("; ");
            io.stdout(t.ownerWait(modes, w.timeoutSec ?? OWNER_WAIT_DEFAULT_SEC));
          }
        },
      });
      formatSummary(state).forEach((l) => io.stdout(l));
      return EXIT[state.finish!.status];
    })();
    log.info(`Exit: code ${code}`);
    return code;
  } catch (e) {
    logger?.error("Internal error", e);
    io.stderr(t.internalError(e instanceof Error ? e.message : String(e)));
    return EXIT.internal;
  }
}
