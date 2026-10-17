import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getProcessLanguage, setProcessLanguage, type Language } from "../i18n/index.ts";
import { resolveDataDir } from "./data-dir.ts";
import { loadEnv } from "./env.ts";
import {
  PREFERENCES_FILE, PreferencesWriteError, applyProcessLanguage, readPreferences, resolveLanguage, writeLanguage,
} from "./preferences.ts";

let dir: string;
const file = () => join(dir, PREFERENCES_FILE);
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "council-prefs-")); });
afterEach(() => {
  for (const p of [dir, join(dir, "ro")]) try { chmodSync(p, 0o755); } catch { /* none */ }
  try { chmodSync(file(), 0o644); } catch { /* none */ }
  rmSync(dir, { recursive: true, force: true });
});
const isRoot = process.getuid?.() === 0;

describe("order of language sources", () => {
  it("variable takes precedence over file", () => {
    writeFileSync(file(), '{"language":"en"}');
    expect(resolveLanguage({ COUNCIL_LANG: "ru" }, dir)).toEqual({ language: "ru", source: "env", invalid: null });
  });
  it("file takes precedence over default", () => {
    writeFileSync(file(), '{"language":"ru"}');
    expect(resolveLanguage({}, dir)).toEqual({ language: "ru", source: "file", invalid: null });
  });
  it.each(["de", "EN", "", " ru"])("variable value %j has no effect", (v) => {
    writeFileSync(file(), '{"language":"ru"}');
    expect(resolveLanguage({ COUNCIL_LANG: v }, dir).source).toBe("file");
    expect(resolveLanguage({ COUNCIL_LANG: v }, join(dir, "none"))).toEqual({ language: "en", source: "default", invalid: null });
  });
  it("nothing: en/default", () => {
    expect(resolveLanguage({}, dir)).toEqual({ language: "en", source: "default", invalid: null });
  });
  it("broken file: default and reason; with a correct variable the reason is also returned", () => {
    writeFileSync(file(), "{");
    expect(resolveLanguage({}, dir)).toEqual({ language: "en", source: "default", invalid: { reason: "not_json", code: null } });
    expect(resolveLanguage({ COUNCIL_LANG: "ru" }, dir)).toMatchObject({ language: "ru", source: "env", invalid: { reason: "not_json" } });
  });
  it("COUNCIL_LANG from the data folder's .env (real loadEnv)", () => {
    writeFileSync(join(dir, ".env"), "COUNCIL_LANG=ru\n");
    const env = loadEnv({ COUNCIL_HOME: dir }, mkdtempSync(join(tmpdir(), "council-cwd-")));
    expect(resolveLanguage(env, dir)).toMatchObject({ language: "ru", source: "env" });
  });
});

describe("readPreferences", () => {
  it("no file", () => expect(readPreferences(dir)).toEqual({ state: "absent" }));
  it("not JSON", () => {
    writeFileSync(file(), "не json");
    expect(readPreferences(dir)).toEqual({ state: "invalid", reason: "not_json", code: null });
  });
  it.each(["{}", "[]", "null", "5"])("no language: %s", (c) => {
    writeFileSync(file(), c);
    expect(readPreferences(dir)).toEqual({ state: "invalid", reason: "no_language", code: null });
  });
  it("unknown language", () => {
    writeFileSync(file(), '{"language":"de"}');
    expect(readPreferences(dir)).toEqual({ state: "invalid", reason: "unknown_language", code: null });
  });
  it.skipIf(isRoot)("нет прав на чтение", () => {
    writeFileSync(file(), '{"language":"ru"}');
    chmodSync(file(), 0o000);
    expect(readPreferences(dir)).toEqual({ state: "invalid", reason: "unreadable", code: "EACCES" });
  });
  it("reading and detection do not create file and folder", () => {
    const none = join(dir, "none");
    readPreferences(none);
    resolveLanguage({}, none);
    expect(existsSync(none)).toBe(false);
    readPreferences(dir);
    expect(existsSync(file())).toBe(false);
    writeFileSync(file(), "{ мусор");
    const before = readFileSync(file());
    readPreferences(dir); resolveLanguage({}, dir);
    expect(readFileSync(file()).equals(before)).toBe(true);
  });
});

