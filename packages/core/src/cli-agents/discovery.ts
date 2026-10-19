import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { providerMessages } from "../messages/providers.ts";
import type { CliAgent } from "./types.ts";

const run = promisify(execFile);

export interface CliLocation {
  agent: CliAgent;
  found: boolean;
  path?: string;
  version?: string;
  searchPath: string;
  reason?: string;
  warning?: string;
}

export interface DiscoveryDeps {
  isExecutable(path: string): boolean;
  loginShellPath(env: Record<string, string | undefined>): Promise<string | undefined>;
  runVersion(path: string, env: Record<string, string | undefined>): Promise<string>;
}

/** Versions on which the isolated-run flags were verified (2026-10-07). */
export const VERIFIED_VERSIONS: Record<CliAgent, readonly [min: string, max: string]> =
  { claude: ["2.1.288", "2.1.288"], codex: ["0.159.2", "0.159.2"] };

const MARK = "__COUNCIL_PATH__";

/** The first ASCII digits.digits.digits substring. A forward scan over digit runs: /\d+\.\d+\.\d+/ retried from every digit and was quadratic on long digit runs. */
export function parseVersion(raw: string): string | undefined {
  type Run = { start: number; end: number };
  const joined = (x: Run, y: Run) => y.start === x.end + 1 && raw[x.end] === ".";
  let a: Run | undefined, b: Run | undefined;
  for (const m of raw.matchAll(/[0-9]+/g)) {
    const c = { start: m.index, end: m.index + m[0].length };
    if (a && b && joined(a, b) && joined(b, c)) return raw.slice(a.start, c.end);
    [a, b] = [b, c];
  }
  return undefined;
}

function compare(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const realDeps: DiscoveryDeps = {
  isExecutable(path) {
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  async loginShellPath(env) {
    try {
      const script = `printf '\\n${MARK}%s${MARK}\\n' "$PATH"`;
      const pending = run(env.SHELL || "/bin/zsh", ["-ilc", script], { env, timeout: 5_000 });
      pending.child.stdin?.end();
      const { stdout } = await pending;
      return stdout.match(new RegExp(`${MARK}(.*?)${MARK}`))?.[1] || undefined;
    } catch {
      return undefined;
    }
  },
  async runVersion(path, env) {
    const { stdout } = await run(path, ["--version"], { env, timeout: 10_000 });
    return stdout;
  },
};

const cache = new Map<string, Promise<CliLocation>>();
let loginPathCache: Promise<string | undefined> | undefined;

export function resetDiscoveryCache(): void {
  cache.clear();
  loginPathCache = undefined;
}

function findIn(agent: CliAgent, searchPath: string | undefined, isExecutable: DiscoveryDeps["isExecutable"]): string | undefined {
  for (const dir of (searchPath ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, agent);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function mergePaths(a: string, b: string): string {
  return [...new Set([...a.split(delimiter), ...b.split(delimiter)].filter(Boolean))].join(delimiter);
}

async function locate(
  agent: CliAgent,
  explicitPath: string | undefined,
  env: Record<string, string | undefined>,
  deps: DiscoveryDeps,
): Promise<CliLocation> {
  let searchPath = env.PATH ?? "";
  let path: string | undefined;
  if (explicitPath !== undefined) {
    if (!deps.isExecutable(explicitPath)) {
      return { agent, found: false, searchPath, reason: providerMessages().cliNotFoundAtPath(agent, explicitPath) };
    }
    path = explicitPath;
  } else {
    path = findIn(agent, env.PATH, deps.isExecutable);
    if (!path) {
      const login = await deps.loginShellPath(env).catch(() => undefined);
      if (login) {
        searchPath = mergePaths(searchPath, login);
        path = findIn(agent, login, deps.isExecutable);
      }
    }
    if (!path) {
      return { agent, found: false, searchPath, reason: providerMessages().cliNotFoundAnywhere(agent) };
    }
  }

  const found: CliLocation = { agent, found: true, path, searchPath };
  const [min, max] = VERIFIED_VERSIONS[agent];
  try {
    const raw = await deps.runVersion(path, { ...env, PATH: searchPath });
    const version = parseVersion(raw);
    if (!version) throw new Error(providerMessages().versionNoNumber(raw.trim().slice(0, 100)));
    found.version = version;
    if (compare(version, max) > 0) found.warning = providerMessages().versionNewer(agent, version, min, max);
    else if (compare(version, min) < 0) found.warning = providerMessages().versionOlder(agent, version, min, max);
  } catch (e) {
    found.warning = providerMessages().versionUnknown(agent, e instanceof Error ? e.message : String(e));
  }
  return found;
}

export async function locateCli(agent: CliAgent, options: {
  explicitPath?: string;
  env: Record<string, string | undefined>;
  deps?: Partial<DiscoveryDeps>;
}): Promise<CliLocation> {
  const { explicitPath, env } = options;
  try {
    if (options.deps) return await locate(agent, explicitPath, env, { ...realDeps, ...options.deps });
    const key = JSON.stringify([agent, explicitPath, env.PATH]);
    let hit = cache.get(key);
    if (!hit) {
      const deps: DiscoveryDeps = { ...realDeps, loginShellPath: (e) => (loginPathCache ??= realDeps.loginShellPath(e)) };
      hit = locate(agent, explicitPath, env, deps);
      cache.set(key, hit);
    }
    return await hit;
  } catch (e) {
    return { agent, found: false, searchPath: env.PATH ?? "", reason: providerMessages().searchFailed(agent, e instanceof Error ? e.message : String(e)) };
  }
}

