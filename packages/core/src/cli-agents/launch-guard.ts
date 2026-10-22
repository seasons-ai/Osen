import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createReadStream, statSync } from "node:fs";
import { providerMessages } from "../messages/providers.ts";
import { parseVersion } from "./discovery.ts";
import { activePin } from "./pins.ts";
import type { CliAgent } from "./types.ts";
import { lookupVerified } from "./verified-record.ts";
import type { VerifiedRecord } from "./verified-record.ts";

type Env = Record<string, string | undefined>;

export interface GuardDeps {
  /** `${size}:${mtimeMs}:${ctimeMs}:${ino}` of a regular executable file (symlinks followed); undefined when it is missing or not runnable. */
  fileId(path: string): string | undefined;
  /** Full-content sha256, hex. */
  hash(path: string): Promise<string>;
  /** Raw stdout of `<path> --version`. */
  readVersion(path: string, env: Env): Promise<string>;
}
export interface PinnedInstall { path: string; version: string; sha256: string }
export type GuardResult = { ok: true; version: string; level: "real"; checkedAt: string | null } | { ok: false; reason: string };

const realGuardDeps: GuardDeps = {
  fileId(path) {
    try {
      const st = statSync(path);
      if (!st.isFile()) return undefined;
      accessSync(path, constants.X_OK);
      return `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
    } catch {
      return undefined;
    }
  },
  hash: (path) =>
    new Promise((res, rej) => {
      const h = createHash("sha256");
      createReadStream(path).on("data", (c) => h.update(c)).on("error", rej).on("end", () => res(h.digest("hex")));
    }),
  readVersion: (path, env) =>
    new Promise((res, rej) =>
      execFile(path, ["--version"], { timeout: 10_000, env }, (err, stdout) => (err ? rej(err) : res(String(stdout)))).stdin?.end(),
    ),
};

// path -> last hashed file identity and its sha256; an unchanged identity is not hashed again.
const shaCache = new Map<string, { id: string; sha: string }>();
export const resetGuardCache = (): void => shaCache.clear();

/** Cache-key part for discovery: changes when the active pin changes or its binary file changes. */
export function pinBinaryState(dataDir: string, agent: CliAgent): string {
  const a = activePin(dataDir, agent);
  if (a.state !== "pin") return a.state;
  return realGuardDeps.fileId(a.path) ?? "missing";
}

export type PinFileResult = { ok: true } | { ok: false; code: "missing" } | { ok: false; code: "sha256_mismatch"; actual: string };

/** File integrity of a recorded install: present and runnable, sha256 equal to the record. Shares the sha256 cache with the launch check. */
export async function checkPinFile(path: string, sha256: string, overrides: Partial<GuardDeps> = {}): Promise<PinFileResult> {
  const d = { ...realGuardDeps, ...overrides };
  const id = d.fileId(path);
  if (id === undefined) return { ok: false, code: "missing" };
  let cached = shaCache.get(path);
  if (cached?.id !== id) {
    try {
      cached = { id, sha: await d.hash(path) };
    } catch {
      return { ok: false, code: "missing" };
    }
    shaCache.set(path, cached);
  }
  return cached.sha === sha256 ? { ok: true } : { ok: false, code: "sha256_mismatch", actual: cached.sha };
}

/** Free check of the active pin before a launch. Stops at the first failure; the binary runs only for `--version`, after the sha256 matches. */
export async function checkPinnedLaunch(
  input: { agent: CliAgent; pin: PinnedInstall; launchPath: string; record: VerifiedRecord; env: Env },
  overrides: Partial<GuardDeps> = {},
): Promise<GuardResult> {
  const d = { ...realGuardDeps, ...overrides };
  const { agent, pin, launchPath, record, env } = input;
  const m = providerMessages();
  if (launchPath !== pin.path) return { ok: false, reason: m.pinPathMismatch(agent, pin.path, launchPath) };
  const file = await checkPinFile(pin.path, pin.sha256, overrides);
  if (!file.ok) {
    return { ok: false, reason: file.code === "missing" ? m.cliPinMissing(agent, pin.path) : m.pinSha256Mismatch(agent, pin.version, pin.path, pin.sha256, file.actual) };
  }
  const entry = lookupVerified(record, agent, pin.version);
  if (entry?.level !== "real") return { ok: false, reason: m.pinNotReal(agent, pin.version, entry?.level ?? "none") };
  let parsed: string | undefined;
  try {
    const raw = await d.readVersion(pin.path, env);
    parsed = parseVersion(raw);
    if (!parsed) return { ok: false, reason: m.pinVersionUnread(agent, pin.path, pin.version, m.versionNoNumber(raw.trim().slice(0, 100))) };
  } catch (e) {
    return { ok: false, reason: m.pinVersionUnread(agent, pin.path, pin.version, e instanceof Error ? e.message : String(e)) };
  }
  if (parsed !== pin.version) return { ok: false, reason: m.pinVersionMismatch(agent, pin.path, pin.version, parsed) };
  return { ok: true, version: parsed, level: "real", checkedAt: entry.checkedAt };
}
