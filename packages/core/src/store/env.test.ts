import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { resolveDataDir } from "./data-dir.ts";
import { envFilePath, loadEnv } from "./env.ts";

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
