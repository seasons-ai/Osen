import { accessSync, constants } from "node:fs";
import { join } from "node:path";

// Path of a packaged wrapper for consumers (changes 140, 141); null outside the package or when the wrapper is missing
export function headlessBinPath(name: "osen-mcp" | "council", o: { packaged: boolean; resourcesPath: string }): string | null {
  if (!o.packaged) return null;
  const p = join(o.resourcesPath, "bin", name);
  try {
    accessSync(p, constants.X_OK);
    return p;
  } catch {
    return null;
  }
}
