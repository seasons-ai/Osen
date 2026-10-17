import { PreparedMaterialsError, createCliDriver, createHttpDriver, createScriptedDriver, createSession, DEFAULT_MODEL, OWNER_WAIT_MAX_SEC, ResumeRejectedError, SessionInputError, envFilePath, inspectProvider, isValidSessionId, loadPreparedMaterials, planResume, readScenario, readSession, resumeDrivers, runResumedSession, runStoredSession, scriptedDevOnlyMessage, templateSessionInput, UnknownTemplateError } from "@model-council/core";
import type { CollectedMaterial, FolderFile, MaterialSource, Logger, ParticipantDriver, Registry, StreamChunk, TemplateCatalog } from "@model-council/core";
import { PREVIEW_RETRY_CODE, ROUNDS_BOUNDS, SCRIPTED_PROVIDER_ID, rosterNames, scriptedProviderLabel } from "../shared/setup.ts";
import { launch as msg } from "../shared/messages/launch.ts";
import type { StartInput } from "../shared/setup.ts";
import { nameReplacements, ReplacementInputError, resumeScenarioPath } from "./resume.ts";
import { providerNames } from "./setup-data.ts";
import type { ResumeReplacement } from "../shared/bridge.ts";

export class LaunchError extends Error { // the message is shown to the owner as is
  readonly code: typeof PREVIEW_RETRY_CODE | undefined;
  constructor(message: string, code?: typeof PREVIEW_RETRY_CODE) { super(message); this.code = code; }
}

export interface LauncherDeps {
  dataDir: string;
  env: Record<string, string | undefined>;
  logger: Logger;
  registry(): Registry;
  catalog(): TemplateCatalog;
  scenarioPath(model: string): string | null; // null — the scenario is unknown or scripted participants are disabled
  materials?: { take(): CollectedMaterial[]; snapshot?(): { sources: MaterialSource[] }; workspace?(): FolderFile[]; clear(): unknown; stamp?(): string }; // the owner's materials draft
  inspect?: typeof inspectProvider;
  run?: typeof runStoredSession;
  onChunk?(id: string, chunk: StreamChunk): void;
  onEnded?(id: string): void;
}

const bad = (what: string) => new LaunchError(msg().badRequest(what));
const str = (v: unknown): v is string => typeof v === "string";
const capOk = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

// The request comes from the renderer: the trust boundary is checked by hand.
function parseInput(raw: unknown): StartInput {
  if (typeof raw !== "object" || raw === null) throw bad(msg().reqObject);
  const r = raw as Record<string, unknown>;
  if (r.templateId !== null && !str(r.templateId)) throw bad(msg().reqTemplateId);
  if (!str(r.topic)) throw bad(msg().reqTopic);
  if (!Array.isArray(r.participants)) throw bad(msg().reqParticipants);
  const participants = r.participants.map((p: unknown, i) => {
    const o = typeof p === "object" && p !== null ? (p as Record<string, unknown>) : null;
    if (!o || !str(o.providerId) || !o.providerId || !str(o.model) || !o.model) throw bad(msg().reqParticipantFields(i + 1));
    if (o.role !== null && !str(o.role)) throw bad(msg().reqParticipantRole(i + 1));
    return { providerId: o.providerId, model: o.model, role: o.role };
  });
  if (!Number.isInteger(r.maxRounds)) throw bad(msg().reqMaxRounds);
  if (r.useMaterials !== undefined && typeof r.useMaterials !== "boolean") throw bad(msg().reqUseMaterials);
  if (r.framingFrom !== undefined && (!str(r.framingFrom) || !isValidSessionId(r.framingFrom))) throw bad(msg().reqFramingFrom);
  if (r.preparedHandle !== undefined && !str(r.preparedHandle)) throw bad(msg().reqPreparedHandle);
  if (r.maxTotalTokens !== undefined && r.maxTotalTokens !== null && !capOk(r.maxTotalTokens)) throw bad(msg().reqMaxTotalTokens);
  let drafts: StartInput["drafts"];
  if (r.drafts !== undefined) {
    const d = r.drafts as Record<string, unknown> | null;
    const n = typeof d?.synthesizerId === "string" && /^p[1-9]\d*$/.test(d.synthesizerId) ? Number(d.synthesizerId.slice(1)) : 0;
    if (typeof d !== "object" || d === null || Array.isArray(d) || n < 1 || n > participants.length) throw bad(msg().reqDrafts);
    drafts = { synthesizerId: d.synthesizerId as string };
  }
  let ownerWait: StartInput["ownerWait"];
  if (r.ownerWait !== undefined) {
    if (typeof r.ownerWait !== "object" || r.ownerWait === null || Array.isArray(r.ownerWait)) throw bad(msg().reqOwnerWaitObject);
    const w = r.ownerWait as Record<string, unknown>;
    if (typeof w.pauseAfterRound !== "boolean" || typeof w.waitForOwner !== "boolean") throw bad(msg().reqOwnerWaitFlags);
    if (typeof w.timeoutSec !== "number" || !Number.isInteger(w.timeoutSec) || w.timeoutSec < 1 || w.timeoutSec > OWNER_WAIT_MAX_SEC) throw bad(msg().reqOwnerWaitTimeout(OWNER_WAIT_MAX_SEC));
    if (!w.pauseAfterRound && !w.waitForOwner) throw bad(msg().reqOwnerWaitMode);
    ownerWait = { pauseAfterRound: w.pauseAfterRound, waitForOwner: w.waitForOwner, timeoutSec: w.timeoutSec };
  }
  return { templateId: r.templateId, topic: r.topic, participants, maxRounds: r.maxRounds as number, useMaterials: r.useMaterials === true, ...(r.maxTotalTokens !== undefined ? { maxTotalTokens: r.maxTotalTokens as number | null } : {}), ...(r.framingFrom !== undefined ? { framingFrom: r.framingFrom } : {}), ...(r.preparedHandle !== undefined ? { preparedHandle: r.preparedHandle } : {}), ...(ownerWait ? { ownerWait } : {}), ...(drafts ? { drafts } : {}) };
}

