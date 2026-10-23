import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkExecutable } from "../executable.testutil.ts";
import { declaredFlags, parseCodexFeatures } from "./flags.ts";
import type { CliAgent, CliRuntime } from "./types.ts";

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const claudeFlags = declaredFlags(fx("claude-2.1.288-help.txt"));
const codexFlags = declaredFlags(fx("codex-0.159.2-exec-help.txt"));
const codexFeatures = parseCodexFeatures(fx("codex-0.159.2-features.txt"));

export interface Stub { runtime: CliRuntime; proto: (name: string) => string; has: (name: string) => boolean }

/** Roots of the stubs created so far; `cleanupStubs` removes them. */
export const stubRoots: string[] = [];
export function cleanupStubs(): void {
  for (const r of stubRoots.splice(0)) rmSync(r, { recursive: true, force: true });
}

/** CLI stub: writes the launch protocol to its own folder, prints the prepared output. */
export function stub(
  agent: CliAgent,
  o: { stdout?: string | Buffer; stderr?: string; code?: number; sleep?: number; flags?: Set<string>; child?: boolean | "ignores-term" } = {},
): Stub {
  const root = mkdtempSync(join(tmpdir(), "stub-"));
  stubRoots.push(root);
  writeFileSync(join(root, "out"), o.stdout ?? "");
  writeFileSync(join(root, "err"), o.stderr ?? "");
  const sh = `#!/bin/sh
D="$(dirname "$0")"; P="$D/proto"; mkdir -p "$P"
echo $$ > "$P/pid"
: > "$P/args"; for a in "$@"; do printf '%s\\n' "$a" >> "$P/args"; done
cat > "$P/stdin"
printf '%s' "$COUNCIL_PARTICIPANT" > "$P/cp"
printf '%s\\n' "COUNCIL_PARTICIPANT=$COUNCIL_PARTICIPANT" "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR" "DISABLE_AUTOUPDATER=$DISABLE_AUTOUPDATER" "DISABLE_UPDATES=$DISABLE_UPDATES" "CODEX_HOME=$CODEX_HOME" > "$P/pinvars"
printf '%s' "\${COUNCIL_TEST_MARKER-unset}" > "$P/marker"
pwd > "$P/pwd"; ls -A > "$P/ls"
prev=""; for a in "$@"; do [ "$prev" = "--output-schema" ] && cat "$a" > "$P/schema"; prev="$a"; done
${o.child === "ignores-term" ? `C="$P/child" sh -c 'trap "" TERM; echo $$ > "$C"; exec sleep 30' >/dev/null 2>&1 &` : o.child ? 'sleep 30 >/dev/null 2>&1 & echo $! > "$P/child"' : ""}
${o.sleep ? `sleep ${o.sleep}` : ""}
cat "$D/out"; cat "$D/err" >&2
exit ${o.code ?? 0}
`;
  const path = linkExecutable(join(root, "stub.sh"), sh);
  const runtime: CliRuntime = {
    agent, path, env: { PATH: process.env.PATH },
    flags: o.flags ?? (agent === "claude" ? claudeFlags : codexFlags),
    ...(agent === "codex" ? { features: codexFeatures } : {}),
  };
  const proto = (name: string) => join(root, "proto", name);
  return { runtime, proto, has: (name) => existsSync(proto(name)) };
}
