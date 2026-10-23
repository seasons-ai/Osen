import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { resolveDataDir } from "./data-dir.ts";
import { cliEnv, envFilePath, loadEnv } from "./env.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "council-"));
  dirs.push(d);
  return d;
};
const put = (file: string, text: string) => writeFileSync(file, text);
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadEnv", () => {
  it("takes the variable from the data folder's .env", () => {
    const data = tmp();
    put(envFilePath(data), "KEY=data\n");
    expect(loadEnv({ COUNCIL_HOME: data }, tmp()).KEY).toBe("data");
  });

  it("takes the variable from the cwd folder's .env", () => {
    const cwd = tmp();
    put(join(cwd, ".env"), "KEY=cwd\n");
    expect(loadEnv({ COUNCIL_HOME: tmp() }, cwd).KEY).toBe("cwd");
  });

  it("process environment takes precedence over both files", () => {
    const data = tmp();
    const cwd = tmp();
    put(envFilePath(data), "KEY=data\n");
    put(join(cwd, ".env"), "KEY=cwd\n");
    expect(loadEnv({ COUNCIL_HOME: data, KEY: "proc" }, cwd).KEY).toBe("proc");
  });

  it("data folder file takes precedence over cwd file", () => {
    const data = tmp();
    const cwd = tmp();
    put(envFilePath(data), "KEY=data\n");
    put(join(cwd, ".env"), "KEY=cwd\n");
    expect(loadEnv({ COUNCIL_HOME: data }, cwd).KEY).toBe("data");
  });

  it("empty string in environment does not override the file", () => {
    const data = tmp();
    put(envFilePath(data), "KEY=data\n");
    expect(loadEnv({ COUNCIL_HOME: data, KEY: "" }, tmp()).KEY).toBe("data");
  });

  it("empty value in file does not get into the result and does not override a lower source", () => {
    const data = tmp();
    const cwd = tmp();
    put(envFilePath(data), "KEY=\nEMPTY=\n");
    put(join(cwd, ".env"), "KEY=cwd\n");
    const out = loadEnv({ COUNCIL_HOME: data }, cwd);
    expect(out.KEY).toBe("cwd");
    expect(out.EMPTY).toBeUndefined();
  });

  it("COUNCIL_HOME from the cwd folder's .env sets the data folder", () => {
    const data = tmp();
    const cwd = tmp();
    put(join(cwd, ".env"), `COUNCIL_HOME=${data}\n`);
    put(envFilePath(data), "KEY=data\n");
    expect(loadEnv({}, cwd).KEY).toBe("data");
  });

  it("without files returns the same environment without exceptions", () => {
    const env = { COUNCIL_HOME: tmp(), A: "1" };
    expect(loadEnv(env, tmp())).toEqual(env);
  });

  it("does not change the input object", () => {
    const data = tmp();
    put(envFilePath(data), "KEY=data\n");
    const env = { COUNCIL_HOME: data };
    loadEnv(env, tmp());
    expect(env).toEqual({ COUNCIL_HOME: data });
  });

  it("parses quotes and comments via parseEnv", () => {
    const data = tmp();
    put(envFilePath(data), '# комментарий\nKEY="a b"\n');
    const out = loadEnv({ COUNCIL_HOME: data }, tmp());
    expect(out.KEY).toBe("a b");
    expect(Object.keys(out).some((k) => k.startsWith("#"))).toBe(false);
  });
});

// Substitute HOME: these tests do not see the owner's real data folder. Platform and XDG are taken as for the process.
function withFakeHome<T>(home: string, run: (oldDir: string, osenDir: string) => T): T {
  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  try {
    if (homedir() !== home) throw new Error(`HOME не подменился: ${homedir()}`);
    const osenDir = resolveDataDir({});
    if (!osenDir.startsWith(home)) throw new Error(`путь по умолчанию вне подставного HOME: ${osenDir}`);
    return run(join(dirname(osenDir), "model-council"), osenDir);
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.XDG !== undefined) process.env.XDG_CONFIG_HOME = saved.XDG;
  }
}

