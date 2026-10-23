import { createHash } from "node:crypto";
import { accessSync, constants, createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getProcessLanguage } from "../i18n/process-language.ts";
import { pinMessages } from "../messages/pins.ts";
import { providerMessages } from "../messages/providers.ts";
import { CODEX_ISOLATION_FEATURES, CODEX_UPDATE_OFF, HELP_ARGS, REQUIRED_FLAGS, planLaunch } from "./args.ts";
import { parseVersion, pinnedEnv } from "./discovery.ts";
import { declaredFlags, parseCodexFeatures } from "./flags.ts";
import { describeOutputError, readOutput } from "./process.ts";
import { activePin } from "./pins.ts";
import type { PackageSource } from "./pins.ts";
import { DEFAULT_MODEL } from "./types.ts";
import type { CliAgent } from "./types.ts";
import { BUILTIN_RECORD, VERIFIED_FILE, addLocalEntry, mergeRecords, readLocalRecord } from "./verified-record.ts";
import type { VerifiedEntry } from "./verified-record.ts";

/** The release source answered with something that is not a list of version strings; the reason text comes from the catalog. */
export class ReleaseListError extends Error {
  constructor() { super("not a list of version strings"); }
}

export const CANDIDATES_DIR = "cli-candidates";
export const CANDIDATE_LIMIT = 5;
export const OWNER_FILE = "owner.pid";
const STALE_MS = 3_600_000;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; } // EPERM and anything else: assume alive
}

/**
 * Removes prefixes left by killed runs: owner pid gone, or no readable pid and untouched for over an hour.
 * Never throws: a failure on one prefix leaves it for the next run.
 */
export function sweepCandidateLeftovers(dataDir: string, opts: { now?: () => number; alive?: (pid: number) => boolean; remove?: (path: string) => void } = {}): void {
  const { now = Date.now, alive = pidAlive, remove = (p: string) => rmSync(p, { recursive: true, force: true }) } = opts;
  const root = join(dataDir, CANDIDATES_DIR);
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const prefix = join(root, entry.name);
      try {
        let pid = 0;
        try {
          const text = readFileSync(join(prefix, OWNER_FILE), "utf8").trim();
          if (/^\d+$/.test(text)) pid = Number(text);
        } catch {}
        const dead = pid > 0 ? pid !== process.pid && !alive(pid) : now() - statSync(prefix).mtimeMs > STALE_MS;
        if (dead) remove(prefix);
      } catch {}
    }
  } catch {}
  try { rmdirSync(root); } catch {}
}
export type ViolationCode = "missing_flag" | "missing_feature" | "features_unread" | "help_unread" | "version_unparsed";
export interface Violation { code: ViolationCode; name: string }
export interface ReleaseSource { list(agent: CliAgent, signal?: AbortSignal): Promise<string[]> }
export type CandidateStatus = "ok" | "violates" | "already_recorded";
export type FailureCode = "source_unavailable" | "install_failed" | "record_failed" | "no_base";
export interface CandidateResult { agent: CliAgent; version: string; status: CandidateStatus; violations: Violation[]; recorded: boolean }
export interface CandidateFailure { agent: CliAgent; code: FailureCode; reason: string } // reason: localized text for humans, never in JSON
export interface CandidatesReport {
  bases: Partial<Record<CliAgent, string>>;
  candidates: CandidateResult[];
  failures: CandidateFailure[];
  interrupted: boolean;
  code: 0 | 1 | 2;
}
export interface CandidateDeps {
  releases: ReleaseSource;
  source: PackageSource;
  builtin?: readonly VerifiedEntry[];
  run?: (path: string, args: readonly string[], env: Record<string, string | undefined>, signal?: AbortSignal) => Promise<string>;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  os?: string;
  osenVersion?: string;
  signal?: AbortSignal;
  makePrefix?: (root: string, base: string) => string; // tests only: replaces mkdtempSync(join(root, base))
}

