import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pinMessages } from "../messages/pins.ts";
import type { PackageSource } from "./pins.ts";
import { readOutput } from "./process.ts";
import type { ReleaseSource } from "./candidates.ts";
import type { CliAgent } from "./types.ts";

const tail = (e: unknown): string => String(e instanceof Error ? e.message : e).slice(-500).trim(); // the message ends with npm's stderr

const PACKAGES: Record<CliAgent, string> = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" };

function executableFor(agent: CliAgent, dir: string, platform: string, arch: string): string {
  if (agent === "claude") return join(dir, "node_modules", PACKAGES.claude, "bin", "claude.exe");
  if (platform !== "darwin" || (arch !== "arm64" && arch !== "x64")) throw new Error(pinMessages().npmUnsupported(platform, arch));
  const triple = arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  return join(dir, "node_modules", `@openai/codex-darwin-${arch}`, "vendor", triple, "bin", "codex");
}

/** Installs `<pkg>@<version>` with npm into the given folder; npm's cache lives inside it and is removed afterwards. */
export function npmSource(env: Record<string, string | undefined>, platform: string = process.platform, arch: string = process.arch): PackageSource {
  return {
    async fetch(agent, version, dir, signal) {
      const exe = executableFor(agent, dir, platform, arch);
      const pkg = PACKAGES[agent];
      const cache = join(dir, ".npm-cache");
      const npmEnv = { ...env, npm_config_cache: cache, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };
      await readOutput("npm", ["install", "--prefix", dir, `${pkg}@${version}`], npmEnv, signal, 15 * 60_000, 64 * 1024 * 1024)
        .catch((e: unknown) => { throw new Error(pinMessages().npmFailed(pkg, version, tail(e))); });
      rmSync(cache, { recursive: true, force: true });
      if (!existsSync(exe)) throw new Error(pinMessages().npmNoExecutable(exe));
      return { executable: exe, source: `npm:${pkg}@${version}` };
    },
  };
}

/** Lists the published versions of a package with `npm view`; metadata only, npm's default cache. */
export function npmReleases(env: Record<string, string | undefined>): ReleaseSource {
  return {
    async list(agent, signal) {
      const npmEnv = { ...env, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };
      const out = await readOutput("npm", ["view", PACKAGES[agent], "versions", "--json"], npmEnv, signal, 60_000, 16 * 1024 * 1024)
        .catch((e: unknown) => { throw new Error(tail(e)); });
      const data: unknown = JSON.parse(out);
      if (!Array.isArray(data) || !data.every((v) => typeof v === "string")) throw new Error("npm view did not return a JSON array of strings");
      return data;
    },
  };
}