describe("loadEnv and data folder move (substitute HOME)", () => {
  it("without COUNCIL_HOME reads .env from the moved folder", () => {
    const home = tmp();
    withFakeHome(home, (old, osen) => {
      mkdirSync(old, { recursive: true });
      put(join(old, ".env"), "KEY=migrated\n");
      expect(loadEnv({}, tmp()).KEY).toBe("migrated");
      expect(lstatSync(old).isSymbolicLink()).toBe(true);
      expect(existsSync(envFilePath(osen))).toBe(true);
    });
  });

  it.skipIf(process.getuid?.() === 0)("ошибка переноса не выбрасывается: .env папки данных не читается", () => {
    const home = tmp();
    withFakeHome(home, (old, osen) => {
      mkdirSync(old, { recursive: true });
      put(join(old, ".env"), "KEY=migrated\n");
      put(join(old, "config.json"), "{}");
      chmodSync(join(old, "config.json"), 0o000);
      try {
        expect(loadEnv({ A: "1" }, tmp())).toEqual({ A: "1" });
        expect(existsSync(osen)).toBe(false);
      } finally {
        chmodSync(join(old, "config.json"), 0o644);
      }
    });
  });
});

describe("cliEnv", () => {
  const setup = (dataText?: string, cwdText?: string) => {
    const dataDir = tmp();
    const cwd = tmp();
    if (dataText !== undefined) put(join(dataDir, ".env"), dataText);
    if (cwdText !== undefined) put(join(cwd, ".env"), cwdText);
    return { dataDir, cwd };
  };

  it("removes data-folder .env keys absent in the shell and keeps the rest", () => {
    const { dataDir, cwd } = setup("K_A=1\nK_B=2\n");
    const out = cliEnv({ K_A: "1", K_B: "2", PATH: "/bin", HOME: "/h" }, { dataDir, cwd, shell: { PATH: "/bin" } });
    expect(out).toEqual({ PATH: "/bin", HOME: "/h" });
  });

  it("keeps a key that is also set in the shell, with the env value", () => {
    const { dataDir, cwd } = setup("K_A=file\n");
    expect(cliEnv({ K_A: "shell" }, { dataDir, cwd, shell: { K_A: "shell" } })).toEqual({ K_A: "shell" });
  });

  it("removes a key that is empty in the shell", () => {
    const { dataDir, cwd } = setup("K_A=file\n");
    expect(cliEnv({ K_A: "file", X: "1" }, { dataDir, cwd, shell: { K_A: "" } })).toEqual({ X: "1" });
  });

  it("removes a key from the cwd .env", () => {
    const { dataDir, cwd } = setup(undefined, "K_C=1\n");
    expect(cliEnv({ K_C: "1", X: "1" }, { dataDir, cwd, shell: {} })).toEqual({ X: "1" });
  });

  it("without dataDir only the cwd .env is read", () => {
    const { dataDir, cwd } = setup("K_A=1\n", "K_C=1\n");
    expect(cliEnv({ K_A: "1", K_C: "1" }, { cwd, shell: {} })).toEqual({ K_A: "1" });
    expect(dataDir).toBeTruthy();
  });

  it("does not change the input", () => {
    const { dataDir, cwd } = setup("K_A=1\n");
    const input = { K_A: "1", X: "2" };
    cliEnv(input, { dataDir, cwd, shell: {} });
    expect(input).toEqual({ K_A: "1", X: "2" });
  });

  it("property: result = env minus (file names minus non-empty shell names)", () => {
    let seed = 20261024;
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const names = Array.from({ length: 12 }, (_, i) => `PK_${i}`);
    const pick = () => names.filter(() => rnd() < 0.4);
    for (let i = 0; i < 60; i++) {
      const inFile = pick(), inEnv = pick(), inShell = pick();
      const shellEmpty = new Set(inShell.filter(() => rnd() < 0.3));
      const dataDir = tmp();
      put(join(dataDir, ".env"), inFile.map((n) => `${n}=v\n`).join(""));
      const env = Object.fromEntries(inEnv.map((n) => [n, "e"]));
      const shell = Object.fromEntries(inShell.map((n) => [n, shellEmpty.has(n) ? "" : "s"]));
      const out = cliEnv(env, { dataDir, cwd: tmp(), shell });
      const expected = Object.fromEntries(Object.entries(env).filter(([k]) => !inFile.includes(k) || (shell[k] ?? "") !== ""));
      expect(out).toEqual(expected);
    }
  });
});
