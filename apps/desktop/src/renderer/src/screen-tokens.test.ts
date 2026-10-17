import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// visual-design "Named style variables": a px number equal to a variable of the same kind from tokens.css is written as the variable.
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const cssIn = (dir: string) => readdirSync(join(root, dir)).filter((name) => name.endsWith(".css")).map((name) => `${dir}/${name}`);

const styles = [
  ...cssIn("design/mockup/screens"),
  "design/mockup/components.css",
  "design/mockup-osen/brand/components-osen.css",
  ...cssIn("apps/desktop/src/renderer/src"),
];

const tokensCss = read("design/mockup-osen/brand/tokens.css");
const values = (kind: string) => new Set([...tokensCss.matchAll(new RegExp(`--${kind}-[a-z0-9-]+:\\s*(\\d+(?:\\.\\d+)?)px`, "g"))].map((m) => Number(m[1])));
const kinds: [RegExp, Set<number>][] = [
  [/^font-size$/, values("fs")],
  [/^(padding|margin)(-[a-z-]+)?$|^(row-|column-)?gap$/, values("sp")],
  [/^border(-[a-z]+)*-radius$/, values("r")],
];

function violations(path: string): string[] {
  const found: string[] = [];
  for (const m of read(path).replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const decl of m[2]!.split(";")) {
      const i = decl.indexOf(":");
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim(), value = decl.slice(i + 1).trim();
      const tokens = kinds.find(([re]) => re.test(prop))?.[1];
      if (!tokens) continue;
      for (const px of value.matchAll(/(?<![\w.-])(\d+(?:\.\d+)?)px/g)) {
        if (tokens.has(Number(px[1]))) found.push(`${path}: ${m[1]!.trim()} { ${prop}:${value} }`);
      }
    }
  }
  return [...new Set(found)];
}

describe("font size and indent — through variables", () => {
  it("values of --fs-*, --sp-*, --r-* are parsed from tokens.css", () => {
    for (const [, set] of kinds) expect(set.size).toBeGreaterThan(0);
  });

  it.each(styles)("%s: no px number equal to a variable of the same kind", (path) => {
    expect(violations(path)).toEqual([]);
  });
});
