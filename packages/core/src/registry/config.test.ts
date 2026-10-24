import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RegistryError, RegistrySchema, configPath, createRegistry, initialRegistry, logRegistryLoaded, readRegistry, removeProvider, writeRegistry } from "./config.ts";
import { createLogger } from "../store/log.ts";

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "council-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const write = (dir: string, v: unknown) => writeFileSync(configPath(dir), typeof v === "string" ? v : JSON.stringify(v));
const withReg = (mut: (r: any) => void) => {
  const r: any = structuredClone(initialRegistry(["claude", "codex"]));
  mut(r);
  const dir = tmp();
  write(dir, r);
  return dir;
};
const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RegistryError);
    return (e as Error).message;
  }
  throw new Error("ошибка не брошена");
};

describe("participant registry config.json", () => {
  it("1. no file, two agents: created and read", () => {
    const dir = tmp();
    expect(createRegistry(dir, ["claude", "codex"])).toBe("created");
    const r = readRegistry(dir);
    expect(r.providers.map((p) => p.id)).toEqual(["claude", "codex"]);
    expect(r.providers[0]).toMatchObject({ kind: "cli", label: "Claude Code", agent: "claude", models: [] });
    expect(r.defaults.participants).toEqual([{ providerId: "claude", model: "default" }, { providerId: "codex", model: "default" }]);
    expect(readFileSync(configPath(dir), "utf8").endsWith("}\n")).toBe(true);
  });

  it("2. no file, no agents: empty registry is read", () => {
    const dir = tmp();
    expect(createRegistry(dir, [])).toBe("created");
    const r = readRegistry(dir);
    expect(r.providers).toEqual([]);
    expect(r.defaults.participants).toEqual([]);
  });

  it("3. file exists (including invalid): exists, same bytes", () => {
    const dir = tmp();
    write(dir, "{ не json");
    expect(createRegistry(dir, ["claude"])).toBe("exists");
    expect(readFileSync(configPath(dir), "utf8")).toBe("{ не json");
    write(dir, initialRegistry(["codex"]));
    const before = readFileSync(configPath(dir));
    expect(createRegistry(dir, ["claude"])).toBe("exists");
    expect(readFileSync(configPath(dir)).equals(before)).toBe(true);
  });

  it("4. round limit as a string: field and expected form", () => {
    const m = message(() => readRegistry(withReg((r) => (r.defaults.maxRounds = "5"))));
    expect(m).toMatch(/^config\.json: /);
    expect(m).toContain("defaults.maxRounds");
    expect(m).toContain("ожидается число");
    expect(RegistrySchema.safeParse(JSON.parse('{"providers":[],"defaults":{"maxRounds":"5"}}')).success).toBe(false);
  });

  it("4a. turnTimeoutSec: 2147483 is read, 2147484 — error with path and bound, file untouched (change 108)", () => {
    expect(readRegistry(withReg((r) => (r.defaults.turnTimeoutSec = 2147483))).defaults.turnTimeoutSec).toBe(2147483);
    const dir = withReg((r) => (r.defaults.turnTimeoutSec = 2147484));
    const before = readFileSync(configPath(dir), "utf8");
    const m = message(() => readRegistry(dir));
    expect(m).toContain("defaults.turnTimeoutSec");
    expect(m).toContain("2147483");
    expect(readFileSync(configPath(dir), "utf8")).toBe(before);
  });

  it("5. duplicate identifier", () => {
    const m = message(() => readRegistry(withReg((r) => (r.providers[1].id = "claude"))));
    expect(m).toContain("повторяющийся идентификатор провайдера «claude»");
    expect(m).toContain("providers.1.id");
  });

  it("6. openai-http: apiKeyEnv is read, apiKey is rejected", () => {
    const http = { id: "gpt", kind: "openai-http", label: "GPT", baseUrl: "https://api.example.com/v1", apiKeyEnv: "GPT_KEY", models: ["m1"] };
    const ok = withReg((r) => r.providers.push(http));
    expect(readRegistry(ok).providers[2]).toMatchObject({ apiKeyEnv: "GPT_KEY" });
    const bad = withReg((r) => r.providers.push({ ...http, apiKey: "sk-secret" }));
    const m = message(() => readRegistry(bad));
    expect(m).toContain("apiKey");
    expect(m).toContain("лишнее поле");
  });

  it("openai-http: key optional, scheme and address checked", () => {
    const http = { id: "gpt", kind: "openai-http", label: "GPT", baseUrl: "https://api.example.com/v1", models: [] };
    const ok = (extra: object) => RegistrySchema.safeParse({ ...initialRegistry([]), providers: [{ ...http, ...extra }] }).success;
    expect(ok({})).toBe(true);
    expect(ok({ apiKeyEnv: "" })).toBe(true);
    expect(ok({ apiKeyEnv: "lower" })).toBe(false);
    expect(ok({ baseUrl: "ftp://x" })).toBe(false);
    expect(ok({ apiKey: "sk-secret" })).toBe(false);
    const m = message(() => readRegistry(withReg((r) => r.providers.push({ ...http, apiKeyEnv: "lower" }))));
    expect(m).toContain("providers.2.apiKeyEnv");
  });

  it("7. changed maxRounds is read", () => {
    const dir = withReg((r) => (r.defaults.maxRounds = 9));
    expect(readRegistry(dir).defaults.maxRounds).toBe(9);
  });

  it("8a. file not found", () => {
    const dir = tmp();
    expect(message(() => readRegistry(dir))).toBe(`config.json: файл не найден — ${configPath(dir)}`);
  });

  it("8b. broken JSON", () => {
    const dir = tmp();
    write(dir, "{ oops");
    expect(message(() => readRegistry(dir))).toMatch(/^config\.json: не JSON — .+/);
  });

  it("8c. unknown providerId in defaults", () => {
    const m = message(() => readRegistry(withReg((r) => (r.defaults.participants[0].providerId = "ghost"))));
    expect(m).toContain("defaults.participants.0.providerId");
    expect(m).toContain("ghost");
  });

  it("8d. id scripted is forbidden", () => {
    const m = message(() => readRegistry(withReg((r) => (r.providers[0].id = "scripted"))));
    expect(m).toContain("providers.0.id");
    expect(m).toContain("scripted");
  });

  it("participants above limit: both numbers named", () => {
    const m = message(() => readRegistry(withReg((r) => (r.defaults.maxParticipants = 2, r.defaults.participants.push({ providerId: "claude", model: "default" })))));
    expect(m).toContain("3");
    expect(m).toContain("maxParticipants = 2");
  });

  it("parsing: empty string, non-integer, invalid kind", () => {
    expect(message(() => readRegistry(withReg((r) => (r.providers[0].label = ""))))).toContain("providers.0.label: ожидается непустая строка");
    expect(message(() => readRegistry(withReg((r) => (r.defaults.maxRounds = 1.5))))).toContain("defaults.maxRounds");
    expect(message(() => readRegistry(withReg((r) => (r.providers[0].kind = "x"))))).toContain("providers.0");
  });
});

