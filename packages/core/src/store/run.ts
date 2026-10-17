import { existsSync, rmSync } from "node:fs";
import { checkSessionMaterials, checkSessionWorkspace, runSession } from "../engine.ts";
import type { RunSessionOptions, SessionRun } from "../engine.ts";
import { appendEvent, createSessionJournal, sessionDir, stopRequestPath, writeMaterialSnapshots, writeWorkspaceSnapshot } from "./journal.ts";
import { storedDraftStore } from "./draft-snapshots.ts";
import type { Logger } from "./log.ts";
import { checkSources, writeMaterialSources } from "./material-sources.ts";
import type { MaterialSource } from "./material-sources.ts";
import { openOwnerQueue } from "./owner-messages.ts";
import { markRunningHere, unmarkRunningHere } from "./sessions.ts";

export interface StoredRunOptions extends RunSessionOptions {
  dataDir: string;
  logger?: Logger;
  stopPollMs?: number;
  sources?: readonly MaterialSource[];
}

/** Polls the stop request file; when it appears, calls onStop once. Returns the poll timer. */
export function watchStopRequest(path: string, pollMs: number | undefined, onStop: () => void): NodeJS.Timeout {
  const timer = setInterval(() => {
    if (!existsSync(path)) return;
    clearInterval(timer);
    onStop();
  }, pollMs ?? 500);
  return timer;
}

export async function runStoredSession(options: StoredRunOptions): Promise<SessionRun> {
  const { dataDir, logger, stopPollMs, sources, ...rest } = options;
  const { session } = rest;
  const own = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let created = false; // this run created the session folder
  let journaled = false; // the first event is written: from then on the folder is the owner's session
  markRunningHere(session.id);
  try {
    checkSessionMaterials(session, rest.materials);
    checkSessionWorkspace(session, rest.workspace);
    if (sources?.length) {
      const bad = checkSources(sources, (rest.materials ?? []).map((m) => m.id));
      if (bad) throw new Error(bad);
    }
    createSessionJournal(dataDir, session.id);
    created = true;
    writeMaterialSnapshots(dataDir, session.id, rest.materials ?? []);
    writeMaterialSources(dataDir, session.id, sources ?? []);
    writeWorkspaceSnapshot(dataDir, session.id, rest.workspace ?? []);
    const ownerMessages = openOwnerQueue(dataDir, session.id);
    logger?.info(`Session ${session.id} started: origin ${session.origin}, participants ${session.participants.length}`);
    const signal = rest.signal ? AbortSignal.any([rest.signal, own.signal]) : own.signal;
    timer = watchStopRequest(stopRequestPath(dataDir, session.id), stopPollMs, () => own.abort());
    const run = await runSession({
      ...rest,
      signal,
      ownerMessages,
      draftStore: rest.draftStore ?? storedDraftStore(dataDir, session.id),
      onEvent: (e, s) => {
        appendEvent(dataDir, session.id, e);
        journaled = true;
        rest.onEvent?.(e, s);
      },
    });
    logger?.info(`Session ${session.id} finished: ${run.state.finish?.status}`);
    return run;
  } catch (e) {
    logger?.error(`Session ${session.id} failed with an error`, e);
    // an error before the first event: a folder without a journal does not remain
    if (created && !journaled) {
      try {
        rmSync(sessionDir(dataDir, session.id), { recursive: true, force: true });
      } catch (err) {
        logger?.error(`Failed to remove the folder of session ${session.id} without a journal`, err);
      }
    }
    throw e;
  } finally {
    clearInterval(timer);
    unmarkRunningHere(session.id);
  }
}
