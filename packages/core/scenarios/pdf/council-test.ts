#!/usr/bin/env node
// Stand service entry: like council.ts, but the PDF extraction process is a stub script (env PDF_STAND_EXTRACTOR, absolute path).
// The production council.ts entry never replaces the extractor; this file lives only in the scenarios folder.
import { main } from "../../src/cli.ts";
import { setPdfExtractorRuntime } from "../../src/pdf/extract.ts";
import { loadEnv } from "../../src/store/env.ts";
import { applyProcessLanguage } from "../../src/store/preferences.ts";

const script = process.env.PDF_STAND_EXTRACTOR;
if (!script) {
  console.error("The PDF_STAND_EXTRACTOR variable is not set (absolute path of the extractor stub): this is the stand service entry.");
  process.exit(2);
}
setPdfExtractorRuntime({ script });
const env = loadEnv(process.env, process.cwd());
applyProcessLanguage(env);
process.exitCode = await main(process.argv.slice(2), { stdout: console.log, stderr: console.error, env });
