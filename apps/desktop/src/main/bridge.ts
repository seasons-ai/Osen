import { OwnerMessageRejectedError, OwnerReleaseRejectedError, OwnerSelectionRejectedError, ResumeRejectedError, StopRejectedError, isValidSessionId } from "@model-council/core";
import type { Logger, SessionEvent, StreamChunk } from "@model-council/core";
import { BRIDGE_ACTIONS } from "../shared/bridge.ts";
import { shell } from "../shared/messages/shell.ts";
import { UnknownClientError } from "./connections.ts";
import type { ConnectionsApi } from "./connections.ts";
import { LanguageRejectedError } from "./language.ts";
import type { LanguageState } from "./language.ts";
import { AppearanceRejectedError } from "./appearance.ts";
import type { AppearanceState } from "./appearance.ts";
import type { OwnerSelection, UsageSummary } from "@model-council/core/protocol";
import type { BridgeActions, BridgeEvent, DraftView, LiveText, ResumeReplacement, ResumeView } from "../shared/bridge.ts";
import type { MaterialsDraft } from "./materials.ts";
import { PreviewError } from "./materials-preview.ts";
import { RerunError } from "./rerun.ts";
import type { SettingsApi } from "./settings.ts";
import { ROUNDS_BOUNDS } from "../shared/setup.ts";
import type { StartResult } from "../shared/setup.ts";
import { ReplacementInputError } from "./resume.ts";
import { LaunchError } from "./launcher.ts";
import type { TemplateEditorApi } from "./template-editor.ts";
import type { LineupSaveResult, LineupsView, MaterialsKind, MaterialsPreviewView, RegistryView, RerunView, RosterEntry, TemplatesView } from "../shared/setup.ts";

export interface BridgeDeps {
  listSessions(): ReturnType<BridgeActions["listSessions"]>;
  sessionExists(id: string): boolean;
  sessionDrafts(id: string): DraftView[];
  usageSummary(from: string, to: string): UsageSummary;
  watchSession(id: string, onEvent: (event: SessionEvent) => void): () => void;
  notices(): string[];
  listTemplates(): TemplatesView;
  registry(): Promise<RegistryView>;
  lineups(): LineupsView | Promise<LineupsView>;
  saveLineup(input: unknown): Promise<LineupSaveResult>;
  startSession(input: unknown): Promise<{ id: string }>;
  lastParticipants(): RosterEntry[] | null;
  resumeOptions(id: string, replacements?: ResumeReplacement[]): Promise<ResumeView>;
  resumeSession(id: string, rounds: number, maxTotalTokens?: number | null, replacements?: ResumeReplacement[]): Promise<{ droppedOwnerRequests: string[] }>;
  stopSession(id: string): void;
  acceptVersion(id: string, version: number, note?: string): OwnerSelection;
  sendOwnerMessage(id: string, text: string, answerTo?: string): { requestId: string };
  continueWait(id: string, waitId: string): { requestId: string };
  previewMaterials(refresh: boolean): MaterialsPreviewView;
  prepareRerun(sessionId: string, withDecision: boolean): RerunView;
  copyText(text: string): void;
  exportSession(id: string): Promise<{ path: string } | null>;
  setPinned(id: string, pinned: boolean): void;
  language: LanguageState;
  appearance: AppearanceState;
  connections: ConnectionsApi;
  settings: SettingsApi;
  templates: TemplateEditorApi;
  materials: MaterialsDraft;
  pickMaterials(kind: MaterialsKind): Promise<string[] | null>; // null or empty — the owner closed the window
  send(event: BridgeEvent): void;
  logger: Logger;
}

export type CallResult = { ok: true; value: unknown } | { ok: false; error: string };

class ActionError extends Error {}

// The replacement map arrives from the window: the shape is checked here, names from the catalog and registry — where they are known.
function replacementsOf(raw: unknown): ResumeReplacement[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new ActionError(shell().replacementsNotArray);
  return raw.map((r: unknown, i) => {
    const o = typeof r === "object" && r !== null && !Array.isArray(r) ? (r as Record<string, unknown>) : null;
    if (!o || typeof o.participantId !== "string" || !/^p[1-9]\d*$/.test(o.participantId)) throw new ActionError(shell().replacementBadParticipant(i + 1));
    if (typeof o.providerId !== "string" || !o.providerId || typeof o.model !== "string" || !o.model) throw new ActionError(shell().replacementBadProvider(i + 1, o.participantId));
    return { participantId: o.participantId, providerId: o.providerId, model: o.model };
  });
}

