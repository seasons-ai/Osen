import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { parseSource, visitAst } from "../../../packages/core/src/ast-scan.testutil.ts";
import type { Node } from "../../../packages/core/src/ast-scan.testutil.ts";
import { TOOLS } from "../../../packages/mcp/src/server.ts";

// Checks of the headless entry points (bin/osen-mcp, bin/council) in an Osen.app copy. `contents` is Osen.app/Contents,
// `work` is a writable folder inside the project for data folders. Each function returns one report line.
type Line = { ok: boolean; text: string };

const WRAPPERS = ["osen-mcp", "council"] as const;
const bin = (contents: string, name: string) => join(contents, "Resources/bin", name);
const mainDir = (contents: string) => join(contents, "Resources/app.asar.unpacked/out/main");
// no PATH, no user variables: the wrappers must not depend on them
const dirs = (work: string, name: string) => {
  const home = join(work, `${name}-data`), userHome = join(work, `${name}-home`);
  mkdirSync(home, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  return { env: { COUNCIL_DEV: "1", COUNCIL_HOME: home, HOME: userHome }, home };
};

/** Wrappers exist, are executable and name neither /Applications nor a user folder. */
export function wrappersLine(contents: string): Line {
  const bad: string[] = [];
  for (const name of WRAPPERS) {
    const p = bin(contents, name);
    if (!existsSync(p)) { bad.push(`${name} is missing`); continue; }
    try { accessSync(p, constants.X_OK); } catch { bad.push(`${name} is not executable`); continue; }
    const text = readFileSync(p, "utf8");
    for (const lit of ["/Applications", "/Users/"]) if (text.includes(lit)) bad.push(`${name} contains ${lit}`);
  }
  return { ok: bad.length === 0, text: `wrappers bin/osen-mcp and bin/council: executable, no install path literals${bad.length ? `: ${bad.join("; ")}` : ""}` };
}

/** Every module specifier of the entry files and chunks is a Node builtin or a file inside out/main. */
export function selfContainedLine(contents: string): Line {
  const main = mainDir(contents);
  const chunks = existsSync(join(main, "chunks")) ? readdirSync(join(main, "chunks")).filter((f) => f.endsWith(".js")).map((f) => `chunks/${f}`) : [];
  const files = ["osen-mcp.mjs", "council.mjs", ...chunks];
  const offenders: string[] = [];
  for (const f of files) {
    const p = join(main, f);
    if (!existsSync(p)) { offenders.push(`${f}: file is missing`); continue; }
    const specs: string[] = [];
    visitAst(parseSource(readFileSync(p, "utf8")), (n: Node) => {
      if ((n.type === "ImportDeclaration" || n.type === "ExportAllDeclaration" || n.type === "ExportNamedDeclaration") && n["source"]) specs.push((n["source"] as { value: string }).value);
      const callee = n["callee"] as Node | undefined;
      const arg = (n["arguments"] as Node[] | undefined)?.[0];
      if (n.type === "CallExpression" && callee && (callee.type === "Import" || (callee.type === "Identifier" && callee["name"] === "require"))) {
        if (arg?.type === "StringLiteral") specs.push(arg["value"] as string);
        else offenders.push(`${f}: computed specifier`);
      }
    });
    for (const s of specs) {
      if (s.startsWith("node:") || isBuiltin(s)) continue;
      if (/^\.\.?\//.test(s)) {
        const target = resolve(dirname(p), s);
        if (target.startsWith(main + "/") && existsSync(target)) continue;
      }
      offenders.push(`${f}: ${s}`);
    }
  }
  return { ok: offenders.length === 0, text: `entry files and chunks import only node:* and files of out/main (${files.length} files)${offenders.length ? `: ${offenders.join("; ")}` : ""}` };
}

/** osen-mcp over stdio: only JSON-RPC lines on stdout, the tools of the server registry, exit 0 when stdin closes. */
export async function mcpLine(contents: string, work: string, timeoutMs = 30000, exitTimeoutMs = timeoutMs): Promise<Line> {
  const { env } = dirs(work, "mcp");
  const expected = TOOLS.map((t) => t.name).sort();
  const label = `MCP server osen-mcp: ${expected.length} tools as in the server registry, clean stdout, exit 0 on stdin close`;
  const child = spawn(bin(contents, "osen-mcp"), [], { env, stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  let buf = "", stderr = "", spawnError = "";
  child.on("error", (e) => { spawnError = e.message; });
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  const exited = new Promise<number | null>((res) => child.on("close", (code) => res(code)));
  const toolsReply = new Promise<void>((res) => {
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        lines.push(line);
        try { if ((JSON.parse(line) as { id?: number }).id === 2) res(); } catch { res(); } // a broken line ends the wait: it is reported below
      }
    });
    child.on("close", () => res());
  });
  const timer = (ms: number) => new Promise<"timeout">((res) => setTimeout(() => res("timeout"), ms).unref());
  const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
  child.stdin.on("error", () => { /* the server died early: reported by the checks below */ });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "headless-check", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const fail = (why: string): Line => ({ ok: false, text: `${label}: ${why}${stderr ? ` (stderr: ${stderr.trim().slice(0, 200)})` : ""}` });
  try {
    if ((await Promise.race([toolsReply, timer(timeoutMs)])) === "timeout") return fail("no tools/list reply in time");
    child.stdin.end();
    const code = await Promise.race([exited, timer(exitTimeoutMs)]);
    if (code === "timeout") return fail("did not exit after stdin closed");
    if (spawnError) return fail(`cannot start: ${spawnError}`);
    const messages: { id?: number; result?: { tools?: { name: string }[] } }[] = [];
    for (const l of lines) {
      try {
        const m = JSON.parse(l) as { jsonrpc?: string };
        if (m.jsonrpc !== "2.0") throw new Error("not JSON-RPC");
        messages.push(m);
      } catch { return fail(`non-protocol line on stdout: ${l.slice(0, 200)}`); }
    }
    const names = (messages.find((m) => m.id === 2)?.result?.tools ?? []).map((t) => t.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(expected)) return fail(`tools [${names.join(", ")}], expected [${expected.join(", ")}]`);
    if (code !== 0) return fail(`exit code ${String(code)}`);
    return { ok: true, text: label };
  } finally {
    child.kill(); // no-op after a normal exit
  }
}

