import { unlinkSync } from "node:fs";
import { SessionEventSchema } from "../protocol/schema.ts";
import type { SessionState, OwnerSelection } from "../protocol/state.ts";
import { appendEvent, readEvents, resumeLockPath } from "./journal.ts";
import { acquireResumeLock, ResumeRejectedError } from "./resume.ts";
import { isProcessAlive, partialNote, readSession } from "./sessions.ts";
import { storeMessages } from "../messages/store.ts";

export type OwnerSelectionRejection =
  | "not_found" | "corrupted" | "newer_version" | "running" | "interrupted" | "unknown_version" | "bad_note" | "busy";

export class OwnerSelectionRejectedError extends Error {
  readonly reason: OwnerSelectionRejection;
  constructor(reason: OwnerSelectionRejection, message: string) {
    super(message);
    this.name = "OwnerSelectionRejectedError";
    this.reason = reason;
  }
}

export const OWNER_NOTE_MAX = 2000;

const reject = (reason: OwnerSelectionRejection, message: string): never => {
  throw new OwnerSelectionRejectedError(reason, message);
};

/** Appends the owner's selection to the journal of a finished session; the status, versions and outcome do not change. */
export function selectOwnerVersion(
  dataDir: string,
  id: string,
  input: { version: number; note?: string | null },
  opts: { isAlive?: (pid: number) => boolean; now?: () => Date } = {},
): OwnerSelection {
  const isAlive = opts.isAlive ?? isProcessAlive;
  const note = input.note?.trim() || undefined;
  if (note !== undefined && note.length > OWNER_NOTE_MAX) reject("bad_note", storeMessages().noteTooLong(OWNER_NOTE_MAX));

  const check = (): { state: SessionState; lastIsSame: boolean } => {
    const read = readEvents(dataDir, id);
    const stored = read === null ? null : readSession(dataDir, id, isAlive);
    if (read === null || stored === null) return reject("not_found", storeMessages().sessionNotFound(id));
    const { events, offset, size } = read;
    if (read.stopped === "newer_version") {
      reject("newer_version", storeMessages().newerSelect(id, partialNote({ reason: "newer_version", lastEvent: events.length })));
    }
    if (offset !== size) {
      reject("corrupted", storeMessages().journalCorruptedSelect(id, events.length));
    }
    if (stored.status === "running") reject("running", storeMessages().sessionRunning(id));
    if (stored.status === "interrupted") reject("interrupted", storeMessages().interruptedSelect(id));
    const { state } = stored;
    if (!Number.isInteger(input.version) || input.version < 1 || !state.versions.some((v) => v.number === input.version)) {
      reject("unknown_version", state.versions.length === 0
        ? storeMessages().noVersions(id)
        : storeMessages().noVersion(id, input.version));
    }
    const last = events[events.length - 1];
    const lastIsSame = last?.type === "owner_selected_version" && last.version === input.version && last.note === note;
    return { state, lastIsSame };
  };

  check();
  const lock = resumeLockPath(dataDir, id);
  try {
    acquireResumeLock(lock, isAlive);
  } catch (e) {
    if (e instanceof ResumeRejectedError && e.reason === "busy") {
      reject("busy", storeMessages().busySelect(id));
    }
    throw e;
  }
  try {
    const { state, lastIsSame } = check();
    if (lastIsSame) return state.ownerSelection!;
    const ts = (opts.now ?? (() => new Date()))().toISOString();
    const statusAtSelection = state.finish!.status;
    const event = SessionEventSchema.parse({
      seq: state.lastSeq + 1, ts, type: "owner_selected_version",
      version: input.version, statusAtSelection, ...(note !== undefined ? { note } : {}),
    });
    appendEvent(dataDir, id, event);
    return { version: input.version, statusAtSelection, note: note ?? null, ts };
  } finally {
    try { unlinkSync(lock); } catch { /* already removed */ }
  }
}
