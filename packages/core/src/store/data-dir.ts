import { accessSync, constants, cpSync, lstatSync, mkdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { storeMessages } from "../messages/store.ts";
import { createLogger } from "./log.ts";
import { isProcessAlive, listSessions } from "./sessions.ts";
import { tryPidLock } from "./pid-lock.ts";

export class DataDirError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DataDirError";
  }
}

export function resolveDataDir(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const custom = env.COUNCIL_HOME?.trim();
  if (custom) return resolve(custom);
  if (platform === "darwin") return join(home, "Library", "Application Support", "osen");
  return join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "osen");
}

type Env = Record<string, string | undefined>;
export interface PrepareHooks {
  lockWaitMs?: number;
  /** After the quick state check, before taking the lock. */
  beforeLock?: () => void;
  /** After the copy, before the repeated check of running sessions. */
  afterCopy?: () => void;
}

const LEGACY = "model-council";
const kind = (path: string): "none" | "dir" | "other" => {
  try {
    return lstatSync(path).isDirectory() ? "dir" : "other";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "none";
    throw e;
  }
};
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const loggedOnce = new Set<string>(); // log write — once per process and kind of write
const p2 = (n: number) => String(n).padStart(2, "0");
const stamp = (d = new Date()) => // the owner's local time, as in docs/deploy.md
  `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;

function hasRunning(old: string): boolean {
  try {
    return listSessions(old).some((s) => s.status === "running");
  } catch (e) {
    throw new DataDirError(storeMessages().dataDirMigrationFailed(old, reasonOf(e)), { cause: e });
  }
}

/** Path of the data folder with the migration of the former model-council to osen (design 79, decisions 1–5, 8). With COUNCIL_HOME it does not read the disk. */
export function prepareDataDir(
  env: Env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  hooks: PrepareHooks = {},
): string {
  const osen = resolveDataDir(env, platform, home);
  if (env.COUNCIL_HOME?.trim()) return osen;
  const parent = dirname(osen);
  const old = join(parent, LEGACY);
  const note = (key: string, dir: string, text: string, level: "info" | "error" = "info") => {
    if (loggedOnce.has(`${key}|${osen}`)) return;
    loggedOnce.add(`${key}|${osen}`);
    const log = createLogger(dir, "store", env);
    if (level === "info") log.info(text); else log.error(text);
  };

  // The state is determined by lstat of two paths; it is called again under the lock as well.
  const settle = (locked: boolean): string | "migrate" => {
    const o = kind(old);
    const n = kind(osen);
    const m = storeMessages();
    if (n === "none" && o === "dir") return locked ? migrate() : "migrate";
    if (n === "none" && o === "other") {
      let target: string;
      try { target = realpathSync(old); } catch { try { target = resolve(parent, readlinkSync(old)); } catch { target = "?"; } }
      note("link", osen, m.dataDirLinkElsewhere(old, target));
    } else if (n !== "none" && o === "dir") {
      note("both", osen, m.dataDirBothFolders(osen, old));
    }
    return osen;
  };

  const migrate = (): string => {
    const m = storeMessages();
    const defer = (why: string) => { note("defer", old, why); return old; };
    if (hasRunning(old)) return defer(m.dataDirMigrationDeferred(old));
    const backup = join(parent, `${LEGACY}-backup-${stamp()}`);
    try {
      cpSync(old, backup, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    } catch (e) {
      rmSync(backup, { recursive: true, force: true });
      throw new DataDirError(m.dataDirMigrationFailed(old, reasonOf(e)), { cause: e });
    }
    hooks.afterCopy?.();
    if (hasRunning(old)) {
      rmSync(backup, { recursive: true, force: true });
      return defer(m.dataDirMigrationDeferred(old));
    }
    try {
      renameSync(old, osen);
    } catch (e) {
      rmSync(backup, { recursive: true, force: true });
      throw new DataDirError(m.dataDirMigrationFailed(old, reasonOf(e)), { cause: e });
    }
    try {
      symlinkSync("osen", old);
    } catch (e) {
      note("linkfail", osen, m.dataDirLinkFailed(old, reasonOf(e)));
    }
    note("moved", osen, m.dataDirMigrated(old, osen, backup));
    return osen;
  };

  const first = settle(false);
  if (first !== "migrate") return first;
  hooks.beforeLock?.();
  const lock = join(parent, "osen.migrating");
  const deadline = Date.now() + (hooks.lockWaitMs ?? 30_000);
  for (;;) {
    let locked: boolean;
    try {
      locked = tryPidLock(lock, isProcessAlive);
    } catch (e) {
      throw new DataDirError(storeMessages().dataDirMigrationFailed(lock, reasonOf(e)), { cause: e });
    }
    if (locked) {
      try {
        return settle(true) as string;
      } finally {
        try { unlinkSync(lock); } catch {}
      }
    }
    if (Date.now() >= deadline) throw new DataDirError(storeMessages().dataDirLockTimeout(lock));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

/** Path of the data folder read-only (lstat) for the installer (change 98): creates nothing, moves nothing and writes nothing to the log.
 *  The former real model-council without osen is not yet migrated: preferences.json is there. */
export function peekDataDir(env: Env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  const osen = resolveDataDir(env, platform, home);
  if (env.COUNCIL_HOME?.trim()) return osen;
  const old = join(dirname(osen), LEGACY);
  return kind(osen) === "none" && kind(old) === "dir" ? old : osen;
}

export function ensureDataDir(dir: string): string {
  try {
    for (const sub of ["", "templates", "sessions", "logs"]) mkdirSync(join(dir, sub), { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new DataDirError(storeMessages().dataDirUnavailable(dir, reason), { cause: e });
  }
  return dir;
}
