import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProcessLanguage, setProcessLanguage } from "@model-council/core/i18n";
import type { LightTheme, ThemeId, ThemeMode } from "../shared/bridge.ts";
import { APPEARANCE_FILE, AppearanceRejectedError, WINDOW_BACKGROUNDS, createAppearanceState, effectiveTheme, readAppearance } from "./appearance.ts";

const prevLanguage = getProcessLanguage();
const dirs: string[] = [];
afterEach(() => {
  setProcessLanguage(prevLanguage);
  for (const d of dirs.splice(0)) {
    try { chmodSync(join(d, APPEARANCE_FILE), 0o644); } catch { /* no file */ }
    rmSync(d, { recursive: true, force: true });
  }
});

function make(file?: string, systemDark = false) {
  const dataDir = mkdtempSync(join(tmpdir(), "appearance-"));
  dirs.push(dataDir);
  const path = join(dataDir, APPEARANCE_FILE);
  if (file !== undefined) writeFileSync(path, file);
  const sys = { dark: systemDark };
  const send = vi.fn();
  const logger = { info: vi.fn(), error: vi.fn() };
  const state = createAppearanceState({ dataDir, systemDark: () => sys.dark, send, logger });
  return { dataDir, path, sys, send, logger, state };
}

describe("Режим и светлая тема: effective theme", () => {
  const table: Array<[ThemeMode, LightTheme, boolean, ThemeId]> = [
    ["dark", "len", false, "osen"], ["dark", "len", true, "osen"],
    ["light", "len", false, "len"], ["light", "len", true, "len"],
    ["system", "inei", false, "inei"], ["system", "inei", true, "osen"],
  ];
  it.each(table)("mode %s, light %s, systemDark %s -> %s", (mode, lightTheme, dark, expected) => {
    expect(effectiveTheme({ mode, lightTheme }, dark)).toBe(expected);
  });

  it("Тёмный режим сохраняет светлую тему", () => {
    const { state } = make();
    const themes = [state.set({ mode: "light", lightTheme: "pergament" }).theme, state.set({ mode: "dark" }).theme, state.set({ mode: "light" }).theme];
    expect(themes).toEqual(["pergament", "osen", "pergament"]);
  });

  it("Режим «как в системе»", () => {
    const { state, sys, send } = make();
    state.set({ mode: "system", lightTheme: "inei" });
    expect(state.view().theme).toBe("inei");
    send.mockClear();
    sys.dark = true;
    state.systemChanged();
    expect(state.view().theme).toBe("osen");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toEqual({ type: "appearance", view: { mode: "system", lightTheme: "inei", theme: "osen" } });
    expect(state.background()).toBe(WINDOW_BACKGROUNDS.osen);
  });

  it("Смена оформления macOS в режиме light: тема и события прежние", () => {
    const { state, sys, send } = make();
    state.set({ mode: "light", lightTheme: "len" });
    send.mockClear();
    sys.dark = true;
    state.systemChanged();
    expect(state.view().theme).toBe("len");
    expect(send).not.toHaveBeenCalled();
  });

  // Electron: themeSource "dark"/"light" forces shouldUseDarkColors, so the source must follow the mode before it is read
  it("Режим «как в системе»: dark -> system on a light macOS answers with the light theme at once", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "appearance-"));
    dirs.push(dataDir);
    const native = { source: "system" as ThemeMode, macDark: false };
    const send = vi.fn();
    const state = createAppearanceState({
      dataDir, send, logger: { info: vi.fn(), error: vi.fn() },
      systemDark: () => (native.source === "system" ? native.macDark : native.source === "dark"),
      applyMode: (m) => void (native.source = m),
    });
    expect(native.source).toBe("dark");
    expect(state.set({ mode: "system", lightTheme: "inei" }).theme).toBe("inei");
    expect(send.mock.calls[0]![0].view.theme).toBe("inei");
  });
});

