import { maxCallsBound } from "@model-council/core/protocol";
import { billingOf, ROUNDS_BOUNDS, rosterNames } from "../../shared/setup.ts";
import { formatDate, formatList } from "@model-council/core/i18n";
import type { Language } from "@model-council/core/i18n";
import { setup as messages } from "../../shared/messages/setup.ts";
import { chars } from "./session-ui.tsx";
import type { Billing, LineupPositionView, LineupSaveInput, LineupView, MaterialsPreviewView, MaterialsView, ProviderOption, RegistryView, RerunView, RosterEntry, StartInput, TemplateCard, TemplateEditorData } from "../../shared/setup.ts";

export interface FormParticipant { key: number; providerId: string; model: string; role: string; issue?: string | null; note?: string | null } // issue — reason a lineup position is unavailable (blocks start), note — a model remark
export interface SetupForm { templateId: string | null; topic: string; participants: FormParticipant[]; maxRounds: number; tokenCap: string; pauseAfterRound: boolean; waitForOwner: boolean; waitSec: string; drafts: boolean; synthesizerKey: number | null; nextKey: number }
export interface SetupContext { registry: RegistryView; template: TemplateCard | null }

export type SetupAction =
  | { type: "topic"; value: string }
  | { type: "add" }
  | { type: "remove"; key: number }
  | { type: "move"; key: number; delta: -1 | 1 }
  | { type: "provider"; key: number; providerId: string }
  | { type: "model"; key: number; model: string }
  | { type: "role"; key: number; role: string }
  | { type: "rounds"; value: number }
  | { type: "cap"; value: string }
  | { type: "pause-after-round"; value: boolean }
  | { type: "wait-for-owner"; value: boolean }
  | { type: "wait-sec"; value: string }
  | { type: "drafts"; value: boolean }
  | { type: "synthesizer"; key: number }
  | { type: "lineup"; participants: LineupPositionView[] };

