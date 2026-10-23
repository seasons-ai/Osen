import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { providerMessages } from "../messages/providers.ts";
import { cliEnv } from "../store/env.ts";
import { createLogger } from "../store/log.ts";
import { checkPinnedLaunch, pinBinaryState } from "./launch-guard.ts";
import type { GuardDeps } from "./launch-guard.ts";
import { activePin, pinsFileState } from "./pins.ts";
import { VERIFIED_FILE, loadVerifiedRecord, lookupVerified } from "./verified-record.ts";
import type { VerifiedRecord } from "./verified-record.ts";
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
  verified?: { level: "real" | "interface" | "none"; checkedAt: string | null };
  source?: "explicit" | "pin" | "path"; // where the executable came from; set when the search got that far
  pin?: { version: string; configDir: string }; // only for source "pin"
}

/** Environment of a CLI launched from an Osen pin: own config dir, self-update off (codex has no env switch for it; see args.ts). */
export function pinnedEnv(agent: CliAgent, configDir: string): Record<string, string> {
  return agent === "claude" ? { CLAUDE_CONFIG_DIR: configDir, DISABLE_AUTOUPDATER: "1", DISABLE_UPDATES: "1" } : { CODEX_HOME: configDir };
}

export interface DiscoveryDeps {
  isExecutable(path: string): boolean;
  loginShellPath(env: Record<string, string | undefined>): Promise<string | undefined>;
  runVersion(path: string, env: Record<string, string | undefined>): Promise<string>;
  record?: VerifiedRecord;
  guard?: Partial<GuardDeps>;
}

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
const recordCache = new Map<string, VerifiedRecord>();
const loggedRejections = new Set<string>(); // once per process and file state; not cleared by resetDiscoveryCache
let loginPathCache: Promise<string | undefined> | undefined;

export function resetDiscoveryCache(): void {
  cache.clear();
  recordCache.clear();
  loginPathCache = undefined;
}

