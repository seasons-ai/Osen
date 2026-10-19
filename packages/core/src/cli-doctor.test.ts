import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { main } from "./cli.ts";
import type { CliIo } from "./cli.ts";
import { setProcessLanguage } from "./i18n/index.ts";
import { configPath, initialRegistry } from "./registry/config.ts";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "council-doctor-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
afterEach(() => setProcessLanguage("ru"));

async function run(argv: string[], home: string, over: Partial<CliIo> = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, {
    stdout: (t) => out.push(t), stderr: (t) => err.push(t),
    env: { COUNCIL_HOME: home, COUNCIL_DEV: "1" },
    inspectDeps: { locate: async (agent) => ({ agent, found: false, searchPath: "", reason: `Команда ${agent} не найдена` }) },
    ...over,
  });
  return { code, out, err: err.join("\n") };
}
const doc = (r: { out: string[] }) => { expect(r.out).toHaveLength(1); return JSON.parse(r.out[0]!); };

describe("council doctor", () => {
  it("healthy install: one document, binary, runtime, data dir existence and config creation", async () => {
    const home = join(tmp(), "fresh");
    const a = await run(["doctor", "--json"], home);
    expect(a.code).toBe(0);
    expect(a.err).toBe("");
    const d = doc(a);
    expect(Object.keys(d)).toEqual(["schemaVersion", "binary", "runtime", "language", "dataDir", "config", "providers"]);
    expect(d.binary.execPath).toBe(process.execPath);
    expect(d.runtime).toEqual({ mode: "node", node: process.versions.node });
    expect(d.dataDir).toEqual({ path: home, exists: false, writable: true });
    expect(d.config).toEqual({ path: configPath(home), created: true });
    expect(existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")) : []).toEqual([]);
    const b = doc(await run(["doctor", "--json"], home));
    expect([b.dataDir.exists, b.config.created]).toEqual([true, false]);
  });

  it("binary version comes from the entry point and is null without it", async () => {
    const home = tmp();
    expect(doc(await run(["doctor", "--json"], home, { appVersion: "1.2.3" })).binary.version).toBe("1.2.3");
    expect(doc(await run(["doctor", "--json"], home)).binary.version).toBeNull();
  });

  it("packaged mode is detected by the Electron version in process versions", async () => {
    const d = doc(await run(["doctor", "--json"], tmp(), { processVersions: { node: "x", electron: "38.0.0" } }));
    expect(d.runtime).toEqual({ mode: "packaged", node: "x" });
  });

  it("unavailable provider keeps code 0; a warning is in the field and in stderr, stdout is one document", async () => {
    const home = tmp();
    writeFileSync(configPath(home), JSON.stringify(initialRegistry(["claude", "codex"])));
    const r = await run(["doctor", "--json"], home);
    expect(r.code).toBe(0);
    const p = doc(r).providers;
    expect(p.map((x: { available: boolean }) => x.available)).toEqual([false, false]);
    expect(p[0].reason).not.toBeNull();
    const w = await run(["doctor", "--json"], home, {
      inspectDeps: {
        locate: async (agent) => agent === "claude" ? { agent, found: true, path: "/nope/claude", version: "9", searchPath: "", warning: "newer than tested" } : { agent, found: false, searchPath: "", reason: "nf" },
        listModels: async () => ({ models: [], confirmed: false, reason: "none" }), readHelp: async () => "",
      },
    });
    expect(w.code).toBe(0);
    expect(doc(w).providers[0].warning).toBe("newer than tested");
    expect(w.err).toContain("newer than tested");
    const text = await run(["doctor"], home, { inspectDeps: { locate: async (agent) => ({ agent, found: true, path: "/nope/x", version: "9", searchPath: "", warning: "newer than tested" }), listModels: async () => ({ models: [], confirmed: false }), readHelp: async () => "" } });
    expect(text.err).toContain("newer than tested");
    expect(text.out.join("\n")).not.toContain("newer than tested");
  });

  it("inaccessible data dir gives the same code as providers, empty stdout and a reason", async () => {
    const parent = tmp(), file = join(parent, "file");
    writeFileSync(file, "x");
    const home = join(file, "sub");
    const d = await run(["doctor", "--json"], home), p = await run(["providers"], home);
    expect(d.code).toBe(1);
    expect(d.code).toBe(p.code);
    expect(d.out).toEqual([]);
    expect(d.err).not.toBe("");
    const locked = join(tmp(), "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const r = await run(["doctor", "--json"], join(locked, "home"));
      expect([r.code, r.out]).toEqual([(await run(["providers"], join(locked, "home"))).code, []]);
    } finally { chmodSync(locked, 0o755); }
  });

  it("language: text labels follow the language, JSON differs only in the language field", async () => {
    const home = tmp();
    setProcessLanguage("en");
    const enText = (await run(["doctor"], home)).out.join("\n"), enJson = doc(await run(["doctor", "--json"], home));
    setProcessLanguage("ru");
    const ruText = (await run(["doctor"], home)).out.join("\n"), ruJson = doc(await run(["doctor", "--json"], home));
    expect(enText).toContain("Data folder:");
    expect(ruText).toContain("Папка данных:");
    expect([enJson.language, ruJson.language]).toEqual(["en", "ru"]);
    expect({ ...enJson, language: "" }).toEqual({ ...ruJson, language: "" });
  });

  it("extra positional arguments are refused with code 2", async () => {
    expect((await run(["doctor", "extra"], tmp())).code).toBe(2);
  });

  it("text output contains the data dir and config paths", async () => {
    const home = tmp();
    const out = (await run(["doctor"], home)).out.join("\n");
    expect(out).toContain(home);
    expect(out).toContain(configPath(home));
  });

  it("the council entry point passes the app version and the script path", () => {
    const entry = join(import.meta.dirname, "council.ts");
    const r = spawnSync(process.execPath, [entry, "doctor", "--json"], { env: { ...process.env, COUNCIL_HOME: tmp(), COUNCIL_DEV: "1" }, encoding: "utf8", stdin: "ignore" } as never);
    const d = JSON.parse(r.stdout);
    const version = JSON.parse(readFileSync(join(import.meta.dirname, "../../../apps/desktop/package.json"), "utf8")).version;
    expect(d.binary.version).toBe(version);
    expect(d.binary.entry.endsWith("council.ts")).toBe(true);
  });
});
