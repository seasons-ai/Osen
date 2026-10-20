import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./cli.ts";
import { pinsPath } from "./cli-agents/pins.ts";
import type { PackageSource } from "./cli-agents/pins.ts";
import type { VerifiedEntry, VerifiedRecord } from "./cli-agents/verified-record.ts";
import { setProcessLanguage } from "./i18n/index.ts";

const real = (version: string): VerifiedEntry => ({ agent: "claude", version, level: "real", checkedAt: "2026-10-20", os: "darwin-arm64", osenVersion: "1.0.0", modelCalls: 2 });
const record: VerifiedRecord = { entries: [real("1.0.0"), real("1.1.0"), { agent: "claude", version: "2.0.0", level: "interface", checkedAt: "2026-10-20", os: "darwin-arm64", osenVersion: "1.0.0" }] };

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
afterEach(() => setProcessLanguage("ru"));

let fetches: string[];
beforeEach(() => { fetches = []; });

const source: PackageSource = {
  async fetch(agent, version, dir) {
    fetches.push(`${agent}@${version}`);
    const bin = join(dir, "node_modules", "pkg", "bin");
    mkdirSync(bin, { recursive: true });
    const exe = join(bin, agent);
    writeFileSync(exe, `#!/bin/sh\necho "${version} (Claude Code)"\n`);
    chmodSync(exe, 0o755);
    return { executable: exe, source: `fake:${agent}@${version}` };
  },
};

async function run(argv: string[], home: string) {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env: { COUNCIL_HOME: home, COUNCIL_DEV: "1" }, cliPin: { source, record } });
  return { code, out: out.join(""), err: err.join("") };
}
const home = () => { const d = mkdtempSync(join(tmpdir(), "cli-pin-")); tmps.push(d); return d; };
const active = (h: string) => JSON.parse(readFileSync(pinsPath(h), "utf8")).agents.claude.active;

describe("council cli", () => {
  beforeEach(() => setProcessLanguage("en"));

  it("rejects wrong arguments with a reason and the help, exit 2, no cli folder and no install", async () => {
    const h = home();
    for (const argv of [
      ["cli", "use", "claude"], ["cli", "install", "gemini"], ["cli", "list", "--candidate"], ["cli", "bogus"], ["cli"],
      ["cli", "install", "claude", "extra"], ["cli", "use", "claude", "1.0.0", "--candidate"], ["cli", "rollback", "claude", "--version", "1.0.0"],
      ["list", "--candidate"],
    ]) {
      const r = await run(argv, h);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err, argv.join(" ")).toMatch(/Error|error/);
      expect(r.err, argv.join(" ")).toContain("Usage:");
    }
    expect(existsSync(join(h, "cli"))).toBe(false);
    expect(fetches).toEqual([]);
  });

  it("lists the four cli commands in --help in en and ru", async () => {
    for (const lang of ["en", "ru"] as const) {
      setProcessLanguage(lang);
      const r = await run(["--help"], home());
      expect(r.code).toBe(0);
      for (const c of ["cli install <agent> [--version <X>] [--candidate]", "cli list", "cli use <agent> <version>", "cli rollback <agent>"]) expect(r.out).toContain(`council ${c}`);
      expect(r.out).toMatch(lang === "ru" ? /закреплённый/ : /pinned/);
    }
  });

  it("list on a fresh data folder: no pins, exit 0, no cli folder", async () => {
    const h = home();
    const r = await run(["cli", "list"], h);
    expect(r.code).toBe(0);
    expect(r.out.length).toBeGreaterThan(0);
    expect(existsSync(join(h, "cli"))).toBe(false);
  });

  it("flow: install, install --version, use, repeated use, rollback, repeated rollback", async () => {
    const h = home();
    expect((await run(["cli", "install", "claude"], h)).code).toBe(0);
    expect(fetches).toEqual(["claude@1.1.0"]);
    expect(active(h)).toBe("1.1.0");
    expect((await run(["cli", "install", "claude", "--version", "1.0.0"], h)).code).toBe(0);
    expect(fetches).toEqual(["claude@1.1.0", "claude@1.0.0"]);
    expect(active(h)).toBe("1.1.0");
    expect((await run(["cli", "use", "claude", "1.0.0"], h)).code).toBe(0);
    expect(active(h)).toBe("1.0.0");
    const before = readFileSync(pinsPath(h));
    expect((await run(["cli", "use", "claude", "1.0.0"], h)).code).toBe(0);
    expect(readFileSync(pinsPath(h)).equals(before)).toBe(true);
    expect((await run(["cli", "rollback", "claude"], h)).code).toBe(0);
    expect(active(h)).toBe("1.1.0");
    const again = await run(["cli", "rollback", "claude"], h);
    expect(again.code).toBe(2);
    expect(again.err.length).toBeGreaterThan(0);
    const list = await run(["cli", "list"], h);
    expect(list.code).toBe(0);
    expect(list.out).toContain("1.1.0");
  });

  it("--candidate installs without activating", async () => {
    const h = home();
    expect((await run(["cli", "install", "claude", "--version", "1.0.0", "--candidate"], h)).code).toBe(0);
    expect(active(h)).toBeNull();
  });

  it("refusal text follows the interface language, exit code is the same", async () => {
    const h = home();
    setProcessLanguage("en");
    const en = await run(["cli", "use", "claude", "9.9.9"], h);
    setProcessLanguage("ru");
    const ru = await run(["cli", "use", "claude", "9.9.9"], h);
    expect(en.code).toBe(ru.code);
    expect(en.code).toBe(2);
    expect(en.err).not.toBe(ru.err);
    expect(ru.err).toMatch(/[А-Яа-я]/);
    expect(en.err).not.toMatch(/[А-Яа-я]/);
  });
});
