import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSource, ROOT, visitAst, walk } from "../../core/src/ast-scan.testutil.ts";
import type { Node } from "../../core/src/ast-scan.testutil.ts";

// Specifiers of import/export-from, require() and import() in a file.
function specifiers(text: string): string[] {
  const out: string[] = [];
  visitAst(parseSource(text), (n: Node) => {
    if ((n.type === "ImportDeclaration" || n.type === "ExportAllDeclaration" || n.type === "ExportNamedDeclaration") && n["source"]) out.push((n["source"] as { value: string }).value);
    const callee = n["callee"] as Node | undefined;
    const arg = (n["arguments"] as Node[] | undefined)?.[0];
    if (n.type === "CallExpression" && callee && (callee.type === "Import" || (callee.type === "Identifier" && callee["name"] === "require")) && arg?.type === "StringLiteral") out.push(arg["value"] as string);
  });
  return out;
}

const forbidden = (s: string): boolean =>
  s === "electron" || s.startsWith("electron/") || s.startsWith("@modelcontextprotocol/") || s.startsWith("@model-council/mcp") || /(^|\/)packages\/mcp(\/|$)/.test(s) || /(^|\/)apps\/desktop(\/|$)/.test(s);

describe("connect stays free of Electron, MCP and desktop", () => {
  it("packages/connect/src imports none of them", () => {
    const bad: string[] = [];
    for (const file of walk(join(ROOT, "packages/connect/src"))) {
      for (const s of specifiers(readFileSync(file, "utf8"))) if (forbidden(s)) bad.push(`${file}: ${s}`);
    }
    expect(bad).toEqual([]);
  });
});
