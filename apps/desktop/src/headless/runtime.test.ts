import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSource, visitAst } from "../../../../packages/core/src/ast-scan.testutil.ts";
import type { Node } from "../../../../packages/core/src/ast-scan.testutil.ts";
import { bundlePaths, dropRunAsNode } from "./runtime.ts";

describe("dropRunAsNode", () => {
  it("removes ELECTRON_RUN_AS_NODE and keeps the rest", () => {
    const vars: Record<string, string | undefined> = { ELECTRON_RUN_AS_NODE: "1", PATH: "/x" };
    dropRunAsNode(vars);
    expect("ELECTRON_RUN_AS_NODE" in vars).toBe(false);
    expect(vars["PATH"]).toBe("/x");
  });
});

describe("bundlePaths", () => {
  it("derives resources and workers from the folder of the bundled entry", () => {
    const dir = "/A b/Osen.app/Contents/Resources/app.asar.unpacked/out/main";
    expect(bundlePaths(dir)).toEqual({
      resources: "/A b/Osen.app/Contents/Resources",
      templates: "/A b/Osen.app/Contents/Resources/templates",
      scenarios: "/A b/Osen.app/Contents/Resources/scenarios",
      council: `${dir}/council.mjs`,
      pdfExtract: `${dir}/pdf-extract.mjs`,
      ocrHelper: "/A b/Osen.app/Contents/Resources/ocr/osen-ocr",
      docExtract: `${dir}/doc-extract.mjs`,
      htmlWorker: `${dir}/html-worker.mjs`,
    });
  });
});

// Source-level order of calls in an entry: line of the first call to each name, and the source of the setPdfExtractorRuntime and setDocumentExtractorRuntime calls.
function scan(file: string): { lines: Record<string, number>; runtimeCall: string; docCall: string; ocrCall: string } {
  const lines: Record<string, number> = {};
  let runtimeCall = "";
  let docCall = "";
  let ocrCall = "";
  const text = readFileSync(join(import.meta.dirname, file), "utf8");
  visitAst(parseSource(text), (n: Node) => {
    const callee = n["callee"] as Node | undefined;
    if (n.type !== "CallExpression" || callee?.type !== "Identifier") return;
    const name = callee["name"] as string;
    lines[name] ??= n.loc!.start.line;
    if (name === "setPdfExtractorRuntime") runtimeCall = text.split("\n")[n.loc!.start.line - 1]!;
    if (name === "setDocumentExtractorRuntime") docCall = text.split("\n")[n.loc!.start.line - 1]!;
    if (name === "setOcrRuntime") ocrCall = text.split("\n")[n.loc!.start.line - 1]!;
  });
  return { lines, runtimeCall, docCall, ocrCall };
}

describe.each(["osen-mcp.ts", "council.ts"])("entry %s", (file) => {
  const { lines, runtimeCall, docCall, ocrCall } = scan(file);
  it("drops ELECTRON_RUN_AS_NODE before the variables are read", () => {
    expect(lines["dropRunAsNode"]).toBeDefined();
    expect(lines["dropRunAsNode"]).toBeLessThan(lines["loadEnv"]!);
  });
  it("passes ELECTRON_RUN_AS_NODE=1 explicitly to the PDF extractor", () => {
    expect(runtimeCall).toContain('env: { ELECTRON_RUN_AS_NODE: "1" }');
    expect(runtimeCall).toContain("command: process.execPath");
  });
  it("passes ELECTRON_RUN_AS_NODE=1 explicitly to the document extractor", () => {
    expect(docCall).toContain('env: { ELECTRON_RUN_AS_NODE: "1" }');
    expect(docCall).toContain("command: process.execPath");
    expect(docCall).toContain("paths.docExtract");
  });
  it("sets the OCR helper from the bundle before the entry starts", () => {
    expect(ocrCall).toContain("paths.ocrHelper");
    expect(lines["setOcrRuntime"]).toBeLessThan(lines["loadEnv"]!);
  });
});