/** Token cap field text: empty — null (no cap), integer from 1 — the number, anything else — undefined (value not accepted). */
export function parseTokenCap(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  return /^\d+$/.test(t) && Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

export function parseWaitSec(text: string, bounds: Pick<RegistryView["ownerWait"], "minSec" | "maxSec">): number | undefined {
  const t = text.trim();
  const n = Number(t);
  return /^\d+$/.test(t) && Number.isSafeInteger(n) && n >= bounds.minSec && n <= bounds.maxSec ? n : undefined;
}

const validRounds = (n: number) => Number.isInteger(n) && n >= ROUNDS_BOUNDS.min && n <= ROUNDS_BOUNDS.max;

const capText = (registry: RegistryView) => (registry.defaults.maxTotalTokens === null ? "" : String(registry.defaults.maxTotalTokens));

export function initialForm(ctx: SetupContext, last: RosterEntry[] | null): SetupForm {
  const { registry, template } = ctx;
  const known = (list: RosterEntry[]) => list.filter((e) => registry.providers.some((p) => p.id === e.providerId));
  let roster = known(last ?? []);
  if (roster.length === 0) roster = known(registry.defaults.participants);
  roster = roster.slice(0, registry.defaults.maxParticipants);
  const rounds = template?.maxRounds ?? registry.defaults.maxRounds;
  return {
    templateId: template?.id ?? null,
    topic: template?.exampleTopic ?? "",
    participants: roster.map((e, i) => ({ key: i, providerId: e.providerId, model: e.model, role: template?.roles[i] ?? "" })),
    maxRounds: Math.min(ROUNDS_BOUNDS.max, Math.max(ROUNDS_BOUNDS.min, rounds)),
    tokenCap: capText(registry),
    pauseAfterRound: false,
    waitForOwner: false,
    waitSec: String(registry.ownerWait.defaultSec),
    drafts: false,
    synthesizerKey: null,
    nextKey: roster.length,
  };
}

/** The synthesizer is always a lineup participant: a disabled option resets the key, a stray key is replaced by the first participant. */
function settleSynthesizer(form: SetupForm): SetupForm {
  const key = !form.drafts ? null : form.participants.some((p) => p.key === form.synthesizerKey) ? form.synthesizerKey : (form.participants[0]?.key ?? null);
  return key === form.synthesizerKey ? form : { ...form, synthesizerKey: key };
}

/** Position (from zero) and key of the selected synthesizer in the current list; null — the option is off or the lineup is empty. */
export function synthesizerOf(form: SetupForm): { index: number; key: number } | null {
  if (!form.drafts) return null;
  const index = form.participants.findIndex((p) => p.key === form.synthesizerKey);
  return index < 0 ? null : { index, key: form.participants[index]!.key };
}

export const reduceSetup = (form: SetupForm, action: SetupAction, ctx: SetupContext, language?: Language): SetupForm => settleSynthesizer(reduceSetupRaw(form, action, ctx, language));

function reduceSetupRaw(form: SetupForm, action: SetupAction, ctx: SetupContext, language?: Language): SetupForm {
  const { registry, template } = ctx;
  const patch = (key: number, f: (p: FormParticipant) => FormParticipant): SetupForm =>
    form.participants.some((p) => p.key === key) ? { ...form, participants: form.participants.map((p) => (p.key === key ? f(p) : p)) } : form;
  switch (action.type) {
    case "topic": return { ...form, topic: action.value };
    case "role": return patch(action.key, (p) => ({ ...p, role: action.role }));
    case "model": return patch(action.key, (p) => ({ ...p, model: action.model, issue: null, note: null }));
    case "add": {
      if (form.participants.length >= registry.defaults.maxParticipants) return form;
      const provider = registry.providers.find((p) => p.available) ?? registry.providers[0];
      if (!provider) return form;
      const row = { key: form.nextKey, providerId: provider.id, model: provider.models[0] ?? "", role: template?.roles[form.participants.length] ?? "" };
      return { ...form, participants: [...form.participants, row], nextKey: form.nextKey + 1 };
    }
    case "remove": return patch(action.key, (p) => p) === form ? form : { ...form, participants: form.participants.filter((p) => p.key !== action.key) };
    case "move": {
      const i = form.participants.findIndex((p) => p.key === action.key);
      const a = form.participants[i], b = form.participants[i + action.delta];
      if (!a || !b) return form;
      const participants = [...form.participants];
      participants[i] = b;
      participants[i + action.delta] = a;
      return { ...form, participants };
    }
    case "provider": {
      const provider = registry.providers.find((p) => p.id === action.providerId);
      return provider ? patch(action.key, (p) => ({ ...p, providerId: provider.id, model: provider.models[0] ?? "", issue: null, note: null })) : form;
    }
    case "lineup": {
      const participants = action.participants.map((p, i) => ({ key: form.nextKey + i, providerId: p.providerId, model: p.model, role: p.role ?? "", issue: p.available ? null : (p.reason ?? messages(language).lineupUnavailable), note: p.modelNote }));
      return { ...form, participants, nextKey: form.nextKey + participants.length };
    }
    case "drafts": return form.drafts === action.value ? form : { ...form, drafts: action.value };
    case "synthesizer": return form.drafts && form.participants.some((p) => p.key === action.key) ? { ...form, synthesizerKey: action.key } : form;
    case "pause-after-round": return { ...form, pauseAfterRound: action.value };
    case "wait-for-owner": return { ...form, waitForOwner: action.value };
    case "wait-sec": return { ...form, waitSec: action.value };
    case "cap": return { ...form, tokenCap: action.value };
    case "rounds": return validRounds(action.value) ? { ...form, maxRounds: action.value } : form;
  }
}

export interface SetupCheck {
  topicError: string | null;
  countError: string | null;
  capError: string | null;
  waitError: string | null;
  participantErrors: (string | null)[];
  participantNotes: (string | null)[];
  canAdd: boolean;
  canStart: boolean;
  startHint: string | null;
}

const joinParts = (parts: string[], language?: Language) => formatList(parts, language);

export const materialsTotal = (m: MaterialsView, language?: Language): string => messages(language).materialsTotal(m.items.length, m.chars, m.limit);

export const materialsOverText = (m: MaterialsView, language?: Language): string => messages(language).materialsOver(chars(m.chars, language), m.limit, m.over);

export const materialsLeftHint = (m: MaterialsView, language?: Language): string => messages(language).materialsLeft(m.limit);

export const materialsFolderLine = (f: { files: number; chars: number }, language?: Language): string => messages(language).materialsFolder(f.files, f.chars);

export function checkSetup(form: SetupForm, registry: RegistryView, materials: MaterialsView | null = null, language?: Language): SetupCheck {
  const t = messages(language);
  const max = registry.defaults.maxParticipants;
  const count = form.participants.length;
  const topicError = form.topic.trim() === "" ? t.topicRequired : null;
  const countError = count < 2 ? t.countMin : count > max ? t.countMax(max) : null;
  const participantErrors = form.participants.map((p) => {
    const provider = registry.providers.find((x) => x.id === p.providerId);
    if (!provider) return t.providerNotFound;
    if (!provider.available) return t.providerUnavailable(provider.label, provider.reason ?? t.reasonUnknown);
    return p.model === "" ? t.modelNotSelected : (p.issue ?? null);
  });
  const participantNotes = form.participants.map((p, i) => (participantErrors[i] ? null : (p.note ?? null)));
  const capError = parseTokenCap(form.tokenCap) === undefined ? t.capInvalid : null;
  const waitError = (form.pauseAfterRound || form.waitForOwner) && parseWaitSec(form.waitSec, registry.ownerWait) === undefined
    ? t.waitInvalid(registry.ownerWait.minSec, registry.ownerWait.maxSec) : null;
  const over = (materials?.over ?? 0) > 0;
  const canStart = !topicError && !countError && !capError && !waitError && !over && participantErrors.every((e) => e === null);
  let startHint: string | null = null;
  if (!canStart) {
    const parts: string[] = [];
    if (topicError) parts.push(t.hintTopic);
    if (count === 0) parts.push(t.hintAddTwo);
    else if (count === 1) parts.push(t.hintAddSecond);
    else if (count > max) parts.push(t.hintMax(max));
    participantErrors.forEach((e, i) => { if (e) parts.push(t.hintParticipant(i + 1, e)); });
    if (capError) parts.push(t.hintCap);
    if (waitError) parts.push(t.hintWait);
    // exceeding the materials limit is explained by a separate line with numbers above the button
    const text = joinParts(parts, language);
    if (text) startHint = text.charAt(0).toUpperCase() + text.slice(1);
  }
  return { topicError, countError, capError, waitError, participantErrors, participantNotes, canAdd: count < max, canStart, startHint };
}

export { billingOf };

export const lineupSaveInput = (form: SetupForm, name: string): LineupSaveInput => ({
  name,
  participants: form.participants.map((p) => ({ providerId: p.providerId, model: p.model, role: p.role.trim() || null })),
});

export const lineupLabel = (l: LineupView, language?: Language): string => (l.available ? l.name : messages(language).lineupUnavailableLabel(l.name));

export interface Estimate { calls: number; callsText: string; note: string; free: boolean; materialsNote?: string; capNote?: string; draftsNote?: string }

export const callsBound = (calls: number, language?: Language): string => messages(language).callsBound(calls);

export function estimate(form: SetupForm, registry: RegistryView, materials: MaterialsView | null = null, language?: Language): Estimate | null {
  const t = messages(language);
  const base = estimateBase(form, registry, language);
  if (!base) return base;
  const cap = parseTokenCap(form.tokenCap);
  return {
    ...base,
    ...(materials && materials.items.length > 0 ? { materialsNote: t.materialsNote(chars(materials.chars, language)) } : {}),
    ...draftsNote(form, registry, language),
    ...(cap === undefined ? {} : { capNote: cap === null ? t.capNone : t.capNote(cap) }),
  };
}

function draftsNote(form: SetupForm, registry: RegistryView, language?: Language): { draftsNote?: string } {
  const s = synthesizerOf(form);
  if (!s) return {};
  return { draftsNote: messages(language).draftsNote(s.index + 1, rosterNames(form.participants, registry.providers)[s.index]!, maxCallsBound(form.participants.length, 0, true)) };
}

function estimateBase(form: SetupForm, registry: RegistryView, language?: Language): Estimate | null {
  if (form.participants.length < 2) return null;
  const calls = maxCallsBound(form.participants.length, form.maxRounds, form.drafts);
  const callsText = callsBound(calls, language);
  const rows = form.participants.map((p) => {
    const provider = registry.providers.find((x) => x.id === p.providerId);
    return { label: provider?.label ?? "", billing: billingOf(provider, p.model), providerBilling: provider?.billing };
  });
  return { calls, callsText, ...billingNote(rows, language) };
}

export interface BillingRow { label: string; billing: Billing; providerBilling: Billing | undefined } // billing — with the model taken into account, providerBilling — the provider's flag

// Spend explanation: shared by the estimate on "Session setup" and the resume panel.
export function billingNote(rows: BillingRow[], language?: Language): { free: boolean; note: string } {
  const t = messages(language);
  if (rows.every((r) => r.billing === "free")) {
    return { free: true, note: t.sessionFree };
  }
  const labels = (pick: (r: BillingRow) => boolean) => [...new Set(rows.filter(pick).map((r) => r.label))];
  const parts: string[] = [];
  const sub = labels((r) => r.providerBilling === "subscription");
  if (sub.length) parts.push(t.usesSubscription(joinParts(sub, language), sub.length > 1));
  const paid = labels((r) => r.billing === "paid");
  if (paid.length) parts.push(t.billedByTariff(joinParts(paid, language), paid.length > 1));
  for (const l of labels((r) => r.providerBilling === "paid" && r.billing === "free")) parts.push(t.freeModel(l));
  return { free: false, note: parts.join("; ") };
}

// Form from a past session: participants with an unknown or unavailable provider stay, checkSetup marks them.
export function formFromRerun(view: RerunView, registry: RegistryView): SetupForm {
  return {
    templateId: view.templateId,
    topic: view.topic,
    participants: view.participants.map((p, i) => ({ key: i, providerId: p.providerId, model: p.model, role: p.role ?? "" })),
    maxRounds: view.maxRounds,
    tokenCap: capText(registry),
    pauseAfterRound: view.ownerWait?.pauseAfterRound ?? false,
    waitForOwner: view.ownerWait?.waitForOwner ?? false,
    waitSec: String(view.ownerWait?.timeoutSec ?? registry.ownerWait.defaultSec),
    drafts: false,
    synthesizerKey: null,
    nextKey: view.participants.length,
  };
}

export interface AcceptedPreview { handle: string; stamp: string; createdAt: string }
export type PreviewStatus = "none" | "accepted" | "stale";

/** none — the set is not accepted; accepted — accepted and the stamp matches the current list; stale — accepted, but the lineup or the limit changed. */
export function previewStatus(materials: MaterialsView | null, accepted: AcceptedPreview | null): PreviewStatus {
  if (accepted === null) return "none";
  return materials !== null && materials.stamp === accepted.stamp ? "accepted" : "stale";
}

/** The shown set corresponds to the current materials list. */
export function previewIsCurrent(materials: MaterialsView | null, preview: Pick<MaterialsPreviewView, "stamp"> | null): boolean {
  return materials !== null && preview !== null && materials.stamp === preview.stamp;
}

/** Time "HH:MM" in local time from an ISO string, in the language's format. */
export const previewTime = (iso: string, language?: Language): string => formatDate(new Date(iso), { timeStyle: "short" }, language);

export function toStartInput(form: SetupForm, registry: RegistryView, materials: MaterialsView | null = null, framingFrom?: string, accepted: AcceptedPreview | null = null): StartInput {
  const cap = parseTokenCap(form.tokenCap);
  const synth = synthesizerOf(form);
  const timeoutSec = (form.pauseAfterRound || form.waitForOwner) ? parseWaitSec(form.waitSec, registry.ownerWait) : undefined;
  return {
    templateId: form.templateId,
    topic: form.topic.trim(),
    participants: form.participants.map((p) => ({ providerId: p.providerId, model: p.model, role: p.role.trim() || null })),
    maxRounds: form.maxRounds,
    ...(cap === undefined ? {} : { maxTotalTokens: cap }),
    ...(synth ? { drafts: { synthesizerId: `p${synth.index + 1}` } } : {}),
    ...(timeoutSec === undefined ? {} : { ownerWait: { pauseAfterRound: form.pauseAfterRound, waitForOwner: form.waitForOwner, timeoutSec } }),
    ...(materials && (materials.items.length > 0 || materials.folder !== null) ? { useMaterials: true } : {}), // a folder without initial materials also goes into the session as a snapshot
    ...(framingFrom !== undefined ? { framingFrom } : {}),
    ...(accepted && previewStatus(materials, accepted) === "accepted" ? { preparedHandle: accepted.handle } : {}),
  };
}

// Setup snapshot for the shared template editor: topic, roles and the round limit from the form, the rest from the main snapshot
export function setupTemplateData(form: SetupForm, snapshot: TemplateEditorData): TemplateEditorData {
  const roles = form.participants.map((p) => p.role.trim());
  return {
    ...snapshot,
    categories: [...snapshot.categories],
    takenIds: [...snapshot.takenIds],
    draft: {
      title: "",
      category: snapshot.draft.category,
      description: form.topic,
      exampleTopic: form.topic,
      framing: snapshot.draft.framing,
      roles: roles.every((r) => r === "") ? [] : roles,
      limits: { maxRounds: form.maxRounds },
    },
  };
}
