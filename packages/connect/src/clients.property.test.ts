import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { connect, disconnect, settingsFile, status, update } from "./clients.ts";
import type { ConnectDeps, ServerCommand } from "./types.ts";

// Own seeded generator: fast-check is not wired in.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const home = mkdtempSync(join(tmpdir(), "connect-prop-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const file = settingsFile("claude-desktop", home);
const deps: ConnectDeps = { home, desktopApps: [], hasCommand: () => false, exec: () => ({ ok: false, stdout: "", stderr: "" }) };
const cmd: ServerCommand = { command: "node", args: ["/repo/packages/mcp/src/main.ts"] };

const NAMES = ["fs", "git", "сервер", "日本語", "a b", "with.dot", "x-1", "ключ"];
type Rng = () => number;
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
function value(r: Rng, depth = 0): unknown {
  const k = Math.floor(r() * (depth > 2 ? 5 : 7));
  if (k === 0) return Math.floor(r() * 1000) - 500;
  if (k === 1) return r() < 0.5;
  if (k === 2) return null;
  if (k === 3) return pick(r, ["", "text", "юникод", "q\"uote", "line\nbreak"]);
  if (k === 4) return r() * 10;
  if (k === 5) return Array.from({ length: Math.floor(r() * 4) }, () => value(r, depth + 1));
  return Object.fromEntries(Array.from({ length: Math.floor(r() * 3) }, (_, i) => [pick(r, NAMES) + i, value(r, depth + 1)]));
}
// a config text of one of the shapes the desktop file can have, with the object it means
function config(r: Rng): { text: string; parsed: Record<string, unknown> } {
  const k = Math.floor(r() * 4);
  if (k === 0) return { text: "", parsed: {} };
  if (k === 1) return { text: pick(r, [" ", "\n\n", " \t\n"]), parsed: {} };
  const obj: Record<string, unknown> = {};
  for (let i = Math.floor(r() * 4); i > 0; i--) obj[pick(r, ["theme", "ключ", "numStartups", "flag", "nested"]) + i] = value(r);
  if (k === 3 || r() < 0.5) {
    const servers: Record<string, unknown> = {};
    for (let i = Math.floor(r() * 5); i > 0; i--) servers[pick(r, NAMES) + i] = r() < 0.3 ? value(r) : { command: pick(r, ["npx", "uvx"]), args: [pick(r, NAMES)], env: value(r) };
    if (k === 3 || Object.keys(servers).length) obj.mcpServers = servers;
  }
  return { text: r() < 0.5 ? JSON.stringify(obj) : JSON.stringify(obj, null, 2) + "\n", parsed: obj };
}
const put = (text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const read = () => readFileSync(file, "utf8");
// absent and {} mcpServers mean the same to the client
const norm = (o: Record<string, unknown>) => {
  const c = { ...o };
  if (c.mcpServers && typeof c.mcpServers === "object" && Object.keys(c.mcpServers).length === 0) delete c.mcpServers;
  return c;
};

const SEED = Number(process.env.CONNECT_SEED ?? 20260101);
const CASES = 400;
async function forAll(prop: (r: Rng, c: ReturnType<typeof config>) => Promise<void>) {
  for (let i = 0; i < CASES; i++) {
    const r = mulberry32(SEED + i);
    const c = config(r);
    try { rmSync(file, { force: true }); put(c.text); await prop(r, c); }
    catch (e) { throw new Error(`seed ${SEED + i} (CONNECT_SEED=${SEED}, case ${i}) config ${JSON.stringify(c.text)}: ${(e as Error).message}`); }
  }
}

describe("Идемпотентность и обратимость подключения", () => {
  it("connecting twice leaves the file after the first call unchanged", () => forAll(async () => {
    expect(await connect("claude-desktop", cmd, deps)).toMatchObject({ ok: true, changed: true });
    const once = read();
    expect(await connect("claude-desktop", cmd, deps)).toMatchObject({ ok: true, changed: false });
    expect(read()).toBe(once);
  }));
  it("connect then disconnect returns the original content", () => forAll(async (_, c) => {
    await connect("claude-desktop", cmd, deps);
    expect(await disconnect("claude-desktop", cmd, deps)).toMatchObject({ ok: true });
    expect(norm(JSON.parse(read().trim() === "" ? "{}" : read()))).toEqual(norm(c.parsed));
  }));
  it("foreign keys and servers survive connect by value", () => forAll(async (_, c) => {
    await connect("claude-desktop", cmd, deps);
    const after = JSON.parse(read());
    const { mcpServers: s1, ...rest1 } = after, { mcpServers: s0, ...rest0 } = c.parsed;
    expect(rest1).toEqual(rest0);
    expect({ ...s1, osen: undefined }).toEqual({ ...(s0 as object | undefined), osen: undefined });
    expect(s1.osen).toEqual({ command: cmd.command, args: cmd.args });
  }));
  it("a foreign osen entry makes connect, update and disconnect refuse and leaves the file byte-identical", () => forAll(async (r, c) => {
    const obj = { ...c.parsed, mcpServers: { ...((c.parsed.mcpServers as object | undefined) ?? {}), osen: { command: pick(r, ["npx", "uvx", "python"]), args: [pick(r, ["-y", "srv"]), "other-" + pick(r, NAMES)] } } };
    const text = JSON.stringify(obj, null, 2) + "\n";
    put(text);
    for (const f of [connect, update, disconnect]) expect(await f("claude-desktop", cmd, deps)).toMatchObject({ ok: false, refusal: "foreign" });
    expect(read()).toBe(text);
    expect(existsSync(file)).toBe(true);
  }));
});

// An in-memory `codex` CLI: `mcp get <name> --json`, `mcp add <name> -- <cmd> <args>`, `mcp remove <name>`.
type Entry = { command: string; args: string[] };
function fakeCodex(initial: Map<string, Entry>, raw: string | null, wrap: (x: { ok: boolean; stdout: string; stderr: string }) => ReturnType<ConnectDeps["exec"]>): ConnectDeps {
  const state = new Map(initial);
  return {
    home, desktopApps: [], hasCommand: () => true,
    exec: (_bin, args) => {
      const name = args[2]!;
      if (args[1] === "get") {
        const e = state.get(name);
        if (raw !== null) return wrap({ ok: true, stdout: raw, stderr: "" });
        return wrap(e ? { ok: true, stdout: JSON.stringify({ name, transport: { type: "stdio", ...e } }), stderr: "" } : { ok: false, stdout: "", stderr: `Error: No MCP server named '${name}' found.\n` });
      }
      if (args[1] === "add") state.set(name, { command: args[4]!, args: args.slice(5) });
      else state.delete(name);
      return wrap({ ok: true, stdout: "", stderr: "" });
    },
  };
}

describe("same results with a sync and an async exec", () => {
  const cmd2: ServerCommand = { command: "node", args: ["/elsewhere/packages/mcp/src/main.ts"] };
  const kinds: (() => { entry: Entry | null; raw: string | null })[] = [
    () => ({ entry: null, raw: null }),
    () => ({ entry: { command: cmd.command, args: cmd.args }, raw: null }),
    () => ({ entry: { command: "x", args: ["y"] }, raw: null }),
    () => ({ entry: { command: cmd2.command, args: cmd2.args }, raw: null }),
    () => ({ entry: null, raw: "something odd" }),
  ];
  it("any chain of status, connect, update and disconnect gives the same results", async () => {
    for (let i = 0; i < CASES; i++) {
      const r = mulberry32(SEED + i);
      const { entry, raw } = pick(r, kinds)();
      const init = new Map(entry ? [["osen", entry] as [string, Entry]] : []);
      const sync = fakeCodex(init, raw, (x) => x);
      const lazy = fakeCodex(init, raw, (x) => new Promise((res) => setTimeout(() => res(x), 0)));
      const ops = { status, connect, update, disconnect };
      const chain = Array.from({ length: 1 + Math.floor(r() * 6) }, () => ({ op: pick(r, Object.keys(ops) as (keyof typeof ops)[]), c: pick(r, [cmd, cmd2]), dryRun: r() < 0.2 }));
      const a: unknown[] = [], b: unknown[] = [];
      for (const { op, c, dryRun } of chain) {
        a.push(await ops[op]("codex", c, sync, { dryRun }));
        b.push(await ops[op]("codex", c, lazy, { dryRun }));
      }
      expect(b, `seed ${SEED + i} (CONNECT_SEED=${SEED}, case ${i}) chain ${JSON.stringify(chain)}`).toEqual(a);
    }
  });
});
