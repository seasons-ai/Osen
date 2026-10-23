import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Builds the Swift OCR helper and its fixture generator. --optional: a missing toolchain is a warning, not a failure.
// --if-stale: rebuild a helper only when its output is missing or older than its source or this script.
const optional = process.argv.includes("--optional");
const ifStale = process.argv.includes("--if-stale");
const ocr = join(import.meta.dirname, "..", "packages/core/src/ocr");

export function isStale(srcPaths: string[], outPath: string): boolean {
  if (!existsSync(outPath)) return true;
  const out = statSync(outPath).mtimeMs;
  return srcPaths.some((p) => statSync(p).mtimeMs > out);
}

function stop(reason: string): never {
  if (optional) {
    console.warn(`build-ocr: skipped — ${reason}`);
    process.exit(0);
  }
  console.error(`build-ocr: ${reason}`);
  process.exit(1);
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  const helpers = ([["osen-ocr.swift", "osen-ocr"], ["fixture.swift", "osen-ocr-fixture"]] as const)
    .filter(([src, out]) => !ifStale || isStale([join(ocr, src), fileURLToPath(import.meta.url)], join(ocr, "bin", out)));
  // up-to-date helpers need no toolchain, so the platform check runs only when something is built
  if (helpers.length > 0 && process.platform !== "darwin") stop("text recognition helper builds only on macOS");
  mkdirSync(join(ocr, "bin"), { recursive: true });
  for (const [src, out] of helpers) {
    const r = spawnSync("swiftc", ["-O", join(ocr, src), "-o", join(ocr, "bin", out)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (r.error) stop(`swiftc is not available (${(r.error as NodeJS.ErrnoException).code ?? r.error.message})`);
    if (r.status !== 0) stop(`swiftc failed on ${src}: ${(r.stderr || "").trim().split("\n").slice(-3).join(" | ")}`);
    console.log(`build-ocr: built ${out}`);
  }
}
