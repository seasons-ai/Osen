// Stand-only helper: wraps a CLI stub so that every launch (version, help, features list, turn) appends one line
// `<agent>\t<argv>\t<names of the environment variables>` to a log. Names only, never values.
import { chmodSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** Writes `exe`, a sh wrapper that logs the launch and runs the sibling file `real` (a base name) with the same arguments and stdin. */
export function writeLoggingWrapper(exe: string, real: string, agent: string, log: string): void {
  // one write per launch: parallel launches must not interleave their lines
  writeFileSync(exe, `#!/bin/sh
args=$(printf '%s' "$*" | tr '\\n\\t' '  ')
names=$(env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p' | tr '\\n' ' ')
printf '%s\\t%s\\t%s\\n' ${q(agent)} "$args" "$names" >> ${q(log)}
exec "$(dirname "$0")/${basename(real)}" "$@"
`);
  chmodSync(exe, 0o755);
}

export interface LaunchRecord { agent: string; args: string; names: string[]; kind: "version" | "help" | "features" | "turn" }

export function parseLog(text: string): LaunchRecord[] {
  return text.split("\n").filter(Boolean).map((line) => {
    const [agent = "", args = "", names = ""] = line.split("\t");
    const kind = args.startsWith("--version") ? "version" : /^(exec )?--help/.test(args) ? "help" : args.startsWith("features") ? "features" : "turn";
    return { agent, args, names: names.split(" ").filter(Boolean), kind };
  });
}
