import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "@babel/parser";

// Shared helpers for checks over the parse tree. ponytail: TypeScript 7 at the root has no JS API, so parsing goes through @babel/parser from node_modules.
export type Node = { type: string; loc?: { start: { line: number } }; [k: string]: unknown };

export const ROOT = resolve(import.meta.dirname, "../../..");

// Working .ts/.tsx files without tests, test utilities, node_modules and testdata.
export function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "testdata") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.(test|testutil)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

export function parseSource(sourceText: string): Node {
  return parse(sourceText, { sourceType: "module", plugins: ["typescript", "jsx"], errorRecovery: true }).program as unknown as Node;
}

// Tree walk: the function receives a node and its chain of ancestors (from the root).
export function visitAst(root: unknown, fn: (n: Node, ancestors: Node[]) => void): void {
  const go = (v: unknown, anc: Node[]): void => {
    if (Array.isArray(v)) return v.forEach((x) => go(x, anc));
    if (!v || typeof v !== "object") return;
    const n = v as Node;
    const isNode = typeof n.type === "string";
    if (isNode) fn(n, anc);
    const next = isNode ? [...anc, n] : anc;
    for (const [k, x] of Object.entries(n)) if (k !== "loc" && k !== "extra") go(x, next);
  };
  go(root, []);
}

const CYR = /[А-Яа-яЁё]/;
const isLogObject = (o: Node | undefined): boolean =>
  !!o && ((o.type === "Identifier" && (o.name === "logger" || o.name === "log"))
    || (o.type === "MemberExpression" && (o.property as Node).type === "Identifier" && (o.property as { name: string }).name === "logger"));

// Finds string, template and regex literals and JSX text containing Cyrillic; comments are not considered.
export function findCyrillicLiterals(fileName: string, sourceText: string): string[] {
  const found: string[] = [];
  visitAst(parseSource(sourceText), (n, anc) => {
    let text: string | null = null;
    if (n.type === "StringLiteral" || n.type === "DirectiveLiteral") text = n.value as string;
    else if (n.type === "RegExpLiteral") text = n.pattern as string;
    else if (n.type === "JSXText") text = n.value as string;
    else if (n.type === "TemplateElement") text = (n.value as { raw: string }).raw;
    if (text === null || !CYR.test(text)) return;
    for (const a of anc) {
      const callee = a.callee as Node | undefined;
      if ((a.type === "CallExpression" || a.type === "OptionalCallExpression") && callee
        && (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") && isLogObject(callee.object as Node)) return;
    }
    found.push(`${fileName}:${n.loc?.start.line}: ${text.trim().slice(0, 80)}`);
  });
  return found;
}
