// Stand-only helper: writes a `#!/bin/sh` stub of the `claude` CLI. It never calls a model.
// --version prints "<version> (Claude Code)", --help prints the real help fixture, a turn appends the
// named variables to $COUNCIL_PIN_ENV_LOG, bumps <counter>.turn and answers with a valid "amend" reply (the first turn only accepts amend).
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VerifiedEntry } from "../../src/cli-agents/verified-record.ts";

export const HELP_FIXTURE = join(import.meta.dirname, "../../src/cli-agents/fixtures/claude-2.1.288-help.txt");
const REPLY = { stance: "amend", reasoning: "The stub proposes.", solution: "Use the stub.", answers: [], questions: [] };
const RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(REPLY), usage: { input_tokens: 1, output_tokens: 1 } });

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** counter: base path; the stub appends one line to <counter>.version, <counter>.help or <counter>.turn per launch. */
export function writeStub(file: string, o: { version: string; counter: string; agent?: string }): void {
  const script = `#!/bin/sh
C=${q(o.counter)}
case "$1" in
  --version) echo x >> "$C.version"; echo ${q(`${o.version} (Claude Code)`)} ;;
  --help) echo x >> "$C.help"; cat ${q(HELP_FIXTURE)} ;;
  *)
    cat > /dev/null
    echo x >> "$C.turn"
    if [ -n "$COUNCIL_PIN_ENV_LOG" ]; then
      {
        echo "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR"
        echo "DISABLE_AUTOUPDATER=$DISABLE_AUTOUPDATER"
        echo "DISABLE_UPDATES=$DISABLE_UPDATES"
        echo "CODEX_HOME=$CODEX_HOME"
        echo "COUNCIL_PARTICIPANT=$COUNCIL_PARTICIPANT"
        echo "---"
      } >> "$COUNCIL_PIN_ENV_LOG"
    fi
    printf '%s\\n' ${q(RESULT)}
    ;;
esac
`;
  writeFileSync(file, script);
  chmodSync(file, 0o755);
}

const base = { checkedAt: "2026-10-20", os: "darwin-arm64", osenVersion: "1.0.0" };
/** The substitute verified-versions record: passed to `cli` commands by council-test.ts and written to <data>/cli-verified.json by check.ts. */
export const STAND_ENTRIES: VerifiedEntry[] = [
  { agent: "claude", version: "1.0.0", level: "real", modelCalls: 2, ...base },
  { agent: "claude", version: "1.1.0", level: "real", modelCalls: 2, ...base },
  { agent: "claude", version: "2.0.0", level: "interface", ...base },
  { agent: "codex", version: "1.0.0", level: "real", modelCalls: 2, ...base },
  { agent: "codex", version: "1.1.0", level: "real", modelCalls: 2, ...base },
];

/** Writes the substitute record into a data folder so discovery and the pre-turn check see the same record as `cli` commands. */
export function writeStandRecord(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "cli-verified.json"), `${JSON.stringify({ schemaVersion: 1, entries: STAND_ENTRIES }, null, 2)}\n`);
}

const FIXTURES = join(import.meta.dirname, "../../src/cli-agents/fixtures");
/** Stub of `codex`: --version prints "codex-cli <version>"; every other call appends its full argument line to argsLog and prints the help or features fixture. */
export function writeCodexStub(file: string, o: { version: string; counter: string; argsLog: string }): void {
  const script = `#!/bin/sh
case "$1" in
  --version) echo x >> ${q(`${o.counter}.version`)}; echo ${q(`codex-cli ${o.version}`)} ;;
  *)
    echo "$*" >> ${q(o.argsLog)}
    case "$1" in
      exec) cat ${q(join(FIXTURES, "codex-0.159.2-exec-help.txt"))} ;;
      features) cat ${q(join(FIXTURES, "codex-0.159.2-features.txt"))} ;;
    esac
    ;;
esac
`;
  writeFileSync(file, script);
  chmodSync(file, 0o755);
}
