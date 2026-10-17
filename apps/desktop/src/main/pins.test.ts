import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setProcessLanguage } from "@model-council/core/i18n";
import { PINS_FILE, onceReporter, readPins, setPinned } from "./pins.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "council-pins-")); });
afterEach(() => {
  try { chmodSync(dir, 0o755); chmodSync(join(dir, PINS_FILE), 0o644); } catch { /* файла нет */ }
  rmSync(dir, { recursive: true, force: true });
  setProcessLanguage("ru");
});
const file = () => join(dir, PINS_FILE);
const put = (text: string) => writeFileSync(file(), text);
const ids = () => readPins(dir).ids;
const root = process.getuid?.() === 0;
const SECRET = "СЕКРЕТ-МЕТКА-123";

describe("readPins", () => {
  it("no file: empty without an error, the file is not created", () => {
    expect(readPins(dir)).toEqual({ ids: [], error: null });
    expect(existsSync(file())).toBe(false);
  });

  it("valid file", () => {
    put('{"pinnedSessionIds":["a","b"]}');
    expect(readPins(dir)).toEqual({ ids: ["a", "b"], error: null });
  });

  it.each([
    ["невалидный JSON", `{${SECRET}`],
    ["не объект", `["${SECRET}"]`],
    ["null", "null"],
    ["pinnedSessionIds не массив", `{"pinnedSessionIds":"${SECRET}"}`],
    ["массив с нестроками", `{"pinnedSessionIds":["a",1,"${SECRET}"]}`],
  ])("%s: ошибка по-русски без содержимого, файл не тронут", (_n, text) => {
    put(text);
    const r = readPins(dir);
    expect(r.ids).toEqual([]);
    expect(r.error).toContain(PINS_FILE);
    expect(r.error).not.toContain(SECRET);
    expect(readFileSync(file(), "utf8")).toBe(text);
  });

  it.skipIf(root)("нет прав на чтение", () => {
    put(`{"pinnedSessionIds":["${SECRET}"]}`);
    chmodSync(file(), 0o000);
    const r = readPins(dir);
    expect(r.ids).toEqual([]);
    expect(r.error).toContain(PINS_FILE);
    expect(r.error).not.toContain(SECRET);
  });
});

describe("setPinned", () => {
  it("pinning creates a file of the right shape and only it", () => {
    setPinned(dir, "a", true);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ pinnedSessionIds: ["a"] });
    expect(readdirSync(dir)).toEqual([PINS_FILE]);
  });

  it("unpinning", () => {
    setPinned(dir, "a", true);
    setPinned(dir, "b", true);
    setPinned(dir, "a", false);
    expect(ids()).toEqual(["b"]);
  });

  it("idempotence: the file is not rewritten", () => {
    setPinned(dir, "a", true);
    const before = readFileSync(file());
    setPinned(dir, "a", true);
    setPinned(dir, "zzz", false);
    expect(readFileSync(file()).equals(before)).toBe(true);
    expect(ids()).toEqual(["a"]);
  });

  it("order and unknown identifiers are kept", () => {
    put('{"pinnedSessionIds":["ghost","a"]}');
    setPinned(dir, "b", true);
    expect(ids()).toEqual(["ghost", "a", "b"]);
    setPinned(dir, "a", false);
    expect(ids()).toEqual(["ghost", "b"]);
  });

  it("corrupted file: the action is rejected, the file is byte-for-byte unchanged, no content in the text", () => {
    const text = `{"pinnedSessionIds":"${SECRET}"`;
    put(text);
    let msg = "";
    try { setPinned(dir, "a", true); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain(PINS_FILE);
    expect(msg).not.toContain(SECRET);
    expect(readFileSync(file(), "utf8")).toBe(text);
    expect(readdirSync(dir)).toEqual([PINS_FILE]);
  });

  it.skipIf(root)("папка без права записи: исключение, файл прежний, временных файлов нет", () => {
    setPinned(dir, "a", true);
    const before = readFileSync(file());
    chmodSync(dir, 0o555);
    let msg = "";
    try { setPinned(dir, "b", true); } catch (e) { msg = (e as Error).message; }
    chmodSync(dir, 0o755);
    expect(msg).toContain(PINS_FILE);
    expect(msg).not.toContain('"a"');
    expect(readFileSync(file()).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual([PINS_FILE]);
  });

  it("write path is a folder: an exception, no temporary files", () => {
    mkdirSync(file());
    // reading a folder as a file gives EISDIR: the file is considered unreadable, the write is rejected
    expect(() => setPinned(dir, "a", true)).toThrow(PINS_FILE);
    expect(readdirSync(dir)).toEqual([PINS_FILE]);
  });

  it("journals and other files are not touched", () => {
    mkdirSync(join(dir, "sessions", "a"), { recursive: true });
    writeFileSync(join(dir, "sessions", "a", "events.jsonl"), "x\n");
    writeFileSync(join(dir, "config.json"), "{}");
    setPinned(dir, "a", true);
    expect(readFileSync(join(dir, "sessions", "a", "events.jsonl"), "utf8")).toBe("x\n");
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe("{}");
  });
});