/** Pure contract check of one candidate from raw outputs; undefined = could not be read. */
export function checkCandidate(input: { agent: CliAgent; versionOutput: string | undefined; help: string | undefined; features: string | undefined }): { version?: string; violations: Violation[] } {
  const { agent, versionOutput, help, features } = input;
  const violations: Violation[] = [];
  const version = versionOutput === undefined ? undefined : parseVersion(versionOutput);
  if (version === undefined) violations.push({ code: "version_unparsed", name: "--version" });
  const featureSet = features === undefined ? undefined : parseCodexFeatures(features);
  let flags: Set<string> | undefined;
  if (help === undefined) violations.push({ code: "help_unread", name: HELP_ARGS[agent].join(" ") });
  else {
    flags = declaredFlags(help);
    const need = [...REQUIRED_FLAGS[agent], ...(agent === "codex" ? ["--config"] : []), "--model"];
    for (const f of need) if (!flags.has(f)) violations.push({ code: "missing_flag", name: f });
  }
  if (agent === "codex") {
    if (featureSet === undefined) violations.push({ code: "features_unread", name: "codex features list" });
    else for (const f of CODEX_ISOLATION_FEATURES) if (!featureSet.has(f)) violations.push({ code: "missing_feature", name: f });
  }
  if (flags) {
    const plan = planLaunch({ agent, flags, version, model: DEFAULT_MODEL, language: getProcessLanguage(), features: featureSet, pinned: true });
    if (!plan.ok && violations.length === 0) throw new Error(`candidate check drifted from planLaunch: ${plan.reason}`);
  }
  return { ...(version === undefined ? {} : { version }), violations };
}

const defaultRun: NonNullable<CandidateDeps["run"]> = (path, args, env, signal) => readOutput(path, args, env, signal, 10_000, 4 * 1024 * 1024);

function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (c) => h.update(c)).on("error", rej).on("end", () => res(h.digest("hex")));
  });
}