/** council --help with an empty environment: exit 0 and help on stdout. */
export function helpLine(contents: string, work: string): Line {
  const { env } = dirs(work, "help");
  const r = spawnSync(bin(contents, "council"), ["--help"], { env, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
  const ok = r.status === 0 && r.stdout.trim() !== "";
  return { ok, text: `bin/council --help without PATH: exit 0, help printed${ok ? "" : `: exit ${String(r.status ?? r.error?.message)}, stdout ${r.stdout.length} chars, stderr ${r.stderr.slice(0, 200)}`}` };
}

/** Scripted consensus session through bin/council: exit 0 and a session folder under COUNCIL_HOME. */
export function scriptedRunLine(contents: string, work: string): Line {
  const { env, home } = dirs(work, "run");
  const sc = (p: string) => `scripted:${join(contents, "Resources/scenarios/consensus", p)}`;
  const r = spawnSync(bin(contents, "council"), ["--topic", "Entry points check", "--participant", sc("p1.json"), "--participant", sc("p2.json"), "--max-rounds", "3"], { env, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
  const sessions = existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")) : [];
  const ok = r.status === 0 && sessions.length > 0;
  return { ok, text: `bin/council scripted run without PATH: consensus (exit 0), session saved${ok ? "" : `: exit ${String(r.status ?? r.error?.message)}, sessions ${sessions.length}, stderr ${r.stderr.slice(0, 200)}`}` };
}

/** council_start through bin/osen-mcp: the session is run by a detached executor and reaches consensus after the server has exited. */
export async function detachedStartLine(contents: string, work: string, timeoutMs = 60000): Promise<Line> {
  const { env, home } = dirs(work, "detached");
  const label = "MCP server osen-mcp without PATH: council_start session finishes with consensus after the server exited (detached executor)";
  const child = spawn(bin(contents, "osen-mcp"), [], { env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", stderr = "", spawnError = "";
  const replies = new Map<number, { result?: { isError?: boolean; content?: { text: string }[] } }>();
  let wake: () => void = () => {};
  child.on("error", (e) => { spawnError = e.message; wake(); });
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  const exited = new Promise<number | null>((res) => child.on("close", (code) => { wake(); res(code); }));
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try { const m = JSON.parse(line) as { id?: number }; if (m.id !== undefined) replies.set(m.id, m); } catch { /* reported by the mcp line */ }
    }
    wake();
  });
  const timer = (ms: number) => new Promise<"timeout">((res) => setTimeout(() => res("timeout"), ms).unref());
  const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
  child.stdin.on("error", () => { /* the server died early: reported below */ });
  const fail = (why: string): Line => ({ ok: false, text: `${label}: ${why}${stderr ? ` (stderr: ${stderr.trim().slice(0, 200)})` : ""}` });
  const reply = async (id: number): Promise<"timeout" | undefined> => {
    const end = Date.now() + timeoutMs;
    while (!replies.has(id) && Date.now() < end && !spawnError) await Promise.race([new Promise<void>((res) => { wake = res; }), timer(200)]);
    return replies.has(id) ? undefined : "timeout";
  };
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "headless-check", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const sc = (p: string) => ({ providerId: "scripted", model: `consensus/${p}` });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "council_start", arguments: { topic: "Entry points check", participants: [sc("p1.json"), sc("p2.json")], maxRounds: 3 } } });
    if (await reply(2) === "timeout") return fail(spawnError ? `cannot start: ${spawnError}` : "no council_start reply in time");
    const result = replies.get(2)!.result;
    const text = result?.content?.[0]?.text ?? "";
    if (result?.isError) return fail(`council_start refused: ${text.slice(0, 200)}`);
    const id = (JSON.parse(text) as { sessionId?: string }).sessionId;
    if (!id) return fail("no sessionId in the council_start reply");
    child.stdin.end();
    const code = await Promise.race([exited, timer(timeoutMs)]);
    if (code === "timeout") return fail("did not exit after stdin closed");
    const events = join(home, "sessions", id, "events.jsonl");
    const end = Date.now() + timeoutMs;
    let finished = "";
    while (Date.now() < end) {
      const text = existsSync(events) ? readFileSync(events, "utf8") : "";
      const m = /"type":"session_finished","status":"(\w+)"/.exec(text) ?? /"type":"session_finished"[^\n]*?"status":"(\w+)"/.exec(text);
      if (m) { finished = m[1]!; break; }
      await new Promise((res) => setTimeout(res, 200));
    }
    if (finished !== "consensus") return fail(`session ${id} status after the server exited: ${finished || "not finished in time"}`);
    return { ok: true, text: label };
  } finally {
    child.kill(); // no-op after a normal exit; the executor is a separate process and is not touched
  }
}

/** All lines in order; `report` prints them. A folder `work` is created by the caller. */
export async function reportHeadlessLines(contents: string, work: string, report: (ok: boolean, text: string) => void): Promise<void> {
  const wrappers = wrappersLine(contents);
  report(wrappers.ok, wrappers.text);
  const self = selfContainedLine(contents);
  report(self.ok, self.text);
  // the runs below need the wrappers: without them the lines would only repeat the same fault
  if (!wrappers.ok) return;
  for (const line of [await mcpLine(contents, work), helpLine(contents, work), scriptedRunLine(contents, work), await detachedStartLine(contents, work)]) report(line.ok, line.text);
}
