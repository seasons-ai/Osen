import type { JournalPartial, StoredStatus } from "@model-council/core";
import type { Language } from "@model-council/core/i18n";
import { partialView } from "../../shared/partial.ts";

export interface ActionInput {
  status: StoredStatus;
  partial: JournalPartial | null;
  waiting: boolean;       // the session has an open owner wait
  hasVersion: boolean;    // there is at least one solution version
  finished: boolean;      // the finish event is recorded
  insufficientActive: boolean; // failure from a lack of active participants (continues only with a replacement)
}

export interface SessionActions {
  reply: boolean; answer: boolean; continueWait: boolean; resume: boolean; select: boolean; stop: boolean;
  reason: string | null; // why mutating actions are unavailable; null — available by the usual rules
}

const RESUMABLE: readonly StoredStatus[] = ["consensus", "no_consensus", "stopped", "interrupted"];

/** The single place of the session actions availability rule. Journal not read to the end: mutating actions are closed, stop — as it was. */
export function sessionActions(input: ActionInput, language?: Language): SessionActions {
  const running = input.status === "running";
  const view = partialView(input.partial, language);
  const open = view === null;
  return {
    reply: open && running,
    answer: open && running,
    continueWait: open && running && input.waiting,
    resume: open && (RESUMABLE.includes(input.status) || (input.status === "failed" && input.insufficientActive)),
    select: open && input.finished && input.hasVersion,
    stop: running,
    reason: view?.message ?? null,
  };
}