export function createLauncher(deps: LauncherDeps): {
  start(input: unknown): Promise<{ id: string }>;
  resume(id: string, rounds: number, maxTotalTokens?: number | null, replacements?: ResumeReplacement[]): Promise<{ droppedOwnerRequests: string[] }>;
  running(): string[];
} {
  const { dataDir, env, logger } = deps;
  let pending: Promise<{ id: string }> | null = null;
  const resumeKeys = new Map<string, string>(); // parameters of the running resume request: a repeat with others is not accepted
  const resuming = new Map<string, Promise<{ droppedOwnerRequests: string[] }>>(); // resumes that have not yet written the first event
  const active = new Set<string>(); // started or resumed from the app and not yet finished

  async function launch(raw: unknown): Promise<{ id: string }> {
    const input = parseInput(raw);
    const { min, max } = ROUNDS_BOUNDS;
    if (input.maxRounds < min || input.maxRounds > max) throw new LaunchError(msg().roundsOutOfBounds(min, max));
    const registry = deps.registry();
    const catalog = deps.catalog();
    const names = rosterNames(input.participants, [
      ...registry.providers.map((p) => ({ id: p.id, label: p.label, defaultModel: p.kind === "cli" ? DEFAULT_MODEL : null })),
      { id: SCRIPTED_PROVIDER_ID, label: scriptedProviderLabel(), defaultModel: null },
    ]);
    let framing: string | undefined;
    if (input.framingFrom) {
      framing = readSession(dataDir, input.framingFrom)?.state.session?.framing;
      if (framing === undefined) throw new LaunchError(msg().framingMissing(input.framingFrom));
    }
    const startOf = (templateId: string | null) => templateSessionInput({
      catalog, templateId, topic: input.topic, origin: "desktop",
      participants: input.participants.map((p, i) => ({ name: names[i]!, providerId: p.providerId, model: p.model })),
      limits: { maxRounds: input.maxRounds, ...(typeof input.maxTotalTokens === "number" ? { maxTotalTokens: input.maxTotalTokens } : {}) },
      defaults: registry.defaults, ...(input.maxTotalTokens === null ? { noTokenCap: true } : {}),
      ...(framing !== undefined ? { framing } : {}),
    });
    let base;
    try {
      base = startOf(input.templateId);
    } catch (e) {
      if (framing === undefined || !(e instanceof UnknownTemplateError)) throw e;
      base = startOf(null); // template deleted after filling: the previous session frame, without a template
    }
    if (input.ownerWait) base.ownerWait = {
      ...(input.ownerWait.pauseAfterRound ? { pauseAfterRound: true } : {}),
      ...(input.ownerWait.waitForOwner ? { waitForOwner: true } : {}),
      timeoutSec: input.ownerWait.timeoutSec,
    };
    let prepared;
    if (input.preparedHandle !== undefined) {
      try {
        prepared = loadPreparedMaterials(dataDir, input.preparedHandle);
      } catch (e) {
        if (!(e instanceof PreparedMaterialsError)) throw e;
        logger.info(`Start by a prepared set rejected: ${e.problem}`);
        throw new LaunchError(`${e.message}. ${msg().previewRetry}`, PREVIEW_RETRY_CODE);
      }
      if (prepared.stamp !== deps.materials?.stamp?.()) {
        logger.info("Start by a prepared set rejected: stale");
        throw new LaunchError(`${msg().previewStale} ${msg().previewRetry}`, PREVIEW_RETRY_CODE);
      }
    }
    const taken = prepared ? prepared.materials : input.useMaterials ? deps.materials?.take() ?? [] : [];
    const materials = taken.length > 0 ? taken : undefined;
    const folder = prepared ? prepared.workspace : input.useMaterials ? deps.materials?.workspace?.() ?? [] : [];
    const workspace = folder.length > 0 ? folder : undefined; // folder snapshot: participants read files on request
    const linked = prepared ? prepared.sources : input.useMaterials ? deps.materials?.snapshot?.().sources ?? [] : [];
    const sources = linked.length > 0 ? linked : undefined; // link sources: written next to the snapshots
    let session;
    try {
      session = createSession(
        { ...base, participants: base.participants.map((p, i) => ({ ...p, role: input.participants[i]!.role?.trim() || null })), ...(materials ? { materials } : {}), ...(workspace ? { workspace } : {}), ...(input.drafts ? { drafts: { synthesizerId: input.drafts.synthesizerId } } : {}) },
        { maxParticipants: registry.defaults.maxParticipants },
      );
    } catch (e) {
      if (e instanceof SessionInputError) throw new LaunchError(e.message);
      throw e;
    }

    const drivers: Record<string, ParticipantDriver> = {};
    const found = new Map<string, Awaited<ReturnType<typeof inspectProvider>>>();
    for (const [i, p] of input.participants.entries()) {
      if (p.providerId === SCRIPTED_PROVIDER_ID) {
        if (env.COUNCIL_DEV !== "1") throw new LaunchError(scriptedDevOnlyMessage());
        const path = deps.scenarioPath(p.model);
        if (path === null) throw new LaunchError(msg().scenarioUnavailable(p.model));
        drivers[`p${i + 1}`] = createScriptedDriver(await readScenario(path), env);
        continue;
      }
      const provider = registry.providers.find((x) => x.id === p.providerId);
      if (!provider) throw new LaunchError(msg().providerNotInRegistry(p.providerId));
      let r = found.get(p.providerId);
      if (!r) {
        r = await (deps.inspect ?? inspectProvider)(provider, { env, withModels: false, keyFile: envFilePath(dataDir) });
        found.set(p.providerId, r);
      }
      if (!r.runtime && !r.http) throw new LaunchError(msg().providerUnavailable(provider.label, r.status.reason ?? msg().reasonUnknown));
      drivers[`p${i + 1}`] = r.runtime ? createCliDriver(r.runtime) : createHttpDriver(r.http!);
    }

    logger.info(`Session start from the app: template ${input.templateId ?? "none"}, participants ${input.participants.length}, round limit ${input.maxRounds}, materials ${materials?.length ?? 0}, size ${materials?.reduce((n, m) => n + m.chars, 0) ?? 0}, folder files ${workspace?.length ?? 0}${sources ? `, link sources ${sources.length}` : ""}${prepared ? `, prepared set ${prepared.id}` : ""}${input.framingFrom ? `, framing from session ${input.framingFrom}` : ""}${session.limits.maxTotalTokens === undefined ? ", no token cap" : `, token cap ${session.limits.maxTotalTokens}`}, independent drafts: ${session.drafts ? `synthesizer ${session.drafts.synthesizerId}` : "none"}, owner wait: ${input.ownerWait ? `${[input.ownerWait.pauseAfterRound && "pause after round", input.ownerWait.waitForOwner && "answer to a question"].filter(Boolean).join(", ")}, timeout ${input.ownerWait.timeoutSec} s` : "none"}`);
    // Resolve on the first event (session_created is already in the journal); do not wait for the end of the discussion.
    return new Promise((resolve, reject) => {
      active.add(session.id);
      let cleared = false;
      const onEvent = () => {
        if ((materials || workspace) && !cleared) { cleared = true; deps.materials?.clear(); } // the start succeeded — the draft is handed to the session
        resolve({ id: session.id });
      };
      (deps.run ?? runStoredSession)({ session, drivers, dataDir, logger, onEvent, ...(materials ? { materials } : {}), ...(workspace ? { workspace } : {}), ...(sources ? { sources } : {}), onChunk: (c) => deps.onChunk?.(session.id, c) })
        .catch(reject) // reject after resolve is a no-op; the error is already recorded by runStoredSession
        .finally(() => {
          active.delete(session.id);
          deps.onEnded?.(session.id);
        });
    });
  }

  async function resumeRun(id: string, rounds: number, cap?: number | null, replacements?: ResumeReplacement[]): Promise<{ droppedOwnerRequests: string[] }> {
    const { min, max } = ROUNDS_BOUNDS;
    if (!Number.isInteger(rounds) || rounds < min || rounds > max) throw new LaunchError(msg().resumeRounds(min, max));
    if (cap !== undefined && cap !== null && !capOk(cap)) throw new LaunchError(msg().resumeCap);
    let named: ReturnType<typeof nameReplacements> | undefined;
    if (replacements !== undefined) {
      try {
        named = nameReplacements(replacements, readSession(dataDir, id)?.state.session?.participants ?? [], providerNames(deps.registry()), deps.scenarioPath);
      } catch (e) {
        if (e instanceof ReplacementInputError) throw new LaunchError(e.message);
        throw e;
      }
    }
    logger.info(`Resume request for session ${id}: rounds ${rounds}, replacements ${named?.length ?? 0}`);
    try {
      const plan = planResume(dataDir, id, { rounds, ...(cap !== undefined ? { maxTotalTokens: cap } : {}), ...(named?.length ? { replacements: named } : {}) });
      const driverOptions = { registry: deps.registry(), env, dataDir, scenarioPath: resumeScenarioPath(deps.scenarioPath) };
      const { drivers } = await resumeDrivers(plan, driverOptions);
      return await new Promise((resolve, reject) => {
        let dropped: string[] = [];
        active.add(id);
        // Resolve on the first event of the segment (session_resumed is already in the journal); do not wait for the end of the discussion.
        runResumedSession({
          dataDir, plan, drivers, logger,
          ...(plan.replacements.length > 0 ? { revalidate: () => resumeDrivers(plan, driverOptions) } : {}),
          onAccepted: (a) => {
            dropped = a.droppedOwnerRequests.map((r) => r.text);
            logger.info(`Resume of session ${id} accepted: unapplied messages removed ${dropped.length}`);
          },
          onEvent: () => resolve({ droppedOwnerRequests: dropped }),
          onChunk: (c) => deps.onChunk?.(id, c),
        })
          .catch(reject) // reject after resolve is a no-op; the error is already recorded by runResumedSession
          .finally(() => {
            active.delete(id);
            deps.onEnded?.(id);
          });
      });
    } catch (e) {
      if (e instanceof ResumeRejectedError) logger.info(`Resume of session ${id} rejected: ${e.reason}`);
      throw e;
    }
  }

  return {
    resume(id, rounds, cap, replacements) {
      const prev = resuming.get(id);
      // undefined for the ceiling ("do not change") and null ("remove") are different requests; the order of replacements does not matter
      const rs = Array.isArray(replacements) ? [...replacements].sort((a, b) => String(a?.participantId).localeCompare(String(b?.participantId), "en", { numeric: true })) : replacements;
      const key = JSON.stringify([rounds, cap === undefined ? "keep" : cap, rs?.length ? rs : null]);
      if (prev) {
        if (resumeKeys.get(id) !== key) {
          logger.info(`Repeated resume request for session ${id} with other parameters rejected`);
          return Promise.reject(new LaunchError(msg().resumeBusy));
        }
        logger.info(`Repeated resume request for session ${id}: the already starting resume returned`);
        return prev;
      }
      const p = resumeRun(id, rounds, cap, replacements).finally(() => { if (resuming.get(id) === p) { resuming.delete(id); resumeKeys.delete(id); } });
      resuming.set(id, p);
      resumeKeys.set(id, key);
      return p;
    },
    start(input) {
      if (pending) {
        logger.info("Repeated start request: the session already being created returned");
        return pending;
      }
      const p = launch(input).finally(() => { if (pending === p) pending = null; });
      pending = p;
      return p;
    },
    running: () => [...active],
  };
}
