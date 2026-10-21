import { mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { configPath, initialRegistry, listSessions, readSession, requestStop } from "@model-council/core";
import { checkProtocol, checkSdkPin, collectResponses, compareWithGolden, EXPECTED_PROTOCOL_VERSION, GOLDEN_DIR, normalize, shapeDiff, writeGolden } from "./contract.ts";

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

const tmp = (prefix = "council-") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
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

describe("Проверка контракта после обновления хост-агента", () => {
  it("Проверка контракта после обновления хост-агента: сервер завершился до ответа", async () => {
    const empty = mkdtempSync(join(tmpdir(), "no-server-"));
    dirs.push(empty);
    const t0 = Date.now();
    const findings = await checkProtocol(empty, { ...baseEnv, COUNCIL_HOME: tmp(), COUNCIL_DEV: "1" });
    expect(Date.now() - t0).toBeLessThan(20_000);
    const failed = findings.filter((f) => !f.ok);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.detail).toMatch(/exited/);
  }, 25_000);

  it("Проверка контракта после обновления хост-агента: сервер не запустился (нет корня)", async () => {
    const t0 = Date.now();
    const findings = await checkProtocol(join(tmpdir(), "no-such-root-188"), { ...baseEnv, COUNCIL_HOME: tmp(), COUNCIL_DEV: "1" });
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(findings.filter((f) => !f.ok).length).toBeGreaterThan(0);
    expect(findings[0]!.detail).toMatch(/ENOENT/);
  }, 25_000);

  it("Проверка контракта после обновления хост-агента: ответ initialize, разрезанный посреди многобайтного знака", async () => {
    const fake = mkdtempSync(join(tmpdir(), "split-server-"));
    dirs.push(fake);
    mkdirSync(join(fake, "packages/mcp/src"), { recursive: true });
    // the reply is written in two chunks; the split falls inside the 2-byte "с" of the server name
    writeFileSync(join(fake, "packages/mcp/src/main.ts"), `
      const line = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25", serverInfo: { name: "осень", version: "0" }, capabilities: {} } }) + "\\n");
      const cut = line.indexOf(Buffer.from("с")) + 1;
      process.stdin.once("data", () => {
        process.stdout.write(line.subarray(0, cut));
        setTimeout(() => process.stdout.write(line.subarray(cut)), 100);
      });
      process.stdin.on("end", () => process.exit(0));
    `);
    const findings = await checkProtocol(fake, { ...baseEnv, COUNCIL_HOME: tmp(), COUNCIL_DEV: "1" });
    expect(findings.find((f) => f.check === "server name")!.detail).toBe("expected osen, got осень");
  }, 25_000);
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
    expect(pin("^1.32.1", "1.32.1")).toEqual(['@modelcontextprotocol/sdk in dependencies is "^1.32.1", expected an exact version without a range']);
    expect(pin("~1.32.1", "1.32.1")[0]).toContain("@modelcontextprotocol/sdk");
    expect(pin("1.32.0", "1.32.1")).toEqual(["@modelcontextprotocol/sdk in dependencies is 1.32.0, lock file has 1.32.1"]);
    expect(pin("1.32.1", "1.32.1")).toEqual([]);
  });

  it("Точная версия SDK: SDK в другом разделе зависимостей", () => {
    const pin = (section: string, range: string) => {
      const d = mkdtempSync(join(tmpdir(), "sdk-pin-"));
      dirs.push(d);
      mkdirSync(join(d, "packages/mcp"), { recursive: true });
      writeFileSync(join(d, "packages/mcp/package.json"), JSON.stringify({ [section]: { "@modelcontextprotocol/sdk": range } }));
      writeFileSync(join(d, "package-lock.json"), JSON.stringify({ packages: { "node_modules/@modelcontextprotocol/sdk": { version: "1.32.1" } } }));
      return checkSdkPin(d).filter((f) => !f.ok).map((f) => f.detail);
    };
    expect(pin("devDependencies", "^1.32.1")).toEqual(['@modelcontextprotocol/sdk in devDependencies is "^1.32.1", expected an exact version without a range']);
    expect(pin("peerDependencies", "1.32.0")).toEqual(["@modelcontextprotocol/sdk in peerDependencies is 1.32.0, lock file has 1.32.1"]);
    expect(pin("optionalDependencies", "1.32.1")).toEqual([]);
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
    // free text keeps its wording; only the embedded session id, time and path vary
    text: () => `free text for ${num(8)}-${num(6)}-${hex(4)} at ${new Date(1.6e12 + Math.floor(v() * 1e10)).toISOString()} in /Users/${hex(6)}/my data/${hex(4)} with spaces`,
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

  it("Эталон форм ответов инструментов: изменён текст подсказки", () => {
    const golden = JSON.parse(readFileSync(join(GOLDEN_DIR, "council_start.json"), "utf8")) as { body: { next: string } };
    const mutant = JSON.parse(JSON.stringify(golden)) as typeof golden;
    mutant.body.next = `${mutant.body.next} (changed)`;
    const d = shapeDiff("council_start", golden, normalize(mutant));
    expect(d.some((l) => l.startsWith("council_start: ") && l.includes("body.next"))).toBe(true);
  });

  it("Эталон форм ответов инструментов: изменён тип нестабильного значения", () => {
    const golden = JSON.parse(readFileSync(join(GOLDEN_DIR, "council_stop.json"), "utf8")) as { body: { stats: { durationMs: unknown } } };
    expect(golden.body.stats.durationMs).toBe("<duration>");
    const mutant = JSON.parse(JSON.stringify(golden)) as typeof golden;
    mutant.body.stats.durationMs = "123";
    const d = shapeDiff("council_stop", golden, normalize(mutant));
    expect(d.some((l) => l.startsWith("council_stop: ") && l.includes("body.stats.durationMs") && l.includes("string") && l.includes("number")), d.join("; ")).toBe(true);
    // a pid has no entry in the goldens: the same rule on a synthetic response
    const d2 = shapeDiff("t", normalize({ body: { pid: 42 } }), normalize({ body: { pid: "42" } }));
    expect(d2.some((l) => l.includes("body.pid") && l.includes("string") && l.includes("number")), d2.join("; ")).toBe(true);
  });

  it("Эталон форм ответов инструментов: unstable parts inside a text are masked, the wording is compared", () => {
    const n = (t: string) => normalize({ next: t });
    const text = (id: string, at: string, dir: string) => `Session ${id} at ${at} is in ${dir}`;
    expect(n(text("20200101-000000-ab12", "2026-01-01T10:00:00.000Z", "/tmp/my data/x y/"))).toEqual(n(text("20260202-111111-cd34", "2027-05-05T01:02:03Z", "/Users/o/other folder/")));
    expect(n("see contract/p1.json and и/или")).toEqual({ next: "see contract/p1.json and и/или" });
    // the wording after an embedded path is still compared
    expect(n("Folder /Users/o/my data/x — done. Round 3 finished.")).not.toEqual(n("Folder /Users/o/my data/x — CHANGED. Round 4 finished."));
    expect(n("Folder /Users/o/my data/x — done.")).toEqual(n("Folder /var/t/other folder/y — done."));
    expect(n("Session 20200101-000000-ab12")).not.toEqual(n("Sessions 20200101-000000-ab12"));
  });

  it("Эталон форм ответов инструментов: snapshots of the tools equal the golden files and carry no unstable values", async () => {
    const run = async () => collectResponses(await connect(tmp()));
    const first = await run();
    if (process.env["UPDATE_MCP_GOLDEN"] === "1") writeGolden(first); // a dedicated change only: rewrites the reference files
    expect(compareWithGolden(first)).toEqual([]);
    // a second run in another data folder (its name has a space) at another time: the same result
    expect(await collectResponses(await connect(tmp("council space-")))).toEqual(first);
    const text = JSON.stringify(first);
    expect(text).not.toMatch(/\d{8}-\d{6}-|\d{4}-\d{2}-\d{2}T|"\/|korat|\/Users\//);
  }, 120_000);
});