export function createBridge(deps: BridgeDeps): {
  call(action: unknown, args: unknown): Promise<CallResult>;
  dispose(): void;
  openId(): string | null;
  chunk(id: string, chunk: StreamChunk): void;
  ended(id: string): void;
} {
  let stop: (() => void) | null = null;
  let openId: string | null = null;
  const live = new Map<string, LiveText>(); // accumulated text of the current attempt for running sessions
  const unwatch = () => {
    const s = stop;
    stop = null;
    openId = null;
    s?.();
  };
  const validId = (id: unknown): string => {
    if (typeof id !== "string" || !isValidSessionId(id)) throw new ActionError(shell().invalidSessionId(String(id)));
    return id;
  };

  const validDate = (s: unknown): s is string => {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  };

  const actions: Record<(typeof BRIDGE_ACTIONS)[number], (args: unknown[]) => unknown> = {
    listSessions: () => deps.listSessions(),
    notices: () => deps.notices(),
    closeSession: () => unwatch(),
    listTemplates: () => deps.listTemplates(),
    registry: () => deps.registry(),
    lineups: () => deps.lineups(),
    saveLineup: ([input]) => deps.saveLineup(input),
    startSession: async ([input]) => {
      try {
        return await deps.startSession(input);
      } catch (e) {
        if (!(e instanceof LaunchError) || !e.code) throw e;
        deps.logger.error(`Action startSession failed: ${e.message}`); // the code goes as a value: Error properties are lost through contextBridge
        return { id: null, code: e.code, error: e.message } satisfies StartResult;
      }
    },
    lastParticipants: () => deps.lastParticipants(),
    stopSession: ([id]) => {
      try {
        deps.stopSession(validId(id));
      } catch (e) {
        if (e instanceof StopRejectedError) throw new ActionError(e.message);
        throw e;
      }
    },
    sendOwnerMessage: ([raw, text, answerTo]) => {
      const id = validId(raw);
      if (typeof text !== "string" || text.trim() === "") throw new ActionError(shell().ownerMessageEmpty);
      if (answerTo !== undefined && answerTo !== null && (typeof answerTo !== "string" || answerTo === "")) {
        throw new ActionError(shell().questionIdInvalid);
      }
      try {
        return deps.sendOwnerMessage(id, text, answerTo ?? undefined);
      } catch (e) {
        if (e instanceof OwnerMessageRejectedError) throw new ActionError(e.message);
        throw e;
      }
    },
    continueWait: ([raw, waitId]) => {
      const id = validId(raw);
      if (typeof waitId !== "string" || !/^w[1-9]\d*$/.test(waitId)) throw new ActionError(shell().waitIdInvalid);
      try {
        return deps.continueWait(id, waitId);
      } catch (e) {
        if (e instanceof OwnerReleaseRejectedError) throw new ActionError(e.message);
        throw e;
      }
    },
    copyText: ([text]) => {
      if (typeof text !== "string") throw new ActionError(shell().clipboardTextInvalid);
      deps.copyText(text);
    },
    exportSession: ([id]) => deps.exportSession(validId(id)),
    setPinned: ([raw, pinned]) => {
      const id = validId(raw);
      if (typeof pinned !== "boolean") throw new ActionError(shell().pinnedInvalid);
      if (pinned && !deps.sessionExists(id)) throw new ActionError(shell().sessionNotFound(id));
      deps.setPinned(id, pinned);
    },
    language: () => deps.language.view(),
    setLanguage: ([language]) => {
      try {
        return deps.language.set(language);
      } catch (e) {
        if (e instanceof LanguageRejectedError) throw new ActionError(e.message);
        throw e;
      }
    },
    appearance: () => deps.appearance.view(),
    setAppearance: ([input]) => {
      try {
        return deps.appearance.set(input);
      } catch (e) {
        if (e instanceof AppearanceRejectedError) throw new ActionError(e.message);
        throw e;
      }
    },
    // client actions take only the id: entries and paths come from main's own server command
    connections: () => deps.connections.view(),
    connectClient: ([id]) => deps.connections.connect(id),
    updateClient: ([id]) => deps.connections.update(id),
    disconnectClient: ([id]) => deps.connections.disconnect(id),
    checkClient: ([id]) => deps.connections.check(id),
    installCommand: () => deps.connections.installCommand(),
    removeCommand: () => deps.connections.removeCommand(),
    copyZprofileLine: () => deps.copyText(deps.connections.zprofileLine()),
    settings: () => deps.settings.view(),
    recheckProviders: () => deps.settings.recheck(),
    saveProvider: ([input]) => deps.settings.saveProvider(input),
    deleteProvider: ([id]) => deps.settings.deleteProvider(id),
    saveModels: ([id, models]) => deps.settings.saveModels(id, models),
    refreshModels: ([id]) => deps.settings.refreshModels(id),
    testProvider: ([id, model]) => deps.settings.testProvider(id, model),
    saveDefaults: ([values]) => deps.settings.saveDefaults(values),
    templateEditor: ([request]) => deps.templates.open(request),
    createTemplate: ([draft]) => deps.templates.create(draft),
    saveTemplate: ([id, draft]) => deps.templates.save(id, draft),
    removeTemplate: ([id, mode]) => deps.templates.remove(id, mode),
    materials: () => deps.materials.view(),
    pickMaterials: async ([kind]) => {
      if (kind !== "files" && kind !== "folder") throw new ActionError(shell().materialsKindInvalid);
      const paths = await deps.pickMaterials(kind);
      return paths && paths.length > 0 ? deps.materials.attach(paths) : deps.materials.view();
    },
    attachMaterials: ([paths]) => {
      if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) throw new ActionError(shell().materialsPathsInvalid);
      return deps.materials.attach(paths);
    },
    addUrl: ([url]) => {
      if (typeof url !== "string") throw new ActionError(shell().materialUrlInvalid);
      return deps.materials.addUrl(url);
    },
    removeMaterial: ([id]) => {
      if (typeof id !== "string") throw new ActionError(shell().materialIdInvalid);
      return deps.materials.remove(id);
    },
    returnIgnored: ([id]) => {
      if (typeof id !== "string") throw new ActionError(shell().materialIdInvalid);
      return deps.materials.returnIgnored(id);
    },
    excludeIgnored: ([id]) => {
      if (typeof id !== "string") throw new ActionError(shell().materialIdInvalid);
      return deps.materials.excludeIgnored(id);
    },
    clearMaterials: () => deps.materials.clear(),
    previewMaterials: ([refresh]) => {
      if (typeof refresh !== "boolean") throw new ActionError(shell().refreshInvalid);
      try {
        return deps.previewMaterials(refresh);
      } catch (e) {
        if (e instanceof PreviewError) throw new ActionError(e.message);
        throw e;
      }
    },
    prepareRerun: ([raw, withDecision]) => {
      const id = validId(raw);
      if (typeof withDecision !== "boolean") throw new ActionError(shell().withDecisionInvalid);
      try {
        return deps.prepareRerun(id, withDecision);
      } catch (e) {
        if (e instanceof RerunError) throw new ActionError(e.message);
        throw e;
      }
    },
    resumeOptions: async ([raw, replacements]) => {
      const id = validId(raw);
      const map = replacementsOf(replacements);
      try {
        return await deps.resumeOptions(id, map);
      } catch (e) {
        if (e instanceof ResumeRejectedError || e instanceof ReplacementInputError) throw new ActionError(e.message);
        throw e;
      }
    },
    resumeSession: async ([raw, rounds, cap, replacements]) => {
      const id = validId(raw);
      const { min, max } = ROUNDS_BOUNDS;
      if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < min || rounds > max) {
        throw new ActionError(shell().roundsInvalid(min, max));
      }
      if (cap !== undefined && cap !== null && (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 1)) {
        throw new ActionError(shell().capInvalid);
      }
      const map = replacementsOf(replacements);
      try {
        return await deps.resumeSession(id, rounds, cap, map);
      } catch (e) {
        if (e instanceof ResumeRejectedError || e instanceof ReplacementInputError) throw new ActionError(e.message);
        throw e;
      }
    },
    acceptVersion: ([raw, version, note]) => {
      const id = validId(raw);
      if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new ActionError(shell().versionInvalid);
      if (note !== undefined && note !== null && typeof note !== "string") throw new ActionError(shell().noteInvalid);
      try {
        return deps.acceptVersion(id, version, note ?? undefined);
      } catch (e) {
        if (e instanceof OwnerSelectionRejectedError) throw new ActionError(e.message);
        throw e;
      }
    },
    sessionDrafts: ([raw]) => {
      const id = validId(raw);
      if (!deps.sessionExists(id)) throw new ActionError(shell().sessionNotFound(id));
      return deps.sessionDrafts(id);
    },
    usageSummary: ([from, to]) => {
      if (!validDate(from) || !validDate(to)) throw new ActionError(shell().periodInvalid);
      if (from > to) throw new ActionError(shell().periodReversed);
      return deps.usageSummary(from, to);
    },
    openSession: ([raw]) => {
      const id = validId(raw);
      if (!deps.sessionExists(id)) throw new ActionError(shell().sessionNotFound(id));
      unwatch();
      stop = deps.watchSession(id, (event) => deps.send({ type: "session-event", id, event }));
      openId = id;
      const l = live.get(id);
      if (l) deps.send({ type: "turn-text", id, turn: l.turn, attempt: l.attempt, offset: 0, text: l.text });
    },
  };

  return {
    async call(action, args) {
      if (typeof action !== "string" || !(BRIDGE_ACTIONS as readonly string[]).includes(action)) {
        deps.logger.error(`Unknown bridge action: ${String(action)}`);
        return { ok: false, error: shell().unknownAction(String(action)) };
      }
      try {
        return { ok: true, value: (await actions[action as keyof typeof actions](Array.isArray(args) ? args : [])) ?? null };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        if (e instanceof UnknownClientError) return { ok: false, error }; // the connections module has logged the refusal itself
        deps.logger.error(`Action ${action} failed: ${error}`, e instanceof ActionError ? undefined : e);
        return { ok: false, error };
      }
    },
    dispose: unwatch,
    openId: () => openId,
    chunk(id, c) {
      const prev = live.get(id);
      const same = prev !== undefined && prev.turn === c.turn && prev.attempt === c.attempt;
      const offset = same ? prev.text.length : 0;
      live.set(id, { turn: c.turn, attempt: c.attempt, text: (same ? prev.text : "") + c.text });
      if (id === openId) deps.send({ type: "turn-text", id, turn: c.turn, attempt: c.attempt, offset, text: c.text });
    },
    ended: (id) => void live.delete(id),
  };
}
