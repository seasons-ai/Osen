import { promptMessages } from "../messages/prompt.ts";
import type { Language } from "../i18n/language.ts";

// Owner folder: pure functions over the file list in memory, with no disk access.
// Lines of collapsed folders and notes on requested files: request text, in the session language.
export const FOLDER_LIMITS = {
  filesPerRequest: 5, // names in one file request
  readChars: 40000, // characters of text per one file request
  mapChars: 12000, // characters of the folder listing in a turn request
  snapshotChars: 20000000, // characters in the folder snapshot; above this the snapshot is not created
} as const;
export const MAX_CALLS_PER_TURN = 3;

/** name — as for materials: "<folder>/<relative path>". */
export interface FolderFile { name: string; text: string }
export interface ServedFile { name: string; chars: number; shown: number; text: string; note: string | null }

export function folderStats(files: readonly FolderFile[]): { files: number; chars: number } {
  return { files: files.length, chars: files.reduce((s, f) => s + f.text.length, 0) };
}

const nfc = (s: string) => s.normalize("NFC"); // the model may return a name in a different Unicode normalization than on disk
const depth = (name: string) => name.split("/").length;
const byDepthThenName = (a: FolderFile, b: FolderFile) => depth(a.name) - depth(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const line = (f: FolderFile) => `${f.name} — ${f.text.length}`;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Collapse level L: a folder deeper than L is replaced by its ancestor from the first L segments. */
function foldKey(dirParts: readonly string[], level: number): string {
  return dirParts.length <= level ? dirParts.join("/") : dirParts.slice(0, level).join("/");
}

export function folderMap(files: readonly FolderFile[], language: Language, limit: number = FOLDER_LIMITS.mapChars): string {
  const sorted = [...files].sort(byDepthThenName);
  const n = sorted.length;
  const m = promptMessages(language);
  const named = sorted.map((f) => line(f).length);
  const parts = sorted.map((f) => f.name.split("/").slice(0, -1));
  const maxLevel = parts.reduce((mx, p) => Math.max(mx, p.length), 1);
  // Collapsed-folder lines of level L for the tail sorted[k..], by key.
  const foldedAt = (level: number, k: number) => {
    const g = new Map<string, { count: number; chars: number }>();
    for (let i = k; i < n; i++) {
      const key = foldKey(parts[i]!, level);
      const e = g.get(key) ?? { count: 0, chars: 0 };
      e.count++;
      e.chars += sorted[i]!.text.length;
      g.set(key, e);
    }
    return [...g.keys()].sort(cmp).map((key) => m.foldedDir(key, g.get(key)!.count, g.get(key)!.chars));
  };
  const render = (level: number, k: number) => [...sorted.slice(0, k).map(line), ...foldedAt(level, k)];
  for (let level = maxLevel; level >= 1; level--) {
    // The fit is not monotonic in k: go from n downward, lengths are tracked incrementally.
    const g = new Map<string, { count: number; chars: number; len: number }>();
    let foldedLen = 0; // sum of lengths of collapsed lines
    let groups = 0;
    let namedLen = named.reduce((s, x) => s + x, 0);
    for (let k = n; k >= 0; k--) {
      if (k < n) {
        const i = k;
        namedLen -= named[i]!;
        const key = foldKey(parts[i]!, level);
        let e = g.get(key);
        if (!e) { e = { count: 0, chars: 0, len: 0 }; g.set(key, e); groups++; }
        e.count++;
        e.chars += sorted[i]!.text.length;
        foldedLen -= e.len;
        e.len = m.foldedDir(key, e.count, e.chars).length;
        foldedLen += e.len;
      }
      const lines = k + groups;
      const total = namedLen + foldedLen + Math.max(0, lines - 1);
      if (total <= limit) return render(level, k).join("\n");
    }
  }
  // Even level 1 without names does not fit: whole lines while they fit.
  const out: string[] = [];
  let used = 0;
  for (const l of foldedAt(1, 0)) {
    const next = used + l.length + (out.length > 0 ? 1 : 0);
    if (next > limit) break;
    out.push(l);
    used = next;
  }
  return out.join("\n");
}

export function serveFiles(files: readonly FolderFile[], names: readonly string[], language: Language): ServedFile[] {
  const m = promptMessages(language);
  const unique = [...new Set(names)];
  const served: ServedFile[] = [];
  let budget: number = FOLDER_LIMITS.readChars;
  unique.forEach((name, idx) => {
    if (idx >= FOLDER_LIMITS.filesPerRequest) {
      served.push({ name, chars: 0, shown: 0, text: "", note: m.noteOverFive });
      return;
    }
    let text: string | undefined;
    if (name.endsWith("/")) {
      const inside = files.filter((f) => nfc(f.name).startsWith(nfc(name)));
      if (inside.length > 0) text = inside.map(line).join("\n");
    } else text = files.find((f) => nfc(f.name) === nfc(name))?.text;
    if (text === undefined) {
      served.push({ name, chars: 0, shown: 0, text: "", note: m.noteMissing });
      return;
    }
    const chars = text.length;
    if (chars <= budget) {
      budget -= chars;
      served.push({ name, chars, shown: chars, text, note: null });
    } else if (budget === 0) {
      served.push({ name, chars, shown: 0, text: "", note: m.noteExhausted });
    } else {
      const shown = budget;
      budget = 0;
      served.push({ name, chars, shown, text: text.slice(0, shown), note: m.notePartial(shown, chars) });
    }
  });
  return served;
}
