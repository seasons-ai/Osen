import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProcessLanguage, setProcessLanguage } from "@model-council/core/i18n";
import { initialRegistry, resetDiscoveryCache, writeRegistry } from "@model-council/core";
import { inertTransition } from "./cli-transition.testutil.ts";
import { createSettings } from "./settings.ts";
import type { BridgeEvent } from "../shared/bridge.ts";
import { closeWarningText, createLanguageState } from "./language.ts";
import { onceReporter } from "./pins.ts";

const prev = getProcessLanguage();
const dirs: string[] = [];
afterEach(() => {
  setProcessLanguage(prev);
  resetDiscoveryCache();
  for (const d of dirs.splice(0)) {
    try { chmodSync(join(d, "preferences.json"), 0o644); } catch { /* файла нет */ }
    rmSync(d, { recursive: true, force: true });
  }
});

function make(env: Record<string, string | undefined> = {}, file?: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "lang-"));
  dirs.push(dataDir);
  if (file !== undefined) writeFileSync(join(dataDir, "preferences.json"), file);
  const send = vi.fn<(e: BridgeEvent) => void>();
  const logger = { info: vi.fn(), error: vi.fn() };
  const state = createLanguageState({ env, dataDir, send, logger });
  return { dataDir, send, logger, state, prefs: join(dataDir, "preferences.json") };
}

describe("language state: sources", () => {
  it("no file and no variable: en, default", () => {
    setProcessLanguage("ru");
    const { state } = make();
    expect(state.view()).toEqual({ language: "en", source: "default", locked: false });
    expect(getProcessLanguage()).toBe("en");
  });
  it("file: ru, file", () => {
    const { state } = make({}, '{"language":"ru"}');
    expect(state.view()).toEqual({ language: "ru", source: "file", locked: false });
    expect(getProcessLanguage()).toBe("ru");
  });
  it("the variable wins over the file and locks the choice", () => {
    const { state } = make({ COUNCIL_LANG: "en" }, '{"language":"ru"}');
    expect(state.view()).toEqual({ language: "en", source: "env", locked: true });
  });
});

