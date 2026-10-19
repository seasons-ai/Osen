#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./cli.ts";
import { loadEnv } from "./store/env.ts";
import { applyProcessLanguage } from "./store/preferences.ts";

const env = loadEnv(process.env, process.cwd());
applyProcessLanguage(env);
let appVersion: string | undefined;
try {
  appVersion = JSON.parse(readFileSync(join(import.meta.dirname, "../../../apps/desktop/package.json"), "utf8")).version;
} catch { /* no package.json next to the sources: the version stays unknown */ }
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.exitCode = await main(process.argv.slice(2), {
  stdout: console.log, stderr: console.error, env, signal: controller.signal,
  chunk: (t) => process.stderr.write(t),
  ...(appVersion ? { appVersion } : {}),
});
