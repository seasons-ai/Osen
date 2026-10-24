// Shared stand check "COUNCIL_HOME is inside the repository".
// The shell gives $PWD in NFC, import.meta.dirname on macOS gives NFD: compare both in NFC.
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function isInsideRepo(repo: string, given: string): boolean {
  const rel = relative(repo.normalize("NFC"), given.normalize("NFC"));
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

// Decides inside/outside for a folder that may not exist yet, creating nothing:
// realpath of the nearest existing ancestor (symlinks, NFC/NFD) plus the missing tail.
// A dangling symlink on the way, or an entry that cannot be read (EACCES), cannot be resolved: outside.
// ENOTDIR (a file on the way) counts as missing, like ENOENT: the decision goes by the file's real path.
export function isInsideRepoBeforeCreate(repo: string, given: string): boolean {
  let head = resolve(given);
  let tail = "";
  for (;;) {
    try { lstatSync(head); break; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return false;
    }
    tail = join(basename(head), tail);
    head = dirname(head);
  }
  let real: string;
  try { real = realpathSync(head); } catch { return false; }
  return isInsideRepo(realpathSync(repo), join(real, tail));
}
