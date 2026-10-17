import type { OwnerWaitReason, StoredStatus } from "@model-council/core";
import type { Language } from "@model-council/core/i18n";
import type { BridgeEvent } from "../shared/bridge.ts";
import { notify } from "../shared/messages/notify.ts";
import { showNotification } from "./finish-notify.ts";
import type { FinishNotifierDeps } from "./finish-notify.ts";

export interface AttentionSnapshot {
  id: string;
  status: StoredStatus;
  ownerQuestionIds: string[]; // all session questions addressed to the owner, in any status
  wait: { waitId: string; reasons: OwnerWaitReason[]; questionIds: string[] } | null; // active owner wait
}
export type AttentionKind = "question" | "pause";
export function attentionText(kind: AttentionKind, language?: Language): { title: string; body: string } {
  const m = notify(language);
  return { title: kind === "question" ? m.attentionQuestion : m.attentionPause, body: m.attentionBody };
}

export function createAttentionObserver(): { observe(snapshots: AttentionSnapshot[]): { id: string; kind: AttentionKind }[] } {
  // ponytail: bookkeeping lives in memory and is never pruned — one row per question and wait per launch; prune when a session disappears from history if the count reaches thousands
  const seen = new Map<string, { questions: Set<string>; waits: Set<string>; pinged: Set<string> }>();
  let first = true;
  return {
    observe(snapshots) {
      const baseline = first;
      first = false;
      const out: { id: string; kind: AttentionKind }[] = [];
      for (const s of snapshots) {
        const known = seen.get(s.id) ?? { questions: new Set<string>(), waits: new Set<string>(), pinged: new Set<string>() };
        seen.set(s.id, known);
        const newQuestion = s.ownerQuestionIds.some((q) => !known.questions.has(q));
        const newWait = s.wait !== null && !known.waits.has(s.wait.waitId);
        // pinged: questions already announced with "Question for the owner" before a wait appeared; a wait holding such a question gives no second notification (once only)
        const covered = newWait && s.wait!.questionIds.some((q) => known.pinged.has(q));
        if (newWait) for (const q of s.wait!.questionIds) known.pinged.delete(q);
        for (const q of s.ownerQuestionIds) known.questions.add(q);
        if (s.wait) {
          for (const q of s.wait.questionIds) known.questions.add(q);
          known.waits.add(s.wait.waitId);
        }
        if (baseline || s.status !== "running") continue;
        if (newWait && !covered && s.wait!.reasons.includes("round_boundary")) out.push({ id: s.id, kind: "pause" });
        else if (newQuestion) {
          out.push({ id: s.id, kind: "question" });
          if (!newWait) for (const q of s.ownerQuestionIds) known.pinged.add(q);
        }
      }
      return out;
    },
  };
}

export function createAttentionNotifier(deps: FinishNotifierDeps): { observe(snapshots: AttentionSnapshot[]): void } {
  const observer = createAttentionObserver();
  return {
    observe(snapshots) {
      for (const { id, kind } of observer.observe(snapshots)) {
        try {
          showNotification(deps, id, attentionText(kind));
        } catch {
          // a logger or dependency failure must not block the remaining attempts and polling
        }
      }
    },
  };
}

export function attentionEvent(id: string, status: StoredStatus | undefined): BridgeEvent {
  return { type: status === "running" ? "open-session" : "open-result", id };
}
