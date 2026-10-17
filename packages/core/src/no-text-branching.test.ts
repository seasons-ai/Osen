import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseSource, ROOT, visitAst, walk } from "./ast-scan.testutil.ts";
import type { Node } from "./ast-scan.testutil.ts";

const CYR = /[А-Яа-яЁё]/;
const METHODS = new Set(["includes", "startsWith", "endsWith", "indexOf", "match", "search", "test"]);
const CMP = new Set(["===", "!==", "==", "!="]);

function hasCyrLiteral(n: unknown): boolean {
  const x = n as Node | null;
  if (!x) return false;
  if (x.type === "StringLiteral") return CYR.test(x.value as string);
  if (x.type === "RegExpLiteral") return CYR.test(x.pattern as string);
  if (x.type === "TemplateLiteral") return (x.quasis as { value: { raw: string } }[]).some((q) => CYR.test(q.value.raw));
  return false;
}

// Names of constants whose initializer is a Cyrillic literal (template without substitutions).
export function collectCyrConstants(sourceText: string): Set<string> {
  const names = new Set<string>();
  visitAst(parseSource(sourceText), (n) => {
    const id = n.id as Node | undefined;
    const init = n.init as Node | undefined;
    if (n.type === "VariableDeclarator" && id?.type === "Identifier" && init && (init.type === "StringLiteral" || (init.type === "TemplateLiteral" && (init.expressions as unknown[]).length === 0)) && hasCyrLiteral(init)) {
      names.add(id.name as string);
    }
  });
  return names;
}

export interface Finding { file: string; line: number | undefined; what: string; name: string | null }

// Decision by natural-language text: comparison with a Cyrillic literal or with a constant from `consts`, case, substring search methods.
// ponytail: constants are matched by name without resolving imports; same-named constants in different files give a false finding (then an exception in ALLOWED).
export function findTextBranching(fileName: string, sourceText: string, consts: Set<string> = new Set()): Finding[] {
  const found: Finding[] = [];
  const constName = (x: unknown): string | null => {
    const n = x as Node | null;
    return n?.type === "Identifier" && consts.has(n.name as string) ? (n.name as string) : null;
  };
  const text = (x: unknown) => hasCyrLiteral(x) || constName(x) !== null;
  const add = (n: Node, what: string, ...ops: unknown[]) =>
    found.push({ file: fileName, line: n.loc?.start.line, what, name: ops.map(constName).find((v) => v !== null) ?? null });
  visitAst(parseSource(sourceText), (n) => {
    if (n.type === "BinaryExpression" && CMP.has(n.operator as string) && (text(n.left) || text(n.right))) add(n, "сравнение с текстом", n.left, n.right);
    if (n.type === "SwitchCase" && text(n.test)) add(n, "case с текстом", n.test);
    const c = n.callee as Node | undefined;
    if (n.type === "CallExpression" && c?.type === "MemberExpression" && !c.computed && (c.property as Node).type === "Identifier"
      && METHODS.has((c.property as { name: string }).name) && (text(c.object) || (n.arguments as unknown[]).some(text))) {
      add(n, `${(c.property as { name: string }).name} с текстом`, c.object, ...(n.arguments as unknown[]));
    }
  });
  return found;
}

// Known places. Key: "<path from root>#<constant name>" (matched by name); value — justification.
const ALLOWED: Record<string, string> = {};

describe("Refusal codes and identifiers do not depend on the language: no text matching", () => {
  it("the search finds every text match in the built-in sample", () => {
    const sample = `
      if (r === "Сбой") {}
      if ("Сбой" != r) {}
      if (r == \`Сбой\`) {}
      switch (r) { case "Сбой": break; }
      msg.includes("сбой"); msg.startsWith("Сбой"); msg.endsWith("сбой"); msg.indexOf("сбой");
      msg.match(/сбой/); msg.search(/сбой/); /сбой/.test(msg);
    `;
    expect(findTextBranching("sample.ts", sample)).toHaveLength(11);
    const withConst = `
      export const HINT = "Обновите.";
      const OK = "fine";
      if (r === HINT) {}
      switch (r) { case HINT: break; }
      msg.includes(HINT); HINT.startsWith(x); msg.endsWith(OK); r === OK;
    `;
    const consts = collectCyrConstants(withConst);
    expect([...consts]).toEqual(["HINT"]);
    const hits = findTextBranching("c.ts", withConst, consts);
    expect(hits).toHaveLength(4);
    expect(hits.every((h) => h.name === "HINT")).toBe(true);
    expect(findTextBranching("ok.ts", `if (r === "fail") {} msg.includes("x"); const t = "Сбой";`)).toEqual([]);
  });

  it("no findings outside the list in packages/core, packages/mcp and apps/desktop", () => {
    const files = ["packages/core/src", "packages/mcp/src", "apps/desktop/src"].flatMap((dir) => walk(join(ROOT, dir)));
    const sources = files.map((f) => ({ rel: relative(ROOT, f), text: readFileSync(f, "utf8") }));
    const consts = new Set<string>();
    for (const { text } of sources) for (const name of collectCyrConstants(text)) consts.add(name);
    const hits: string[] = [];
    for (const { rel, text } of sources) {
      for (const h of findTextBranching(rel, text, consts)) {
        if (h.name !== null && `${rel}#${h.name}` in ALLOWED) continue;
        hits.push(`${h.file}:${h.line}: ${h.what}${h.name ? ` (${h.name})` : ""}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