describe("writeLanguage", () => {
  it("writes exactly one key; repeat and broken file are replaced", () => {
    writeFileSync(file(), "мусор");
    writeLanguage(dir, "ru");
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ language: "ru" });
    writeLanguage(dir, "en");
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ language: "en" });
    expect(readPreferences(dir)).toEqual({ state: "loaded", language: "en" });
    expect(readdirSync(dir)).toEqual([PREFERENCES_FILE]);
  });
  it.skipIf(isRoot)("файл только для чтения: отказ, байты прежние, нет tmp", () => {
    writeFileSync(file(), '{"language":"ru"}');
    chmodSync(file(), 0o444);
    const before = readFileSync(file());
    let err: unknown;
    try { writeLanguage(dir, "en"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(PreferencesWriteError);
    expect((err as PreferencesWriteError).code).toBe("EACCES");
    expect((err as Error).message).not.toContain(dir);
    expect(readFileSync(file()).equals(before)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
  it.skipIf(isRoot)("папка только для чтения: отказ, ничего не появилось", () => {
    const ro = join(dir, "ro");
    mkdirSync(ro);
    chmodSync(ro, 0o555);
    expect(() => writeLanguage(ro, "ru")).toThrow(PreferencesWriteError);
    expect(readdirSync(ro)).toEqual([]);
  });
});

describe("applyProcessLanguage", () => {
  const saved = getProcessLanguage();
  afterEach(() => setProcessLanguage(saved));
  it("COUNCIL_LANG=ru, no data folder: language ru, folder not created", () => {
    const home = join(dir, "nonexistent");
    setProcessLanguage("en");
    expect(applyProcessLanguage({ COUNCIL_HOME: home, COUNCIL_LANG: "ru" }).source).toBe("env");
    expect(getProcessLanguage()).toBe("ru");
    expect(existsSync(home)).toBe(false);
  });
  it("neither variable nor file: en", () => {
    setProcessLanguage("ru");
    applyProcessLanguage({ COUNCIL_HOME: join(dir, "nonexistent") });
    expect(getProcessLanguage()).toBe("en");
  });
  it("file in data folder sets process language", () => {
    writeLanguage(dir, "ru");
    setProcessLanguage("en");
    applyProcessLanguage({ COUNCIL_HOME: dir });
    expect(getProcessLanguage()).toBe("ru");
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

describe("applyProcessLanguage and data folder move (substitute HOME)", () => {
  const saved = getProcessLanguage();
  afterEach(() => setProcessLanguage(saved));
  it("without COUNCIL_HOME reads preferences.json from the moved folder", () => {
    withFakeHome(dir, (old, osen) => {
      mkdirSync(old, { recursive: true });
      writeLanguage(old, "ru");
      setProcessLanguage("en");
      expect(applyProcessLanguage({}).source).toBe("file");
      expect(getProcessLanguage()).toBe("ru");
      expect(lstatSync(old).isSymbolicLink()).toBe(true);
      expect(existsSync(join(osen, PREFERENCES_FILE))).toBe(true);
    });
  });
  it.skipIf(isRoot)("ошибка переноса не выбрасывается: остаётся умолчание", () => {
    withFakeHome(dir, (old, osen) => {
      mkdirSync(old, { recursive: true });
      writeLanguage(old, "ru");
      writeFileSync(join(old, "config.json"), "{}");
      chmodSync(join(old, "config.json"), 0o000);
      try {
        setProcessLanguage("ru");
        expect(applyProcessLanguage({}).source).toBe("default");
        expect(getProcessLanguage()).toBe("en");
        expect(existsSync(osen)).toBe(false);
      } finally {
        chmodSync(join(old, "config.json"), 0o644);
      }
    });
  });
  // Move failure: an allowed COUNCIL_LANG from the environment applies, the old folder's preferences.json is not read.
  it.skipIf(isRoot).each([
    ["ru", "ru", "env"],
    ["en", "en", "env"],
    ["de", "en", "default"],
    [undefined, "en", "default"],
  ] as const)("ошибка переноса при COUNCIL_LANG=%j и файле ru: %s/%s", (v, lang, source) => {
    withFakeHome(dir, (old, osen) => {
      mkdirSync(old, { recursive: true });
      writeLanguage(old, "ru");
      writeFileSync(join(old, "config.json"), "{}");
      chmodSync(join(old, "config.json"), 0o000);
      try {
        setProcessLanguage(lang === "ru" ? "en" : "ru");
        expect(applyProcessLanguage(v === undefined ? {} : { COUNCIL_LANG: v })).toEqual({ language: lang, source, invalid: null });
        expect(getProcessLanguage()).toBe(lang);
        expect(existsSync(osen)).toBe(false);
      } finally {
        chmodSync(join(old, "config.json"), 0o644);
      }
    });
  });
});

describe("source order: property on generated inputs", () => {
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  it("500 cases", () => {
    const r = rng(20261012);
    const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)]!;
    const junk = () => Array.from({ length: 1 + Math.floor(r() * 12) }, () => String.fromCharCode(32 + Math.floor(r() * 200))).join("");
    for (let i = 0; i < 500; i++) {
      const v = pick<string | undefined>([undefined, "en", "ru", "EN", "de", "", " ru", junk()]);
      const f = pick<string | null>([null, '{"language":"en"}', '{"language":"ru"}', "{", "{}", '{"language":"de"}', junk()]);
      const home = join(dir, `c${i}`);
      mkdirSync(home);
      if (f !== null) writeFileSync(join(home, PREFERENCES_FILE), f);
      const before = f === null ? null : readFileSync(join(home, PREFERENCES_FILE));
      const res = resolveLanguage(v === undefined ? {} : { COUNCIL_LANG: v }, home);
      const fileLang: Language | null = f === '{"language":"en"}' ? "en" : f === '{"language":"ru"}' ? "ru" : null;
      const envLang: Language | null = v === "en" || v === "ru" ? v : null;
      const want = envLang ? [envLang, "env"] : fileLang ? [fileLang, "file"] : ["en", "default"];
      expect([res.language, res.source], `env=${JSON.stringify(v)} file=${JSON.stringify(f)}`).toEqual(want);
      expect(["en", "ru"]).toContain(res.language);
      if (before === null) expect(existsSync(join(home, PREFERENCES_FILE))).toBe(false);
      else expect(readFileSync(join(home, PREFERENCES_FILE)).equals(before)).toBe(true);
    }
  });
  // Through applyProcessLanguage in a substitute HOME: the outcome of prepareDataDir (move succeeded or failed) is part of the input.
  it.skipIf(isRoot)("через applyProcessLanguage с исходом переноса: полный перебор и 100 случайных", () => {
    const r = rng(20261016);
    const vs: (string | undefined)[] = [undefined, "en", "ru", "de", "", "  ", "RU"];
    const fs: (string | null)[] = [null, '{"language":"ru"}', '{"language":"en"}', "{"];
    const cases: [string | undefined, boolean, string | null][] = [];
    for (const v of vs) for (const fail of [false, true]) for (const f of fs) cases.push([v, fail, f]);
    for (let i = 0; i < 100; i++) cases.push([vs[Math.floor(r() * vs.length)], r() < 0.5, fs[Math.floor(r() * fs.length)]!]);
    const saved = getProcessLanguage();
    try {
      cases.forEach(([v, fail, f], i) => {
        withFakeHome(join(dir, `h${i}`), (old) => {
          mkdirSync(old, { recursive: true });
          if (f !== null) writeFileSync(join(old, PREFERENCES_FILE), f);
          const cfg = join(old, "config.json");
          writeFileSync(cfg, "{}");
          if (fail) chmodSync(cfg, 0o000);
          try {
            const res = applyProcessLanguage(v === undefined ? {} : { COUNCIL_LANG: v });
            const envLang: Language | null = v === "en" || v === "ru" ? v : null;
            const fileLang: Language | null = fail ? null : f === '{"language":"ru"}' ? "ru" : f === '{"language":"en"}' ? "en" : null;
            const want = envLang ? [envLang, "env"] : fileLang ? [fileLang, "file"] : ["en", "default"];
            expect([res.language, res.source], `env=${JSON.stringify(v)} fail=${fail} file=${JSON.stringify(f)}`).toEqual(want);
            expect(getProcessLanguage()).toBe(want[0]);
          } finally {
            if (fail) chmodSync(cfg, 0o644);
          }
        });
      });
    } finally { setProcessLanguage(saved); }
  });
});
