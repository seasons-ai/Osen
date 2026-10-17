import { DEFAULT_MODEL } from "../cli-agents/types.ts";
import { registryMessages } from "../messages/registry.ts";
import type { Registry } from "./config.ts";
import type { Lineup, LineupParticipant } from "./lineups.ts";
import type { ProviderStatus } from "./providers.ts";

export interface LineupPosition extends LineupParticipant {
  available: boolean;
  reason: string | null;
  modelNote: string | null;
}
export interface LineupCheck { id: string; name: string; available: boolean; participants: LineupPosition[] }
export interface LineupCheckContext {
  registry: Registry;
  statuses: readonly ProviderStatus[];
  scripted: ((model: string) => string | null) | null;
}

function checkPosition(p: LineupParticipant, ctx: LineupCheckContext): LineupPosition {
  const m = registryMessages();
  const fail = (reason: string): LineupPosition => ({ ...p, available: false, reason, modelNote: null });
  if (p.providerId === "scripted") {
    if (ctx.scripted === null) return fail(m.chkScriptedDev);
    const r = ctx.scripted(p.model);
    return { ...p, available: r === null, reason: r, modelNote: null };
  }
  const provider = ctx.registry.providers.find((x) => x.id === p.providerId);
  if (!provider) return fail(m.chkProviderMissing(p.providerId));
  if (provider.kind === "openai-http" && p.model === DEFAULT_MODEL) return fail(m.chkNeedModel(p.providerId));
  const status = ctx.statuses.find((s) => s.id === p.providerId);
  if (!status) return fail(m.chkNotInspected);
  if (!status.available) return fail(status.reason ?? m.chkUnavailable);
  let modelNote: string | null = null;
  if (p.model !== DEFAULT_MODEL && !status.models.includes(p.model)) {
    const tail = !status.modelsConfirmed && status.modelsReason ? m.chkModelTail(status.modelsReason) : "";
    modelNote = m.chkModelMissing(p.model, p.providerId, tail);
  }
  return { ...p, available: true, reason: null, modelNote };
}

export function checkLineup(lineup: Lineup, ctx: LineupCheckContext): LineupCheck {
  const participants = lineup.participants.map((p) => checkPosition(p, ctx));
  return { id: lineup.id, name: lineup.name, available: participants.every((p) => p.available), participants };
}
