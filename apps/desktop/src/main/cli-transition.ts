import { accessSync, constants, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_AGENTS, resetDiscoveryCache } from "@model-council/core";
import type { CliAgent, Logger, ProviderStatus } from "@model-council/core";
import { candidatesJson, checkCandidates } from "../../../../packages/core/src/cli-agents/candidates.ts";
import type { CandidateDeps, CandidatesReport } from "../../../../packages/core/src/cli-agents/candidates.ts";
import { checkPinFile } from "../../../../packages/core/src/cli-agents/launch-guard.ts";
import { installedPath, readPins, rollbackPin, usePin } from "../../../../packages/core/src/cli-agents/pins.ts";
import type { AgentPins } from "../../../../packages/core/src/cli-agents/pins.ts";
import { loadVerifiedRecord } from "../../../../packages/core/src/cli-agents/verified-record.ts";
import type { VerifiedEntry } from "../../../../packages/core/src/cli-agents/verified-record.ts";
import { DEFAULT_PERIOD_DAYS, PERIOD_BOUNDS, checkPeriod } from "../shared/settings.ts";
import type { CliCheckOutcome, CliLevel, CliSource, CliTransition, CliTransitionSettings } from "../shared/settings.ts";
import { settings } from "../shared/messages/settings.ts";
import { SettingsError } from "./settings.ts";

export const REMINDER_FILE = "cli-reminder.json";
const DAY_MS = 86_400_000;
const CHECK_INTERVAL_MS = 24 * 3_600_000;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const VERSION = /^\d+\.\d+\.\d+$/;

type Candidate = ReturnType<typeof candidatesJson>["candidates"][number];
type Failure = { agent: CliAgent; code: Exclude<CliCheckOutcome, "ok"> };
export interface LastCheck { at: string; candidates: Candidate[]; failures: Failure[] }
export interface ReminderData { schemaVersion: 1; periodDays: number; lastCheck: LastCheck | null }
export type ReminderState = { state: "absent" } | { state: "loaded"; data: ReminderData } | { state: "broken"; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isAgent = (v: unknown): v is CliAgent => typeof v === "string" && (CLI_AGENTS as readonly string[]).includes(v);
const FAIL_CODES = ["source_unavailable", "install_failed", "record_failed", "no_base", "check_failed"];
const STATUSES = ["ok", "violates", "already_recorded"];

function validCandidate(c: unknown): c is Candidate {
  return isObj(c) && isAgent(c["agent"]) && typeof c["version"] === "string" && VERSION.test(c["version"]) && STATUSES.includes(c["status"] as string)
    && typeof c["recorded"] === "boolean" && Array.isArray(c["violations"])
    && c["violations"].every((v) => isObj(v) && typeof v["code"] === "string" && typeof v["name"] === "string");
}
const validFailure = (f: unknown): f is Failure => isObj(f) && isAgent(f["agent"]) && FAIL_CODES.includes(f["code"] as string);
function validLastCheck(l: unknown): l is LastCheck {
  return isObj(l) && typeof l["at"] === "string" && STAMP.test(l["at"]) && Array.isArray(l["candidates"]) && l["candidates"].every(validCandidate)
    && Array.isArray(l["failures"]) && l["failures"].every(validFailure);
}

export const reminderPath = (dataDir: string) => join(dataDir, REMINDER_FILE);

/** Reads cli-reminder.json; never creates or rewrites anything. */
export function readReminder(dataDir: string): ReminderState {
  const file = reminderPath(dataDir);
  const broken = (why: string): ReminderState => ({ state: "broken", error: settings().reminderBroken(file, why) });
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "unknown";
    return code === "ENOENT" ? { state: "absent" } : broken(settings().reminderWhyAccess(code));
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return broken(settings().reminderWhyJson);
  }
  const { min, max } = PERIOD_BOUNDS;
  if (!isObj(data) || data["schemaVersion"] !== 1 || typeof data["periodDays"] !== "number" || !Number.isInteger(data["periodDays"]) || data["periodDays"] < min || data["periodDays"] > max
    || (data["lastCheck"] !== null && !validLastCheck(data["lastCheck"]))) return broken(settings().reminderWhyShape);
  return { state: "loaded", data: { schemaVersion: 1, periodDays: data["periodDays"], lastCheck: data["lastCheck"] } };
}

