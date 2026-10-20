// Sources named by a link-refusal diagnostic: each line is `«<safe address>»: <reason>` (core collectUrlMaterials).
// The stand compares the whole address field instead of searching the prose for a URL substring (CodeQL js/incomplete-url-substring-sanitization).
// A line without the field yields "", so it never equals an expected source.
export const refusalSources = (diagnostic: string): string[] =>
  diagnostic.split("\n").map((line) => /^«([^»]*)»: /.exec(line)?.[1] ?? "");

// The stand's 404 oracle: the refusal names exactly one source, and it is `expected`.
export const assertNamesSource = (diagnostic: string, expected: string): void => {
  const found = refusalSources(diagnostic);
  if (found.length !== 1 || found[0] !== expected) throw new Error(`expected the single source «${expected}», got ${JSON.stringify(found)}: ${diagnostic}`);
};