describe("setPinned: read-only file", () => {
  it.skipIf(root)("запись отклонена, файл побайтно прежний, после возврата прав закрепление сохраняется", () => {
    put(JSON.stringify({ pinnedSessionIds: ["a"] }));
    const before = readFileSync(file());
    chmodSync(file(), 0o444);
    expect(() => setPinned(dir, "b", true)).toThrow(/Не удалось сохранить закрепления/);
    expect(readFileSync(file()).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual([PINS_FILE]);
    chmodSync(file(), 0o644);
    setPinned(dir, "b", true);
    expect(ids()).toEqual(["a", "b"]);
  });
});

describe("onceReporter", () => {
  it("one message is not repeated; after disappearing and reappearing it comes again", () => {
    const report = vi.fn();
    const r = onceReporter(report);
    r("e"); r("e"); r("e");
    expect(report).toHaveBeenCalledTimes(1);
    r(null);
    r("e");
    expect(report).toHaveBeenCalledTimes(2);
    r("другая");
    expect(report).toHaveBeenCalledTimes(3);
  });
});

describe("messages by language at the time of the error", () => {
  it.each([
    ["en", `{${SECRET}`, "is not valid JSON", "Pin not changed"],
    ["ru", `{${SECRET}`, "не является корректным JSON", "Закрепление не изменено"],
    ["en", `{"pinnedSessionIds":"${SECRET}"}`, "string array pinnedSessionIds", "Pin not changed"],
    ["ru", `{"pinnedSessionIds":"${SECRET}"}`, "массивом строк pinnedSessionIds", "Закрепление не изменено"]
  ] as const)("%s: чтение и запись", (lang, text, why, refusal) => {
    put(text);
    setProcessLanguage(lang);
    const r = readPins(dir);
    expect(r.error).toContain(why);
    expect(r.error).toContain(PINS_FILE);
    expect(r.error).not.toContain(SECRET);
    if (lang === "en") expect(r.error).not.toMatch(/[А-Яа-я]/);
    let msg = "";
    try { setPinned(dir, "a", true); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain(refusal);
    expect(msg).not.toContain(SECRET);
    expect(readFileSync(file(), "utf8")).toBe(text);
  });

  it.skipIf(root)("en: нет доступа к чтению с кодом; сохранение не удалось — прежнее не тронуто", () => {
    put(`{"pinnedSessionIds":["${SECRET}"]}`);
    setProcessLanguage("en");
    chmodSync(file(), 0o000);
    expect(readPins(dir).error).toMatch(/no read access \(EACCES\)/);
    chmodSync(file(), 0o444);
    let msg = "";
    try { setPinned(dir, "b", true); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("Could not save pins");
    expect(msg).toContain("Previous pins are kept");
    expect(msg).not.toMatch(/[А-Яа-я]/);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ pinnedSessionIds: [SECRET] });
  });
});
