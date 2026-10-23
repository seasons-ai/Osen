#!/usr/bin/env node
import { join } from "node:path";
import { DataDirError, applyProcessLanguage, createLogger, ensureDataDir, loadEnv, prepareDataDir } from "@model-council/core";
import { runServer } from "./server.ts";

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
  builtinTemplatesDir: join(import.meta.dirname, "../../../templates"),
  scenariosDir: env["COUNCIL_DEV"] === "1" ? join(import.meta.dirname, "../../core/scenarios") : null,
  councilLaunch: { command: process.execPath, args: [join(import.meta.dirname, "../../core/src/council.ts")], env: {} },
});
