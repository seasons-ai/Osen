import { LineupsError, checkLineup, readLineups, saveLineup } from "@model-council/core";
import type { ProviderStatus, Registry } from "@model-council/core";
import type { LineupSaveResult, LineupsView } from "../shared/setup.ts";
import { setupMain } from "../shared/messages/setup-main.ts";

/** Lineups checked against the registry. The DTO is built by listing fields: nothing beyond the contract goes to the renderer. */
export function lineupsView(dataDir: string, registry: Registry, statuses: readonly ProviderStatus[], scripted: ((model: string) => string | null) | null): LineupsView {
  try {
    const lineups = readLineups(dataDir).map((l) => checkLineup(l, { registry, statuses, scripted })).map((c) => ({
      id: c.id, name: c.name, available: c.available,
      participants: c.participants.map((p) => ({ providerId: p.providerId, model: p.model, role: p.role, available: p.available, reason: p.reason, modelNote: p.modelNote })),
    }));
    return { lineups, error: null };
  } catch (e) {
    if (!(e instanceof LineupsError)) throw e;
    return { lineups: [], error: e.message };
  }
}

const bad = (what: string): LineupSaveResult => ({ ok: false, error: setupMain().lineupBadRequest(what) });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Trust boundary: input from the renderer. Only providerId, model, role go to the core; provider availability is not checked. */
export async function saveLineupInput(dataDir: string, raw: unknown): Promise<LineupSaveResult> {
  if (!isObject(raw)) return bad(setupMain().lineupReqObject);
  if (typeof raw["name"] !== "string") return bad(setupMain().lineupNameString);
  if (!Array.isArray(raw["participants"])) return bad(setupMain().lineupParticipantsArray);
  const participants: { providerId: string; model: string; role: string | null }[] = [];
  for (const [i, p] of raw["participants"].entries()) {
    if (!isObject(p)) return bad(setupMain().lineupParticipantObject(i + 1));
    if (!nonEmpty(p["providerId"])) return bad(setupMain().lineupNoProvider(i + 1));
    if (!nonEmpty(p["model"])) return bad(setupMain().lineupNoModel(i + 1));
    const role = p["role"];
    if (role !== null && typeof role !== "string") return bad(setupMain().lineupRoleType(i + 1));
    participants.push({ providerId: p["providerId"], model: p["model"], role: role?.trim() || null });
  }
  try {
    const l = await saveLineup(dataDir, { name: raw["name"], participants });
    return { ok: true, id: l.id, name: l.name };
  } catch (e) {
    if (!(e instanceof LineupsError)) throw e;
    return { ok: false, error: e.message };
  }
}