const VERSION = /^\d+\.\d+\.\d+$/;
const parts = (v: string) => v.split(".").map(Number);
function cmp(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

class Interrupted extends Error {}

export async function checkCandidates(dataDir: string, agents: readonly CliAgent[], deps: CandidateDeps): Promise<CandidatesReport> {
  const m = providerMessages();
  const { signal } = deps;
  const run = deps.run ?? defaultRun;
  const env = deps.env ?? process.env;
  const report: CandidatesReport = { bases: {}, candidates: [], failures: [], interrupted: false, code: 0 };
  const finish = (): CandidatesReport => {
    report.code = report.interrupted ? 1 : report.failures.some((f) => f.code === "no_base") ? 2 : report.failures.length ? 1 : 0; // an interruption is always 1
    return report;
  };
  const check = () => { if (signal?.aborted) throw new Interrupted(); };
  // An await that rejects while aborted is an interruption, not a failure.
  const step = async <T>(p: Promise<T>): Promise<T> => {
    try {
      const v = await p;
      check();
      return v;
    } catch (e) {
      check();
      throw e;
    }
  };

  sweepCandidateLeftovers(dataDir);
  const local = readLocalRecord(dataDir);
  if (local.state === "rejected") {
    for (const agent of agents) report.failures.push({ agent, code: "record_failed", reason: m.candidatesRecordRejected(join(dataDir, VERIFIED_FILE), local.reason) });
    return finish();
  }
  const record = mergeRecords(deps.builtin ?? BUILTIN_RECORD, local.state === "loaded" ? local.entries : []);
  const fail = (agent: CliAgent, code: FailureCode, reason: string) => report.failures.push({ agent, code, reason });

  try {
    for (const agent of agents) {
      check();
      const pin = activePin(dataDir, agent);
      if (pin.state === "rejected") {
        fail(agent, "no_base", m.candidatesPinsRejected(agent, pin.reason));
        continue;
      }
      // Interface entries written by this command must not move the base: only builtin entries and local real ones count.
      const baseRecord = mergeRecords(deps.builtin ?? BUILTIN_RECORD, (local.state === "loaded" ? local.entries : []).filter((e) => e.level === "real"));
      const recorded = baseRecord.filter((e) => e.agent === agent).map((e) => e.version);
      const base = pin.state === "pin" ? pin.version : recorded.sort(cmp).at(-1);
      if (base === undefined) {
        fail(agent, "no_base", m.candidatesNoBase(agent));
        continue;
      }
      report.bases[agent] = base;
      let listed: string[];
      try {
        const got: unknown = await step(deps.releases.list(agent, signal));
        if (!Array.isArray(got) || !got.every((v) => typeof v === "string")) throw new ReleaseListError();
        listed = got;
      } catch (e) {
        if (e instanceof Interrupted) throw e;
        fail(agent, "source_unavailable", m.candidatesSourceFailed(agent, e instanceof ReleaseListError ? m.candidatesNotList : describeOutputError(e)));
        continue;
      }
      const newer = [...new Set(listed.filter((v) => VERSION.test(v) && cmp(v, base) > 0))].sort(cmp).slice(-CANDIDATE_LIMIT);
      for (const version of newer) {
        check();
        if (record.some((e) => e.agent === agent && e.version === version)) {
          report.candidates.push({ agent, version, status: "already_recorded", violations: [], recorded: false });
          continue;
        }
        await checkOne(agent, version);
      }
    }
  } catch (e) {
    if (!(e instanceof Interrupted)) throw e;
    report.interrupted = true;
  }
  return finish();

  async function checkOne(agent: CliAgent, version: string): Promise<void> {
    let prefix: string | undefined;
    try {
      // A parallel check may remove the empty shared root between mkdir and mkdtemp: retry on ENOENT, 3 attempts in all.
      const root = join(dataDir, CANDIDATES_DIR);
      for (let attempt = 1; prefix === undefined; attempt++) {
        try {
          mkdirSync(root, { recursive: true });
          prefix = (deps.makePrefix ?? ((r, b) => mkdtempSync(join(r, b))))(root, `${agent}-${version}-`);
        } catch (e) {
          if (attempt >= 3 || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      writeFileSync(join(prefix, OWNER_FILE), String(process.pid));
      const got = await step(deps.source.fetch(agent, version, prefix, signal));
      const exe = resolve(got.executable);
      if (!exe.startsWith(resolve(prefix) + sep)) throw new Error(pinMessages().executableOutside(got.executable));
      try { accessSync(exe, constants.X_OK); } catch { throw new Error(pinMessages().executableNotRunnable(exe)); }
      const configDir = join(prefix, "config");
      mkdirSync(configDir, { recursive: true });
      const childEnv = { ...env, ...pinnedEnv(agent, configDir) };
      const read = async (args: readonly string[]): Promise<string | undefined> => {
        try {
          return await step(run(exe, args, childEnv, signal));
        } catch (e) {
          if (e instanceof Interrupted) throw e;
          return undefined;
        }
      };
      const versionOutput = await read(["--version"]);
      const actual = versionOutput === undefined ? undefined : parseVersion(versionOutput);
      if (actual !== undefined && actual !== version) {
        fail(agent, "install_failed", m.candidatesInstallFailed(agent, version, m.candidatesVersionMismatch(agent, version, actual)));
        return;
      }
      const updateOff = agent === "codex" ? CODEX_UPDATE_OFF : [];
      const help = await read([...HELP_ARGS[agent], ...updateOff]);
      const features = agent === "codex" ? await read(["features", "list", ...updateOff]) : undefined;
      const { violations } = checkCandidate({ agent, versionOutput, help, features });
      if (violations.length) {
        report.candidates.push({ agent, version, status: "violates", violations, recorded: false });
        return;
      }
      const sha256 = await step(sha256File(exe));
      const added = addLocalEntry(dataDir, {
        agent,
        version,
        level: "interface",
        checkedAt: (deps.now?.() ?? new Date()).toISOString().slice(0, 10),
        os: deps.os ?? `${process.platform}-${process.arch}`,
        osenVersion: deps.osenVersion ?? "unknown",
        sha256,
      });
      report.candidates.push({ agent, version, status: "ok", violations: [], recorded: added.ok });
      if (!added.ok) fail(agent, "record_failed", added.reason);
    } catch (e) {
      // Install, temp folder, config folder or hash read failed: this candidate fails, the rest go on.
      if (e instanceof Interrupted) throw e;
      fail(agent, "install_failed", m.candidatesInstallFailed(agent, version, e instanceof Error ? e.message : String(e)));
    } finally {
      if (prefix) rmSync(prefix, { recursive: true, force: true });
      try { rmdirSync(join(dataDir, CANDIDATES_DIR)); } catch {}
    }
  }
}

export function candidatesJson(r: CandidatesReport): { schemaVersion: 1; candidates: { agent: CliAgent; version: string; status: CandidateStatus; violations: Violation[]; recorded: boolean }[]; failures: { agent: CliAgent; code: FailureCode }[] } {
  return {
    schemaVersion: 1,
    candidates: r.candidates.map(({ agent, version, status, violations, recorded }) => ({ agent, version, status, violations, recorded })),
    failures: r.failures.map(({ agent, code }) => ({ agent, code })),
  };
}
