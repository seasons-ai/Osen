import { currentVersion, sessionTotals } from "./protocol/state.ts";
import type { SessionState } from "./protocol/state.ts";
import type { ProviderStatus } from "./registry/providers.ts";
import type { Lineup } from "./registry/lineups.ts";
import type { JournalPartial, StoredStatus } from "./store/sessions.ts";
import type { TemplateCatalog } from "./templates/templates.ts";

// Machine output of the council commands (--json). Keys, statuses and codes do not depend on the language.
export const SCHEMA_VERSION = 1;

// commands that accept --json; extend here
export const JSON_COMMANDS: readonly string[] = ["status", "list", "show", "providers", "templates", "lineups", "doctor"];

interface ListedSession { id: string; createdAt: string; status: StoredStatus; origin: string; topic: string; partial: JournalPartial | null }

const partialJson = (p: JournalPartial | null) => (p === null ? null : { reason: p.reason, lastEvent: p.lastEvent });

export function listJson(sessions: readonly ListedSession[]) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessions: sessions.map((s) => ({ id: s.id, createdAt: s.createdAt, status: s.status, origin: s.origin, topic: s.topic, partial: partialJson(s.partial) })),
  };
}

function waitingJson(state: SessionState) {
  const w = state.waiting;
  if (w === null) return null;
  return {
    waitId: w.waitId,
    reasons: w.reasons,
    questions: w.questionIds.map((id) => {
      const q = state.questions.find((x) => x.id === id);
      return { id, from: q?.from ?? null, text: q?.text ?? null };
    }),
    deadline: w.deadline,
  };
}

export function statusJson(id: string, status: StoredStatus, partial: JournalPartial | null, state: SessionState) {
  return {
    schemaVersion: SCHEMA_VERSION, id, status, partial: partialJson(partial),
    round: state.round, maxRounds: state.session!.limits.maxRounds, turns: state.turns.length, waiting: waitingJson(state),
  };
}

export function showJson(id: string, status: StoredStatus, partial: JournalPartial | null, state: SessionState) {
  const f = state.finish, v = currentVersion(state), sel = state.ownerSelection, tot = sessionTotals(state);
  return {
    schemaVersion: SCHEMA_VERSION, id, status, partial: partialJson(partial),
    finish: f === null ? null : { status: f.status, reason: f.reason ?? null, agreed: f.agreed, objecting: f.objectors.map((o) => ({ participantId: o.participantId, reasoning: o.reasoning ?? null })) },
    currentVersion: v === null ? null : { number: v.number, authorId: v.authorId, text: v.text },
    agreed: state.agreed,
    waiting: waitingJson(state),
    ownerSelection: sel === null ? null : { version: sel.version, ts: sel.ts, note: sel.note ?? null, statusAtSelection: sel.statusAtSelection },
    totals: { turns: tot.turns, drafts: tot.drafts, durationMs: tot.durationMs, inputTokens: tot.inputTokens, outputTokens: tot.outputTokens, costUsd: tot.costUsd, incomplete: tot.incomplete },
  };
}

const providerItem = (s: ProviderStatus) => ({
  id: s.id, kind: s.kind, label: s.label, available: s.available, reason: s.reason ?? null, warning: s.warning ?? null,
  path: s.path ?? null, version: s.version ?? null, verified: s.verified ?? null, baseUrl: s.baseUrl ?? null, keyEnv: s.keyEnv ?? null, keySet: s.keySet ?? null,
  models: s.models, modelsConfirmed: s.modelsConfirmed, modelsReason: s.modelsReason ?? null,
});

export function providersJson(statuses: readonly ProviderStatus[]) {
  return { schemaVersion: SCHEMA_VERSION, providers: statuses.map(providerItem) };
}

/** Facts collected by the caller; the document only shapes them. */
export interface DoctorFacts {
  execPath: string; entry: string | null; version: string | null;
  mode: "packaged" | "node"; node: string | null;
  language: string;
  dataDir: { path: string; exists: boolean; writable: boolean };
  config: { path: string; created: boolean };
  providers: readonly ProviderStatus[];
}

export function doctorJson(f: DoctorFacts) {
  return {
    schemaVersion: SCHEMA_VERSION,
    binary: { execPath: f.execPath, entry: f.entry, version: f.version },
    runtime: { mode: f.mode, node: f.node },
    language: f.language,
    dataDir: f.dataDir,
    config: f.config,
    providers: f.providers.map(providerItem),
  };
}

export function templatesJson(c: Pick<TemplateCatalog, "templates" | "errors">) {
  return {
    schemaVersion: SCHEMA_VERSION,
    templates: c.templates.map((t) => ({ id: t.id, category: t.category, title: t.title, source: t.source })),
    errors: c.errors.map((e) => ({ file: e.file, source: e.source, reason: e.reason })),
  };
}

export function lineupsJson(lineups: readonly Lineup[]) {
  return {
    schemaVersion: SCHEMA_VERSION,
    lineups: lineups.map((l) => ({ id: l.id, name: l.name, participants: l.participants.map((p) => ({ providerId: p.providerId, model: p.model, role: p.role ?? null })) })),
  };
}
