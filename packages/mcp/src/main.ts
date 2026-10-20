#!/usr/bin/env node
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DataDirError, applyProcessLanguage, createLogger, ensureDataDir, loadEnv, prepareDataDir } from "@model-council/core";
import { createServer } from "./server.ts";

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
  builtinTemplatesDir: join(import.meta.dirname, "../../../templates"),
  scenariosDir: env["COUNCIL_DEV"] === "1" ? join(import.meta.dirname, "../../core/scenarios") : null,
  shutdown: controller.signal,
  councilLaunch: { command: process.execPath, args: [join(import.meta.dirname, "../../core/src/council.ts")], env: {} },
};

// ponytail: quit only exits the server and wakes its waits; every session (council_start, council_resume) runs in its own detached executor and survives
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
