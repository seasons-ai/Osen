import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSource, ROOT, visitAst, walk } from "./ast-scan.testutil.ts";
import type { Node } from "./ast-scan.testutil.ts";

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

describe("core and mcp stay free of Electron", () => {
  it("packages/core/src and packages/mcp/src import neither electron nor apps/desktop", () => {
    const bad: string[] = [];
    for (const dir of ["packages/core/src", "packages/mcp/src"]) {
      for (const file of walk(join(ROOT, dir))) {
        for (const s of specifiers(readFileSync(file, "utf8"))) {
          if (s === "electron" || s.startsWith("electron/") || /(^|\/)apps\/desktop(\/|$)/.test(s)) bad.push(`${file}: ${s}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
