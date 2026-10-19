// Headless entry points (bin/osen-mcp, bin/council) on a built bundle without a .dmg: wrappers, self-contained entry files, MCP over stdio, --help, a scripted run, all with an empty PATH.
//   COUNCIL_DEV=1 node apps/desktop/scenarios/headless/check.ts
// Needs `npm run build -w @model-council/desktop` and a packaged app in apps/desktop/release.noindex/mac-arm64/Osen.app (npm run dist or electron-builder --dir):
// the app is copied into .council-data/headless-stand-*/, its out/main and bin are replaced with the fresh build output and the checks run on the copy.
// Models are not called. The stand folder is removed on success and kept on failure. --keep-exec-bit-off removes the exec bit from the copied bin/council (proves the check fails).
import "../../../../packages/core/scenarios/language-ru.ts";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { reportHeadlessLines } from "../../scripts/headless-in-image.ts";

const root = resolve(import.meta.dirname, "../../../..");
const desktop = join(root, "apps/desktop");
const source = join(desktop, "release.noindex/mac-arm64/Osen.app");

let failed = false;
const report = (ok: boolean, text: string) => {
  if (!ok) failed = true;
  console.log(`${ok ? "OK  " : "FAIL"} ${text}`);
};

if (!existsSync(source)) {
  console.log("FAIL no apps/desktop/release.noindex/mac-arm64/Osen.app — run npm run dist (or electron-builder --dir) first");
  process.exit(1);
}
if (!existsSync(join(desktop, "out/main/osen-mcp.mjs")) || !existsSync(join(desktop, "out/main/council.mjs"))) {
  console.log("FAIL no apps/desktop/out/main/osen-mcp.mjs or council.mjs — run npm run build -w @model-council/desktop first");
  process.exit(1);
}

mkdirSync(join(root, ".council-data"), { recursive: true });
const stand = mkdtempSync(join(root, ".council-data", "headless-stand-"));
const contents = join(stand, "Osen.app/Contents");
try {
  // ditto keeps the bundle intact; no quarantine attribute is added, Gatekeeper would show a dialog
  execFileSync("ditto", [source, join(stand, "Osen.app")], { stdio: "pipe" });
  const main = join(contents, "Resources/app.asar.unpacked/out/main");
  rmSync(main, { recursive: true, force: true });
  cpSync(join(desktop, "out/main"), main, { recursive: true });
  rmSync(join(contents, "Resources/bin"), { recursive: true, force: true });
  cpSync(join(desktop, "resources/bin"), join(contents, "Resources/bin"), { recursive: true });
  if (process.argv.includes("--keep-exec-bit-off")) chmodSync(join(contents, "Resources/bin/council"), 0o644);
  await reportHeadlessLines(contents, stand, report);
} catch (e) {
  report(false, `check not performed: ${e instanceof Error ? e.message : String(e)}`);
}
if (!failed) rmSync(stand, { recursive: true, force: true });
console.log(`${failed ? `CHECK FAILED (stand kept: ${stand})` : "ALL CHECKS PASSED"}`);
process.exit(failed ? 1 : 0);
