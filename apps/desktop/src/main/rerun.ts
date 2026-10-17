import { OWNER_WAIT_DEFAULT_SEC, materialFromText, readMaterialSnapshots, readMaterialSources, readSession, slotRoster } from "@model-council/core";
import type { CollectedMaterial, MaterialSource, TemplateCatalog } from "@model-council/core";
import { chosenVersion, finalVersion } from "../shared/final-version.ts";
import { ROUNDS_BOUNDS } from "../shared/setup.ts";
import type { RerunView } from "../shared/setup.ts";
import type { MaterialsDraft } from "./materials.ts";
import { setupMain } from "../shared/messages/setup-main.ts";

export class RerunError extends Error {} // the message is shown to the owner

export interface RerunDeps {
  dataDir: string;
  catalog(): TemplateCatalog;
  materials: Pick<MaterialsDraft, "carry">;
}

const two = (n: number) => String(n).padStart(2, "0");

export function prepareRerun(deps: RerunDeps, sessionId: string, withDecision: boolean): RerunView {
  const stored = readSession(deps.dataDir, sessionId);
  if (stored === null) throw new RerunError(setupMain().sessionNotFound(sessionId));
  if (stored.status === "running") throw new RerunError(setupMain().sessionRunning);
  const session = stored.state.session!;
  const created = new Date(session.createdAt);
  const date = `${created.getFullYear()}-${two(created.getMonth() + 1)}-${two(created.getDate())}`;

  const catalog = deps.catalog();
  const template = catalog.templates.find((t) => t.id === session.templateId);
  // The owner choice (if such a version is in the journal) outranks the result; a nonexistent choice is not a refusal but a fallback to the result.
  const chosen = chosenVersion(stored.state);
  const version = withDecision ? chosen ?? finalVersion(stored.state) : null;
  if (withDecision && version === null) throw new RerunError(setupMain().noDecision);

  const list: CollectedMaterial[] = [];
  const notes: string[] = [];
  const old = readMaterialSources(deps.dataDir, sessionId) ?? []; // an unreadable sources.json — materials are carried as plain text
  const sources: MaterialSource[] = [];
  for (const s of readMaterialSnapshots(deps.dataDir, sessionId) ?? []) {
    if (s.ok) {
      const id = `m${list.length + 1}`;
      const src = old.find((x) => x.id === s.material.id);
      if (src) sources.push({ ...src, id });
      list.push({ ...s.material, id });
    }
    else notes.push(setupMain().materialNotCarried(s.name, s.reason));
  }
  if (version !== null) list.push(materialFromText(`m${list.length + 1}`, (chosen ? setupMain().choiceName : setupMain().decisionName)(version.number, date), version.text));

  return {
    sessionId,
    date,
    topic: session.topic,
    templateId: template?.id ?? null,
    framingFromSession: session.framing !== (template?.framing ?? catalog.neutralFraming),
    participants: slotRoster(session).map((p) => ({ providerId: p.providerId, model: p.model, role: p.role })),
    maxRounds: Math.min(ROUNDS_BOUNDS.max, Math.max(ROUNDS_BOUNDS.min, session.limits.maxRounds)),
    ownerWait: session.ownerWait?.pauseAfterRound || session.ownerWait?.waitForOwner ? { pauseAfterRound: !!session.ownerWait.pauseAfterRound, waitForOwner: !!session.ownerWait.waitForOwner, timeoutSec: session.ownerWait.timeoutSec ?? OWNER_WAIT_DEFAULT_SEC } : null,
    materials: deps.materials.carry(list, notes, sources),
  };
}
