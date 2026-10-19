import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TOOLS } from "../../../packages/mcp/src/server.ts";
import { helpLine, mcpLine, scriptedRunLine, selfContainedLine, wrappersLine } from "./headless-in-image.ts";

const BIN = join(import.meta.dirname, "../resources/bin");
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

// Fake MCP server: answers initialize and tools/list, exits 0 when stdin closes. `noise` is printed to stdout first.
const fakeMcp = (noise: string) => `
${noise ? `process.stdout.write(${JSON.stringify(noise)} + "\\n");` : ""}
import("node:readline").then(({ createInterface }) => {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (l) => {
    const m = JSON.parse(l);
    if (m.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: "fake", version: "1" } } }));
    if (m.method === "tools/list") console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: ${JSON.stringify(TOOLS.map((t) => ({ name: t.name })))} } }));
  });
  rl.on("close", () => process.exit(0));
});
`;
const FAKE_COUNCIL = `
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--help") console.log("Usage: council");
else mkdirSync(join(process.env.COUNCIL_HOME, "sessions", "s1"), { recursive: true });
`;

interface Opts { noise?: string; skipWrapper?: string; noExec?: string; mcpImport?: string }

// Contents of a fake Osen.app: MacOS/Osen runs the node of the test on the given file; the entries are tiny hand-written scripts.
function bundle(o: Opts = {}): { contents: string; work: string } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "headless-image-"));
  roots.push(root);
  const contents = join(root, "Osen.app/Contents");
  const main = join(contents, "Resources/app.asar.unpacked/out/main");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources/bin"), { recursive: true });
  mkdirSync(join(main, "chunks"), { recursive: true });
  writeFileSync(join(contents, "MacOS/Osen"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  for (const w of ["osen-mcp", "council"]) if (w !== o.skipWrapper) {
    copyFileSync(join(BIN, w), join(contents, "Resources/bin", w));
    chmodSync(join(contents, "Resources/bin", w), w === o.noExec ? 0o644 : 0o755);
  }
  writeFileSync(join(main, "osen-mcp.mjs"), `${o.mcpImport ?? 'import "./chunks/c.js";'}\n${fakeMcp(o.noise ?? "")}`);
  writeFileSync(join(main, "council.mjs"), `import "./chunks/c.js";\nimport "node:fs";\n${FAKE_COUNCIL}`);
  writeFileSync(join(main, "chunks/c.js"), 'export const a = "import x from \\"ajv\\"";\n// require("zod")\nexport const b = import("node:path");\n');
  return { contents, work: join(root, "work") };
}

describe("headless entry points in the image", () => {
  it("healthy fake bundle: every line is OK", async () => {
    const { contents, work } = bundle();
    expect(wrappersLine(contents).ok).toBe(true);
    expect(selfContainedLine(contents)).toMatchObject({ ok: true }); // ajv in a string and zod in a comment are not imports
    const mcp = await mcpLine(contents, work);
    expect(mcp).toEqual({ ok: true, text: `MCP server osen-mcp: ${TOOLS.length} tools as in the server registry, clean stdout, exit 0 on stdin close` });
    expect(helpLine(contents, work).ok).toBe(true);
    expect(scriptedRunLine(contents, work).ok).toBe(true);
  });

  it("missing bin/osen-mcp: FAIL naming the wrapper", () => {
    const r = wrappersLine(bundle({ skipWrapper: "osen-mcp" }).contents);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("osen-mcp is missing");
  });

  it("non-executable wrapper: FAIL naming the wrapper", () => {
    const r = wrappersLine(bundle({ noExec: "council" }).contents);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("council is not executable");
  });

  it("server printing a non-protocol line to stdout: FAIL with that line", async () => {
    const { contents, work } = bundle({ noise: "Debug: hello from the server" });
    const r = await mcpLine(contents, work);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("Debug: hello from the server");
  });

  it("server printing JSON that is not a JSON-RPC message: FAIL with that line", async () => {
    const { contents, work } = bundle({ noise: '{"debug":1}' });
    const r = await mcpLine(contents, work);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('{"debug":1}');
  });

  it("entry file importing @modelcontextprotocol/sdk: FAIL with file and specifier", () => {
    const r = selfContainedLine(bundle({ mcpImport: 'import "@modelcontextprotocol/sdk/server/stdio.js";' }).contents);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("osen-mcp.mjs: @modelcontextprotocol/sdk/server/stdio.js");
  });

  it("relative import of a file outside out/main or a missing file: FAIL", () => {
    expect(selfContainedLine(bundle({ mcpImport: 'import "./chunks/missing.js";' }).contents).ok).toBe(false);
    expect(selfContainedLine(bundle({ mcpImport: 'import "../../x.js";' }).contents).ok).toBe(false);
  });

  it("server that never exits after stdin closes: FAIL by timeout", async () => {
    const { contents, work } = bundle();
    // keeps the loop alive after stdin ends
    const fs = await import("node:fs");
    const p = join(contents, "Resources/app.asar.unpacked/out/main/osen-mcp.mjs");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("process.exit(0)", "setInterval(() => {}, 1000)"));
    const r = await mcpLine(contents, work, 3000);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("did not exit");
  }, 20000);

  it("wrong tool set: FAIL listing both", async () => {
    const { contents, work } = bundle();
    const fs = await import("node:fs");
    const p = join(contents, "Resources/app.asar.unpacked/out/main/osen-mcp.mjs");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(`"${TOOLS[0]!.name}"`, '"other_tool"'));
    const r = await mcpLine(contents, work);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("other_tool");
  });
});
