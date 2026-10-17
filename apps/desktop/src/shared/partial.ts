import type { JournalPartial } from "@model-council/core";
import type { Language } from "@model-council/core/i18n";
import { session } from "./messages/session.ts";

export interface PartialView {
  reason: "newer_version" | "corrupted";
  lastEvent: number;
  badge: string;    // badge text instead of the status
  mark: string;     // "read up to event #N"
  message: string;  // message above the feed / instead of the result status / first export line; also the reason actions are unavailable
  icon: "i-alert";
  tone: "warn";
}

export function partialView(partial: JournalPartial | null | undefined, language?: Language): PartialView | null {
  if (!partial) return null;
  const m = session(language);
  const newer = partial.reason === "newer_version";
  return {
    reason: partial.reason,
    lastEvent: partial.lastEvent,
    badge: newer ? m.partialBadgeNewer : m.partialBadgeCorrupted,
    mark: m.partialMark(partial.lastEvent),
    message: newer ? m.partialNewer(partial.lastEvent) : m.partialCorrupted(partial.lastEvent),
    icon: "i-alert",
    tone: "warn",
  };
}
