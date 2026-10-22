// Stand-only helper: writes a `#!/bin/sh` stub of the `claude` or `codex` CLI. It never calls a model.
// Every launch (including --version and --help) appends a line to <mark>, so an empty mark file proves the binary never ran.
// A turn also appends a line to <mark>.turn.
// Side files (outside the pinned folder, so they do not change the file checksum): <side>.ver replaces the reported version,
// <side>.help replaces the help text, <side>.swap makes a turn append a byte to the stub itself after answering,
// <side>.hook is a shell script a turn runs before answering (the stand uses it to break pins.json in the middle of a session).
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fixtures = join(import.meta.dirname, "../../src/cli-agents/fixtures");
export const CLAUDE_HELP = join(fixtures, "claude-2.1.288-help.txt");
export const CODEX_HELP = join(fixtures, "codex-0.159.2-exec-help.txt");
const CODEX_FEATURES = join(fixtures, "codex-0.159.2-features.txt");
const REPLY = { stance: "amend", reasoning: "The stub proposes.", solution: "Use the stub.", answers: [], questions: [] };
const CLAUDE_RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(REPLY), usage: { input_tokens: 1, output_tokens: 1 } });
const CODEX_ITEM = JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text: JSON.stringify({ ...REPLY, stance: "agree", solution: null }) } });
const CODEX_DONE = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export function writeStub(file: string, o: { agent: "claude" | "codex"; version: string; mark: string; side: string }): void {
  const swap = `echo x >> ${q(`${o.mark}.turn`)}; if [ -e ${q(`${o.side}.swap`)} ]; then printf '#' >> "$0"; fi; if [ -e ${q(`${o.side}.hook`)} ]; then sh ${q(`${o.side}.hook`)}; fi`;
  const body = o.agent === "claude"
    ? `case "$1" in
  --version) echo "$(ver) (Claude Code)" ;;
  --help) help ${q(CLAUDE_HELP)} ;;
  *)
    read -r line
    case "$line" in
      *control_request*)
        id=$(printf '%s' "$line" | sed 's/.*"request_id":"\\([^"]*\\)".*/\\1/')
        printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"models":[{"value":"default"},{"value":"sonnet"}]}}}\\n' "$id"
        exit 0 ;;
    esac
    cat > /dev/null; ${swap}; printf '%s\\n' ${q(CLAUDE_RESULT)} ;;
esac`
    : `case "$1" in
  --version) echo "codex-cli $(ver)" ;;
  exec) if [ "$2" = "--help" ]; then help ${q(CODEX_HELP)}; else cat > /dev/null; ${swap}; printf '%s\\n%s\\n' ${q(CODEX_ITEM)} ${q(CODEX_DONE)}; fi ;;
  features) cat ${q(CODEX_FEATURES)} ;;
  *) exit 2 ;;
esac`;
  writeFileSync(file, `#!/bin/sh
echo x >> ${q(o.mark)}
ver() { if [ -e ${q(`${o.side}.ver`)} ]; then cat ${q(`${o.side}.ver`)}; else echo ${q(o.version)}; fi; }
help() { if [ -e ${q(`${o.side}.help`)} ]; then cat ${q(`${o.side}.help`)}; else cat "$1"; fi; }
${body}
exit 0
`);
  chmodSync(file, 0o755);
}

/** Number of launches recorded in a mark file. */
export const launches = (mark: string): number => {
  try { return readFileSync(mark, "utf8").split("\n").filter(Boolean).length; } catch { return 0; }
};
