import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CandidateDeps } from "../../../../packages/core/src/cli-agents/candidates.ts";

// A service seam only for the stand and the live window check (enabled by COUNCIL_DEV=1 and COUNCIL_CLI_STAND in index.ts):
// release lists and package stubs come from a JSON file that is re-read at every call, so a stand can change it while the app runs.
// { "releases": { "claude"?: string[], "codex"?: string[] }, "failReleases"?: string, "packages": { "<agent>@<version>": "<absolute path to an executable stub>" } }
interface StandFile { releases?: Record<string, string[]>; failReleases?: string; packages?: Record<string, string> }

export function standCandidateDeps(path: string): Pick<CandidateDeps, "releases" | "source"> {
  const read = (): StandFile => JSON.parse(readFileSync(path, "utf8")) as StandFile;
  return {
    releases: {
      async list(agent) {
        const f = read();
        if (f.failReleases) throw new Error(f.failReleases);
        return f.releases?.[agent] ?? [];
      },
    },
    source: {
      async fetch(agent, version, dir) {
        const stub = read().packages?.[`${agent}@${version}`];
        if (!stub) throw new Error(`stand: package ${agent}@${version} is not listed`);
        const executable = join(dir, "bin", agent);
        mkdirSync(join(dir, "bin"), { recursive: true });
        copyFileSync(stub, executable);
        chmodSync(executable, 0o755);
        return { executable, source: `stand:${agent}@${version}` };
      },
    },
  };
}
