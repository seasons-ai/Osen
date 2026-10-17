import { readFileSync } from "node:fs";
import { sha256Of } from "../materials.ts";
import type { CollectedMaterial } from "../materials.ts";
import { isValidSessionId, materialPath } from "./journal.ts";
import { readSession } from "./sessions.ts";
import { storeMessages } from "../messages/store.ts";

export type SnapshotProblem = "missing" | "mismatch";
export type MaterialSnapshot =
  | { ok: true; material: CollectedMaterial }
  | { ok: false; id: string; name: string; problem: SnapshotProblem; reason: string };

/** Materials of a saved session by its snapshots, in metadata order. Writes nothing. null — no such session. */
export function readMaterialSnapshots(dataDir: string, sessionId: string): MaterialSnapshot[] | null {
  if (!isValidSessionId(sessionId)) return null;
  const s = readSession(dataDir, sessionId);
  if (s === null) return null;
  return (s.state.session!.materials ?? []).map((meta): MaterialSnapshot => {
    const { id, name, chars, sha256 } = meta;
    let text: string;
    try {
      text = readFileSync(materialPath(dataDir, sessionId, id), "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return { ok: false, id, name, problem: "missing", reason: code === "ENOENT" ? storeMessages().snapshotMissing : storeMessages().snapshotUnreadable(code ?? storeMessages().errorWord) };
    }
    if (text.length !== chars || sha256Of(text) !== sha256) return { ok: false, id, name, problem: "mismatch", reason: storeMessages().hashMismatch };
    return { ok: true, material: { id, name, chars, sha256, text } };
  });
}

/** Material from a ready text by the collector's rules. The id is assigned by the caller. */
export function materialFromText(id: string, name: string, text: string): CollectedMaterial {
  return { id, name, chars: text.length, sha256: sha256Of(text), text };
}
