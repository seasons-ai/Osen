// Shared stand check "COUNCIL_HOME is inside the repository".
// The shell gives $PWD in NFC, import.meta.dirname on macOS gives NFD: compare both in NFC.
import { relative } from "node:path";

export function isInsideRepo(repo: string, given: string): boolean {
  return !relative(repo.normalize("NFC"), given.normalize("NFC")).startsWith("..");
}
