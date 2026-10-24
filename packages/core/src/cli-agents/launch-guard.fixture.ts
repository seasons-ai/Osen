import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detachExecutable, linkExecutable } from "../executable.testutil.ts";
import { activePin, installPin, usePin } from "./pins.ts";
import type { PackageSource } from "./pins.ts";
import type { VerifiedEntry, VerifiedRecord } from "./verified-record.ts";

export const realEntry = (version: string, agent: "claude" | "codex" = "claude"): VerifiedEntry =>
  ({ agent, version, level: "real", checkedAt: "2026-10-20", os: "darwin-arm64", osenVersion: "1.0.0", modelCalls: 2 });
export const ifaceEntry = (version: string, agent: "claude" | "codex" = "claude"): VerifiedEntry =>
  ({ agent, version, level: "interface", checkedAt: "2026-10-20", os: "darwin-arm64", osenVersion: "1.0.0" });

export const claudeTurn = (stance: string, solution: string | null) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "x", structured_output: { stance, reasoning: "r", solution, answers: [], questions: [] }, usage: { input_tokens: 5, output_tokens: 2 } });

/**
 * Stub CLI: every run appends a line to `<binary>.runs`; `--version` prints the contents of `<binary>.version`, a turn prints `turn`.
 * The text does not depend on the version, so all installs share one linked file; `_version` is kept for callers that restore a binary.
 */
export const stubScript = (_version: string, turn = claudeTurn("agree", null)) =>
  `#!/bin/sh\necho run >> "$0.runs"\ncase "$1" in --version) /bin/cat "$0.version"; exit 0;; esac\ncat > /dev/null\nprintf '%s' '${turn}'\n`;

export function fetchSource(turn?: string): PackageSource {
  return {
    async fetch(agent, version, dir) {
      const exe = join(dir, "bin", agent);
      mkdirSync(join(dir, "bin"), { recursive: true });
      linkExecutable(exe, stubScript(version, turn));
      writeFileSync(`${exe}.version`, `${version} (Claude Code)\n`);
      return { executable: exe, source: `fake:${agent}@${version}` };
    },
  };
}

/** Installs `version`, makes it the active pin of claude and returns its binary path (run counter reset). */
export async function installStub(dataDir: string, version: string, record: VerifiedRecord, turn?: string): Promise<string> {
  const r = await installPin(dataDir, "claude", { version }, { source: fetchSource(turn), record });
  if (!r.ok) throw new Error(r.text);
  const u = usePin(dataDir, "claude", version, { record });
  if (!u.ok) throw new Error(u.text);
  const a = activePin(dataDir, "claude");
  if (a.state !== "pin") throw new Error("no active pin");
  rmSync(`${a.path}.runs`, { force: true });
  return a.path;
}

export const runs = (binary: string): number => (existsSync(`${binary}.runs`) ? readFileSync(`${binary}.runs`, "utf8").trim().split("\n").length : 0);
/** Changes the content of the binary and keeps its mode, so only the checksum tells it apart (detached first: installs are shared hard links). */
export const tamper = (binary: string): void => {
  detachExecutable(binary);
  appendFileSync(binary, "# tampered\n");
};
