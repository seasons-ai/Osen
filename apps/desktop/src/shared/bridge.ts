import type { JournalPartial, Session, SessionEvent, StoredStatus } from "@model-council/core";
import type { Language } from "@model-council/core/i18n";
import type { OwnerSelection, UsageSummary } from "@model-council/core/protocol";
import type { CheckResult, ClientActionReply, CommandActionReply, ConnectionsView, InstallResult, RemoveResult } from "./connections.ts";
import type { DefaultsValues, ProviderInput, SettingsProvider, SettingsView, TestResult } from "./settings.ts";
import type { Billing, LineupSaveInput, LineupSaveResult, LineupsView, MaterialsKind, MaterialsPreviewView, MaterialsView, ProviderOption, RegistryView, RerunView, RosterEntry, StartInput, StartResult, TemplateDraft, TemplateEditorData, TemplateEditorRequest, TemplateRemoveMode, TemplateSaveResult, TemplatesView } from "./setup.ts";

export interface HistoryItem {
  id: string;
  topic: string;
  createdAt: string;
  origin: Session["origin"];
  status: StoredStatus;
  templateName: string | null; // null — own topic
  participants: { id: string; name: string; model: string; dropped: boolean }[]; // name — full, as in the journal; without the model — splitName(name, model)
  round: number;
  maxRounds: number;
  turns: number;
  pinned: boolean;
  tokenCapStop: boolean;      // status === "stopped" and the stop was by the token cap
  tokensIncomplete: boolean;  // token accounting is incomplete
  partial: JournalPartial | null; // the journal was not read to the end: the reason and the number of the last read event; null — read entirely
}

/** A participant replacement chosen in the resume panel. */
export interface ResumeReplacement { participantId: string; providerId: string; model: string }

export interface ResumeView {
  allowed: boolean;          // resume is allowed by the engine rules
  reason: string | null;     // reason for the engine's refusal when allowed === false
  blocked: string | null;    // resume is impossible until replacements are chosen: the reason as text; null — no obstacle
  rounds: {
    min: number; max: number;
    remaining: number | null; // what is left of the previous limit, including the unfinished round; null — nothing left
    initial: number;          // what to put in the field: remaining, and if there is none — the registry's defaults.maxRounds; within bounds
  };
  participants: { id: string; name: string; billing: Billing; available: boolean; reason: string | null; replaces?: string }[]; // future active participants in slot order; replaces — on a new participant from a chosen replacement
  replaceable: { id: string; name: string; why: "dropped" | "unavailable"; reason: string; required: boolean }[]; // who can be replaced, in slot order; required — resume is impossible without a replacement
  replacements: { participantId: string; newId: string; name: string; providerId: string; model: string }[]; // replacements taken into account in this view
  providers: ProviderOption[]; // the replacement choice catalog — the same as in "Session setup"
  agreementReset: boolean;     // with these replacements all agreements are reset
  tokenCap: { cap: number | null; spent: number; exhausted: boolean }; // cap — the session's effective cap; exhausted — resume is impossible without a new cap or removal
  draftCalls: number;        // remaining calls of unfinished independent drafts from the engine plan; 0 — no phase or it is finished
  messageRequired: boolean;  // the engine refused with code consensus: resume only with an owner message; reason holds the engine text, the panel shows the message field
}

// An accepted independent draft for the feed. text === null — the snapshot was not read or was changed, the reason is in error.
export interface DraftView { draftId: string; participantId: string; attempts: number; chars: number; reasoning: string; text: string | null; error: string | null }

/** Interface language: locked — set by the COUNCIL_LANG environment variable, a change is rejected; damaged — preferences.json is damaged, choosing even the current language rewrites it. */
export interface LanguageView { language: Language; source: "env" | "file" | "default"; locked: boolean; damaged: boolean }

/** Theme: the stored choice (mode and light theme are independent) and the effective theme derived from it. */
export type ThemeMode = "dark" | "light" | "system";
export type LightTheme = "tuman" | "len" | "inei" | "pergament";
export type ThemeId = "osen" | LightTheme;
/** Initial theme of the window, handed to the renderer by preload as window.osenInitial. */
export interface OsenInitial { theme: ThemeId }
export interface AppearanceView { mode: ThemeMode; lightTheme: LightTheme; theme: ThemeId }

export interface LiveText { turn: number; attempt: number; text: string }