/** Atomic write; an existing read-only file is respected, the old bytes stay on any error. */
function saveReminder(dataDir: string, data: ReminderData): string | null {
  const file = reminderPath(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    if (existsSync(file)) accessSync(file, constants.W_OK);
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
    return null;
  } catch (e) {
    rmSync(tmp, { force: true });
    return (e as NodeJS.ErrnoException).code ?? "unknown";
  }
}

const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const cmp = (a: string, b: string): number => {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
};

export interface TransitionInput {
  agent: CliAgent;
  now: Date;
  periodDays: number;
  source: CliSource | null;
  level: CliLevel;
  checkedAt: string | null;
  pins: AgentPins | undefined;
  record: readonly VerifiedEntry[];
  lastCheck: LastCheck | null;
  /** Integrity of the recorded installs newer than the active pin that are `real` in the record: a version missing here is not intact. */
  integrity: ReadonlyMap<string, "ok" | "missing" | "sha256_mismatch">;
}

/** Pure: reminders and the switch target from already-read inputs. Writes nothing. */
export function computeTransition(i: TransitionInput): CliTransition {
  const { agent, source, level, checkedAt } = i;
  const active = i.pins?.active ?? null;
  const act = i.pins?.activatedAt ?? null;
  const ageDays = act === null ? null : Math.floor((i.now.getTime() - Date.parse(act)) / DAY_MS);
  const pin = active === null ? null : { version: active, activatedAt: act, ageDays, previous: i.pins?.previous ?? null };
  const out: CliTransition = { agent, source, level, checkedAt, pin, due: null, target: null, install: null, broken: [], candidates: [], violations: [], check: null };
  if (source !== "pin" || active === null) return out;

  const newer = (v: string) => cmp(v, active) > 0;
  const mine = i.record.filter((e) => e.agent === agent && newer(e.version));
  const reals = mine.filter((e) => e.level === "real").sort((a, b) => cmp(b.version, a.version));
  const installed = new Set((i.pins?.installed ?? []).map((x) => x.version));
  const newestReal = reals[0];
  const targetEntry = reals.find((e) => installed.has(e.version) && i.integrity.get(e.version) === "ok");
  out.broken = reals.filter((e) => installed.has(e.version)).flatMap((e) => {
    const code = i.integrity.get(e.version);
    return code === "missing" || code === "sha256_mismatch" ? [{ version: e.version, code }] : [];
  });
  if (ageDays !== null && ageDays > i.periodDays && newestReal) out.due = { from: active, to: newestReal.version, ageDays, acceptedAt: newestReal.checkedAt };
  if (targetEntry) out.target = { version: targetEntry.version, acceptedAt: targetEntry.checkedAt };
  if (newestReal && !installed.has(newestReal.version) && (!targetEntry || cmp(newestReal.version, targetEntry.version) > 0)) {
    out.install = { version: newestReal.version, command: `council cli install ${agent} --version ${newestReal.version}` };
  }
  out.candidates = mine.filter((e) => e.level === "interface").sort((a, b) => cmp(b.version, a.version)).map((e) => ({ version: e.version }));
  const last = i.lastCheck;
  if (last) {
    out.violations = last.candidates.filter((c) => c.agent === agent && c.status === "violates" && newer(c.version)).sort((a, b) => cmp(b.version, a.version))
      .map((c) => ({ version: c.version, names: c.violations.map((v) => v.name) }));
    const failure = last.failures.find((f) => f.agent === agent);
    out.check = { at: last.at, outcome: (failure?.code ?? "ok") as CliCheckOutcome };
  }
  return out;
}

export interface CliTransitionDeps {
  dataDir: string;
  logger: Logger;
  now?(): Date;
  /** Milliseconds from a monotonic clock: the in-process 24 h gate is measured on it, so a wall-clock jump cannot shorten or disable it. */
  monotonic?(): number;
  running(): boolean;
  onChecked(): void;
  candidateDeps(): CandidateDeps;
  check?: typeof checkCandidates;
  osenVersion?: string;
  env?: Record<string, string | undefined>;
  resetDiscovery?(): void;
}

