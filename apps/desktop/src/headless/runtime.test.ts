import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { launchDir } from "../../../../packages/core/src/store/launch.ts";
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

const ENTRIES = [join(import.meta.dirname, "../../../../packages/mcp/src/main.ts"), join(import.meta.dirname, "osen-mcp.ts")];

// Names called as `f()` and as `a.b.c()` in a source file.
function callNames(file: string): Set<string> {
  const names = new Set<string>();
  const member = (n: Node): string => (n.type === "Identifier" ? (n["name"] as string) : n.type === "MemberExpression" ? `${member(n["object"] as Node)}.${member(n["property"] as Node)}` : "?");
  visitAst(parseSource(readFileSync(file, "utf8")), (n: Node) => {
    if (n.type === "CallExpression") names.add(member(n["callee"] as Node));
  });
  return names;
}

describe.each(ENTRIES)("MCP entry %s", (file) => {
  it("delegates start-up and shutdown to runServer", () => {
    const calls = callNames(file);
    expect(calls.has("runServer")).toBe(true);
    for (const banned of ["sweepLaunchDir", "cleanupActiveLaunches", "createServer", "process.on", "process.stdin.on"]) expect(calls.has(banned), banned).toBe(false);
  });

  it("sweeps stale launch files at start and exits 0 when stdin closes", async () => {
    const home = mkdtempSync(join(tmpdir(), "osen-mcp-sweep-"));
    try {
      const dir = launchDir(home);
      mkdirSync(dir, { recursive: true });
      const old = ["x.old.err", "x.old.accepted.json"].map((n) => join(dir, n));
      const fresh = ["y.new.err", "y.new.accepted.json"].map((n) => join(dir, n));
      for (const [paths, age] of [[old, 120_000], [fresh, 1_000]] as const) {
        for (const p of paths) {
          writeFileSync(p, "");
          utimesSync(p, new Date(Date.now() - age), new Date(Date.now() - age));
        }
      }
      const env: NodeJS.ProcessEnv = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: home };
      delete env["ELECTRON_RUN_AS_NODE"];
      const child = spawn(process.execPath, [file], { env, stdio: ["pipe", "pipe", "ignore"] });
      const exit = new Promise<number | null>((resolve) => child.on("exit", resolve));
      const reply = new Promise<void>((resolve) => {
        let buf = "";
        child.stdout.on("data", (d: Buffer) => {
          buf += d.toString();
          if (buf.split("\n").some((l) => l.includes('"id":1'))) resolve();
        });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "0" } } })}\n`);
      await reply;
      for (const p of old) expect(existsSync(p), p).toBe(false);
      for (const p of fresh) expect(existsSync(p), p).toBe(true);
      child.stdin.end();
      expect(await exit).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