export interface BridgeActions {
  listSessions(): HistoryItem[];
  openSession(id: string): void;
  closeSession(): void;
  sessionDrafts(id: string): DraftView[]; // accepted drafts of the session from verified snapshots; for a session without a phase — an empty list
  notices(): string[];
  listTemplates(): TemplatesView;
  registry(): RegistryView;
  lineups(): LineupsView;
  saveLineup(input: LineupSaveInput): LineupSaveResult; // a refusal is the value { ok: false }, the lineups file does not change
  startSession(input: StartInput): StartResult;
  lastParticipants(): RosterEntry[] | null;
  stopSession(id: string): void;
  sendOwnerMessage(id: string, text: string, answerTo?: string): { requestId: string }; // answerTo — id of a participant question to the owner
  continueWait(id: string, waitId: string): { requestId: string }; // lift the owner wait waitId of a running session; models are not called, the journal is written by the executor
  copyText(text: string): void;
  exportSession(id: string): { path: string } | null; // null — the owner closed the location picker window
  setPinned(id: string, pinned: boolean): void;
  usageSummary(from: string, to: string): UsageSummary; // reported usage of the whole history for dates YYYY-MM-DD (Europe/Moscow, inclusive); read-only on journals
  settings(): SettingsView;
  recheckProviders(): SettingsView;
  saveProvider(input: ProviderInput): SettingsView;
  deleteProvider(id: string): SettingsView;
  saveModels(id: string, models: string[]): SettingsView;
  refreshModels(id: string): SettingsProvider;
  testProvider(id: string, model: string): TestResult;
  saveDefaults(values: DefaultsValues): SettingsView;
  setTransitionPeriod(days: number): SettingsView; // planned CLI transition period, integer 1–365; writes cli-reminder.json, never starts a candidate check
  switchCli(agent: string, version: string): SettingsView; // 176 use; refused while a session runs; only on the owner's confirmed press
  rollbackCli(agent: string): SettingsView;                // 176 rollback; refused while a session runs
  materials(): MaterialsView;
  pickMaterials(kind: MaterialsKind): MaterialsView;
  attachMaterials(paths: string[]): MaterialsView;
  addUrl(url: string): MaterialsView; // load a URL into the materials set; a load refusal arrives in MaterialsView.error
  removeMaterial(id: string): MaterialsView;
  clearMaterials(): MaterialsView;
  returnIgnored(id: string): MaterialsView; // return to the set the path of row id of the "Excluded by rules" section; an unknown id changes nothing
  excludeIgnored(id: string): MaterialsView; // exclude the returned path of row id again
  previewMaterials(refresh: boolean): MaterialsPreviewView; // saves the prepared set; does not create a session
  prepareRerun(sessionId: string, withDecision: boolean): RerunView; // replaces the window's materials draft
  resumeOptions(id: string, replacements?: ResumeReplacement[], message?: string): ResumeView; // message — the owner message of the resume, passed to the engine plan as is
  resumeSession(id: string, rounds: number, maxTotalTokens?: number | null, replacements?: ResumeReplacement[], message?: string): { droppedOwnerRequests: string[] }; // texts of dropped unapplied messages; message — written right after session_resumed
  acceptVersion(id: string, version: number, note?: string): OwnerSelection; // owner's choice: a journal record, models are not called
  templateEditor(request: TemplateEditorRequest): TemplateEditorData;
  createTemplate(draft: TemplateDraft): TemplateSaveResult;
  saveTemplate(id: string, draft: TemplateDraft): TemplateSaveResult;
  removeTemplate(id: string, mode: TemplateRemoveMode): void;
  language(): LanguageView;
  appearance(): AppearanceView;
  connections(): ConnectionsView; // clients and the council command as the modules report them; writes nothing
  connectClient(id: string): ClientActionReply; // only the client id: the entry comes from main's own server command
  updateClient(id: string): ClientActionReply;
  disconnectClient(id: string): ClientActionReply;
  checkClient(id: string): CheckResult; // free check of the recorded command: initialize + tools/list, no models
  installCommand(): CommandActionReply<InstallResult>;
  removeCommand(): CommandActionReply<RemoveResult>;
  copyZprofileLine(): void; // the line comes from main, not from the window
  setLanguage(language: Language): LanguageView; // a refusal on locked and on a write error; the language event goes to all subscribers
  setAppearance(input: { mode?: ThemeMode; lightTheme?: LightTheme }): AppearanceView; // a refusal on an unknown value and on a write error; the appearance event goes to all subscribers
}

export const BRIDGE_ACTIONS = ["listSessions", "openSession", "closeSession", "sessionDrafts", "notices", "listTemplates", "registry", "lineups", "saveLineup", "startSession", "lastParticipants", "stopSession", "sendOwnerMessage", "continueWait", "copyText", "exportSession", "setPinned", "usageSummary", "settings", "recheckProviders", "saveProvider", "deleteProvider", "saveModels", "refreshModels", "testProvider", "saveDefaults", "setTransitionPeriod", "switchCli", "rollbackCli", "materials", "pickMaterials", "attachMaterials", "addUrl", "removeMaterial", "clearMaterials", "returnIgnored", "excludeIgnored", "previewMaterials", "prepareRerun", "resumeOptions", "resumeSession", "acceptVersion", "templateEditor", "createTemplate", "saveTemplate", "removeTemplate", "language", "setLanguage", "appearance", "setAppearance", "connections", "connectClient", "updateClient", "disconnectClient", "checkClient", "installCommand", "removeCommand", "copyZprofileLine"] as const satisfies readonly (keyof BridgeActions)[];

export type BridgeEvent =
  | { type: "sessions"; sessions: HistoryItem[] }
  | { type: "session-event"; id: string; event: SessionEvent }
  // offset — length of the attempt text already accumulated; 0 — the start: replace the accumulated
  | { type: "turn-text"; id: string; turn: number; attempt: number; offset: number; text: string }
  | { type: "error"; message: string }
  | { type: "language"; view: LanguageView }
  | { type: "appearance"; view: AppearanceView }
  | { type: "cli-transition" } // a background candidate check finished: re-read settings()
  | { type: "open-result"; id: string }
  | { type: "open-session"; id: string }; // open the session screen without requesting "Result": a running session shows "Discussion"

export const CALL_CHANNEL = "council:call";
export const EVENT_CHANNEL = "council:event";

export type Bridge = {
  [K in keyof BridgeActions]: (...args: Parameters<BridgeActions[K]>) => Promise<ReturnType<BridgeActions[K]>>;
} & {
  subscribe(listener: (event: BridgeEvent) => void): () => void;
  attachDropped(files: readonly File[]): Promise<MaterialsView>; // paths are taken by preload from File
};
