import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "../i18n/process-language.ts";
import { npmReleases, npmSource } from "./npm-source.ts";

let root: string;
let bin: string;
let work: string;

// A fake npm: records args and the npm_config_* environment, creates the files the real package would, or fails.
function fakeNpm(body: string) {
  writeFileSync(join(bin, "npm"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "npm"), 0o755);
}
const env = () => ({ PATH: `${bin}:/usr/bin:/bin`, KEEP: "1" });

beforeEach(() => {
  setProcessLanguage("en");
  root = mkdtempSync(join(tmpdir(), "npm-source-"));
  bin = join(root, "bin");
  work = join(root, "work");
  mkdirSync(bin);
  mkdirSync(work);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const RECORD = (rel: string) => `echo "$@" > "${root}/args"; echo "$npm_config_cache|$npm_config_update_notifier|$npm_config_fund|$npm_config_audit|$KEEP" > "${root}/env"; mkdir -p "$3/.npm-cache" "$3/${rel}/.."; echo x > "$3/${rel}"; chmod +x "$3/${rel}"`;

describe("Шов источника пакета: npm", () => {
  it("claude: installs the pinned package with a cache inside the folder and removes the cache", async () => {
    fakeNpm(RECORD("node_modules/@anthropic-ai/claude-code/bin/claude.exe"));
    const r = await npmSource(env()).fetch("claude", "2.1.288", work);
    expect(r).toEqual({ executable: join(work, "node_modules/@anthropic-ai/claude-code/bin/claude.exe"), source: "npm:@anthropic-ai/claude-code@2.1.288" });
    expect(readFileSync(join(root, "args"), "utf8").trim()).toBe(`install --prefix ${work} @anthropic-ai/claude-code@2.1.288`);
    expect(readFileSync(join(root, "env"), "utf8").trim()).toBe(`${join(work, ".npm-cache")}|false|false|false|1`);
    expect(existsSync(join(work, ".npm-cache"))).toBe(false);
  });

  it("codex: runs the vendored native binary for the platform", async () => {
    fakeNpm(RECORD("node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"));
    const arm = await npmSource(env(), "darwin", "arm64").fetch("codex", "0.159.2", work);
    expect(arm.executable).toBe(join(work, "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"));
    expect(arm.source).toBe("npm:@openai/codex@0.159.2");
    fakeNpm(RECORD("node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex"));
    const x64 = await npmSource(env(), "darwin", "x64").fetch("codex", "0.159.2", work);
    expect(x64.executable).toContain("codex-darwin-x64/vendor/x86_64-apple-darwin");
  });

  it("codex on an unsupported platform throws before npm runs", async () => {
    fakeNpm(`touch "${root}/ran"`);
    await expect(npmSource(env(), "linux", "x64").fetch("codex", "0.159.2", work)).rejects.toThrow(/macOS/);
    await expect(npmSource(env(), "darwin", "ia32").fetch("codex", "0.159.2", work)).rejects.toThrow(/macOS/);
    expect(existsSync(join(root, "ran"))).toBe(false);
  });

  it("npm failure carries the tail of stderr", async () => {
    fakeNpm(`echo "${"e".repeat(2000)}ETARGET no such version" >&2; exit 1`);
    const e = await npmSource(env()).fetch("claude", "9.9.9", work).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toContain("ETARGET no such version");
    expect((e as Error).message.length).toBeLessThan(700);
  });

  it("npm succeeded without the expected file: error", async () => {
    fakeNpm("exit 0");
    await expect(npmSource(env()).fetch("claude", "1.0.0", work)).rejects.toThrow(/did not produce/);
  });
});

describe("Шов источника пакета: npm / прерывание", () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  // npm whose script leaves a child holding stdout open; the child's pid goes to <root>/child.
  const hang = () => `sleep 15 & echo $! > "${root}/child"; wait`;
  async function interrupt(start: (signal: AbortSignal) => Promise<unknown>) {
    fakeNpm(hang());
    const pidfile = join(root, "child");
    const ac = new AbortController();
    const p = start(ac.signal).catch((x: unknown) => x);
    const t0 = Date.now();
    while (!(existsSync(pidfile) && readFileSync(pidfile, "utf8").trim()) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 25));
    const pid = Number(readFileSync(pidfile, "utf8").trim());
    try {
      const abortedAt = Date.now();
      ac.abort();
      expect(await p).toBeInstanceOf(Error);
      expect(Date.now() - abortedAt).toBeLessThan(5000);
      expect(alive(pid)).toBe(false);
    } finally { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
  it("install: the npm group is killed", async () => {
    await interrupt((signal) => npmSource(env()).fetch("claude", "2.1.288", work, signal));
  }, 20_000);
  it("view: the npm group is killed", async () => {
    await interrupt((signal) => npmReleases(env()).list("claude", signal));
  }, 20_000);
});
