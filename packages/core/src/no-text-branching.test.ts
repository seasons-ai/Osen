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

// A message catalog: a call `xxxMessages()` or a variable initialized with one (`const m = resumeMessages()`).
// Bindings are scoped: `m` of a nested function or block (`(m) => m.id`) shadows the catalog `m`; the innermost binding around a use decides.
const CATALOG = /Messages$/;
const isCatalogCall = (x: unknown) => {
  const n = x as Node | null;
  return n?.type === "CallExpression" && (n.callee as Node).type === "Identifier" && CATALOG.test((n.callee as { name: string }).name);
};
type Span = { start: number; end: number };
type Binding = Span & { name: string; catalog: boolean };
const SCOPES = new Set(["Program", "BlockStatement", "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "CatchClause", "ForStatement", "ForOfStatement", "ForInStatement"]);
const FUNCS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "CatchClause"]);
function patternNames(x: unknown, out: string[] = []): string[] {
  const n = x as Node | null;
  if (!n) return out;
  if (n.type === "Identifier") out.push(n.name as string);
  else if (n.type === "ObjectPattern") for (const p of n.properties as Node[]) patternNames(p.type === "RestElement" ? p.argument : p.value, out);
  else if (n.type === "ArrayPattern") for (const e of n.elements as Node[]) patternNames(e, out);
  else if (n.type === "AssignmentPattern") patternNames(n.left, out);
  else if (n.type === "RestElement") patternNames(n.argument, out);
  else if (n.type === "TSParameterProperty") patternNames(n.parameter, out);
  return out;
}
function bindings(ast: Node): Binding[] {
  const out: Binding[] = [];
  const span = (n: Node) => ({ start: n.start as number, end: n.end as number });
  visitAst(ast, (n, anc) => {
    if (FUNCS.has(n.type)) {
      for (const name of patternNames(n.param)) out.push({ name, catalog: false, ...span(n) });
      for (const p of (n.params as Node[] | undefined) ?? []) for (const name of patternNames(p)) out.push({ name, catalog: false, ...span(n) });
    }
    if (n.type === "VariableDeclarator") {
      const scope = [...anc].reverse().find((a) => SCOPES.has(a.type))!;
      for (const name of patternNames(n.id)) out.push({ name, catalog: (n.id as Node).type === "Identifier" && isCatalogCall(n.init), ...span(scope) });
    }
  });
  return out;
}
// A text taken from a catalog: `xxxMessages().field`, `xxxMessages().field(...)`, `m.field`, `m.field(...)`. Returns the field name.
function catalogField(x: unknown, scope: Binding[]): string | null {
  const n = x as Node | null;
  if (n?.type === "CallExpression") return catalogField(n.callee, scope);
  if (n?.type !== "MemberExpression" || n.computed) return null;
  const o = n.object as Node;
  const field = (n.property as { name: string }).name;
  if (isCatalogCall(o)) return field;
  if (o.type !== "Identifier") return null;
  const at = o.start as number;
  const inner = scope.filter((b) => b.name === o.name && b.start <= at && at < b.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
  return inner?.catalog ? field : null;
}

export interface Finding { file: string; line: number | undefined; what: string; name: string | null }

// Decision by natural-language text: comparison with a Cyrillic literal, a constant from `consts` or a catalog text, case, substring search methods.
// ponytail: constants are matched by name without resolving imports; same-named constants in different files give a false finding (then an exception in ALLOWED).
export function findTextBranching(fileName: string, sourceText: string, consts: Set<string> = new Set()): Finding[] {
  const found: Finding[] = [];
  const constName = (x: unknown): string | null => {
    const n = x as Node | null;
    return n?.type === "Identifier" && consts.has(n.name as string) ? (n.name as string) : null;
  };
  const ast = parseSource(sourceText);
  const scope = bindings(ast);
  const named = (x: unknown) => constName(x) ?? catalogField(x, scope);
  const text = (x: unknown) => hasCyrLiteral(x) || named(x) !== null;
  const add = (n: Node, what: string, ...ops: unknown[]) =>
    found.push({ file: fileName, line: n.loc?.start.line, what, name: ops.map(named).find((v) => v !== null) ?? null });
  visitAst(ast, (n) => {
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

// Known places. Key: "<path from root>#<constant name or catalog field>" (matched by name); value — justification.
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
    const catalog = `
      const m = resumeMessages();
      if (e.message === resumeMessages().journalChanged(id)) {}
      if (resumeMessages().busy !== e.message) {}
      if (e.message == m.journalChanged(id)) {}
      switch (e.message) { case m.busy: break; }
      msg.includes(cliMessages().failed);
    `;
    expect(findTextBranching("cat.ts", catalog).map((h) => h.line)).toEqual([3, 4, 5, 6, 7]);
    expect(findTextBranching("cat.ts", catalog).map((h) => h.name)).toEqual(["journalChanged", "busy", "journalChanged", "busy", "failed"]);
    const ok = `
      const m = resumeMessages();
      if (e.reason === "busy") {} const x = m.busy; io.stderr(m.journalChanged(id)); if (n.journalChanged(id) === y) {}
      list.some((m) => m.requestId === id);
      function f(m: Item) { return m.id !== x; }
      { const m = other(); if (m.text === y) {} }
      for (const m of items) if (m.name === y) {}
      const g = ({ m }: { m: Item }) => m.id === y;
    `;
    expect(findTextBranching("cat-ok.ts", ok)).toEqual([]);
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
