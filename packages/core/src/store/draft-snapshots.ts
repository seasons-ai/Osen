import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { sha256Of } from "../materials.ts";
import type { DraftStore } from "../engine.ts";
import type { SessionState } from "../protocol/state.ts";
import { sessionDir } from "./journal.ts";
import { storeMessages } from "../messages/store.ts";

export interface DraftSnapshotMeta { draftId: string; chars: number; sha256: string }

export class DraftSnapshotError extends Error {
  readonly draftId: string;
  constructor(draftId: string, message: string) {
    super(message);
    this.name = "DraftSnapshotError";
    this.draftId = draftId;
  }
}

export function draftPath(dataDir: string, id: string, draftId: string): string {
  if (!/^d[1-9]\d*$/.test(draftId)) throw new DraftSnapshotError(draftId, storeMessages().draftIdInvalid(draftId));
  return join(sessionDir(dataDir, id), "drafts", `${draftId}.txt`);
}

/** Writes through a temp file and a rename; an existing file (an orphaned snapshot of an interrupted attempt) is replaced. */
export function writeDraftSnapshot(dataDir: string, id: string, draftId: string, text: string): { chars: number; sha256: string } {
  const path = draftPath(dataDir, id, draftId);
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
  return { chars: text.length, sha256: sha256Of(text) };
}

export function readDraftSnapshot(dataDir: string, id: string, meta: DraftSnapshotMeta): string {
  const { draftId } = meta;
  const path = draftPath(dataDir, id, draftId);
  let text: string;
  try {
    if (!lstatSync(path).isFile()) throw new DraftSnapshotError(draftId, storeMessages().draftSnapshotMissing(draftId));
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e instanceof DraftSnapshotError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    throw new DraftSnapshotError(draftId, code === "ENOENT" ? storeMessages().draftSnapshotMissing(draftId) : storeMessages().draftSnapshotUnreadable(draftId, code ?? storeMessages().errorWord));
  }
  if (text.length !== meta.chars || sha256Of(text) !== meta.sha256) throw new DraftSnapshotError(draftId, storeMessages().draftSnapshotChanged(draftId));
  return text;
}

/** Session draft storage on disk for the engine. */
export function storedDraftStore(dataDir: string, id: string): DraftStore {
  return {
    save: (draftId, text) => writeDraftSnapshot(dataDir, id, draftId, text),
    load: (meta) => readDraftSnapshot(dataDir, id, meta),
  };
}

export interface AcceptedDraft {
  draftId: string; participantId: string; attempts: number; chars: number; reasoning: string;
  text: string | null; error?: string;
}

/** Accepted draft texts of the state in session.participants order; a broken snapshot gives text: null and error, not an exception. */
export function readAcceptedDrafts(dataDir: string, id: string, state: SessionState): AcceptedDraft[] {
  const order = new Map((state.session?.participants ?? []).map((p, i) => [`d${i + 1}`, i]));
  return state.drafts
    .filter((s) => s.done)
    .sort((a, b) => (order.get(a.draftId) ?? 0) - (order.get(b.draftId) ?? 0))
    .map((s) => {
      const d = s.done!;
      const base = { draftId: s.draftId, participantId: d.participantId, attempts: d.attempts, chars: d.chars, reasoning: d.reasoning };
      try {
        return { ...base, text: readDraftSnapshot(dataDir, id, { draftId: s.draftId, chars: d.chars, sha256: d.sha256 }) };
      } catch (e) {
        return { ...base, text: null, error: (e as Error).message };
      }
    });
}
