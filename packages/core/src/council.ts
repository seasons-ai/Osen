#!/usr/bin/env node
import { main } from "./cli.ts";
import { loadEnv } from "./store/env.ts";
import { applyProcessLanguage } from "./store/preferences.ts";

const env = loadEnv(process.env, process.cwd());
applyProcessLanguage(env);
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.exitCode = await main(process.argv.slice(2), {
  stdout: console.log, stderr: console.error, env, signal: controller.signal,
  chunk: (t) => process.stderr.write(t),
});
