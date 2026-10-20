import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ensureRegistry, eventsPath, planResume, logRegistryLoaded, readRegistry, ResumeRejectedError, resumeDrivers, runResumedSession } from "@model-council/core";
import type { ResumePlan } from "@model-council/core";
import { z } from "zod";
import { defineTool, resumeScenarioPath, ROUNDS_BOUNDS, SCRIPTED_PROVIDER_ID, ToolError } from "./context.ts";
import { mcpMessages } from "./messages.ts";
import { rosterNames, rosterProviders } from "./start.ts";
import { load } from "./status.ts";

export interface ResumeView {
  sessionId: string;
  mode: "plan" | "execute";
  accepted: boolean;
  planToken: string;
  status: ResumePlan["status"];
  source: "desktop" | "mcp" | "cli";
  topic: string;
  addedRounds: number;
  maxRounds: number;
  maxCalls: number;
  draftCalls: number;
  maxTotalTokens: number | null;
  spentTokens: number;
  participants: { id: string; name: string; providerId: string; model: string; role: string | null; billing: "subscription" | "paid" | "free" }[];
  requiresConsent: boolean;
  waiting: { waitId: string; deadline: string; expired: boolean } | null;
  replacements: { oldParticipantId: string; oldName: string; newParticipantId: string; name: string; providerId: string; model: string; role: string | null; reason: string }[];
  agreementReset: boolean;
  droppedOwnerRequests?: { requestId: string; text: string; questionId: string | null }[];
  next: string;
}

const HINTED: Record<string, () => string> = {
  no_rounds_left: () => mcpMessages().resumeCapHint,
  token_cap: () => mcpMessages().resumeCapHint,
  bad_token_cap: () => mcpMessages().resumeCapHint,
  consensus: () => mcpMessages().resumeConsensusHint,
};

// on execute a participant or replacement refusal means availability changed after the plan
const staleOrRefuse = (id: string, e: unknown): never => {
  if (e instanceof ResumeRejectedError && (e.reason === "participant" || e.reason === "replacement")) {
    throw new ToolError(`stale_plan: ${mcpMessages().resumeStaleWithReason(e.message)}`, `Resume of session ${id} rejected: stale_plan`);
  }
  return refuse(id, e);
};

const refuse = (id: string, e: unknown): never => {
  if (!(e instanceof ResumeRejectedError)) throw e;
  throw new ToolError(`${e.reason}: ${e.message}${HINTED[e.reason]?.() ?? ""}`, `Resume of session ${id} rejected: ${e.reason}`);
};

// The token confirms that the plan is unchanged; it is not written to disk.
function tokenOf(ctxDir: string, plan: ResumePlan): string {
  const bytes = readFileSync(eventsPath(ctxDir, plan.id));
  // the journal grew between the plan and the hash — another executor is already resuming the session: this is busy, not stale_plan
  if (bytes.length !== plan.journalBytes) throw new ResumeRejectedError("busy", mcpMessages().resumeJournalChanged(plan.id));
  const journal = createHash("sha256").update(bytes).digest("hex");
  return createHash("sha256").update(JSON.stringify([
    plan.id, plan.addedRounds, plan.maxRounds, plan.maxCalls, plan.tokenCap,
    plan.maxTotalTokens === undefined ? "keep" : plan.maxTotalTokens, plan.journalBytes, journal,
    plan.active.map((p) => [p.id, p.providerId, p.model, p.role, p.name]),
    plan.status, plan.message ?? null,
    plan.replacements.map((r) => [r.oldParticipantId, r.participant.id, r.participant.providerId, r.participant.model, r.participant.role, r.participant.name]),
  ])).digest("hex");
}