describe("Хранение выбора темы: reading", () => {
  it("Файла нет: defaults, no warning, file not created", () => {
    const { dataDir, logger, state } = make();
    expect(readAppearance(dataDir)).toEqual({ mode: "dark", lightTheme: "tuman", warning: null });
    expect(existsSync(join(dataDir, APPEARANCE_FILE))).toBe(false);
    expect(state.view().theme).toBe("osen");
    expect(logger.error).not.toHaveBeenCalled();
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it.each([["not JSON", "{oops"], ["array", "[1]"], ["string", '"light"'], ["null", "null"], ["number", "5"]])("%s: both fields default, warning, bytes unchanged", (_n, text) => {
    const { dataDir, path, logger, state } = make(text);
    const r = readAppearance(dataDir);
    expect(r).toMatchObject({ mode: "dark", lightTheme: "tuman" });
    expect(r.warning).toBeTruthy();
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(state.view().theme).toBe("osen");
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("Неизвестная светлая тема: only that field defaults, the warning names it, bytes unchanged", () => {
    const text = '{ "mode": "light", "lightTheme": "sakura" }';
    const { path, logger, state } = make(text);
    expect(state.view()).toEqual({ mode: "light", lightTheme: "tuman", theme: "tuman" });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toContain("lightTheme");
    expect(logger.error.mock.calls[0]![0]).toContain("sakura");
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("partial file: the missing field defaults without a warning", () => {
    const { dataDir, logger } = make('{ "mode": "light" }');
    expect(readAppearance(dataDir)).toEqual({ mode: "light", lightTheme: "tuman", warning: null });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("unreadable file: defaults and a warning", () => {
    if (process.getuid?.() === 0) return;
    const { dataDir, path } = make("{}");
    chmodSync(path, 0o000);
    const r = readAppearance(dataDir);
    chmodSync(path, 0o644);
    expect(r.warning).toContain("EACCES");
    expect(r).toMatchObject({ mode: "dark", lightTheme: "tuman" });
  });
});

describe("Хранение выбора темы: set", () => {
  it("writes the file, sends the event, leaves other files byte-identical", () => {
    const { dataDir, path, send, logger, state } = make();
    writeFileSync(join(dataDir, "preferences.json"), '{ "language": "ru" }\n');
    writeFileSync(join(dataDir, "config.json"), "{}\n");
    const before = [readFileSync(join(dataDir, "preferences.json")), readFileSync(join(dataDir, "config.json"))];
    const v = state.set({ mode: "light", lightTheme: "len" });
    expect(v).toEqual({ mode: "light", lightTheme: "len", theme: "len" });
    expect(readFileSync(path, "utf8")).toBe('{\n  "mode": "light",\n  "lightTheme": "len"\n}\n');
    expect(send).toHaveBeenCalledWith({ type: "appearance", view: v });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect([readFileSync(join(dataDir, "preferences.json")), readFileSync(join(dataDir, "config.json"))]).toEqual(before);
    expect(readdirSync(dataDir).sort()).toEqual(["appearance.json", "config.json", "preferences.json"]);
  });

  it.each([["unknown mode", { mode: "blue" }], ["unknown light theme", { lightTheme: "osen" }], ["null", null], ["array", []], ["string", "light"], ["wrong type", { mode: 1 }]])("rejects %s", (_n, input) => {
    const { path, send, state } = make();
    expect(() => state.set(input)).toThrow(AppearanceRejectedError);
    expect(existsSync(path)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(state.view().mode).toBe("dark");
  });

  it.each([["en", /Theme not saved/], ["ru", /Тема не сохранена/]] as const)("read-only file (%s): refusal in the current language, state and file unchanged", (lang, re) => {
    if (process.getuid?.() === 0) return;
    setProcessLanguage(lang);
    const { path, send, state } = make('{ "mode": "dark", "lightTheme": "tuman" }\n');
    const before = readFileSync(path);
    chmodSync(path, 0o444);
    expect(() => state.set({ mode: "light" })).toThrow(re);
    expect(() => state.set({ mode: "light" })).toThrow(AppearanceRejectedError);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(state.view().mode).toBe("dark");
    expect(send).not.toHaveBeenCalled();
    expect(readdirSync(join(path, "..")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("Без вспышки при запуске: window background table (task 1.3)", () => {
  it("WINDOW_BACKGROUNDS equals --bg-0 of every [data-theme] block in tokens.css", () => {
    const css = readFileSync(join(import.meta.dirname, "../../../../design/mockup-osen/brand/tokens.css"), "utf8");
    const found: Record<string, string> = {};
    for (const m of css.matchAll(/\[data-theme="([a-z]+)"\]\s*\{([^}]*)\}/g)) {
      const bg = /--bg-0:\s*(#[0-9a-fA-F]{6})/.exec(m[2]!);
      if (bg) found[m[1]!] = bg[1]!;
    }
    expect(Object.keys(found).sort()).toEqual(Object.keys(WINDOW_BACKGROUNDS).sort());
    for (const [id, bg] of Object.entries(found)) expect(WINDOW_BACKGROUNDS[id as ThemeId].toLowerCase()).toBe(bg.toLowerCase());
  });
});
