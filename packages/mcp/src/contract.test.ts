import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { configPath, initialRegistry, listSessions, readSession, requestStop } from "@model-council/core";
import { checkProtocol, checkSdkPin, collectResponses, compareWithGolden, EXPECTED_PROTOCOL_VERSION, normalize, shapeDiff, writeGolden } from "./contract.ts";

const root = join(import.meta.dirname, "../../..");
const baseEnv = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", COUNCIL_LANG: "ru" }; // the child process does not inherit the vitest env

const dirs: string[] = [];
const clients: Client[] = [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  // sessions live in detached executors: stop them before the folders go
  for (const d of dirs) {
    for (const x of listSessions(d)) {
      const pid = readSession(d, x.id)?.state.pid ?? null;
      if (x.status !== "running" || pid === null) continue;
      requestStop(d, x.id);
      for (const t0 = Date.now(); alive(pid) && Date.now() - t0 < 5000; ) await sleep(50);
      if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "council-"));
  dirs.push(d);
  writeFileSync(configPath(d), JSON.stringify(initialRegistry([])));
  return d;
};

async function connect(dataDir: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "main.ts")], cwd: root, stderr: "ignore", env: { ...baseEnv, COUNCIL_HOME: dataDir, COUNCIL_DEV: "1" } });
  const client = new Client({ name: "test", version: "0" });
  clients.push(client);
  await client.connect(transport);
  return client;
}

describe("Закреплённая версия протокола", () => {
  it("Закреплённая версия протокола: the real server over stdio negotiates EXPECTED_PROTOCOL_VERSION for a known and an unknown client version", async () => {
    const findings = await checkProtocol(root, { ...baseEnv, COUNCIL_HOME: tmp(), COUNCIL_DEV: "1" });
    expect(findings.filter((f) => !f.ok)).toEqual([]);
    expect(findings.length).toBe(3);
  }, 60_000);
});

describe("Точная версия SDK", () => {
  it("Точная версия SDK: a range or a version other than the lock file fails and names the dependency", () => {
    const pin = (range: string, locked: string) => {
      const d = mkdtempSync(join(tmpdir(), "sdk-pin-"));
      dirs.push(d);
      mkdirSync(join(d, "packages/mcp"), { recursive: true });
      writeFileSync(join(d, "packages/mcp/package.json"), JSON.stringify({ dependencies: { "@modelcontextprotocol/sdk": range, zod: "^4.6.7" } }));
      writeFileSync(join(d, "package-lock.json"), JSON.stringify({ packages: { "node_modules/@modelcontextprotocol/sdk": { version: locked } } }));
      return checkSdkPin(d).filter((f) => !f.ok).map((f) => f.detail);
    };
    expect(pin("^1.32.1", "1.32.1")).toEqual(['@modelcontextprotocol/sdk is "^1.32.1", expected an exact version without a range']);
    expect(pin("~1.32.1", "1.32.1")[0]).toContain("@modelcontextprotocol/sdk");
    expect(pin("1.32.0", "1.32.1")).toEqual(["@modelcontextprotocol/sdk is 1.32.0, lock file has 1.32.1"]);
    expect(pin("1.32.1", "1.32.1")).toEqual([]);
  });

  it("Точная версия SDK: no range and equals the lock file", () => {
    const bad = checkSdkPin(root).filter((f) => !f.ok);
    expect(bad.map((f) => f.detail)).toEqual([]);
  });
});

// ---- normalizer: own seeded generator (fast-check is not wired in) ----

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The structure (keys, kinds, stable values) comes from `structSeed`; unstable values from `valueSeed`.
// Stable keys are k<n>; unstable keys are fixed names that normalize replaces.
function generate(structSeed: number, valueSeed: number): Record<string, unknown> {
  const s = mulberry32(structSeed);
  const v = mulberry32(valueSeed);
  const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(v() * 16)]).join("");
  const num = (n: number) => String(Math.floor(v() * 10 ** n)).padStart(n, "0");
  const unstable: Record<string, () => unknown> = {
    sessionId: () => `${num(8)}-${num(6)}-${hex(4)}`,
    requestId: () => hex(12),
    waitId: () => hex(8),
    planToken: () => hex(32),
    pid: () => Math.floor(v() * 99999),
    elapsedMs: () => Math.floor(v() * 1e6),
    deadline: () => new Date(1.7e12 + Math.floor(v() * 1e10)).toISOString(),
    at: () => new Date(1.6e12 + Math.floor(v() * 1e10)).toISOString(),
    dataDir: () => `/Users/${hex(6)}/data/${hex(4)}`,
    text: () => `free text ${hex(5)} with spaces`,
  };
  const names = Object.keys(unstable);
  let n = 0;
  const node = (depth: number): unknown => {
    const r = s();
    if (depth > 0 && r < 0.3) return Array.from({ length: Math.floor(s() * 4) }, () => node(depth - 1)); // may be empty
    if (depth > 0 && r < 0.6) return obj(depth - 1);
    const leaf = Math.floor(s() * 5);
    if (leaf === 0) return Math.floor(s() * 100);
    if (leaf === 1) return s() < 0.5;
    if (leaf === 2) return null;
    return ["running", "amend", "agree", "scripted", "object"][Math.floor(s() * 5)]!;
  };
  const obj = (depth: number): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    for (let i = Math.floor(s() * 5); i > 0; i--) o[`k${n++}`] = node(depth); // may be empty
    if (s() < 0.7) { const name = names[Math.floor(s() * names.length)]!; o[name] = unstable[name]!(); }
    return o;
  };
  return obj(5);
}

