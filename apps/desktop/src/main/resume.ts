import { statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { planResume, readSession, ResumeRejectedError, slotRoster, tokenUsage } from "@model-council/core";
import type { Participant, ReplacementInput, ResumePlan } from "@model-council/core";
import type { ResumeReplacement, ResumeView } from "../shared/bridge.ts";
import { billingOf, ROUNDS_BOUNDS, rosterNames, SCRIPTED_PROVIDER_ID } from "../shared/setup.ts";
import type { ProviderOption, RegistryView } from "../shared/setup.ts";
import { resultMain } from "../shared/messages/result-main.ts";
import { session } from "../shared/messages/session.ts";

const isFile = (p: string): boolean => {
  try { return statSync(p).isFile(); } catch { return false; }
};

// Sessions started in the app keep the scenario name in model; sessions started by the council command keep the call path.
// The app does not resolve a relative path from the terminal: the working folder is different.
export const resumeScenarioPath = (byName: (model: string) => string | null) => (model: string): string | null =>
  byName(model) ?? (isAbsolute(model) && isFile(model) ? model : null);

/** The replacement map did not pass the window check; the caller turns it into a LaunchError or ActionError. */
export class ReplacementInputError extends Error {}

/**
 * Checks the replacement map from the window and names new participants the same way as "Session setup":
 * names are counted over the whole session roster (including dropped ones) plus new entries by identifier number.
 * A scripted participant — only a name from the catalog; a path from the window is not accepted.
 */
export function nameReplacements(
  raw: unknown, existing: readonly Pick<Participant, "providerId" | "model">[],
  providers: readonly Pick<ProviderOption, "id" | "label" | "defaultModel">[], scenarioPath: (model: string) => string | null,
): ReplacementInput[] {
  const m = resultMain();
  if (!Array.isArray(raw)) throw new ReplacementInputError(m.replacementsNotArray);
  const entries = raw.map((r: unknown, i): ResumeReplacement => {
    const o = typeof r === "object" && r !== null && !Array.isArray(r) ? (r as Record<string, unknown>) : null;
    const at = m.replacementAt(i + 1);
    if (!o || typeof o.participantId !== "string" || !/^p[1-9]\d*$/.test(o.participantId)) throw new ReplacementInputError(m.replacementBadId(at));
    if (typeof o.providerId !== "string" || !o.providerId || typeof o.model !== "string" || !o.model) throw new ReplacementInputError(m.replacementNeedFields(at, o.participantId));
    if (o.providerId === SCRIPTED_PROVIDER_ID) {
      // A path from the window does not go into the refusal whole: it contains the owner's home folder.
      if (isAbsolute(o.model)) throw new ReplacementInputError(m.replacementScenarioPath(at, o.participantId, basename(o.model)));
      if (scenarioPath(o.model) === null) throw new ReplacementInputError(m.replacementNoScenario(at, o.participantId, o.model));
    } else if (!providers.some((p) => p.id === o.providerId)) {
      throw new ReplacementInputError(m.replacementNoProvider(at, o.participantId, o.providerId));
    }
    return { participantId: o.participantId, providerId: o.providerId, model: o.model };
  });
  const sorted = [...entries].sort((a, b) => Number(a.participantId.slice(1)) - Number(b.participantId.slice(1)));
  const names = rosterNames([...existing, ...sorted].map((e) => ({ providerId: e.providerId, model: e.model })), providers).slice(existing.length);
  return sorted.map((e, i) => ({ ...e, name: names[i]! }));
}

/** What to show on the resume screen. Writes and starts nothing. */
export function resumeView(
  dataDir: string, id: string, registry: RegistryView, scenarioPath: (model: string) => string | null, replacements?: readonly ResumeReplacement[],
): ResumeView {
  const { min, max } = ROUNDS_BOUNDS;
  const m = resultMain();
  const before = readSession(dataDir, id)?.state ?? null;
  const inputs = replacements?.length
    ? nameReplacements(replacements, before?.session?.participants ?? [], registry.providers, scenarioPath)
    : undefined;
  let plan: ResumePlan;
  let remaining: number | null = null;
  let exhausted = false;
  const initialRounds = Math.min(max, Math.max(min, registry.defaults.maxRounds));
  const availability = (p: Participant) => {
    if (p.providerId === SCRIPTED_PROVIDER_ID) {
      const found = scenarioPath(p.model) !== null;
      return { id: p.id, name: p.name, billing: "free" as const, available: found, reason: found ? null : m.scenarioUnavailable(p.model) };
    }
    const provider = registry.providers.find((x) => x.id === p.providerId);
    if (!provider) return { id: p.id, name: p.name, billing: "free" as const, available: false, reason: m.providerMissing(p.providerId) };
    return { id: p.id, name: p.name, billing: billingOf(provider, p.model), available: provider.available, reason: provider.available ? null : provider.reason };
  };
  // Who can be replaced: computed on the roster before replacements, in slot order.
  const replaceable = (): ResumeView["replaceable"] => {
    if (!before?.session) return [];
    const out: ResumeView["replaceable"] = [];
    for (const p of slotRoster(before.session)) {
      const st = before.participants.find((x) => x.id === p.id);
      if (st?.status === "dropped") out.push({ id: p.id, name: p.name, why: "dropped", reason: st.dropReason ?? session().reasonMissing, required: false });
      else {
        const a = availability(p);
        if (!a.available) out.push({ id: p.id, name: p.name, why: "unavailable", reason: a.reason ?? m.unavailable, required: true });
      }
    }
    return out;
  };
  try {
    // An exhausted ceiling does not prevent building the view: the plan is taken without the ceiling, and the owner is offered a new one or removal.
    const plan_ = (o: { rounds?: number; maxTotalTokens?: number | null }) => {
      const opts = { ...o, ...(inputs ? { replacements: inputs } : {}) };
      try {
        return planResume(dataDir, id, opts);
      } catch (e) {
        if (!(e instanceof ResumeRejectedError) || e.reason !== "token_cap") throw e;
        exhausted = true;
        return planResume(dataDir, id, { ...opts, maxTotalTokens: null });
      }
    };
    try {
      plan = plan_({});
      remaining = plan.addedRounds;
    } catch (e) {
      if (!(e instanceof ResumeRejectedError) || e.reason !== "no_rounds_left") throw e;
      plan = plan_({ rounds: 1 }); // no remainder — the screen asks the owner for the number of rounds
    }
  } catch (e) {
    if (!(e instanceof ResumeRejectedError)) throw e;
    if (e.reason === "replacement") throw e; // the panel keeps the previous view and shows the message
    const rounds = { min, max, remaining: null, initial: initialRounds };
    if (e.reason === "too_few_active" && before?.session) {
      const replaced = new Set(inputs?.map((r) => r.participantId));
      const alive = new Set(before.participants.filter((x) => x.status === "active").map((x) => x.id));
      return {
        allowed: true, reason: null, blocked: e.message, rounds,
        participants: slotRoster(before.session).filter((p) => alive.has(p.id) && !replaced.has(p.id)).map(availability), // those being replaced will not be in the future roster
        replaceable: replaceable(), replacements: [], providers: registry.providers, agreementReset: false,
        tokenCap: { cap: before.session.limits.maxTotalTokens ?? null, spent: tokenUsage(before).total, exhausted: false }, draftCalls: 0,
      };
    }
    return { allowed: false, reason: e.message, blocked: null, rounds, participants: [], replaceable: [], replacements: [], providers: [], agreementReset: false, tokenCap: { cap: null, spent: 0, exhausted: false }, draftCalls: 0 };
  }
  const initial = Math.min(max, Math.max(min, remaining ?? registry.defaults.maxRounds));
  const replacedOf = new Map(plan.replacements.map((r) => [r.participant.id, r.oldParticipantId]));
  const participants = plan.active.map((p) => ({ ...availability(p), ...(replacedOf.has(p.id) ? { replaces: replacedOf.get(p.id)! } : {}) }));
  const cap = plan.state.session?.limits.maxTotalTokens ?? null;
  return {
    allowed: true, reason: null, blocked: null, rounds: { min, max, remaining, initial }, participants,
    replaceable: replaceable(),
    replacements: plan.replacements.map((r) => ({ participantId: r.oldParticipantId, newId: r.participant.id, name: r.participant.name, providerId: r.participant.providerId, model: r.participant.model })),
    providers: registry.providers, agreementReset: plan.replacements.length > 0,
    tokenCap: { cap, spent: plan.spentTokens, exhausted }, draftCalls: plan.draftCalls,
  };
}