describe("registry write and provider removal", () => {
  const bytes = (dir: string) => readFileSync(configPath(dir), "utf8");
  const tmpLeft = (dir: string) => existsSync(`${configPath(dir)}.tmp`);

  it("writing a valid registry reads back", () => {
    const dir = withReg(() => {});
    const next: any = structuredClone(initialRegistry(["claude"]));
    next.defaults.maxRounds = 7;
    expect(writeRegistry(dir, next)).toEqual(next);
    expect(readRegistry(dir)).toEqual(next);
    expect(bytes(dir).endsWith("}\n")).toBe(true);
    expect(tmpLeft(dir)).toBe(false);
  });

  it("invalid registry: error with field path, file untouched", () => {
    const dir = withReg(() => {});
    const before = bytes(dir);
    const bad: any = structuredClone(initialRegistry(["claude"]));
    bad.defaults.maxRounds = 0;
    expect(message(() => writeRegistry(dir, bad))).toContain("defaults.maxRounds");
    bad.defaults.maxRounds = 5;
    bad.defaults.participants[0].providerId = "ghost";
    expect(message(() => writeRegistry(dir, bad))).toContain("defaults.participants.0.providerId");
    expect(bytes(dir)).toBe(before);
    expect(tmpLeft(dir)).toBe(false);
  });

  it("read-only file: write failed, content unchanged", () => {
    const dir = withReg(() => {});
    const before = bytes(dir);
    chmodSync(configPath(dir), 0o444);
    try {
      expect(message(() => writeRegistry(dir, initialRegistry(["codex"])))).toContain("не удалось записать");
      expect(bytes(dir)).toBe(before);
      expect(tmpLeft(dir)).toBe(false);
    } finally {
      chmodSync(configPath(dir), 0o644);
    }
  });

  it("read-only folder: error, content unchanged, no .tmp left", () => {
    const dir = withReg(() => {});
    const before = bytes(dir);
    chmodSync(dir, 0o555);
    try {
      expect(message(() => writeRegistry(dir, initialRegistry(["codex"])))).toContain("не удалось записать");
      expect(bytes(dir)).toBe(before);
      expect(tmpLeft(dir)).toBe(false);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it("removeProvider: removes from providers and participants, input intact", () => {
    const r = initialRegistry(["claude", "codex"]);
    const snap = structuredClone(r);
    const out = removeProvider(r, "claude");
    expect(out.providers.map((p) => p.id)).toEqual(["codex"]);
    expect(out.defaults.participants).toEqual([{ providerId: "codex", model: "default" }]);
    expect(r).toEqual(snap);
    expect(removeProvider(r, "nope")).toEqual(r);
  });
});

describe("materials: materialsIgnore and materialsChars", () => {
  const stripped = (mut?: (d: any) => void) => {
    const r: any = structuredClone(initialRegistry(["claude"]));
    delete r.defaults.materialsIgnore;
    delete r.defaults.materialsChars;
    mut?.(r.defaults);
    const dir = tmp();
    write(dir, r);
    return dir;
  };

  it("new file contains both fields with initial values", () => {
    const dir = tmp();
    createRegistry(dir, ["claude"]);
    const d = JSON.parse(readFileSync(configPath(dir), "utf8")).defaults;
    expect(d.materialsIgnore).toEqual(["node_modules", "dist", "build"]);
    expect(d.materialsChars).toBe(60000);
  });

  it("old file without fields: initial values in memory, file bytes unchanged", () => {
    const dir = stripped();
    const before = readFileSync(configPath(dir));
    const r = readRegistry(dir);
    expect(r.defaults.materialsIgnore).toEqual(["node_modules", "dist", "build"]);
    expect(r.defaults.materialsChars).toBe(60000);
    expect(readFileSync(configPath(dir)).equals(before)).toBe(true);
  });

  it("owner's values are read as written, empty list is allowed", () => {
    const d = readRegistry(stripped((x) => ((x.materialsIgnore = ["vendor"]), (x.materialsChars = 80000)))).defaults;
    expect([d.materialsIgnore, d.materialsChars]).toEqual([["vendor"], 80000]);
    expect(readRegistry(stripped((x) => (x.materialsIgnore = []))).defaults.materialsIgnore).toEqual([]);
  });

  it("materialsChars: 0, 1.5, string, 2**53 rejected with field name", () => {
    for (const v of [0, 1.5, "10", 2 ** 53]) {
      expect(message(() => readRegistry(stripped((x) => (x.materialsChars = v))))).toContain("defaults.materialsChars: ожидается");
    }
  });

  it("materialsIgnore: path, empty name, pattern, non-array rejected with field name", () => {
    for (const v of ["src/cache", "", "  ", "*.log", "a\\b", "a?"]) {
      expect(message(() => readRegistry(stripped((x) => (x.materialsIgnore = [v]))))).toContain(v === "" || v === "  " || /[/\\*?]/.test(v) ? "defaults.materialsIgnore.0: имя без путей и шаблонов" : "");
    }
    expect(message(() => readRegistry(stripped((x) => (x.materialsIgnore = "node_modules"))))).toContain("defaults.materialsIgnore: ожидается массив");
  });

  it("materialsIgnore: names with brackets, braces and a leading ! are accepted", () => {
    const names = ["[id]", "{a,b}", "!x"];
    expect(readRegistry(stripped((x) => (x.materialsIgnore = names))).defaults.materialsIgnore).toEqual(names);
  });

  it("writeRegistry returns and writes both fields; removeProvider keeps them", () => {
    const dir = tmp();
    const r: any = initialRegistry(["claude", "codex"]);
    r.defaults.materialsIgnore = ["vendor"];
    r.defaults.materialsChars = 80000;
    writeRegistry(dir, r);
    const back = readRegistry(dir);
    expect([back.defaults.materialsIgnore, back.defaults.materialsChars]).toEqual([["vendor"], 80000]);
    const out = removeProvider(back, "claude").defaults;
    expect([out.materialsIgnore, out.materialsChars]).toEqual([["vendor"], 80000]);
  });
});

describe("defaults.maxTotalTokens", () => {
  const dir = (mut?: (d: any) => void) => withReg((r) => mut?.(r.defaults));
  it("Old registry: field is optional, file is not overwritten", () => {
    const d = dir();
    const before = readFileSync(configPath(d), "utf8");
    expect(readRegistry(d).defaults.maxTotalTokens).toBeUndefined();
    expect(readFileSync(configPath(d), "utf8")).toBe(before);
  });
  it("20000 is read", () => {
    expect(readRegistry(dir((x) => (x.maxTotalTokens = 20000))).defaults.maxTotalTokens).toBe(20000);
  });
  it("0, -1, 1.5, string rejected with field name", () => {
    for (const v of [0, -1, 1.5, "abc"]) {
      expect(message(() => readRegistry(dir((x) => (x.maxTotalTokens = v))))).toContain("defaults.maxTotalTokens");
    }
  });
  it("initial registry contains no field", () => {
    expect("maxTotalTokens" in initialRegistry(["claude"]).defaults).toBe(false);
    const d = tmp();
    createRegistry(d, ["claude"]);
    expect(readFileSync(configPath(d), "utf8")).not.toContain("maxTotalTokens");
  });
});

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Common log: loading settings", () => {
  it("one entry per logger for any number of reads, no addresses or keys (500 cases)", () => {
    const secret = "sk-log-secret-value-117";
    const env = { LOG_SECRET_KEY: secret };
    const http = { id: "gpt", kind: "openai-http", label: "GPT", baseUrl: "http://log-secret-host.test:8787/v1", apiKeyEnv: "LOG_SECRET_KEY", models: ["m1"] };
    const dir = withReg((r) => r.providers.push(http));
    const registry = readRegistry(dir);
    const want = `Settings loaded: ${configPath(dir)}, providers: ${registry.providers.length}`;
    const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
    for (let seed = 1; seed <= 500; seed++) {
      const rnd = mulberry32(seed);
      const int = (n: number) => Math.floor(rnd() * n);
      const n = seed === 1 ? 0 : seed === 2 ? 1 : seed === 3 ? 50 : int(51);
      const loggers = Array.from({ length: 1 + int(3) }, (_, i) => {
        const d = join(dir, `run-${seed}-${i}`);
        return { file: join(d, "logs", "app.log"), logger: createLogger(d, "test", env), calls: 0 };
      });
      for (let k = 0; k < n; k++) {
        const l = loggers[seed === 3 ? 0 : int(loggers.length)]!;
        logRegistryLoaded(l.logger, dir, registry);
        l.calls++;
      }
      for (const l of loggers) {
        const got = lines(l.file);
        expect(got.length, `seed ${seed}`).toBe(l.calls > 0 ? 1 : 0);
        for (const line of got) {
          expect(line, `seed ${seed}`).toMatch(new RegExp(`^\\S+ INFO \\[test\\] `));
          expect(line.endsWith(want), `seed ${seed}`).toBe(true);
          for (const s of [secret, "log-secret-host", "LOG_SECRET_KEY", "[hidden]"]) expect(line, `seed ${seed}`).not.toContain(s);
        }
      }
    }
  });
});
