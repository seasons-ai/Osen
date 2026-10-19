import { execFile } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, readlinkSync, renameSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Language } from "@model-council/core/i18n";
import { commandInstall } from "../shared/messages/command-install.ts";

const run = promisify(execFile);
const MARK = "__OSEN_CMD__";

export const LINK_HINT_LINE = 'export PATH="$HOME/.local/bin:$PATH"';
export const LINK_HINT_FILE = "~/.zprofile";
export const OWN_SUFFIX = "/Osen.app/Contents/Resources/bin/council";

export interface CommandOptions {
  home: string;
  wrapper: string;
  env?: Record<string, string | undefined>;
  shell?: string;
  timeoutMs?: number;
  language?: Language;
}
export type LinkKind = "missing" | "own" | "stale" | "foreign";
type ForeignKind = "file" | "dir" | "symlink" | "other";

const binDir = (home: string): string => join(home, ".local", "bin");
const linkPath = (home: string): string => join(binDir(home), "council");

export function classifyLink(o: Pick<CommandOptions, "home" | "wrapper">): { kind: LinkKind; link: string; target?: string; foreignKind?: ForeignKind } {
  const link = linkPath(o.home);
  let st;
  try {
    st = lstatSync(link);
  } catch (e) {
    // ENOTDIR (~/.local/bin is a file) also means there is no link at that path
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing", link };
    throw e;
  }
  if (st.isSymbolicLink()) {
    const target = readlinkSync(link);
    if (target === o.wrapper) return { kind: "own", link, target };
    if (target.endsWith(OWN_SUFFIX)) return { kind: "stale", link, target };
    return { kind: "foreign", link, target, foreignKind: "symlink" };
  }
  return { kind: "foreign", link, foreignKind: st.isFile() ? "file" : st.isDirectory() ? "dir" : "other" };
}

export type CommandState =
  | { state: "not_installed"; link: string }
  | { state: "found"; link: string; target: string }
  | { state: "not_in_path"; link: string; target: string; hint: { file: string; line: string } }
  | { state: "shadowed"; link: string; target: string; shadowedBy: string }
  | { state: "stale"; link: string; target: string; expected: string }
  | { state: "foreign"; link: string; foreignKind: ForeignKind; target?: string }
  | { state: "check_failed"; link: string; target: string; reason: string };

export async function commandStatus(o: CommandOptions): Promise<CommandState> {
  const c = classifyLink(o);
  if (c.kind === "missing") return { state: "not_installed", link: c.link };
  if (c.kind === "foreign") return { state: "foreign", link: c.link, foreignKind: c.foreignKind!, ...(c.target ? { target: c.target } : {}) };
  if (c.kind === "stale") return { state: "stale", link: c.link, target: c.target!, expected: o.wrapper };
  const target = c.target!;
  const m = commandInstall(o.language);
  const failed = (reason: string): CommandState => ({ state: "check_failed", link: c.link, target, reason });

  const env: Record<string, string | undefined> = { ...(o.env ?? process.env), HOME: o.home };
  const script = `printf '\\n${MARK}%s${MARK}%s${MARK}\\n' "$(command -v council)" "$PATH"`;
  let stdout: string;
  try {
    const pending = run(o.shell ?? (env.SHELL || "/bin/zsh"), ["-ilc", script], { env, timeout: o.timeoutMs ?? 5_000 });
    pending.child.stdin?.end();
    stdout = (await pending).stdout;
  } catch (e) {
    const err = e as { code?: unknown; killed?: boolean; signal?: string | null; message?: string };
    if (err.killed || err.signal) return failed(m.probeTimeout);
    if (typeof err.code === "number") return failed(m.probeExit(String(err.code)));
    return failed(m.probeSpawn(err.message ?? String(e)));
  }
  const hit = stdout.match(new RegExp(`${MARK}(.*?)${MARK}(.*?)${MARK}`));
  if (!hit) return failed(m.probeNoMarkers);
  const [, found, shellPath] = hit as unknown as [string, string, string];
  if (found) {
    return resolve(found) === resolve(c.link) ? { state: "found", link: c.link, target } : { state: "shadowed", link: c.link, target, shadowedBy: found };
  }
  const dir = binDir(o.home);
  if (!shellPath.split(delimiter).some((p) => p && resolve(p) === dir)) {
    return { state: "not_in_path", link: c.link, target, hint: { file: LINK_HINT_FILE, line: LINK_HINT_LINE } };
  }
  return failed(m.notResolved(dir));
}

