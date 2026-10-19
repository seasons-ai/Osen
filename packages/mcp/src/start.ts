import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { checkLineup, collectSessionMaterials, createSession, eventsPath, launchErrPath, launchFilePath, writeLaunchFile, DEFAULT_MODEL, ensureRegistry, envFilePath, FOLDER_LIMITS, folderStats, inspectProvider, LineupsError, maxCallsBound, loadTemplates, logRegistryLoaded, MaterialsError, OWNER_WAIT_DEFAULT_SEC, OWNER_WAIT_MAX_SEC, readLineups, readRegistry, readScenario, ScriptedUnavailableError, scriptedDevOnlyMessage, SessionInputError, templateSessionInput, UnknownTemplateError, userTemplatesDir } from "@model-council/core";
import type { FolderFile, LaunchPayload } from "@model-council/core";
import { z } from "zod";
import { defineTool, ROUNDS_BOUNDS, resumeScenarioPath, SCRIPTED_PROVIDER_ID, scriptedProviderLabel, scenarioPath, ToolError } from "./context.ts";
import type { ToolContext } from "./context.ts";
import { mcpMessages } from "./messages.ts";
import { lineupScripted } from "./options.ts";

export interface StartView {
  sessionId: string;
  templateId: string | null;
  maxRounds: number;
  maxCalls: number;
  maxTotalTokens: number | null;
  participants: { id: string; name: string; providerId: string; model: string; role: string | null }[];
  materials: { count: number; chars: number; skipped: { name: string; reason: string }[]; left: { count: number; items: { name: string; reason: string }[] } };
  folder: { files: number; chars: number } | null;
  ownerWait: { pauseAfterRound: boolean; waitForOwner: boolean; timeoutSec: number } | null;
  lineup: { id: string; name: string; notes: string[] } | null;
  drafts: { synthesizerId: string; synthesizerName: string; byDefault: boolean } | null;
  next: string;
}

// The same display boundary as in the `council --attach` summary.
const LEFT_SHOWN = 20;

interface Entry { providerId: string; model: string }
interface ProviderInfo { id: string; label: string; defaultModel: string | null }

// ponytail: repeats rosterNames from apps/desktop/src/shared/setup.ts; a shared session launch in core is a separate change
export function rosterNames(roster: readonly Entry[], providers: readonly ProviderInfo[]): string[] {
  const seen = new Map<string, number>();
  return roster.map((e) => {
    const p = providers.find((x) => x.id === e.providerId);
    const base = !p ? e.providerId : e.model === p.defaultModel ? p.label : `${p.label} (${e.model})`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} #${n}`;
  });
}

export const rosterProviders = (registry: ReturnType<typeof readRegistry>): ProviderInfo[] => [
  ...registry.providers.map((p) => ({ id: p.id, label: p.label, defaultModel: p.kind === "cli" ? DEFAULT_MODEL : null })),
  { id: SCRIPTED_PROVIDER_ID, label: scriptedProviderLabel(), defaultModel: null },
];

const START_TIMEOUT_MS = 15_000;

