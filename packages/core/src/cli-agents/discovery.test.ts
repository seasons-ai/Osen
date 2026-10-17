import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locateCli, parseVersion, resetDiscoveryCache } from "./discovery.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "discovery-"));
  resetDiscoveryCache();
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function script(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}
const bin = (out: string, name = "claude") => script(join(tmp, "bin"), name, `echo '${out}'`);
const noLogin = { loginShellPath: async () => undefined };

describe("locateCli", () => {
  it("finds the CLI in the process PATH, real isExecutable and runVersion", async () => {
    const file = bin("2.1.288 (Claude Code)");
    const r = await locateCli("claude", { env: { PATH: join(tmp, "bin") }, deps: { loginShellPath: async () => undefined } });
    expect(r).toMatchObject({ found: true, path: file, version: "2.1.288" });
    expect(r.warning).toBeUndefined();
  });

  it("trimmed PATH: takes the folder from the login shell", async () => {
    const file = bin("2.1.288 (Claude Code)");
    const r = await locateCli("claude", {
      env: { PATH: "/usr/bin:/bin" },
      deps: { loginShellPath: async () => `/usr/bin${delimiter}${join(tmp, "bin")}` },
    });
    expect(r).toMatchObject({ found: true, path: file });
    expect(r.searchPath.split(delimiter)).toEqual(["/usr/bin", "/bin", join(tmp, "bin")]);
  });

  it("real loginShellPath: value between markers, junk around it is ignored", async () => {
    const file = bin("2.1.288 (Claude Code)");
    const shell = script(tmp, "fakesh", `echo junk; printf '\\n__COUNCIL_PATH__${join(tmp, "bin")}__COUNCIL_PATH__\\n'; echo more junk`);
    const r = await locateCli("claude", { env: { PATH: "/usr/bin:/bin", SHELL: shell } });
    expect(r).toMatchObject({ found: true, path: file, version: "2.1.288" });
  });

  it("shell fails or prints no markers: not found", async () => {
    for (const body of ["exit 3", "echo nothing here"]) {
      resetDiscoveryCache();
      const shell = script(tmp, "badsh", body);
      const r = await locateCli("claude", { env: { PATH: "/usr/bin:/bin", SHELL: shell } });
      expect(r.found).toBe(false);
      expect(r.reason).toBe("Команда claude не найдена: её нет ни в PATH процесса, ни в PATH оболочки входа");
    }
  });

  it("explicit path does not exist: not found, PATH is not searched", async () => {
    bin("2.1.288 (Claude Code)");
    const missing = join(tmp, "nope", "claude");
    const r = await locateCli("claude", { explicitPath: missing, env: { PATH: join(tmp, "bin") }, deps: noLogin });
    expect(r.found).toBe(false);
    expect(r.reason).toBe(`Команда claude не найдена по заданному пути ${missing}`);
  });

  it("explicit path takes precedence over PATH", async () => {
    bin("2.1.288 (Claude Code)");
    const other = script(join(tmp, "other"), "claude", "echo '2.1.288 (Claude Code)'");
    const r = await locateCli("claude", { explicitPath: other, env: { PATH: join(tmp, "bin") }, deps: noLogin });
    expect(r).toMatchObject({ found: true, path: other });
  });

  it("version warnings", async () => {
    const env = { PATH: join(tmp, "bin") };
    bin("2.1.300 (Claude Code)");
    expect((await locateCli("claude", { env, deps: noLogin })).warning).toBe("Версия claude 2.1.300 новее проверенного диапазона 2.1.288–2.1.288");
    bin("2.0.999 (Claude Code)");
    expect((await locateCli("claude", { env, deps: noLogin })).warning).toBe("Версия claude 2.0.999 старше проверенного диапазона 2.1.288–2.1.288");
    bin("2.1.1000 (Claude Code)");
    expect((await locateCli("claude", { env, deps: noLogin })).warning).toContain("новее");
    script(join(tmp, "bin"), "claude", "exit 1");
    const failed = await locateCli("claude", { env, deps: noLogin });
    expect(failed).toMatchObject({ found: true });
    expect(failed.version).toBeUndefined();
    expect(failed.warning).toContain("Версию claude определить не удалось");
    bin("hello");
    const noVer = await locateCli("claude", { env, deps: noLogin });
    expect(noVer.version).toBeUndefined();
    expect(noVer.warning).toContain("Версию claude определить не удалось");
  });

  it("cache: --version runs once before resetDiscoveryCache", async () => {
    const counter = join(tmp, "count");
    script(join(tmp, "bin"), "claude", `echo x >> '${counter}'; echo '2.1.288 (Claude Code)'`);
    const opts = { env: { PATH: join(tmp, "bin") } };
    await locateCli("claude", opts);
    await locateCli("claude", opts);
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);
    resetDiscoveryCache();
    await locateCli("claude", opts);
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("does not pick a different name", async () => {
    bin("0.159.2", "codex");
    const r = await locateCli("claude", { env: { PATH: join(tmp, "bin") }, deps: noLogin });
    expect(r.found).toBe(false);
  });
});

describe("parseVersion", () => {
  it("parses real lines and junk", () => {
    expect(parseVersion("2.1.288 (Claude Code)")).toBe("2.1.288");
    expect(parseVersion("codex-cli 0.159.2")).toBe("0.159.2");
    expect(parseVersion("no version")).toBeUndefined();
    expect(parseVersion("")).toBeUndefined();
  });
});
