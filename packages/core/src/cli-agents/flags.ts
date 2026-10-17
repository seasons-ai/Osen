// Flag declaration: a line indented by up to 6 spaces, `[-x, ]--name[, --name2]`. Descriptions and continuations are indented deeper.
const DECLARATION = /^ {2,6}(?:-\w, )?(--[\w-]+)(?:, (--[\w-]+))?/;

/** Long flags (`--name`) declared on their own help line. */
export function declaredFlags(help: string): Set<string> {
  const flags = new Set<string>();
  for (const line of help.split(/\r?\n/)) {
    const m = DECLARATION.exec(line);
    if (m) for (const flag of m.slice(1)) if (flag) flags.add(flag);
  }
  return flags;
}

/** Capability names from `codex features list`, except the removed stage. */
export function parseCodexFeatures(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+)\s+(.+?)\s+(?:true|false)\s*$/.exec(line);
    if (m && m[2] !== "removed") names.add(m[1]!);
  }
  return names;
}
