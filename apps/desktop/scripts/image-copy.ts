import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

export function copyDirFor(root: string): string {
  // .council-data is gitignored, so it is absent on a fresh clone
  mkdirSync(join(root, ".council-data"), { recursive: true });
  return mkdtempSync(join(root, ".council-data", "headless-image-"));
}