describe("language state: set", () => {
  it("writes the file, sends one event, changes the process language", () => {
    const { state, send, prefs, logger } = make();
    const v = state.set("ru");
    expect(v).toEqual({ language: "ru", source: "file", locked: false });
    expect(JSON.parse(readFileSync(prefs, "utf8"))).toEqual({ language: "ru" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: "language", view: v });
    expect(getProcessLanguage()).toBe("ru");
    expect(state.view()).toEqual(v);
    expect(logger.info).toHaveBeenCalled();
  });

  it("when locked: refusal, the file did not appear, no events, the language unchanged", () => {
    const { state, send, prefs } = make({ COUNCIL_LANG: "en" });
    setProcessLanguage("en");
    expect(() => state.set("ru")).toThrow(/COUNCIL_LANG/);
    expect(existsSync(prefs)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(getProcessLanguage()).toBe("en");
  });

  it("when locked the refusal text is in English at en", () => {
    const { state } = make({ COUNCIL_LANG: "en" });
    expect(() => state.set("ru")).toThrow(/environment variable/);
  });

  it.each([["fr"], [undefined], [null], ["RU"], [5]])("недопустимое значение %j отклоняется", (bad) => {
    const { state, send, prefs } = make();
    expect(() => state.set(bad)).toThrow();
    expect(existsSync(prefs)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("read-only file: refusal with a code, language and bytes unchanged, no events", () => {
    const { state, send, prefs } = make({}, '{"language":"ru"}');
    const before = readFileSync(prefs);
    chmodSync(prefs, 0o444);
    // under root chmod does not block writing; then the check is meaningless
    if (process.getuid?.() === 0) return;
    setProcessLanguage("en");
    expect(() => state.set("en")).toThrow(/EACCES/);
    expect(readFileSync(prefs).equals(before)).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(getProcessLanguage()).toBe("en");
    expect(state.view()).toEqual({ language: "ru", source: "file", locked: false });
  });

  it("write error message in English at en and in Russian at ru", () => {
    const { state, prefs } = make({}, '{"language":"ru"}');
    chmodSync(prefs, 0o444);
    if (process.getuid?.() === 0) return;
    setProcessLanguage("en");
    expect(() => state.set("ru")).toThrow("Language not saved: cannot write preferences.json (EACCES)");
    setProcessLanguage("ru");
    expect(() => state.set("en")).toThrow("Язык не сохранён: нет доступа на запись preferences.json (EACCES)");
  });

  it("corrupted file: notice, bytes untouched until set, after set the file is replaced", () => {
    const { state, prefs } = make({}, "{ не json");
    const before = readFileSync(prefs);
    expect(getProcessLanguage()).toBe("en");
    const notice = state.invalidNotice();
    expect(notice).toMatch(/preferences\.json/);
    expect(notice).toMatch(/English/);
    expect(notice).not.toMatch(/[А-Яа-яЁё]/);
    expect(notice).not.toContain("не json");
    expect(readFileSync(prefs).equals(before)).toBe(true);
    state.set("ru");
    expect(JSON.parse(readFileSync(prefs, "utf8"))).toEqual({ language: "ru" });
    expect(state.invalidNotice()).toBeNull();
  });

  it("notice in the current language and by reasons", () => {
    const cases: [string | undefined, string][] = [
      ['{"language":"de"}', "unknown language"],
      ["{}", "no language"],
      ["[", "not valid JSON"],
    ];
    for (const [file, text] of cases) expect(make({}, file).state.invalidNotice()).toContain(text);
  });

  it("language from the variable with a corrupted file: no notice, the file has no effect", () => {
    const { state } = make({ COUNCIL_LANG: "ru" }, "[");
    expect(state.view()).toEqual({ language: "ru", source: "env", locked: true });
    expect(state.invalidNotice()).toBeNull();
  });

  it("a healthy and a missing file: no notice", () => {
    expect(make().state.invalidNotice()).toBeNull();
    expect(make({}, '{"language":"en"}').state.invalidNotice()).toBeNull();
  });

  it("a notice through onceReporter goes out exactly once", () => {
    const { state } = make({}, "[");
    const report = vi.fn();
    const once = onceReporter(report);
    for (let i = 0; i < 3; i++) once(state.invalidNotice());
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("a language change does not touch the other files of the data folder", () => {
    const { state, dataDir, prefs } = make();
    writeFileSync(join(dataDir, "config.json"), '{"a":1}\n');
    mkdirSync(join(dataDir, "sessions"));
    writeFileSync(join(dataDir, "sessions", "x.json"), "{}");
    const snap = () => {
      const files = readdirSync(dataDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).filter((f) => f !== prefs).sort();
      return files.map((f) => `${f}:${createHash("sha256").update(readFileSync(f)).digest("hex")}`);
    };
    const before = snap();
    state.set("ru");
    state.set("en");
    expect(snap()).toEqual(before);
    expect(readdirSync(dataDir).sort()).toEqual(["config.json", "preferences.json", "sessions"]);
  });
});

describe("close warning window", () => {
  it("English: singular and plural forms", () => {
    const one = closeWarningText(1, "en");
    expect(one).toEqual({ message: "Discussion in progress", detail: "The session started in the app will be aborted if you close the window.", buttons: ["Stay", "Close and abort"] });
    expect(closeWarningText(2, "en").detail).toBe("Sessions started in the app (2) will be aborted if you close the window.");
  });
  it("Russian: current texts verbatim", () => {
    expect(closeWarningText(1, "ru")).toEqual({ message: "Идёт обсуждение", detail: "Сессия, запущенная в приложении, будет прервана, если закрыть окно.", buttons: ["Остаться", "Закрыть и прервать"] });
    expect(closeWarningText(3, "ru").detail).toBe("Сессии, запущенные в приложении (3), будут прерваны, если закрыть окно.");
  });
  it("without a language the process language at the time of display is taken", () => {
    setProcessLanguage("en");
    expect(closeWarningText(1).buttons[0]).toBe("Stay");
    setProcessLanguage("ru");
    expect(closeWarningText(1).buttons[0]).toBe("Остаться");
  });
});

describe("language state: CLI discovery reset", () => {
  it("a successful change resets the cache once and before the language event; refusals do not reset", () => {
    const order: string[] = [];
    const resetDiscovery = vi.fn(() => { order.push("reset"); });
    const dataDir = mkdtempSync(join(tmpdir(), "lang-"));
    dirs.push(dataDir);
    const send = vi.fn((e: BridgeEvent) => { order.push(e.type); });
    const state = createLanguageState({ env: {}, dataDir, send, logger: { info: vi.fn(), error: vi.fn() }, resetDiscovery });
    expect(() => state.set("de")).toThrow();
    expect(resetDiscovery).not.toHaveBeenCalled();
    state.set("ru");
    expect(resetDiscovery).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["reset", "language"]);
    const locked = createLanguageState({ env: { COUNCIL_LANG: "en" }, dataDir, send, logger: { info: vi.fn(), error: vi.fn() }, resetDiscovery });
    expect(() => locked.set("ru")).toThrow();
    expect(resetDiscovery).toHaveBeenCalledTimes(1);
  });

  it("A reason from core after a language change: CLI discovery is reset", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lang-"));
    dirs.push(dataDir);
    const bin = join(dataDir, "fakebin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), '#!/bin/sh\necho "9.9.9 (fake)"\n');
    chmodSync(join(bin, "claude"), 0o755);
    const base = initialRegistry(["claude", "codex"]);
    writeRegistry(dataDir, { ...base, providers: base.providers.map((p) => (p.id === "codex" ? { ...p, path: "/nonexistent/codex" } : p)) });
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dataDir };
    const logger = { info: vi.fn(), error: vi.fn() };
    const state = createLanguageState({ env: {}, dataDir, send: vi.fn(), logger });
    setProcessLanguage("en");
    const api = createSettings({ dataDir, env, reloadEnv: () => {}, logger, transition: inertTransition(dataDir, logger) });
    const show = async () => (await api.view()).providers.map((p) => [p.id, p.reason, p.warning]);
    const en = await show();
    expect(en.some((r) => r[1] || r[2])).toBe(true);
    expect(JSON.stringify(en)).not.toMatch(/[А-Яа-яЁё]/);
    state.set("ru");
    const ru = await show();
    // no reason and no warning stayed in English
    expect(JSON.stringify(en)).toMatch(/newer than the verified range/);
    expect(JSON.stringify(en)).toMatch(/not found at the given path/);
    for (const [, reason, warning] of ru) for (const t of [reason, warning]) if (t) expect(t).toMatch(/[А-Яа-яЁё]/);
  });
});
