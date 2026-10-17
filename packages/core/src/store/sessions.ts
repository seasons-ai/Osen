import { readdirSync, writeFileSync } from "node:fs";
import { foldEvents } from "../protocol/fold.ts";
import type { Participant, Session } from "../protocol/schema.ts";
import type { SessionState, SessionStatus } from "../protocol/state.ts";
import { isValidSessionId, readEvents, sessionsDir, stopRequestPath } from "./journal.ts";
import type { JournalStopReason } from "./journal.ts";
import { storeMessages } from "../messages/store.ts";

export type StoredStatus = SessionStatus | "interrupted";

/** The journal was not read entirely: the stop reason and the number of events read. */
export interface JournalPartial { reason: JournalStopReason; lastEvent: number }

/** A note about a journal that was not read entirely; one wording for refusals, terminal output and MCP. */
export function partialNote(partial: JournalPartial): string {
  const m = storeMessages();
  return partial.reason === "newer_version" ? m.partialNewer(partial.lastEvent) : m.partialCorrupted(partial.lastEvent);
}

export interface StoredSession { id: string; state: SessionState; status: StoredStatus; partial: JournalPartial | null }

export interface SessionSummary {
  id: string; topic: string; createdAt: string; origin: Session["origin"];
  participants: Participant[]; status: StoredStatus; partial: JournalPartial | null;
}

// ponytail: a pid may be reused by another process — then a dead session would look running; if needed, check the process start time
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ponytail: a registry per process: a session whose executor failed in this same process is seen only by it; another process
// on the same pid cannot tell — its pid is different, and it judges by the liveness of the pid. A file mark would fail on the same lack of space.
const runningHere = new Set<string>();
export function markRunningHere(id: string): void { runningHere.add(id); }
export function unmarkRunningHere(id: string): void { runningHere.delete(id); }

/** The executor is alive: the pid is alive and, if it is the pid of the reading process, the session really is running in it. */
function executorAlive(id: string, pid: number, isAlive: (pid: number) => boolean): boolean {
  return isAlive(pid) && (pid !== process.pid || runningHere.has(id));
}

export function readSession(dataDir: string, id: string, isAlive: (pid: number) => boolean = isProcessAlive): StoredSession | null {
  const r = readEvents(dataDir, id);
  if (r === null) return null;
  const state = foldEvents(r.events);
  if (state.session === null) return null;
  const status: StoredStatus =
    state.finish !== null ? state.status : state.pid !== null && executorAlive(id, state.pid, isAlive) ? "running" : "interrupted";
  return { id, state, status, partial: r.stopped === null ? null : { reason: r.stopped, lastEvent: r.events.length } };
}

export function summarize(s: StoredSession): SessionSummary {
  const { topic, createdAt, origin, participants } = s.state.session!;
  return { id: s.id, topic, createdAt, origin, participants, status: s.status, partial: s.partial };
}

/** An unreadable journal of one session does not interrupt the list: the session is skipped, the reason goes to onUnreadable. */
export function listSessions(
  dataDir: string, isAlive: (pid: number) => boolean = isProcessAlive, onUnreadable?: (id: string, error: unknown) => void,
): SessionSummary[] {
  let entries;
  try {
    entries = readdirSync(sessionsDir(dataDir), { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: SessionSummary[] = [];
  for (const d of entries) {
    if (!d.isDirectory() || !isValidSessionId(d.name)) continue;
    let s;
    try {
      s = readSession(dataDir, d.name, isAlive);
    } catch (e) {
      onUnreadable?.(d.name, e);
      continue;
    }
    if (s !== null) out.push(summarize(s));
  }
  return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export type StopRejection = "not_found" | "finished" | "interrupted";

export class StopRejectedError extends Error {
  readonly reason: StopRejection;
  constructor(reason: StopRejection, message: string) {
    super(message);
    this.name = "StopRejectedError";
    this.reason = reason;
  }
}

export function requestStop(dataDir: string, id: string, isAlive: (pid: number) => boolean = isProcessAlive): void {
  const s = readSession(dataDir, id, isAlive);
  if (s === null) throw new StopRejectedError("not_found", storeMessages().sessionNotFound(id));
  if (s.state.finish !== null) throw new StopRejectedError("finished", storeMessages().sessionFinished(id, s.status));
  if (s.status === "interrupted") {
    // for a journal of a newer version the outcome could have been written beyond what was read: we do not assert "interrupted"
    const m = storeMessages();
    throw new StopRejectedError("interrupted", s.partial?.reason === "newer_version" ? m.stopNotRunningNewer(id, partialNote(s.partial)) : m.sessionInterrupted(id));
  }
  writeFileSync(stopRequestPath(dataDir, id), new Date().toISOString() + "\n");
}
