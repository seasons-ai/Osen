import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { describeIssue } from "../messages/zod.ts";
import { pinMessages } from "../messages/pins.ts";
import { createLogger } from "../store/log.ts";
import { parseVersion, pinnedEnv } from "./discovery.ts";
import { CLI_AGENTS } from "./types.ts";
import type { CliAgent } from "./types.ts";
import { lookupVerified } from "./verified-record.ts";
import type { VerifiedRecord } from "./verified-record.ts";

export const CLI_DIR = "cli";
export const PINS_FILE = "pins.json";
export const cliDir = (dataDir: string) => join(dataDir, CLI_DIR);
export const pinsPath = (dataDir: string) => join(dataDir, CLI_DIR, PINS_FILE);
export const versionDir = (dataDir: string, agent: CliAgent, version: string) => join(dataDir, CLI_DIR, agent, version);
export const pinConfigDir = (dataDir: string, agent: CliAgent, version: string) => join(versionDir(dataDir, agent, version), "config");

export interface PinInstall { version: string; path: string; source: string; sha256: string; installedAt: string }
export interface AgentPins { installed: PinInstall[]; active: string | null; previous: string | null; activatedAt: string | null }
export interface PinsFile { schemaVersion: 1; agents: Partial<Record<CliAgent, AgentPins>> }
export type PinsState = { state: "absent" } | { state: "loaded"; pins: PinsFile } | { state: "rejected"; reason: string };

const VERSION = /^\d+\.\d+\.\d+$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const InstallSchema = z.strictObject({
  version: z.string().regex(VERSION),
  path: z.string().min(1),
  source: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  installedAt: z.string().regex(STAMP),
}).superRefine((i, ctx) => {
  if (isAbsolute(i.path) || i.path.split(/[\\/]/).includes("..")) ctx.addIssue({ code: "custom", path: ["path"], message: pinMessages().pinsBadPath });
});
const AgentSchema = z.strictObject({
  installed: z.array(InstallSchema),
  active: z.string().regex(VERSION).nullable(),
  previous: z.string().regex(VERSION).nullable(),
  activatedAt: z.string().regex(STAMP).nullable(),
}).superRefine((a, ctx) => {
  const seen = new Set<string>();
  for (const [n, i] of a.installed.entries()) {
    if (seen.has(i.version)) ctx.addIssue({ code: "custom", path: ["installed", n, "version"], message: pinMessages().pinsDuplicate(i.version) });
    seen.add(i.version);
  }
  for (const k of ["active", "previous"] as const) {
    const v = a[k];
    if (v !== null && !seen.has(v)) ctx.addIssue({ code: "custom", path: [k], message: pinMessages().pinsActiveNotInstalled(v) });
  }
});
const PinsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  agents: z.strictObject({ claude: AgentSchema.optional(), codex: AgentSchema.optional() }),
});

const reject = (dataDir: string, where: string, why: string): PinsState =>
  ({ state: "rejected", reason: pinMessages().pinsRejected(pinsPath(dataDir), where, why) });

/** Reads cli/pins.json; never creates or rewrites anything. */
export function readPins(dataDir: string): PinsState {
  let raw: string;
  try {
    raw = readFileSync(pinsPath(dataDir), "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "unknown";
    return code === "ENOENT" ? { state: "absent" } : reject(dataDir, pinMessages().pinsWhereFile, pinMessages().pinsUnreadable(code));
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return reject(dataDir, pinMessages().pinsWhereFile, pinMessages().pinsNotJson);
  }
  const sv = (data as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof data === "object" && data !== null && "schemaVersion" in data && sv !== 1) {
    return reject(dataDir, "schemaVersion", pinMessages().pinsBadVersion(JSON.stringify(sv)));
  }
  const r = PinsSchema.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0]!;
    return reject(dataDir, i.path.join(".") || pinMessages().pinsWhereFile, describeIssue(i));
  }
  return { state: "loaded", pins: r.data as PinsFile };
}

