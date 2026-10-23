import { DataDirError, applyProcessLanguage, createLogger, ensureDataDir, loadEnv, prepareDataDir, setDocumentExtractorRuntime, setOcrRuntime, setPdfExtractorRuntime } from "@model-council/core";
import { runServer } from "../../../../packages/mcp/src/server.ts";
import { bundlePaths, dropRunAsNode } from "./runtime.ts";

// Packaged entry of the MCP server: shares runServer with packages/mcp/src/main.ts, resources come from the app bundle
dropRunAsNode(process.env);
const paths = bundlePaths(import.meta.dirname);
setPdfExtractorRuntime({ command: process.execPath, script: paths.pdfExtract, env: { ELECTRON_RUN_AS_NODE: "1" } });
setDocumentExtractorRuntime({ command: process.execPath, script: paths.docExtract, env: { ELECTRON_RUN_AS_NODE: "1" } });
setOcrRuntime({ helper: paths.ocrHelper });
const env = loadEnv(process.env, process.cwd());
applyProcessLanguage(env);
let dataDir: string;
try {
  dataDir = ensureDataDir(prepareDataDir(env));
} catch (e) {
  if (!(e instanceof DataDirError)) throw e;
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
const logger = createLogger(dataDir, "mcp", env);
logger.info(`MCP server started, data folder: ${dataDir}`);

await runServer({
  dataDir, env, logger,
  builtinTemplatesDir: paths.templates,
  scenariosDir: env["COUNCIL_DEV"] === "1" ? paths.scenarios : null,
  councilLaunch: { command: process.execPath, args: [paths.council], env: { ELECTRON_RUN_AS_NODE: "1" } },
});
