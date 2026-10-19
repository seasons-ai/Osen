import { applyProcessLanguage, loadEnv, setPdfExtractorRuntime } from "@model-council/core";
import { main } from "../../../../packages/core/src/cli.ts";
import pkg from "../../package.json" with { type: "json" };
import { bundlePaths, dropRunAsNode } from "./runtime.ts";

// Packaged copy of packages/core/src/council.ts: resources come from the app bundle
dropRunAsNode(process.env);
const paths = bundlePaths(import.meta.dirname);
setPdfExtractorRuntime({ command: process.execPath, script: paths.pdfExtract, env: { ELECTRON_RUN_AS_NODE: "1" } });
const env = loadEnv(process.env, process.cwd());
applyProcessLanguage(env);
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.exitCode = await main(process.argv.slice(2), {
  stdout: console.log, stderr: console.error, env, signal: controller.signal,
  chunk: (t) => process.stderr.write(t),
  appVersion: pkg.version, builtinTemplatesDir: paths.templates, urlWorker: paths.htmlWorker,
});