// Hands the prepared session to a detached executor and waits for the first journal event; any other outcome is a ToolError and leaves no launch files.
async function startExecutor(ctx: ToolContext, payload: Omit<LaunchPayload, "deadline">): Promise<void> {
  const m = mcpMessages();
  const id = payload.session.id;
  const timeoutMs = ctx.startTimeoutMs ?? START_TIMEOUT_MS;
  const pollMs = ctx.startPollMs ?? 100;
  const file = launchFilePath(ctx.dataDir, id);
  const errPath = launchErrPath(ctx.dataDir, id);
  const cleanup = (): void => { rmSync(file, { force: true }); rmSync(errPath, { force: true }); };
  let failure: string | null = null;
  try {
    writeLaunchFile(ctx.dataDir, { ...payload, deadline: new Date(Date.now() + timeoutMs).toISOString() });
    const reason = (code: number | null): string => {
      let text = "";
      try { text = readFileSync(errPath, "utf8").trim(); } catch { /* no .err file */ }
      return text || `exit code ${code}`;
    };
    if (ctx.spawnExecutor) {
      ctx.spawnExecutor(file, errPath).then((code) => { failure ??= reason(code); }, (e: unknown) => { failure ??= e instanceof Error ? e.message : String(e); });
    } else {
      const errFd = openSync(errPath, "w", 0o600);
      try {
        const child = spawn(ctx.councilLaunch.command, [...ctx.councilLaunch.args, "run-prepared", file], {
          detached: true,
          stdio: ["ignore", "ignore", errFd],
          env: { ...Object.fromEntries(Object.entries(ctx.env).filter((e): e is [string, string] => e[1] !== undefined)), COUNCIL_HOME: ctx.dataDir, ...ctx.councilLaunch.env },
        });
        child.on("error", (e) => { failure ??= e.message; });
        child.on("exit", (code) => { failure ??= reason(code); });
        child.unref();
      } finally {
        closeSync(errFd);
      }
    }
    ctx.logger.info(`Executor started for session ${id}, waiting for the first event up to ${timeoutMs} ms`);
    const first = eventsPath(ctx.dataDir, id);
    const hasEvent = (): boolean => { try { return existsSync(first) && statSync(first).size > 0; } catch { return false; } };
    const end = Date.now() + timeoutMs;
    while (!hasEvent()) {
      if (failure !== null) {
        ctx.logger.error(`Executor of session ${id} failed before the first event`, failure);
        throw new ToolError(m.startExecutorFailed(failure));
      }
      if (Date.now() >= end) {
        ctx.logger.error(`Executor of session ${id} did not respond in ${timeoutMs} ms`);
        throw new ToolError(m.startExecutorTimeout(Math.round(timeoutMs / 1000)));
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    cleanup();
  } catch (e) {
    cleanup();
    throw e;
  }
}

export const councilStart = defineTool({
  name: "council_start",
  get description() { return mcpMessages().startDesc; },
  get inputSchema() {
    const m = mcpMessages();
    return {
      topic: z.string().describe(m.startFTopic),
      templateId: z.string().optional().describe(m.startFTemplateId),
      participants: z.array(z.object({
        providerId: z.string().describe(m.startFProviderId),
        model: z.string().optional().describe(m.startFModel),
      })).optional().describe(m.startFParticipants),
      maxRounds: z.number().int().optional().describe(m.startFMaxRounds(ROUNDS_BOUNDS.min, ROUNDS_BOUNDS.max)),
      maxTotalTokens: z.number().optional().describe(m.startFMaxTotalTokens),
      pauseAfterRound: z.boolean().optional().describe(m.startFPauseAfterRound),
      waitForOwner: z.boolean().optional().describe(m.startFWaitForOwner),
      ownerWaitSec: z.number().optional().describe(m.startFOwnerWaitSec(OWNER_WAIT_MAX_SEC, OWNER_WAIT_DEFAULT_SEC)),
      lineupId: z.string().optional().describe(m.startFLineupId),
      drafts: z.boolean().optional().describe(m.startFDrafts),
      synthesizerId: z.string().optional().describe(m.startFSynthesizerId),
      attachments: z.array(z.string()).optional().describe(m.startFAttachments(FOLDER_LIMITS.snapshotChars)),
    };
  },
  async run(ctx, input) {
    const m = mcpMessages();
    if (ctx.env.COUNCIL_PARTICIPANT === "1") throw new ToolError(m.startParticipant);
    if (input.lineupId !== undefined && input.participants !== undefined) throw new ToolError(m.startLineupAndParticipants);
    const { min, max } = ROUNDS_BOUNDS;
    if (input.maxRounds !== undefined && (input.maxRounds < min || input.maxRounds > max)) throw new ToolError(m.startRoundsBounds(min, max));

    if (input.maxTotalTokens !== undefined && (!Number.isInteger(input.maxTotalTokens) || input.maxTotalTokens < 1)) throw new ToolError(m.startTokenCap);

    if (input.synthesizerId !== undefined && input.drafts !== true) throw new ToolError(m.startSynthesizerNeedsDrafts);
    const drafts = input.drafts === true;

    const sec = input.ownerWaitSec;
    if (sec !== undefined) {
      if (!Number.isInteger(sec) || sec < 1 || sec > OWNER_WAIT_MAX_SEC) throw new ToolError(m.startOwnerWaitRange(OWNER_WAIT_MAX_SEC));
      if (input.pauseAfterRound !== true && input.waitForOwner !== true) throw new ToolError(m.startOwnerWaitNeedsWait);
    }
    const waits = input.pauseAfterRound === true || input.waitForOwner === true;

    const relative = (input.attachments ?? []).filter((a) => !isAbsolute(a));
    if (relative.length > 0) {
      throw new ToolError(
        m.startRelativePaths(relative),
        `Relative paths in attachments rejected: ${relative.length}`,
      );
    }

    await ensureRegistry(ctx.dataDir, { env: ctx.env, deps: ctx.inspectDeps });
    const registry = readRegistry(ctx.dataDir);
    logRegistryLoaded(ctx.logger, ctx.dataDir, registry);

    const found = new Map<string, Awaited<ReturnType<typeof inspectProvider>>>();
    let entries: Entry[];
    let lineupRoles: (string | null)[] | null = null;
    let lineup: StartView["lineup"] = null;
    if (input.lineupId !== undefined) {
      let saved;
      try {
        saved = readLineups(ctx.dataDir).find((l) => l.id === input.lineupId);
      } catch (e) {
        if (e instanceof LineupsError) throw new ToolError(e.message);
        throw e;
      }
      if (!saved) throw new ToolError(m.startLineupNotFound(input.lineupId));
      for (const id of new Set(saved.participants.map((p) => p.providerId))) {
        const provider = registry.providers.find((p) => p.id === id);
        if (provider) found.set(id, await inspectProvider(provider, { env: ctx.env, deps: ctx.inspectDeps, keyFile: envFilePath(ctx.dataDir) }));
      }
      const check = checkLineup(saved, { registry, statuses: [...found.values()].map((r) => r.status), scripted: lineupScripted(ctx) });
      if (!check.available) {
        throw new ToolError([m.startLineupUnavailable(check.name), ...check.participants.flatMap((p, i) => (p.available ? [] : [`${i + 1}. ${p.providerId}:${p.model} — ${p.reason}`]))].join("\n"));
      }
      entries = saved.participants.map((p) => ({ providerId: p.providerId, model: p.model }));
      lineupRoles = saved.participants.map((p) => p.role);
      lineup = { id: check.id, name: check.name, notes: check.participants.flatMap((p, i) => (p.modelNote === null ? [] : [m.startLineupNote(i + 1, p.providerId, p.model, p.modelNote)])) };
    } else {
      const requested: { providerId: string; model?: string | undefined }[] = input.participants ?? registry.defaults.participants;
      if (input.participants === undefined && requested.length === 0) throw new ToolError(m.startNoProviders);
      entries = requested.map((r) => {
        if (r.providerId === SCRIPTED_PROVIDER_ID) {
          if (!r.model) throw new ToolError(m.startScriptedNeedsModel);
          if (ctx.scenariosDir === null) throw new ToolError(scriptedDevOnlyMessage());
          if (scenarioPath(ctx.scenariosDir, r.model) === null) throw new ToolError(m.scenarioUnavailable(r.model));
          return { providerId: r.providerId, model: r.model };
        }
        const provider = registry.providers.find((p) => p.id === r.providerId);
        if (!provider) throw new ToolError(m.startProviderNotFound(r.providerId, registry.providers.map((p) => p.id)));
        if (provider.kind === "openai-http" && (!r.model || r.model === DEFAULT_MODEL)) throw new ToolError(m.startProviderNeedsModel(r.providerId));
        return { providerId: r.providerId, model: r.model ?? DEFAULT_MODEL };
      });
    }

    const names = rosterNames(entries, rosterProviders(registry));
    const { session, materials, skipped, left, workspace } = (() => {
      try {
        const base = templateSessionInput({
          catalog: loadTemplates({ builtinDir: ctx.builtinTemplatesDir, userDir: userTemplatesDir(ctx.dataDir) }),
          templateId: input.templateId, topic: input.topic, origin: "mcp",
          participants: entries.map((e, i) => ({ name: names[i]!, ...e })),
          limits: { ...(input.maxRounds === undefined ? {} : { maxRounds: input.maxRounds }), ...(input.maxTotalTokens === undefined ? {} : { maxTotalTokens: input.maxTotalTokens }) }, defaults: registry.defaults,
        });
        if (lineupRoles) base.participants.forEach((p, i) => { p.role = lineupRoles[i]!; });
        if (waits) {
          base.ownerWait = {
            ...(input.pauseAfterRound === true ? { pauseAfterRound: true } : {}),
            ...(input.waitForOwner === true ? { waitForOwner: true } : {}),
            ...(sec !== undefined ? { timeoutSec: sec } : {}),
          };
        }
        const set = input.attachments?.length
          ? collectSessionMaterials(input.attachments, { materialsChars: base.limits.materialsChars!, materialsIgnore: registry.defaults.materialsIgnore })
          : null;
        const materials = set?.materials;
        const workspace: FolderFile[] = set?.workspace ?? [];
        return {
          session: createSession({ ...base, ...(drafts ? { drafts: { ...(input.synthesizerId !== undefined ? { synthesizerId: input.synthesizerId } : {}) } } : {}), ...(materials ? { materials } : {}), ...(workspace.length ? { workspace } : {}) }, { maxParticipants: registry.defaults.maxParticipants }),
          materials, skipped: (set?.skipped ?? []).map((s) => ({ name: s.name, reason: s.reason })), left: set?.left ?? [], workspace,
        };
      } catch (e) {
        if (e instanceof MaterialsError) throw new ToolError(e.reasons.join("\n"), `Materials not collected: reasons ${e.reasons.length}`);
        if (e instanceof UnknownTemplateError || e instanceof SessionInputError) throw new ToolError(e.message);
        throw e;
      }
    })();

    const count = materials?.length ?? 0;
    const chars = materials?.reduce((n, m) => n + m.chars, 0) ?? 0;
    const folder = workspace.length ? folderStats(workspace) : null;
    // The session runs in a detached `council run-prepared` process; here we only validate providers and scenarios.
    const scenarios: Record<string, string> = {};
    for (const [i, e] of entries.entries()) {
      if (e.providerId === SCRIPTED_PROVIDER_ID) {
        const path = (lineup ? resumeScenarioPath : scenarioPath)(ctx.scenariosDir, e.model)!;
        try {
          await readScenario(path);
        } catch (err) {
          if (err instanceof ScriptedUnavailableError) throw new ToolError(err.message);
          throw err;
        }
        scenarios[`p${i + 1}`] = path;
        continue;
      }
      const provider = registry.providers.find((p) => p.id === e.providerId)!;
      let r = found.get(e.providerId);
      if (!r) {
        r = await inspectProvider(provider, { env: ctx.env, withModels: false, deps: ctx.inspectDeps, keyFile: envFilePath(ctx.dataDir) });
        found.set(e.providerId, r);
      }
      if (!r.runtime && !r.http) throw new ToolError(m.startProviderUnavailable(provider.label, r.status.reason));
    }

    const ow = session.ownerWait
      ? { pauseAfterRound: session.ownerWait.pauseAfterRound === true, waitForOwner: session.ownerWait.waitForOwner === true, timeoutSec: session.ownerWait.timeoutSec ?? OWNER_WAIT_DEFAULT_SEC }
      : null;
    ctx.logger.info(`Session start from MCP: template ${session.templateId ?? "none"}, participants ${session.participants.length}, round limit ${session.limits.maxRounds}, materials ${count}, size ${chars}, snapshot files ${folder?.files ?? 0}, snapshot size ${folder?.chars ?? 0}, not in the initial set ${left.length}, ${session.limits.maxTotalTokens === undefined ? "no token cap" : `token cap ${session.limits.maxTotalTokens}`}, ${ow === null ? "owner wait: none" : `owner wait: pause after round ${ow.pauseAfterRound ? "yes" : "no"}, answer to a question ${ow.waitForOwner ? "yes" : "no"}, timeout ${ow.timeoutSec} s`}, ${lineup ? `lineup ${lineup.id}` : "no lineup"}`);
    await startExecutor(ctx, { session, ...(materials ? { materials } : {}), ...(workspace.length ? { workspace } : {}), scenarios });

    const draftsView: StartView["drafts"] = session.drafts
      ? { synthesizerId: session.drafts.synthesizerId, synthesizerName: session.participants.find((p) => p.id === session.drafts!.synthesizerId)!.name, byDefault: input.synthesizerId === undefined }
      : null;
    const view: StartView = {
      sessionId: session.id,
      templateId: session.templateId,
      maxRounds: session.limits.maxRounds,
      maxCalls: maxCallsBound(session.participants.length, session.limits.maxRounds, drafts),
      maxTotalTokens: session.limits.maxTotalTokens ?? null,
      participants: session.participants.map((p) => ({ id: p.id, name: p.name, providerId: p.providerId, model: p.model, role: p.role })),
      materials: { count, chars, skipped, left: { count: left.length, items: left.slice(0, LEFT_SHOWN) } },
      folder,
      ownerWait: ow,
      lineup,
      drafts: draftsView,
      next: m.startNext(count > 0, folder !== null) + (lineup && lineup.notes.length > 0 ? m.startNextLineupNotes : "")
        + (draftsView ? m.startNextDrafts(draftsView.synthesizerId, draftsView.synthesizerName, draftsView.byDefault, maxCallsBound(session.participants.length, session.limits.maxRounds, true)) : "")
        + (ow ? m.startNextOwnerWait(ow.timeoutSec) : ""),
    };
    return view;
  },
});