type Slot = { path: string; parent: Record<string, unknown>; key: string };

// every stable key (k<n>) and every object of the tree, with dotted paths as shapeDiff prints them
function walk(value: unknown, path: string, keys: Slot[], objects: { path: string; obj: Record<string, unknown> }[]): void {
  if (Array.isArray(value)) value.forEach((x, i) => walk(x, `${path}[${i}]`, keys, objects));
  else if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    objects.push({ path, obj: o });
    for (const [k, x] of Object.entries(o)) {
      const p = path === "" ? k : `${path}.${k}`;
      if (/^k\d+$/.test(k)) keys.push({ path: p, parent: o, key: k });
      walk(x, p, keys, objects);
    }
  }
}

describe("Эталон форм ответов инструментов", () => {
  it("Эталон форм ответов инструментов: normalize ignores unstable values and shapeDiff names a changed key (300 seeded cases)", () => {
    let mutations = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const a = generate(seed, seed * 7 + 1);
      const b = generate(seed, seed * 13 + 5000);
      expect(normalize(a), `seed ${seed}`).toEqual(normalize(b));
      expect(shapeDiff("t", normalize(a), normalize(b)), `seed ${seed}`).toEqual([]);

      const keys: Slot[] = [];
      const objects: { path: string; obj: Record<string, unknown> }[] = [];
      const base = JSON.parse(JSON.stringify(b)) as Record<string, unknown>;
      walk(base, "", keys, objects);
      const expected = normalize(a);
      const check = (mutant: unknown, path: string, what: string) => {
        const d = shapeDiff("t", expected, normalize(mutant));
        expect(d.length, `seed ${seed} ${what} ${path}`).toBeGreaterThan(0);
        expect(d.some((l) => l.startsWith("t: ") && l.includes(path)), `seed ${seed} ${what} ${path}: ${d.join("; ")}`).toBe(true);
        mutations++;
      };
      // the mutation is applied to the generated tree and undone, so the next mutation starts from the same tree
      if (keys.length > 0) {
        const { path, parent, key } = keys[seed % keys.length]!;
        const old = parent[key];
        delete parent[key];
        check(base, path, "drop key");
        parent[`renamed_${key}`] = old;
        check(base, path, "rename key");
        delete parent[`renamed_${key}`];
        parent[key] = old === null ? 0 : typeof old === "number" || typeof old === "boolean" ? "abc" : typeof old === "string" ? 42 : null;
        check(base, path, "change type");
        parent[key] = old;
      }
      const { path, obj } = objects[seed % objects.length]!;
      obj["extra"] = 1;
      check(base, path === "" ? "extra" : `${path}.extra`, "add key");
      delete obj["extra"];
      expect(shapeDiff("t", expected, normalize(base)), `seed ${seed} restored`).toEqual([]);
    }
    expect(mutations).toBeGreaterThan(600);
  });

  it("Эталон форм ответов инструментов: snapshots of the tools equal the golden files and carry no unstable values", async () => {
    const run = async () => collectResponses(await connect(tmp()));
    const first = await run();
    if (process.env["UPDATE_MCP_GOLDEN"] === "1") writeGolden(first); // a dedicated change only: rewrites the reference files
    expect(compareWithGolden(first)).toEqual([]);
    // a second run in another data folder at another time: the same result
    expect(await run()).toEqual(first);
    const text = JSON.stringify(first);
    expect(text).not.toMatch(/\d{8}-\d{6}-|\d{4}-\d{2}-\d{2}T|"\/|korat|\/Users\//);
  }, 120_000);
});
