import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { createLogger } from "./log.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "council-"));
  dirs.push(d);
  return d;
};
const read = (d: string) => readFileSync(join(d, "logs", "app.log"), "utf8");
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("createLogger", () => {
  it("writes info and error one line each and creates logs folder", () => {
    const d = tmp();
    const log = createLogger(d, "store", {});
    log.info("Сессия создана");
    log.error("Сбой");
    const lines = read(d).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z INFO \[store\] Сессия создана$/);
    expect(lines[1]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z ERROR \[store\] Сбой$/);
  });

  it("adds the error reason", () => {
    const d = tmp();
    createLogger(d, "engine", {}).error("Запуск сессии не удался", new Error("нет доступа"));
    expect(read(d)).toMatch(/^\S+ ERROR \[engine\] Запуск сессии не удался — reason: нет доступа\n$/);
  });

  it("non-Error reason becomes a string", () => {
    const d = tmp();
    createLogger(d, "c", {}).error("Сбой", 42);
    expect(read(d)).toContain("— reason: 42");
  });

  it("hides secret values, but not other variables", () => {
    const d = tmp();
    const log = createLogger(d, "c", { OPENAI_API_KEY: "sk-test-1234567890", HOME: "/Users/x" });
    log.info("ключ sk-test-1234567890 в /Users/x");
    log.error("сбой sk-test-1234567890", new Error("bad sk-test-1234567890"));
    const text = read(d);
    expect(text).not.toContain("sk-test-1234567890");
    expect(text).toContain("[hidden]");
    expect(text).toContain("/Users/x");
  });

  it("secret names in any case; short values are not hidden", () => {
    const d = tmp();
    const log = createLogger(d, "c", { my_token: "tok-aaaa", Db_Password: "pass-bbbb", client_secret: "sec-cccc", API_KEY: "1" });
    log.info("tok-aaaa pass-bbbb sec-cccc 1");
    expect(read(d)).toMatch(/INFO \[c\] \[hidden\] \[hidden\] \[hidden\] 1\n$/);
  });

  it("a prefix of another secret leaves no tail", () => {
    const d = tmp();
    createLogger(d, "c", { A_KEY: "abcdef", B_KEY: "abcdefghij" }).info("x abcdefghij y abcdef z");
    const text = read(d);
    expect(text).not.toContain("abcdef");
    expect(text).not.toContain("ghij");
  });

  it("multiline message stays one line", () => {
    const d = tmp();
    createLogger(d, "c", {}).info("а\nб\r\nв");
    const text = read(d);
    expect(text.trimEnd().split("\n")).toHaveLength(1);
    expect(text).toContain("а\\nб\\n\\nв");
  });

  it("does not overwrite existing app.log", () => {
    const d = tmp();
    mkdirSync(join(d, "logs"));
    writeFileSync(join(d, "logs", "app.log"), "старая строка\n");
    createLogger(d, "c", {}).info("новая");
    const lines = read(d).trimEnd().split("\n");
    expect(lines[0]).toBe("старая строка");
    expect(lines[1]).toContain("INFO [c] новая");
  });

  it("does not throw if the folder cannot be created", () => {
    const d = tmp();
    const blocker = join(d, "file");
    writeFileSync(blocker, "x");
    expect(() => {
      const log = createLogger(join(blocker, "data"), "c", {});
      log.info("a");
      log.error("b", new Error("c"));
    }).not.toThrow();
  });
});
