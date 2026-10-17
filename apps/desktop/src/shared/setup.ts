// Data of the "New discussion" and "Session setup" screens: the contract between main and renderer.
import type { Language } from "@model-council/core/i18n";
import { launch } from "./messages/launch.ts";

export interface TemplateCard {
  id: string;
  title: string;
  category: string;
  description: string;
  exampleTopic: string;
  roles: string[];
  maxRounds: number | null; // null — the template sets no limit, the registry value is used
  source: "builtin" | "user";
  modified: boolean; // a user file overrides the built-in template
}

export interface TemplateLoadIssue { file: string; reason: string }

export interface TemplatesView { templates: TemplateCard[]; errors: TemplateLoadIssue[] }

export type Billing = "subscription" | "paid" | "free";

export interface ProviderOption {
  id: string;
  kind: "cli" | "openai-http" | "scripted";
  label: string;
  available: boolean;
  reason: string | null;        // reason for unavailability
  models: string[];             // values of Participant.model; for cli defaultModel goes first
  defaultModel: string | null;  // the value meaning "default model"; null — no such option
  billing: Billing;
}

export interface RosterEntry { providerId: string; model: string }

// Owner wait in the session setup. Both modes off — no value (StartInput) or null (RerunView).
export interface OwnerWaitInput { pauseAfterRound: boolean; waitForOwner: boolean; timeoutSec: number }

export interface RegistryView {
  providers: ProviderOption[];
  defaults: { maxRounds: number; maxParticipants: number; materialsChars: number; maxTotalTokens: number | null; participants: RosterEntry[] };
  ownerWait: { minSec: number; maxSec: number; defaultSec: number }; // bounds and initial value of the owner wait deadline (engine values)
}

export interface MaterialsView {
  items: { id: string; name: string; chars: number; source: { label: string; fetchedAt: string } | null }[]; // id: m1..mN in sequence; source — for a link: host and path without scheme, query and credentials, load time ISO; null — not a link
  skipped: { name: string; reason: string }[];
  left: { name: string; reason: string }[]; // folder files that did not fit the limit; recomputed on every response
  ignored: { id: string; name: string; rule: string; returned: boolean }[]; // excluded by .gitignore rules: id x1..xN in row order; returned — the owner returned the path to the set; the absolute path stays in main
  folder: { files: number; chars: number } | null; // folder snapshot for reading on request: all files of attached folders; null — no folders
  error: string | null;   // reason of the last rejected addition; lines are separated by "\n"
  chars: number;          // total size of items
  limit: number;          // the registry's defaults.materialsChars at the moment of the response
  over: number;           // limit excess: max(0, chars − limit)
  stamp: string;          // stamp of the draft composition and selection limits; changes whenever either changes
}
// Materials preview before start: exact texts of the request sections and the saved set from which a session can be launched.
export interface MaterialsPreviewView {
  handle: string;            // id of the prepared set
  stamp: string;             // stamp of the draft the set was prepared for
  createdAt: string;         // ISO
  initial: string | null;    // exact text of the "Owner materials" section
  manifest: string | null;   // exact text of the "Owner folder" section
  folder: { files: number; chars: number } | null;
  available: { name: string; chars: number; initial: boolean; reason: string | null }[];
  skipped: { name: string; reason: string }[]; // without those excluded by rules: they are in materials.ignored
  left: { name: string; reason: string }[];
  sources: { id: string; url: string; fetchedAt: string }[]; // "Link sources": material id, address without query and credentials, receipt time ISO; the line with the time per language is built by the renderer
  materials: MaterialsView;  // list view after the action
}
// Launch refusal code for a prepared set: the window clears the acceptance by it. Goes as a response value, not an error property: Error properties are lost through contextBridge.
export const PREVIEW_RETRY_CODE = "preview_retry";
export type StartResult = { id: string } | { id: null; code: typeof PREVIEW_RETRY_CODE; error: string };
export type MaterialsKind = "files" | "folder";

