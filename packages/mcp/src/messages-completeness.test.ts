import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { findCyrillicLiterals, parseSource, ROOT, visitAst, walk } from "../../core/src/ast-scan.testutil.ts";
import type { Node } from "../../core/src/ast-scan.testutil.ts";

// Files entirely excluded from the check (paths relative to packages/mcp/src).
const SKIP_FILES: Record<string, string> = {
  "messages.ts": "каталог сообщений: значения ru",
};
// Individual literals excluded from the check: file and full text of the found line (after "file:line: ").
const SKIP_LITERALS: { file: string; text: string; why: string }[] = [
  { file: "main.ts", text: "stdin закрыт", why: "строки журнала: аргумент quit() уходит только в logger.info" },
];

// The second argument of new ToolError(...) is logText, a log line: its text is blanked with spaces (line numbers are preserved).
export function blankToolErrorLogText(source: string): string {
  const spans: [number, number][] = [];
  visitAst(parseSource(source), (n) => {
    const callee = n.callee as Node | undefined;
    const args = n.arguments as (Node & { start: number; end: number })[] | undefined;
    if (n.type === "NewExpression" && callee?.type === "Identifier" && callee["name"] === "ToolError" && args && args.length > 1) spans.push([args[1]!.start, args[1]!.end]);
  });
  let out = source;
  for (const [a, b] of spans) out = out.slice(0, a) + out.slice(a, b).replace(/[^\n]/g, " ") + out.slice(b);
  return out;
}

describe("MCP server texts in the process language: completeness", () => {
  it("packages/mcp/src has no Cyrillic literals outside the exclusion list", () => {
    const base = join(ROOT, "packages/mcp/src");
    const hits: string[] = [];
    for (const file of walk(base)) {
      const rel = relative(base, file);
      if (rel in SKIP_FILES) continue;
      hits.push(...findCyrillicLiterals(rel, blankToolErrorLogText(readFileSync(file, "utf8"))).filter((h) => !SKIP_LITERALS.some((s) => h.startsWith(`${s.file}:`) && h.endsWith(`: ${s.text}`))));
    }
    expect(hits).toEqual([]);
  });

  it("Russian text in the first argument of ToolError and in a literal next to logText is caught", () => {
    const bad = "throw new ToolError(`Продолжение сессии ${id}: тест`);";
    expect(findCyrillicLiterals("resume.ts", blankToolErrorLogText(bad)).length).toBeGreaterThan(0);
    const ok = "throw new ToolError(m.text, `Продолжение сессии ${id} отклонено`);";
    expect(findCyrillicLiterals("resume.ts", blankToolErrorLogText(ok))).toEqual([]);
  });
});
