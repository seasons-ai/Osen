// Stand-only helper: writes a `#!/bin/sh` stub of the `claude` CLI. It never calls a model.
// --version prints "<version> (Claude Code)", --help prints the real help fixture, a turn appends the
// named variables to $COUNCIL_PIN_ENV_LOG, bumps <counter>.turn and answers with a valid "amend" reply (the first turn only accepts amend).
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
