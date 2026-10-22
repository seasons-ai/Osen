import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..", "..", "..");

function walk(dir: string, out: string[]): void {
  let names: import("node:fs").Dirent[];
  try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of names) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
}

function sources(): string[] {
  const files: string[] = [];
  for (const group of ["packages"]) for (const pkg of readdirSync(join(root, group))) {
    walk(join(root, group, pkg, "src"), files);
    walk(join(root, group, pkg, "scenarios"), files);
  }
  for (const d of ["apps/desktop/src", "apps/desktop/scenarios", "apps/desktop/scripts", "skill"]) walk(join(root, d), files);
  return files;
}

const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

function importers(target: (spec: string, from: string) => boolean): string[] {
  const hits: string[] = [];
  for (const file of sources()) {
    // type-only imports are erased at build time and load nothing
    const text = readFileSync(file, "utf8").replace(/\b(?:import|export)\s+type\b[^;]*?from\s*["'][^"']+["']/gs, "");
    for (const m of text.matchAll(SPEC)) if (target(m[1]!, file)) { hits.push(relative(root, file)); break; }
  }
  return hits.sort();
}

const imports = (path: string) => (spec: string, from: string): boolean =>
  spec.startsWith(".") && resolve(dirname(from), spec) === join(root, path);

describe("parse5 import boundary", () => {
  it("only url/html-text.ts imports parse5", () => {
    expect(importers((s) => s === "parse5" || s.startsWith("parse5/"))).toEqual(["packages/core/src/url/html-text.ts"]);
  });
  it("url/html-text.ts is imported by epub.ts and html-worker.ts only", () => {
    expect(importers(imports("packages/core/src/url/html-text.ts"))).toEqual([
      "packages/core/src/documents/epub.ts", "packages/core/src/url/html-worker.ts"]);
  });
  it("documents/epub.ts is imported by detect.ts only", () => {
    expect(importers(imports("packages/core/src/documents/epub.ts"))).toEqual(["packages/core/src/documents/detect.ts"]);
  });
  it("documents/detect.ts is imported by doc-extract.ts only", () => {
    expect(importers(imports("packages/core/src/documents/detect.ts"))).toEqual(["packages/core/src/documents/doc-extract.ts"]);
  });
});