export const installedPath = (dataDir: string, agent: CliAgent, install: PinInstall): string =>
  join(versionDir(dataDir, agent, install.version), install.path);

export type ActivePin = { state: "none" } | { state: "pin"; version: string; path: string; configDir: string; sha256: string } | { state: "rejected"; reason: string };

export function activePin(dataDir: string, agent: CliAgent): ActivePin {
  const s = readPins(dataDir);
  if (s.state === "rejected") return s;
  const a = s.state === "loaded" ? s.pins.agents[agent] : undefined;
  const inst = a?.active ? a.installed.find((i) => i.version === a.active) : undefined;
  if (!a || !inst) return { state: "none" };
  return { state: "pin", version: inst.version, path: installedPath(dataDir, agent, inst), configDir: pinConfigDir(dataDir, agent, inst.version), sha256: inst.sha256 };
}

/** Cache key part for discovery: changes when the pins file is rewritten, or its error code. */
export function pinsFileState(dataDir: string): string {
  try {
    const st = statSync(pinsPath(dataDir));
    return `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? "unknown";
  }
}

export interface PackageSource {
  fetch(agent: CliAgent, version: string, dir: string, signal?: AbortSignal): Promise<{ executable: string; source: string }>;
}
export interface PinDeps {
  source: PackageSource;
  record: VerifiedRecord;
  now?: () => Date;
  readVersion?: (path: string, env: Record<string, string | undefined>) => Promise<string>;
}
export type PinResult = { ok: true; code: 0; text: string } | { ok: false; code: 1 | 2; text: string };

const ok = (text: string): PinResult => ({ ok: true, code: 0, text });
const fail = (code: 1 | 2, text: string): PinResult => ({ ok: false, code, text });
const stamp = (now?: () => Date) => (now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
const isAgent = (a: string): a is CliAgent => (CLI_AGENTS as readonly string[]).includes(a);
const cmpVersion = (a: string, b: string) => {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
};

function writePins(dataDir: string, pins: PinsFile): string | undefined {
  const file = pinsPath(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(pins, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
    return undefined;
  } catch (e) {
    rmSync(tmp, { force: true });
    return pinMessages().pinsWriteFailed(file, (e as NodeJS.ErrnoException).code ?? "unknown");
  }
}

function log(dataDir: string, line: string, error = false): void {
  const l = createLogger(dataDir, "cli-pin");
  if (error) l.error(line);
  else l.info(line);
}

function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (c) => h.update(c)).on("error", rej).on("end", () => res(h.digest("hex")));
  });
}

const defaultReadVersion = (path: string, env: Record<string, string | undefined>): Promise<string> =>
  new Promise((res, rej) =>
    execFile(path, ["--version"], { timeout: 10_000, env }, (err, stdout) => (err ? rej(err) : res(String(stdout)))).stdin?.end(),
  );

function checkAgent(agent: string): PinResult | undefined {
  return isAgent(agent) ? undefined : fail(2, pinMessages().unknownAgent(agent, CLI_AGENTS.join(", ")));
}

export async function installPin(
  dataDir: string,
  agentName: string,
  opts: { version?: string; candidate?: boolean },
  deps: PinDeps,
): Promise<PinResult> {
  const m = pinMessages();
  const bad = checkAgent(agentName);
  if (bad) return bad;
  const agent = agentName as CliAgent;
  if (opts.version !== undefined && !VERSION.test(opts.version)) return fail(2, m.badVersionFormat(opts.version));
  const state = readPins(dataDir);
  if (state.state === "rejected") {
    log(dataDir, `install ${agent} outcome=pins-rejected`, true);
    return fail(1, state.reason);
  }
  let version = opts.version;
  if (version === undefined) {
    const newest = deps.record.entries.filter((e) => e.agent === agent && e.level === "real").sort((a, b) => cmpVersion(b.version, a.version))[0];
    if (!newest) return fail(2, m.noRealVersion(agent));
    version = newest.version;
  } else if (!opts.candidate) {
    const e = lookupVerified(deps.record, agent, version);
    if (e?.level !== "real") return fail(2, m.notReal(agent, version, e?.level ?? m.levelNone));
  }
  const level = lookupVerified(deps.record, agent, version)?.level;
  const pins: PinsFile = state.state === "loaded" ? state.pins : { schemaVersion: 1, agents: {} };
  const cur = pins.agents[agent] ?? { installed: [], active: null, previous: null, activatedAt: null };
  if (cur.installed.some((i) => i.version === version)) {
    log(dataDir, `install ${agent} ${version} outcome=already-installed`);
    return ok(m.alreadyInstalled(agent, version));
  }
  const target = versionDir(dataDir, agent, version);
  if (existsSync(target)) {
    log(dataDir, `install ${agent} ${version} outcome=leftover-folder`, true);
    return fail(1, m.leftoverFolder(target));
  }

  const agentDir = join(cliDir(dataDir), agent);
  const hadCli = existsSync(cliDir(dataDir));
  const hadAgent = existsSync(agentDir);
  let tmp: string | undefined;
  let renamed = false;
  try {
    mkdirSync(agentDir, { recursive: true });
    tmp = mkdtempSync(join(agentDir, ".install-"));
    const got = await deps.source.fetch(agent, version, tmp);
    const exe = resolve(got.executable);
    if (!exe.startsWith(resolve(tmp) + sep)) throw new Error(m.executableOutside(got.executable));
    try { accessSync(exe, constants.X_OK); } catch { throw new Error(m.executableNotRunnable(exe)); }
    let reported: string | undefined;
    try {
      // the probe already runs as a pin: own config dir and self-update off, so the owner's config is never touched
      mkdirSync(join(tmp, "config"));
      reported = parseVersion(await (deps.readVersion ?? defaultReadVersion)(exe, { ...process.env, ...pinnedEnv(agent, join(tmp, "config")) }));
    } catch (e) {
      throw new Error(m.versionUnreadable(e instanceof Error ? e.message : String(e)));
    }
    if (reported !== version) throw new Error(m.versionMismatch(version, reported ?? "?"));
    const sha256 = await sha256File(exe);
    const rel = relative(resolve(tmp), exe);
    renameSync(tmp, target);
    renamed = true;
    // npm may take minutes: re-read so a use/rollback made meanwhile is kept.
    // ponytail: no lock between this read and the write; add a file lock if two installs at once matter
    const fresh = readPins(dataDir);
    if (fresh.state === "rejected") throw new Error(fresh.reason);
    const pins: PinsFile = fresh.state === "loaded" ? fresh.pins : { schemaVersion: 1, agents: {} };
    const cur = pins.agents[agent] ?? { installed: [], active: null, previous: null, activatedAt: null };
    if (cur.installed.some((i) => i.version === version)) throw new Error(m.alreadyInstalled(agent, version));
    const at = stamp(deps.now);
    const activate = level === "real" && !opts.candidate && cur.active === null;
    const next: AgentPins = {
      installed: [...cur.installed, { version, path: rel, source: got.source, sha256, installedAt: at }],
      active: activate ? version : cur.active,
      previous: cur.previous,
      activatedAt: activate ? at : cur.activatedAt,
    };
    const werr = writePins(dataDir, { schemaVersion: 1, agents: { ...pins.agents, [agent]: next } });
    if (werr) throw new Error(werr);
    log(dataDir, `install ${agent} ${version} outcome=ok active=${activate}`);
    const head = m.installedOk(agent, version, installedPath(dataDir, agent, next.installed.at(-1)!));
    return ok(`${head}\n${activate ? m.nowActive(agent, version) : m.notActivated(agent, version)}`);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (renamed) rmSync(target, { recursive: true, force: true });
    if (!hadAgent) try { rmdirSync(agentDir); } catch {}
    if (!hadCli) try { rmdirSync(cliDir(dataDir)); } catch {}
    log(dataDir, `install ${agent} ${version} outcome=failed`, true);
    return fail(1, m.installFailed(agent, version, why));
  }
}

type Loaded = { res: PinResult } | { pins: PinsFile; cur: AgentPins; agent: CliAgent };

function load(dataDir: string, agentName: string): Loaded {
  const bad = checkAgent(agentName);
  if (bad) return { res: bad };
  const s = readPins(dataDir);
  if (s.state === "rejected") return { res: fail(1, s.reason) };
  const pins: PinsFile = s.state === "loaded" ? s.pins : { schemaVersion: 1, agents: {} };
  const agent = agentName as CliAgent;
  return { pins, agent, cur: pins.agents[agent] ?? { installed: [], active: null, previous: null, activatedAt: null } };
}

function commit(dataDir: string, pins: PinsFile, agent: CliAgent, next: AgentPins, line: string, text: string): PinResult {
  const werr = writePins(dataDir, { ...pins, agents: { ...pins.agents, [agent]: next } });
  if (werr) {
    log(dataDir, `${line} outcome=write-failed`, true);
    return fail(1, werr);
  }
  log(dataDir, `${line} outcome=ok`);
  return ok(text);
}

function missingFile(dataDir: string, agent: CliAgent, i: PinInstall): string | undefined {
  const p = installedPath(dataDir, agent, i);
  return existsSync(p) ? undefined : p;
}

export function usePin(dataDir: string, agentName: string, version: string, deps: { record: VerifiedRecord; now?: () => Date }): PinResult {
  const m = pinMessages();
  const l = load(dataDir, agentName);
  if ("res" in l) return l.res;
  const { agent, cur, pins } = l;
  const inst = cur.installed.find((i) => i.version === version);
  if (!inst) return fail(2, m.useNotInstalled(agent, version));
  const gone = missingFile(dataDir, agent, inst);
  if (gone) return fail(2, m.useFileMissing(agent, version, gone));
  const level = lookupVerified(deps.record, agent, version)?.level;
  if (level !== "real") return fail(2, m.notReal(agent, version, level ?? m.levelNone));
  if (cur.active === version) return ok(m.alreadyActive(agent, version));
  const next: AgentPins = { ...cur, previous: cur.active, active: version, activatedAt: stamp(deps.now) };
  return commit(dataDir, pins, agent, next, `use ${agent} ${version}`, next.previous ? m.switched(agent, version, next.previous) : m.switchedNoPrevious(agent, version));
}

export function rollbackPin(dataDir: string, agentName: string, deps: { now?: () => Date }): PinResult {
  const m = pinMessages();
  const l = load(dataDir, agentName);
  if ("res" in l) return l.res;
  const { agent, cur, pins } = l;
  if (cur.previous === null) return fail(2, m.noPrevious(agent));
  const inst = cur.installed.find((i) => i.version === cur.previous);
  if (!inst) return fail(2, m.useNotInstalled(agent, cur.previous));
  const gone = missingFile(dataDir, agent, inst);
  if (gone) return fail(2, m.useFileMissing(agent, inst.version, gone));
  const next: AgentPins = { ...cur, active: inst.version, previous: null, activatedAt: stamp(deps.now) };
  return commit(dataDir, pins, agent, next, `rollback ${agent} ${inst.version}`, m.rolledBack(agent, inst.version));
}

export function listPins(dataDir: string, record: VerifiedRecord): PinResult {
  const m = pinMessages();
  const s = readPins(dataDir);
  if (s.state === "rejected") return fail(1, s.reason);
  const blocks: string[] = [];
  if (s.state === "loaded") {
    for (const agent of CLI_AGENTS) {
      const a = s.pins.agents[agent];
      if (!a || a.installed.length === 0) continue;
      const lines = a.installed.map((i) => {
        const marks = (i.version === a.active ? m.markActive : "") + (i.version === a.previous ? m.markPrevious : "");
        return m.listLine(i.version, marks, lookupVerified(record, agent, i.version)?.level ?? m.levelNone, i.installedAt);
      });
      blocks.push([agent, ...lines].join("\n"));
    }
  }
  return ok(blocks.length ? blocks.join("\n") : m.noPins);
}
