import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createConnections } from "./connections.ts";

// Own seeded generator: fast-check is not wired in.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SERVER = { command: "/opt/node", args: ["/opt/Osen.app/Contents/Resources/bin/osen-mcp"] };
const STALE = { command: "/opt/node", args: ["/gone/Osen.app/Contents/Resources/bin/osen-mcp"] };
const FOREIGN_OSEN = { command: "python3", args: ["/srv/other-tool.py"] };

type Doc = Record<string, unknown>;
const readDoc = (f: string): Doc | null => { try { return JSON.parse(readFileSync(f, "utf8")) as Doc; } catch { return null; } };

async function run(seed: number): Promise<void> {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const root = mkdtempSync(join(tmpdir(), "osen-prop-"));
  try {
    const home = join(root, "home");
    const app = join(root, "Claude.app");
    mkdirSync(home);
    mkdirSync(app);
    const file = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    const write = (text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
    const bytes = () => (existsSync(file) ? readFileSync(file, "utf8") : null);
    const trace: string[] = [];
    const fail = (msg: string): never => { throw new Error(`seed ${seed}: ${msg}\ntrace: ${trace.join(" > ")}`); };

    // starting states: no file, empty file, only a foreign osen, foreign servers and other keys
    const start = int(4);
    trace.push(`start${start}`);
    if (start === 1) write("");
    else if (start === 2) write(JSON.stringify({ mcpServers: { osen: FOREIGN_OSEN } }));
    else if (start === 3) write(JSON.stringify({ theme: "dark", n: 7, mcpServers: { a: { command: "a", args: ["1"] }, b: { command: "b" } } }));

    const lines: string[] = [];
    const api = createConnections({
      home, env: { PATH: "/usr/bin:/bin" }, serverCommand: SERVER, councilWrapper: null, shell: "/bin/sh", desktopApps: [app],
      logger: { info: (m) => void lines.push(m), error: (m) => void lines.push(m) },
      deps: { hasCommand: () => false, exec: () => ({ ok: false, stdout: "", stderr: "" }) },
    });
    const junk = (): unknown[] => [{ command: "/evil", args: ["x"] }, "/etc/passwd", { file: "/tmp/x" }].slice(0, int(4));

    const n = 1 + int(12);
    for (let i = 0; i < n; i++) {
      const before = bytes();
      const docBefore = before === null ? null : readDoc(file);
      const op = ["view", "connect", "update", "disconnect", "noop", "mutate"][int(6)]!;
      let refusedOrNoop = false;
      if (op === "mutate") {
        const m = int(8);
        trace.push(`mutate${m}`);
        const d = readDoc(file) ?? {};
        const servers = (d.mcpServers && typeof d.mcpServers === "object" && !Array.isArray(d.mcpServers) ? d.mcpServers : {}) as Doc;
        if (m === 0) write(JSON.stringify({ ...d, mcpServers: { ...servers, osen: FOREIGN_OSEN } }));
        else if (m === 1) write("{ not json");
        else if (m === 2) write("");
        else if (m === 3) rmSync(file, { force: true });
        else if (m === 4) write(JSON.stringify({ ...d, [`k${int(5)}`]: int(100) }));
        else if (m === 5) write(JSON.stringify({ ...d, mcpServers: { ...servers, [`s${int(4)}`]: { command: `c${int(9)}`, args: [] } } }));
        else if (m === 6) { const { [`s${int(4)}`]: _x, ...rest } = servers; write(JSON.stringify({ ...d, mcpServers: rest })); }
        else write(JSON.stringify({ ...d, mcpServers: { ...servers, osen: STALE } }));
        continue;
      }
      trace.push(op);
      let reply: Awaited<ReturnType<typeof api.connect>> | null = null;
      const fn = { connect: api.connect, update: api.update, disconnect: api.disconnect }[op as "connect"] as ((id: unknown, ...x: unknown[]) => ReturnType<typeof api.connect>) | undefined;
      if (op === "view") { const v = await api.view(); if (!v) fail("no view"); }
      else if (fn) reply = await fn("claude-desktop", ...junk());
      else refusedOrNoop = true; // "check-free-noop"/cancelled confirmation: no call at all

      const after = bytes();
      if (op === "view" || refusedOrNoop) { if (after !== before) fail(`${op} changed the file`); continue; }
      const r = reply!.result;
      if (!r.ok && after !== before) fail(`refused ${op} (${r.ok ? "" : r.refusal}) changed the file`);
      if (r.ok && !r.changed && after !== before) fail(`${op} with changed=false changed the file`);

      // invariants on the document, where it was and is a valid object
      const docAfter = after === null ? null : readDoc(file);
      if (docAfter && docBefore) {
        for (const [k, v] of Object.entries(docBefore)) if (k !== "mcpServers" && JSON.stringify(docAfter[k]) !== JSON.stringify(v)) fail(`foreign key ${k} changed`);
        const sb = (docBefore.mcpServers ?? {}) as Doc, sa = (docAfter.mcpServers ?? {}) as Doc;
        for (const [k, v] of Object.entries(sb)) {
          if (k === "osen" && !(r.ok && r.changed)) { if (JSON.stringify(sa[k]) !== JSON.stringify(v)) fail("osen changed without a successful change"); continue; }
          if (k !== "osen" && JSON.stringify(sa[k]) !== JSON.stringify(v)) fail(`foreign server ${k} changed`);
        }
        for (const k of Object.keys(sa)) if (k !== "osen" && !(k in sb)) fail(`server ${k} appeared`);
        if (JSON.stringify(sb.osen) === JSON.stringify(FOREIGN_OSEN) && JSON.stringify(sa.osen) !== JSON.stringify(FOREIGN_OSEN)) fail("foreign osen changed");
        if (sa.osen !== undefined && JSON.stringify(sa.osen) !== JSON.stringify(sb.osen) && JSON.stringify(sa.osen) !== JSON.stringify(SERVER)) fail(`written osen is not the server command: ${JSON.stringify(sa.osen)}`);
      } else if (docAfter && !docBefore) {
        // created from nothing: only our entry
        const sa = (docAfter.mcpServers ?? {}) as Doc;
        if (JSON.stringify(Object.keys(docAfter)) !== JSON.stringify(["mcpServers"]) || JSON.stringify(sa) !== JSON.stringify({ osen: SERVER })) fail(`unexpected new file ${after}`);
      }
    }
    if (lines.join("\n").includes("/evil")) fail("request value reached the log");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Граница моста для подключений: random action sequences on claude-desktop", () => {
  it("keeps foreign data, writes only the server command, refuses without writing (400 seeded cases)", async () => {
    for (let seed = 1; seed <= 400; seed++) await run(seed);
  }, 120_000);
});
