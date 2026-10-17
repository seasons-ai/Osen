import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { OwnerMessageRequest, OwnerMessageSource, OwnerRequest } from "../engine.ts";
import { OWNER_ID } from "../protocol/state.ts";
import { readEvents, sessionDir } from "./journal.ts";
import { isProcessAlive, partialNote, readSession } from "./sessions.ts";
import { storeMessages } from "../messages/store.ts";

export type OwnerMessageRejection =
  | "empty" | "not_found" | "newer_version" | "finished" | "interrupted" | "closing"
  | "question_not_found" | "question_not_owner" | "question_closed";

export class OwnerMessageRejectedError extends Error {
  readonly reason: OwnerMessageRejection;
  constructor(reason: OwnerMessageRejection, message: string) {
    super(message);
    this.name = "OwnerMessageRejectedError";
    this.reason = reason;
  }
}

const RETRY_WAIT_MS = 25;
const RETRY_TRIES = 40;

export function ownerMessagesDir(dataDir: string, id: string): string {
  return join(sessionDir(dataDir, id), "owner-messages");
}

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;
const pad = (v: number | bigint, n: number) => String(v).padStart(n, "0");

function publish(dir: string, body: Record<string, unknown>): string {
  const requestId = `${pad(Date.now(), 15)}-${pad(process.hrtime.bigint(), 20)}-${randomUUID()}`;
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmp, JSON.stringify({ ...body, createdAt: new Date().toISOString() }));
  try {
    renameSync(tmp, join(dir, `${requestId}.json`));
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
  return requestId;
}

/** Publication with retries until the executor creates the folder; check() is called before publication and after each ENOENT. */
function publishWithRetry(dirOf: () => string, body: () => Record<string, unknown>, check: () => void, closing: () => Error): string {
  check();
  const dir = dirOf();
  for (let tries = 0; ; ) {
    try {
      return publish(dir, body());
    } catch (e) {
      if (code(e) !== "ENOENT") throw e;
    }
    check();
    if (++tries >= RETRY_TRIES) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_WAIT_MS);
  }
  throw closing();
}

/** Sender. Returns the identifier of the accepted request or throws OwnerMessageRejectedError. */
export function requestOwnerMessage(
  dataDir: string, id: string, text: string,
  opts: { questionId?: string; isAlive?: (pid: number) => boolean } = {},
): { requestId: string } {
  const { questionId, isAlive = isProcessAlive } = opts;
  if (text.trim() === "") throw new OwnerMessageRejectedError("empty", storeMessages().messageEmpty);
  const check = () => {
    const s = readSession(dataDir, id, isAlive);
    if (s === null) throw new OwnerMessageRejectedError("not_found", storeMessages().sessionNotFound(id));
    if (s.partial?.reason === "newer_version") {
      throw new OwnerMessageRejectedError("newer_version", storeMessages().newerMessage(id, partialNote(s.partial)));
    }
    if (s.state.finish !== null) throw new OwnerMessageRejectedError("finished", storeMessages().sessionFinished(id, s.status));
    if (s.status === "interrupted") throw new OwnerMessageRejectedError("interrupted", storeMessages().sessionInterrupted(id));
    if (questionId !== undefined) {
      const q = s.state.questions.find((x) => x.id === questionId);
      if (!q) throw new OwnerMessageRejectedError("question_not_found", storeMessages().questionNotFound(questionId));
      if (q.to !== OWNER_ID) throw new OwnerMessageRejectedError("question_not_owner", storeMessages().questionNotOwner(questionId));
      if (q.status !== "open") {
        throw new OwnerMessageRejectedError(
          "question_closed", storeMessages().questionClosed(questionId, q.status === "answered"),
        );
      }
    }
  };
  const requestId = publishWithRetry(
    () => ownerMessagesDir(dataDir, id), () => ({ text, ...(questionId !== undefined ? { questionId } : {}) }), check,
    () => new OwnerMessageRejectedError(
      "closing", storeMessages().closingMessages(id),
    ),
  );
  return { requestId };
}

export type OwnerReleaseRejection = "not_found" | "corrupted" | "newer_version" | "finished" | "interrupted" | "not_waiting" | "stale_wait" | "closing";

export class OwnerReleaseRejectedError extends Error {
  readonly reason: OwnerReleaseRejection;
  constructor(reason: OwnerReleaseRejection, message: string) {
    super(message);
    this.name = "OwnerReleaseRejectedError";
    this.reason = reason;
  }
}