export const councilResume = defineTool({
  name: "council_resume",
  get description() { return mcpMessages().resumeDesc; },
  get inputSchema() {
    const m = mcpMessages();
    return {
      sessionId: z.string().describe(m.fSessionId),
      rounds: z.number().optional().describe(m.resumeFRounds(ROUNDS_BOUNDS.min, ROUNDS_BOUNDS.max)),
      maxTotalTokens: z.number().nullable().optional().describe(m.resumeFMaxTotalTokens),
      execute: z.boolean().optional().describe(m.resumeFExecute),
      planToken: z.string().optional().describe(m.resumeFPlanToken),
      replacements: z.array(z.object({ participantId: z.string(), providerId: z.string(), model: z.string() })).optional()
        .describe(m.resumeFReplacements),
      message: z.string().optional().describe(m.resumeFMessage),
    };
  },
  async run(ctx, input) {
    const m = mcpMessages();
    if (ctx.env.COUNCIL_PARTICIPANT === "1") throw new ToolError(m.resumeParticipant);
    const { sessionId, rounds, maxTotalTokens } = input;
    const { min, max } = ROUNDS_BOUNDS;
    if (rounds !== undefined && (!Number.isInteger(rounds) || rounds < min || rounds > max)) {
      throw new ToolError(`bad_rounds: ${m.resumeBadRounds(min, max)}`);
    }
    const execute = input.execute === true;
    if (execute && !input.planToken) {
      throw new ToolError(`plan_required: ${m.resumePlanRequired}`);
    }
    const stored = load(ctx, sessionId);
    await ensureRegistry(ctx.dataDir, { env: ctx.env, deps: ctx.inspectDeps });
    const registry = readRegistry(ctx.dataDir);
    logRegistryLoaded(ctx.logger, ctx.dataDir, registry);

    let plan: ResumePlan;
    let token: string;
    const driverOpts = () => ({
      registry, env: ctx.env, dataDir: ctx.dataDir, deps: ctx.inspectDeps,
      scenarioPath: (m: string) => resumeScenarioPath(ctx.scenariosDir, m),
    });
    // names of new participants — by the same rules as in council_start; the order of map entries does not matter
    const named = (reps: NonNullable<typeof input.replacements>) => {
      const num = (r: { participantId: string }) => Number(r.participantId.replace(/\D/g, ""));
      const sorted = [...reps].sort((a, b) => num(a) - num(b));
      const names = rosterNames([...(stored.state.session?.participants ?? []), ...sorted], rosterProviders(registry));
      const tail = names.slice(names.length - sorted.length);
      return sorted.map((r, i) => ({ ...r, name: tail[i]! }));
    };
    let unavailable: Record<string, string> = {};
    let drivers: Awaited<ReturnType<typeof resumeDrivers>>["drivers"];
    try {
      plan = planResume(ctx.dataDir, sessionId, {
        ...(rounds !== undefined ? { rounds } : {}), ...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}),
        ...(input.replacements ? { replacements: named(input.replacements) } : {}),
        ...(input.message !== undefined ? { message: input.message } : {}),
      });
      token = tokenOf(ctx.dataDir, plan); // right after the plan: while the journal is the same
      // a stale plan is noticed before the availability checks
      if (execute && input.planToken !== token) throw new ToolError(`stale_plan: ${m.resumeStale}`, `Resume of session ${sessionId} rejected: stale_plan`);
    } catch (e) {
      return refuse(sessionId, e);
    }
    try {
      ({ drivers, unavailable } = await resumeDrivers(plan, driverOpts()));
    } catch (e) {
      return execute ? staleOrRefuse(sessionId, e) : refuse(sessionId, e);
    }

    const participants = plan.active.map((p) => {
      const kind = registry.providers.find((x) => x.id === p.providerId)?.kind;
      const billing = p.providerId === SCRIPTED_PROVIDER_ID ? "free" : kind === "cli" ? "subscription" : "paid";
      return { id: p.id, name: p.name, providerId: p.providerId, model: p.model, role: p.role, billing } as const;
    });
    const replacements = plan.replacements.map((r) => ({
      oldParticipantId: r.oldParticipantId,
      oldName: plan.session.participants.find((p) => p.id === r.oldParticipantId)?.name ?? r.oldParticipantId,
      newParticipantId: r.participant.id, name: r.participant.name, providerId: r.participant.providerId, model: r.participant.model, role: r.participant.role,
      reason: r.wasActive ? m.resumeReplacementUnavailable(unavailable[r.oldParticipantId]) : m.resumeReplacementDropped(r.dropReason),
    }));
    const w = plan.state.waiting;
    const view: ResumeView = {
      sessionId, mode: execute ? "execute" : "plan", accepted: false, planToken: token,
      status: plan.status, source: plan.session.origin, topic: plan.session.topic,
      addedRounds: plan.addedRounds, maxRounds: plan.maxRounds, maxCalls: plan.maxCalls, draftCalls: plan.draftCalls,
      maxTotalTokens: plan.tokenCap, spentTokens: plan.spentTokens, participants, replacements, agreementReset: replacements.length > 0 || plan.message !== undefined,
      requiresConsent: participants.some((p) => p.billing !== "free"),
      waiting: w ? { waitId: w.waitId, deadline: w.deadline, expired: Date.parse(w.deadline) <= Date.now() } : null,
      next: m.resumeNextPlan(plan.addedRounds, plan.maxCalls, plan.draftCalls, replacements.length > 0, plan.message !== undefined),
    };
    if (!execute) {
      ctx.logger.info(`Resume plan of session ${sessionId} from MCP: ${plan.addedRounds} more rounds, call bound ${plan.maxCalls}`);
      return view;
    }
    // We resolve on the first event (session_resumed is already in the journal); we do not wait for the discussion to end, a late failure is already written to the log.
    let dropped: NonNullable<ResumeView["droppedOwnerRequests"]> = [];
    try {
      await new Promise<void>((resolve, reject) => {
        runResumedSession({
          dataDir: ctx.dataDir, plan, drivers,
          ...(plan.replacements.length > 0 ? { revalidate: () => resumeDrivers(plan, driverOpts()) } : {}), logger: ctx.logger, signal: ctx.shutdown,
          onAccepted: (a) => { dropped = a.droppedOwnerRequests.map((r) => ({ requestId: r.requestId, text: r.text, questionId: r.questionId ?? null })); },
          onEvent: () => resolve(),
        }).catch(reject);
      });
    } catch (e) {
      return staleOrRefuse(sessionId, e);
    }
    ctx.logger.info(`Resume of session ${sessionId} from MCP accepted: ${plan.addedRounds} more rounds, call bound ${plan.maxCalls}, unapplied messages removed ${dropped.length}`);
    return {
      ...view, accepted: true, droppedOwnerRequests: dropped,
      next: m.resumeNextAccepted(sessionId, dropped.length),
    };
  },
});