export type CommandRefusal = { ok: false; code: "no_wrapper" | "foreign" | "create_failed"; path: string; detail?: string; message: string };
export type InstallResult = { ok: true; changed: boolean; updated: boolean; status: CommandState } | CommandRefusal;
export type RemoveResult = { ok: true; removed: boolean } | (CommandRefusal & { code: "foreign" | "create_failed" });

const kindText = (k: ForeignKind, language?: Language): string => {
  const m = commandInstall(language);
  return { file: m.kindFile, dir: m.kindDir, symlink: m.kindSymlink, other: m.kindOther }[k];
};

function foreignRefusal(c: ReturnType<typeof classifyLink>, language?: Language): CommandRefusal & { code: "foreign" } {
  const kind = kindText(c.foreignKind!, language);
  return { ok: false, code: "foreign", path: c.link, detail: kind, message: commandInstall(language).refusalForeign(c.link, kind) };
}

export async function installCommand(o: CommandOptions): Promise<InstallResult> {
  const m = commandInstall(o.language);
  // Check the wrapper before any filesystem change
  try {
    accessSync(o.wrapper, constants.X_OK);
  } catch {
    return { ok: false, code: "no_wrapper", path: o.wrapper, message: m.refusalNoWrapper(o.wrapper) };
  }
  const failure = (e: unknown): CommandRefusal => {
    const detail = (e as Error).message ?? String(e);
    return { ok: false, code: "create_failed", path: linkPath(o.home), detail, message: m.refusalCreateFailed(linkPath(o.home), detail) };
  };
  let c;
  try {
    c = classifyLink(o);
  } catch (e) {
    return failure(e);
  }
  if (c.kind === "foreign") return foreignRefusal(c, o.language);
  let changed = false;
  let updated = false;
  if (c.kind === "stale") {
    // Atomic replace: temp symlink in the same dir, then rename over the link
    const tmp = join(binDir(o.home), `.council.${process.pid}.tmp`);
    try {
      symlinkSync(o.wrapper, tmp);
      renameSync(tmp, c.link);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* nothing to clean */ }
      return failure(e);
    }
    changed = updated = true;
  } else if (c.kind === "missing") {
    const dir = binDir(o.home);
    let createdDir: string | undefined;
    try {
      createdDir = firstMissing(dir);
      mkdirSync(dir, { recursive: true });
      symlinkSync(o.wrapper, c.link);
    } catch (e) {
      try { unlinkSync(c.link); } catch { /* not created */ }
      if (createdDir) removeCreated(createdDir, dir);
      return failure(e);
    }
    changed = true;
  }
  return { ok: true, changed, updated, status: await commandStatus(o) };
}

// Topmost directory of `dir` that does not exist yet (what mkdir -p would create), or undefined if all exist
function firstMissing(dir: string): string | undefined {
  let missing: string | undefined;
  for (let d = dir; ; d = dirname(d)) {
    try {
      lstatSync(d);
      return missing;
    } catch {
      missing = d;
    }
    if (dirname(d) === d) return missing;
  }
}

// Remove only the dirs this call created, from `leaf` up to `top`, and only while empty
function removeCreated(top: string, leaf: string): void {
  for (let d = leaf; ; d = dirname(d)) {
    try { rmdirSync(d); } catch { return; }
    if (d === top) return;
  }
}

export function removeCommand(o: Pick<CommandOptions, "home" | "wrapper" | "language">): RemoveResult {
  let c;
  try {
    c = classifyLink(o);
  } catch (e) {
    const detail = (e as Error).message;
    return { ok: false, code: "create_failed", path: linkPath(o.home), detail, message: commandInstall(o.language).refusalCreateFailed(linkPath(o.home), detail) };
  }
  if (c.kind === "missing") return { ok: true, removed: false };
  if (c.kind === "foreign") return foreignRefusal(c, o.language);
  try {
    unlinkSync(c.link);
  } catch (e) {
    const detail = (e as Error).message;
    return { ok: false, code: "create_failed", path: c.link, detail, message: commandInstall(o.language).refusalCreateFailed(c.link, detail) };
  }
  return { ok: true, removed: true };
}

export function describeState(s: CommandState, language?: Language): string {
  const m = commandInstall(language);
  switch (s.state) {
    case "not_installed": return m.notInstalled(s.link);
    case "found": return m.found(s.link, s.target);
    case "not_in_path": return m.notInPath(s.link, s.hint.file, s.hint.line);
    case "shadowed": return m.shadowed(s.link, s.shadowedBy);
    case "stale": return m.stale(s.link, s.target, s.expected);
    case "foreign": return m.foreign(s.link, kindText(s.foreignKind, language));
    case "check_failed": return m.checkFailed(s.link, s.reason);
  }
}
