import type { Logger } from "@model-council/core";
import type { Language } from "@model-council/core/i18n";
import type { HistoryItem } from "../shared/bridge.ts";
import { notify } from "../shared/messages/notify.ts";
import { partialView } from "../shared/partial.ts";

export type FinalStatus = Exclude<HistoryItem["status"], "running">;

export function finishTitle(status: FinalStatus, language?: Language): string {
  const m = notify(language);
  switch (status) {
    case "consensus": return m.finishConsensus;
    case "no_consensus": return m.finishNoConsensus;
    case "stopped": return m.finishStopped;
    case "failed": return m.finishFailed;
    case "interrupted": return m.finishInterrupted;
  }
}

export const TOPIC_LIMIT = 60;

// the language is taken at call time (the process one) if not passed
export function finishText(item: HistoryItem, language?: Language): { title: string; body: string } {
  const topic = item.topic.replace(/\s+/g, " ").trim();
  const short = topic.length > TOPIC_LIMIT ? `${topic.slice(0, TOPIC_LIMIT - 1).trimEnd()}…` : topic;
  // the journal was not read to the end: the status after line N is unknown, show the partial-read badge
  const view = partialView(item.partial, language);
  if (view) return { title: view.badge, body: `${short}\n${view.mark}` };
  return {
    title: finishTitle(item.status as FinalStatus, language),
    body: `${short}\n${notify(language).rounds(item.round)}`,
  };
}

export function createFinishObserver(): {
  markRunning(id: string): void;
  observe(items: HistoryItem[]): HistoryItem[];
} {
  const running = new Set<string>();
  return {
    markRunning: (id) => void running.add(id),
    observe(items) {
      const done: HistoryItem[] = [];
      for (const item of items) {
        if (item.status === "running") running.add(item.id);
        else if (running.delete(item.id)) done.push(item);
      }
      return done;
    },
  };
}

export interface FinishNotifierDeps {
  isSupported(): boolean;
  show(text: { title: string; body: string }, on: { shown(): void; click(): void; failed(error: unknown): void }): void;
  focused(): boolean;
  openId(): string | null;
  activate(id: string): void;
  logger: Logger;
}

// common display: focus suppression, support check, one log line per attempt
export function showNotification(deps: FinishNotifierDeps, id: string, text: { title: string; body: string }): void {
  if (deps.focused() && deps.openId() === id) return;
  if (!deps.isSupported()) {
    deps.logger.error(`Notification not shown: the system does not support notifications (session ${id})`);
    return;
  }
  // the first of shown / failed / an exception wins: one log line per attempt
  let logged = false;
  const once = (write: () => void) => {
    if (logged) return;
    logged = true;
    write();
  };
  const on = {
    shown: () => once(() => deps.logger.info(`Notification shown: ${id} — ${text.title}`)),
    click: () => deps.activate(id),
    failed: (error: unknown) => once(() => deps.logger.error(`Notification not shown (session ${id})`, error)),
  };
  try {
    deps.show(text, on);
  } catch (error) {
    on.failed(error);
  }
}

export function createFinishNotifier(deps: FinishNotifierDeps): {
  markRunning(id: string): void;
  observe(items: HistoryItem[]): void;
} {
  const observer = createFinishObserver();
  return {
    markRunning: observer.markRunning,
    observe(items) {
      for (const item of observer.observe(items)) {
        try {
          showNotification(deps, item.id, finishText(item));
        } catch {
          // a logger or dependency failure must not block the remaining attempts and polling
        }
      }
    },
  };
}
