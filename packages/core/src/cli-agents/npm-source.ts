import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pinMessages } from "../messages/pins.ts";
import type { PackageSource } from "./pins.ts";
import type { CliAgent } from "./types.ts";

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
    async fetch(agent, version, dir) {
      const exe = executableFor(agent, dir, platform, arch);
      const pkg = PACKAGES[agent];
      const cache = join(dir, ".npm-cache");
      await new Promise<void>((res, rej) => {
        const child = execFile(
          "npm",
          ["install", "--prefix", dir, `${pkg}@${version}`],
          { env: { ...env, npm_config_cache: cache, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" }, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 },
          (err, _out, stderr) => (err ? rej(new Error(pinMessages().npmFailed(pkg, version, String(stderr || err.message).slice(-500).trim()))) : res()),
        );
        child.stdin?.end();
      });
      rmSync(cache, { recursive: true, force: true });
      if (!existsSync(exe)) throw new Error(pinMessages().npmNoExecutable(exe));
      return { executable: exe, source: `npm:${pkg}@${version}` };
    },
  };
}