export interface CliTransitionApi {
  maybeCheck(): Promise<void>;
  settingsView(): CliTransitionSettings;
  forProvider(agent: CliAgent, status: ProviderStatus): Promise<CliTransition>;
  setPeriod(days: unknown): void;
  switchCli(agent: unknown, version: unknown): void;
  rollbackCli(agent: unknown): void;
}

export function createCliTransition(deps: CliTransitionDeps): CliTransitionApi {
  const { dataDir, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const mono = deps.monotonic ?? (() => performance.now());
  let checking = false;
  let lastRunMono: number | null = null;
  let unsaved: { lastCheck: LastCheck; code: string } | null = null;

  const loadedData = (s: ReminderState): ReminderData | null => (s.state === "loaded" ? s.data : null);
  const activeAgents = (): CliAgent[] => {
    const p = readPins(dataDir);
    return p.state === "loaded" ? CLI_AGENTS.filter((a) => p.pins.agents[a]?.active != null) : [];
  };

  async function runCheck(agents: CliAgent[], at: string): Promise<LastCheck> {
    const check = deps.check ?? checkCandidates;
    let report: CandidatesReport | null = null;
    try {
      report = await check(dataDir, agents, { ...deps.candidateDeps(), now, ...(deps.osenVersion ? { osenVersion: deps.osenVersion } : {}), ...(deps.env ? { env: deps.env } : {}) });
    } catch (e) {
      logger.error("CLI candidate check threw", e);
    }
    if (!report) return { at, candidates: [], failures: agents.map((agent) => ({ agent, code: "check_failed" as const })) };
    const json = candidatesJson(report);
    if (json.failures.length) logger.error(`CLI candidate check finished with failures: ${json.failures.map((f) => `${f.agent}=${f.code}`).join(", ")}`);
    else logger.info(`CLI candidate check finished: agents ${agents.join(",")}, candidates ${json.candidates.length}, violations ${json.candidates.filter((c) => c.status === "violates").length}`);
    return { at, candidates: json.candidates, failures: json.failures };
  }

  async function maybeCheck(): Promise<void> {
    if (checking) return;
    if (lastRunMono !== null && mono() - lastRunMono < CHECK_INTERVAL_MS) return;
    try {
      const first = readReminder(dataDir);
      if (first.state === "broken") return;
      const agents = activeAgents();
      if (agents.length === 0) return;
      const last = loadedData(first)?.lastCheck;
      if (last) {
        const elapsed = now().getTime() - Date.parse(last.at);
        if (elapsed >= 0 && elapsed < CHECK_INTERVAL_MS) return;
        if (elapsed < 0) logger.info(`CLI candidate check: the recorded attempt ${last.at} is later than now, treated as stale`);
      }
      checking = true;
      lastRunMono = mono(); // the attempt counts even if anything below fails
      const lastCheck = await runCheck(agents, stamp(now()));
      const fresh = readReminder(dataDir); // the period may have changed, the file may have broken, while npm worked
      if (fresh.state === "broken") {
        logger.error("CLI candidate check result not saved: the reminder file is damaged");
        return;
      }
      const code = saveReminder(dataDir, { schemaVersion: 1, periodDays: loadedData(fresh)?.periodDays ?? DEFAULT_PERIOD_DAYS, lastCheck });
      if (code !== null) {
        unsaved = { lastCheck, code };
        logger.error(`CLI candidate check result not saved to ${reminderPath(dataDir)}: ${code}; next attempt in this run not before 24 hours`);
      } else unsaved = null;
      deps.onChecked();
    } catch (e) {
      logger.error("CLI candidate check could not be recorded", e);
    } finally {
      checking = false;
    }
  }

  function settingsView(): CliTransitionSettings {
    const s = readReminder(dataDir);
    return { periodDays: loadedData(s)?.periodDays ?? DEFAULT_PERIOD_DAYS, fileError: s.state === "broken" ? s.error : null, running: deps.running() };
  }

  async function forProvider(agent: CliAgent, status: ProviderStatus): Promise<CliTransition> {
    const reminder = loadedData(readReminder(dataDir));
    const pins = readPins(dataDir);
    const agentPins = pins.state === "loaded" ? pins.pins.agents[agent] : undefined;
    const record = loadVerifiedRecord(dataDir).entries;
    // only recorded `real` installs newer than the active pin can become a target, so only those are hashed
    const integrity = new Map<string, "ok" | "missing" | "sha256_mismatch">();
    if (status.source === "pin" && agentPins?.active) { // the target exists only for the pin source
      const real = new Set(record.filter((e) => e.agent === agent && e.level === "real").map((e) => e.version));
      for (const inst of agentPins.installed) {
        if (cmp(inst.version, agentPins.active) <= 0 || !real.has(inst.version)) continue;
        const r = await checkPinFile(installedPath(dataDir, agent, inst), inst.sha256);
        integrity.set(inst.version, r.ok ? "ok" : r.code);
      }
    }
    const out = computeTransition({
      agent, now: now(), periodDays: reminder?.periodDays ?? DEFAULT_PERIOD_DAYS,
      source: status.source ?? null, level: status.verified?.level ?? "none", checkedAt: status.verified?.checkedAt ?? null,
      pins: agentPins,
      record, integrity, lastCheck: unsaved?.lastCheck ?? reminder?.lastCheck ?? null,
    });
    if (unsaved && out.check) out.check = { ...out.check, notSaved: { code: unsaved.code } };
    return out;
  }

  /** The window text carries the code only; the path goes to the log. */
  function writeReminder(data: ReminderData): void {
    const code = saveReminder(dataDir, data);
    if (code === null) return;
    logger.error(`CLI transition period not saved to ${reminderPath(dataDir)}: ${code}`);
    throw new SettingsError(settings().reminderSaveFailed(code));
  }

  function setPeriod(days: unknown): void {
    const reason = checkPeriod(days);
    if (reason !== null) throw new SettingsError(reason);
    const prev = loadedData(readReminder(dataDir)); // a damaged file is replaced only here, by the owner's explicit save
    writeReminder({ schemaVersion: 1, periodDays: days as number, lastCheck: unsaved?.lastCheck ?? prev?.lastCheck ?? null });
    unsaved = null; // the check result is on disk now
    logger.info(`CLI transition period saved: ${days as number} days`);
  }

  const agentOf = (v: unknown): CliAgent => {
    if (!isAgent(v)) throw new SettingsError(settings().badRequest(settings().reqAgent));
    return v;
  };
  function guard(agent: CliAgent): void {
    if (deps.running()) throw new SettingsError(settings().cliSessionRunning);
    const p = readPins(dataDir);
    const noActive = p.state === "absent" || (p.state === "loaded" && !p.pins.agents[agent]?.active); // a damaged pins.json goes to 176 for its own reason
    if (noActive) throw new SettingsError(settings().cliNoPin(agent));
  }
  function done(what: string, agent: CliAgent, r: { ok: boolean; code: number; text: string; textNoPath?: string }): void {
    if (!r.ok) {
      logger.error(`CLI ${what} ${agent} refused by the pin store (code ${r.code})`); // the 176 text is in the process language: the log line stays language independent
      if (r.code === 1) { // pins.json rejected or not writable: the text carries the path, so it stays in the log
        logger.error(r.text);
        throw new SettingsError(settings().cliPinsUnavailable);
      }
      throw new SettingsError(r.textNoPath ?? r.text);
    }
    (deps.resetDiscovery ?? resetDiscoveryCache)();
    logger.info(`CLI ${what} ${agent}: done`);
  }

  return {
    maybeCheck, settingsView, forProvider, setPeriod,
    switchCli(agentRaw, version) {
      const agent = agentOf(agentRaw);
      if (typeof version !== "string" || !VERSION.test(version)) throw new SettingsError(settings().badRequest(settings().reqVersion));
      guard(agent);
      done(`switch to ${version}`, agent, usePin(dataDir, agent, version, { record: loadVerifiedRecord(dataDir), now }));
    },
    rollbackCli(agentRaw) {
      const agent = agentOf(agentRaw);
      guard(agent);
      done("rollback", agent, rollbackPin(dataDir, agent, { now }));
    },
  };
}
