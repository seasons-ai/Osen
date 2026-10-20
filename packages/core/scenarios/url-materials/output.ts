// Link-source rows printed by `council resume`: `  <id> ← <safe address> · <localized label> <fetchedAt>` (cli.ts + formatSource).
// The stand compares the whole fields with the saved sidecar instead of searching stdout for a URL substring
// (CodeQL js/incomplete-url-substring-sanitization). A line with ` ← ` that does not have this shape yields empty
// fields, so it never equals an expected source and still counts as a row.
export type SourceRow = { id: string; url: string; fetchedAt: string };

export const sourceRows = (out: string): SourceRow[] =>
  out.split("\n").filter((line) => line.includes(" ← ")).map((line) => {
    const m = /^ {2}(m[1-9]\d*) ← (\S+) · \S+ (\S+)$/.exec(line);
    return m ? { id: m[1]!, url: m[2]!, fetchedAt: m[3]! } : { id: "", url: "", fetchedAt: "" };
  });

// The stand's resume oracle: stdout has exactly one source row, and its fields are the saved ones.
export const assertResumedSource = (out: string, saved: SourceRow): void => {
  const rows = sourceRows(out);
  const [row] = rows;
  if (rows.length !== 1 || row!.id !== saved.id || row!.url !== saved.url || row!.fetchedAt !== saved.fetchedAt) {
    throw new Error(`expected the single source row ${JSON.stringify(saved)}, got ${JSON.stringify(rows)}`);
  }
};