// Filling "Session setup" with data of a past session ("Run again", "Discuss further").
export interface RerunView {
  sessionId: string;            // the past session; goes into StartInput.framingFrom
  date: string;                 // date of the past session, YYYY-MM-DD (by createdAt): the "rerun of the session from …" label
  topic: string;
  templateId: string | null;    // template of the past session, if it is still in the catalog; otherwise null
  framingFromSession: boolean;  // the session framing differs from what its template would give now (or is neutral): show "framing from the past session"
  participants: { providerId: string; model: string; role: string | null }[];
  maxRounds: number;            // within ROUNDS_BOUNDS
  materials: MaterialsView;     // draft after the carry-over; reasons for materials not added — in error
  ownerWait: OwnerWaitInput | null; // owner wait settings of the past session; null — both modes off or the session was created before they appeared
}

export interface StartInput {
  templateId: string | null; // null — own topic, neutral framing
  topic: string;
  participants: { providerId: string; model: string; role: string | null }[];
  maxRounds: number;
  maxTotalTokens?: number | null; // number — session cap; null — no cap; no field — the registry value
  useMaterials?: boolean; // launch with the current materials draft
  preparedHandle?: string; // launch from the accepted prepared set (preview); materials come from it, not from the draft
  framingFrom?: string;   // id of the past session: the framing comes from its journal, not from the template file
  ownerWait?: OwnerWaitInput; // present only when the wait mode is on; no field — the previous launch without a wait
  drafts?: { synthesizerId: string }; // present only when independent drafts are on; synthesizerId — pN by participants order
}

// ponytail: the registry stores only the default round limit value, without bounds; the upper bound is taken from the mockup (setup.html, data-max). If configuring is needed — a field in the registry defaults as a separate change
export const ROUNDS_BOUNDS = { min: 1, max: 20 } as const;

export const SCRIPTED_PROVIDER_ID = "scripted";
export const scriptedProviderLabel = (language?: Language): string => launch(language).scriptedProvider;

// Participant names in list order: the provider name, with the model if it is not "default"; repeats get a number.
export function rosterNames(roster: readonly RosterEntry[], providers: readonly Pick<ProviderOption, "id" | "label" | "defaultModel">[]): string[] {
  const seen = new Map<string, number>();
  return roster.map((e) => {
    const p = providers.find((x) => x.id === e.providerId);
    const base = !p ? e.providerId : e.model === p.defaultModel ? p.label : `${p.label} (${e.model})`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} #${n}`;
  });
}

export function billingOf(provider: ProviderOption | undefined, model: string): Billing {
  if (provider === undefined) return "free";
  // ponytail: the ":free" suffix is OpenRouter's convention for free models; other paid endpoints have no price flag
  if (provider.billing === "paid" && model.endsWith(":free")) return "free";
  return provider.billing;
}

// Template editor: form data — the template file fields without an identifier
export interface TemplateDraft {
  title: string;
  category: string;
  description: string;
  exampleTopic: string;
  framing: string;
  roles: string[];
  limits: { maxRounds?: number; turnTimeoutSec?: number; contextChars?: number }; // an unset limit is absent
}

export type TemplateOrigin = "new" | "builtin" | "user" | "modified"; // modified — a user file overrides the built-in one

export interface TemplateEditorData {
  id: string | null;        // null — a new template: the id will be derived from the title
  origin: TemplateOrigin;
  draft: TemplateDraft;
  categories: string[];     // existing catalog categories
  takenIds: string[];       // taken identifiers — for a preliminary view of the new one
}

export type TemplateEditorRequest =
  | { mode: "new" }
  | { mode: "edit"; id: string }
  | { mode: "duplicate"; id: string }
  | { mode: "snapshot"; templateId: string | null; framingFrom?: string }; // session setup: the template's effective framing or neutral; framingFrom — id of a past session: the framing comes from its journal (session rerun)

export interface TemplateFieldIssue { path: string; message: string }

export type TemplateSaveResult = { ok: true; id: string } | { ok: false; error: string; issues: TemplateFieldIssue[] };

export type TemplateRemoveMode = "delete" | "reset"; // reset — only for a modified built-in

/** A named lineup position checked against the current registry. */
export interface LineupPositionView { providerId: string; model: string; role: string | null; available: boolean; reason: string | null; modelNote: string | null }
export interface LineupView { id: string; name: string; available: boolean; participants: LineupPositionView[] }
/** error — the lineups file is unreadable (lineups is empty then); null — read, including empty. */
export interface LineupsView { lineups: LineupView[]; error: string | null }
export interface LineupSaveInput { name: string; participants: { providerId: string; model: string; role: string | null }[] }
export type LineupSaveResult = { ok: true; id: string; name: string } | { ok: false; error: string };