/** Request to release the current owner wait from a live executor. Does not start models, does not write the journal. */
export function requestOwnerRelease(
  dataDir: string, id: string, opts: { waitId?: string; isAlive?: (pid: number) => boolean } = {},
): { requestId: string; waitId: string } {
  const { isAlive = isProcessAlive } = opts;
  const reject = (r: OwnerReleaseRejection, m: string): never => { throw new OwnerReleaseRejectedError(r, m); };
  const check = (): string => {
    const read = readEvents(dataDir, id);
    const s = read === null ? null : readSession(dataDir, id, isAlive);
    if (read === null || s === null) return reject("not_found", storeMessages().sessionNotFound(id));
    if (read.stopped === "newer_version") {
      reject("newer_version", storeMessages().newerRelease(id, partialNote({ reason: "newer_version", lastEvent: read.events.length })));
    }
    if (read.offset !== read.size) {
      reject("corrupted", storeMessages().journalCorruptedRelease(id, read.events.length));
    }
    if (s.state.finish !== null) reject("finished", storeMessages().sessionFinished(id, s.status));
    if (s.status === "interrupted") {
      reject("interrupted", storeMessages().interruptedRelease(id));
    }
    const w = s.state.waiting;
    if (w === null) return reject("not_waiting", storeMessages().notWaiting(id));
    if (opts.waitId !== undefined && opts.waitId !== w.waitId) {
      reject("stale_wait", storeMessages().staleWait(id, opts.waitId, w.waitId));
    }
    return w.waitId;
  };
  let waitId = "";
  const requestId = publishWithRetry(
    () => ownerMessagesDir(dataDir, id), () => ({ releaseWaitId: waitId }), () => { waitId = check(); },
    () => new OwnerReleaseRejectedError(
      "closing", storeMessages().closingRequests(id),
    ),
  );
  return { requestId, waitId };
}

function readRequests(dir: string): OwnerRequest[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: OwnerRequest[] = [];
  for (const name of names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort()) {
    try {
      const j = JSON.parse(readFileSync(join(dir, name), "utf8")) as { text?: unknown; questionId?: unknown; releaseWaitId?: unknown };
      if (typeof j.text === "string" && j.text.trim() !== "") {
        out.push({
          requestId: name.slice(0, -5), text: j.text,
          ...(typeof j.questionId === "string" && j.questionId !== "" ? { questionId: j.questionId } : {}),
        });
      } else if (typeof j.text !== "string" && typeof j.releaseWaitId === "string" && j.releaseWaitId !== "") {
        out.push({ requestId: name.slice(0, -5), releaseWaitId: j.releaseWaitId });
      }
    } catch { /* half-written or foreign file: skip it */ }
  }
  return out;
}

const mkdirOpen = (dir: string) => {
  try { mkdirSync(dir); } catch (e) { if (code(e) !== "EEXIST") throw e; }
};

/** Executor. Creates the queue folder and returns the source of owner messages for the engine. */
export function openOwnerQueue(dataDir: string, id: string): OwnerMessageSource {
  const open = ownerMessagesDir(dataDir, id);
  const closed: string[] = [];
  let n = 0;
  mkdirOpen(open);
  return {
    take(closing) {
      if (!closing) return readRequests(open);
      const target = `${open}.closed-${n + 1}`;
      try {
        renameSync(open, target);
        n++;
        closed.push(target);
      } catch { /* no open folder: nothing to rename */ }
      const got = closed.flatMap(readRequests);
      for (const d of closed.splice(0)) {
        try { rmdirSync(d); } catch { closed.push(d); }
      }
      return got.sort((a, b) => (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0));
    },
    done(requestId) {
      if (requestId === "" || /[/\\]|\.\./.test(requestId)) return;
      for (const d of [open, ...closed]) {
        try { unlinkSync(join(d, `${requestId}.json`)); } catch { continue; }
        const i = closed.indexOf(d);
        if (i >= 0) {
          try { rmdirSync(d); closed.splice(i, 1); } catch { /* not empty: stays */ }
        }
        return;
      }
    },
    reopen() {
      try { mkdirOpen(open); } catch { /* the sender sees a creation error as closing */ }
      for (const d of closed.splice(0)) {
        try { rmdirSync(d); } catch { closed.push(d); }
      }
    },
  };
}

/**
 * Accepting a resume: removes the request files (messages and release) left from the previous executor (the open folder and `closed-*`).
 * Requests whose requestId is already recorded by an event (applied) are deleted silently; the rest of the messages are returned in ascending requestId order; release does not go into the result.
 */
export function discardOwnerRequests(dataDir: string, id: string, applied: ReadonlySet<string>): OwnerMessageRequest[] {
  const open = ownerMessagesDir(dataDir, id);
  const parent = sessionDir(dataDir, id);
  const prefix = `${basename(open)}.closed-`;
  let names: string[] = [];
  try { names = readdirSync(parent).filter((n) => n.startsWith(prefix)); } catch { /* no session folder: nothing to remove */ }
  const dropped: OwnerMessageRequest[] = [];
  for (const dir of [open, ...names.map((n) => join(parent, n))]) {
    for (const r of readRequests(dir)) {
      try { unlinkSync(join(dir, `${r.requestId}.json`)); } catch { /* already gone */ }
      if (!applied.has(r.requestId) && "text" in r) dropped.push(r);
    }
    if (dir !== open) { try { rmdirSync(dir); } catch { /* not empty: stays */ } }
  }
  return dropped.sort((a, b) => (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0));
}
