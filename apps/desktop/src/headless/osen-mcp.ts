import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DataDirError, applyProcessLanguage, createLogger, ensureDataDir, loadEnv, prepareDataDir, setPdfExtractorRuntime } from "@model-council/core";
import { createServer } from "../../../../packages/mcp/src/server.ts";
import { bundlePaths, dropRunAsNode } from "./runtime.ts";

// Packaged copy of packages/mcp/src/main.ts: resources come from the app bundle
dropRunAsNode(process.env);
const paths = bundlePaths(import.meta.dirname);
setPdfExtractorRuntime({ command: process.execPath, script: paths.pdfExtract, env: { ELECTRON_RUN_AS_NODE: "1" } });
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

const controller = new AbortController();
const ctx = {
  dataDir, env, logger,
  builtinTemplatesDir: paths.templates,
  scenariosDir: env["COUNCIL_DEV"] === "1" ? paths.scenarios : null,
  shutdown: controller.signal,
};

// ponytail: abort() sends SIGTERM to participants synchronously, an immediate exit does not let the finish event be written — the session becomes interrupted; the SIGKILL follow-up after 2 s does not make it
const quit = (reason: string): void => {
  logger.info(`MCP server is stopping: ${reason}`);
  controller.abort();
  process.exit(0);
};
process.stdin.on("end", () => quit("stdin closed"));
process.stdin.on("close", () => quit("stdin closed"));
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, () => quit(s));
process.on("unhandledRejection", (e) => logger.error("Unhandled promise rejection", e));

await createServer(ctx).connect(new StdioServerTransport());
