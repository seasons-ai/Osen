import { readAcceptedDrafts, readSession } from "@model-council/core";
import type { DraftView } from "../shared/bridge.ts";

/** Accepted session drafts from verified snapshots; writes nothing. */
export function sessionDrafts(dataDir: string, id: string): DraftView[] {
  const s = readSession(dataDir, id);
  if (!s) return [];
  return readAcceptedDrafts(dataDir, id, s.state).map((d) => ({
    draftId: d.draftId, participantId: d.participantId, attempts: d.attempts, chars: d.chars, reasoning: d.reasoning, text: d.text, error: d.error ?? null,
  }));
}
