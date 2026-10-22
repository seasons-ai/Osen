import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";

// Check of the OCR helper in an Osen.app copy: `resources` is Osen.app/Contents/Resources. Returns one report line.
export const OCR_VERSION = "osen-ocr 1";

export function ocrHelperLine(resources: string): { ok: boolean; text: string } {
  const file = join(resources, "ocr", "osen-ocr");
  const line = (ok: boolean, why = "") => ({ ok, text: `OCR helper ocr/osen-ocr: executable, prints "${OCR_VERSION}"${why ? `: ${why}` : ""}` });
  if (!existsSync(file)) return line(false, "missing");
  try { accessSync(file, constants.X_OK); } catch { return line(false, "not executable"); }
  try {
    const out = execFileSync(file, ["--version"], { encoding: "utf8", timeout: 10_000, env: {}, stdio: ["ignore", "pipe", "pipe"] }).trim();
    return out === OCR_VERSION ? line(true) : line(false, `printed "${out}"`);
  } catch (e) {
    return line(false, `did not run: ${e instanceof Error ? e.message : String(e)}`);
  }
}
