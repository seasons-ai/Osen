// ponytail: polling on a timer; if sessions number in the thousands or load matters — switch to fs.watch with polling as a safety net
import { readdirSync } from "node:fs";
import { applyEvent } from "../protocol/fold.ts";
import type { SessionEvent } from "../protocol/schema.ts";
import { initialState } from "../protocol/state.ts";
import type { SessionState } from "../protocol/state.ts";
import { isValidSessionId, readEvents, sessionsDir } from "./journal.ts";
import { listSessions, readSession, summarize } from "./sessions.ts";
import type { SessionSummary } from "./sessions.ts";

export interface WatchOptions { intervalMs?: number }

function poll(intervalMs: number | undefined, pass: (active: () => boolean) => void): () => void {
  let stopped = false;
  const active = () => !stopped;
  const run = () => { if (!stopped) pass(active); };
  const first = setTimeout(run, 0);
  const timer = setInterval(run, intervalMs ?? 500);
  return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
}

export function watchSession(
  dataDir: string, id: string,
  onEvent: (event: SessionEvent, state: SessionState) => void,
  options: WatchOptions & { afterSeq?: number } = {},
): () => void {
  const afterSeq = options.afterSeq ?? 0;
  let offset = 0;
  let state = initialState();
  return poll(options.intervalMs, (active) => {
    let r;
    try {
      r = readEvents(dataDir, id, offset);
    } catch {
      return;
    }
    if (r === null) return;
    offset = r.offset;
    for (const event of r.events) {
      if (!active()) return;
      state = applyEvent(state, event);
      if (event.seq > afterSeq) onEvent(event, state);
    }
  });
}

export function watchSessions(
  dataDir: string,
  onSession: (summary: SessionSummary) => void,
  options: WatchOptions = {},
): () => void {
  const known = new Set(listSessions(dataDir).map((s) => s.id));
  return poll(options.intervalMs, (active) => {
    let entries;
    try {
      entries = readdirSync(sessionsDir(dataDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (!active()) return;
      if (!d.isDirectory() || !isValidSessionId(d.name) || known.has(d.name)) continue;
      let s;
      try {
        s = readSession(dataDir, d.name);
      } catch {
        continue;
      }
      if (s === null) continue;
      known.add(d.name);
      onSession(summarize(s));
    }
  });
}