// The local file state: changes when the file is rewritten or its mode changes, so a long-running process notices it.
function fileState(dataDir: string): string {
  try {
    const st = statSync(join(dataDir, VERIFIED_FILE));
    return `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? "unknown";
  }
}

// Loads the record once per (dataDir, file state); a rejected file is logged once per state.
export function verifiedRecordFor(dataDir: string | undefined): VerifiedRecord {
  if (dataDir === undefined) return loadVerifiedRecord();
  const key = `${dataDir}\0${fileState(dataDir)}`;
  let rec = recordCache.get(key);
  if (!rec) {
    rec = loadVerifiedRecord(dataDir);
    recordCache.set(key, rec);
    if (rec.rejected && !loggedRejections.has(key)) {
      loggedRejections.add(key);
      createLogger(dataDir, "discovery").error(rec.rejected);
    }
  }
  return rec;
}

function versionWarning(agent: CliAgent, version: string, record: VerifiedRecord): { warning?: string; verified: NonNullable<CliLocation["verified"]> } {
  const m = providerMessages();
  const entry = lookupVerified(record, agent, version);
  if (entry) return { verified: { level: entry.level, checkedAt: entry.checkedAt }, ...(entry.level === "interface" ? { warning: m.versionInterfaceOnly(agent, version) } : {}) };
  const verified = { level: "none" as const, checkedAt: null };
  const recorded = record.entries.filter((e) => e.agent === agent).map((e) => e.version).sort(compare);
  if (!recorded.length) return { verified, warning: m.versionNotRecorded(agent, version, "—") };
  const [min, max] = [recorded[0]!, recorded[recorded.length - 1]!];
  if (compare(version, max) > 0) return { verified, warning: m.versionNewer(agent, version, min, max) };
  if (compare(version, min) < 0) return { verified, warning: m.versionOlder(agent, version, min, max) };
  return { verified, warning: m.versionNotRecorded(agent, version, recorded.join(", ")) };
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
  dataDir: string | undefined,
): Promise<CliLocation> {
  let searchPath = env.PATH ?? "";
  let path: string | undefined;
  let source: NonNullable<CliLocation["source"]> = "path";
  let pin: CliLocation["pin"];
  let guarded: { version: string; checkedAt: string | null } | undefined; // set when the pin check already read the version
  const warnings: string[] = [];
  const active = explicitPath === undefined && dataDir !== undefined ? activePin(dataDir, agent) : undefined;
  if (explicitPath !== undefined) {
    if (!deps.isExecutable(explicitPath)) {
      return { agent, found: false, searchPath, reason: providerMessages().cliNotFoundAtPath(agent, explicitPath) };
    }
    path = explicitPath;
    source = "explicit";
  } else if (active?.state === "pin") {
    // Any mismatch with the install record is an error: the PATH binary is never run in its place.
    const g = await checkPinnedLaunch(
      { agent, pin: active, launchPath: active.path, record: deps.record ?? verifiedRecordFor(dataDir), env: { ...env, PATH: searchPath, ...pinnedEnv(agent, active.configDir) } },
      { readVersion: deps.runVersion, ...deps.guard },
    );
    if (!g.ok) return { agent, found: false, source: "pin", searchPath, reason: g.reason };
    guarded = g;
    path = active.path;
    source = "pin";
    pin = { version: active.version, configDir: active.configDir };
  } else {
    if (active?.state === "rejected") warnings.push(active.reason);
    path = findIn(agent, env.PATH, deps.isExecutable);
    if (!path) {
      const login = await deps.loginShellPath(env).catch(() => undefined);
      if (login) {
        searchPath = mergePaths(searchPath, login);
        path = findIn(agent, login, deps.isExecutable);
      }
    }
    if (!path) {
      return { agent, found: false, searchPath, reason: providerMessages().cliNotFoundAnywhere(agent), ...(warnings.length ? { warning: warnings.join("; ") } : {}) };
    }
  }

  const found: CliLocation = { agent, found: true, path, source, searchPath, verified: { level: "none", checkedAt: null } };
  if (pin) found.pin = pin;
  const record = deps.record ?? verifiedRecordFor(dataDir);
  if (guarded) {
    found.version = guarded.version;
    found.verified = { level: "real", checkedAt: guarded.checkedAt };
  } else try {
    const raw = await deps.runVersion(path, { ...env, PATH: searchPath, ...(pin ? pinnedEnv(agent, pin.configDir) : {}) });
    const version = parseVersion(raw);
    if (!version) throw new Error(providerMessages().versionNoNumber(raw.trim().slice(0, 100)));
    found.version = version;
    const w = versionWarning(agent, version, record);
    found.verified = w.verified;
    if (w.warning) warnings.push(w.warning);
  } catch (e) {
    warnings.push(providerMessages().versionUnknown(agent, e instanceof Error ? e.message : String(e)));
  }
  if (record.rejected) warnings.push(record.rejected);
  if (warnings.length) found.warning = warnings.join("; ");
  return found;
}

export async function locateCli(agent: CliAgent, options: {
  explicitPath?: string;
  env: Record<string, string | undefined>;
  dataDir?: string;
  deps?: Partial<DiscoveryDeps>;
}): Promise<CliLocation> {
  const { explicitPath, dataDir } = options;
  const env = cliEnv(options.env, { dataDir });
  try {
    if (options.deps) return await locate(agent, explicitPath, env, { ...realDeps, ...options.deps }, dataDir);
    const key = JSON.stringify([agent, explicitPath, env.PATH, dataDir, dataDir === undefined ? null : fileState(dataDir), dataDir === undefined ? null : pinsFileState(dataDir), explicitPath === undefined && dataDir !== undefined ? pinBinaryState(dataDir, agent) : null]);
    let hit = cache.get(key);
    if (!hit) {
      const deps: DiscoveryDeps = { ...realDeps, loginShellPath: (e) => (loginPathCache ??= realDeps.loginShellPath(e)) };
      hit = locate(agent, explicitPath, env, deps, dataDir);
      cache.set(key, hit);
    }
    return await hit;
  } catch (e) {
    return { agent, found: false, searchPath: env.PATH ?? "", reason: providerMessages().searchFailed(agent, e instanceof Error ? e.message : String(e)) };
  }
}

