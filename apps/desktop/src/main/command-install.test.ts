import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commandInstall } from "../shared/messages/command-install.ts";
import { LINK_HINT_LINE, classifyLink, commandStatus, describeState, installCommand, removeCommand } from "./command-install.ts";

let root: string;
let home: string;
let wrapper: string;
const bin = () => join(home, ".local", "bin");
const link = () => join(bin(), "council");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cmd-install-"));
  home = join(root, "home");
  mkdirSync(home);
  const dir = join(root, "A", "Osen.app", "Contents", "Resources", "bin");
  mkdirSync(dir, { recursive: true });
  wrapper = join(dir, "council");
  writeFileSync(wrapper, "#!/bin/sh\necho 'council help'\n");
  chmodSync(wrapper, 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const opts = (extra: object = {}) => ({ home, wrapper, language: "en" as const, ...extra });
const stubShell = (name: string, body: string) => {
  const p = join(root, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};

describe("Requirement: foreign council is not overwritten", () => {
  it("classifies missing", () => {
    expect(classifyLink({ home, wrapper }).kind).toBe("missing");
  });
  it("classifies own", () => {
    mkdirSync(bin(), { recursive: true });
    symlinkSync(wrapper, link());
    expect(classifyLink({ home, wrapper })).toMatchObject({ kind: "own", target: wrapper });
  });
  it("classifies stale for an existing and a non-existing other Osen.app", () => {
    mkdirSync(bin(), { recursive: true });
    const other = join(root, "B", "Osen.app", "Contents", "Resources", "bin", "council");
    symlinkSync(other, link());
    expect(classifyLink({ home, wrapper }).kind).toBe("stale");
    rmSync(link());
    mkdirSync(join(other, ".."), { recursive: true });
    writeFileSync(other, "x");
    symlinkSync(other, link());
    expect(classifyLink({ home, wrapper }).kind).toBe("stale");
  });
  it.each([
    ["regular file", "file", () => writeFileSync(link(), "mine")],
    ["directory", "dir", () => mkdirSync(link())],
    ["symlink to other council", "symlink", () => symlinkSync("/usr/local/bin/other-council", link())],
    ["broken non-Osen symlink", "symlink", () => symlinkSync(join(root, "nowhere"), link())],
  ])("classifies foreign: %s", (_n, kind, make) => {
    mkdirSync(bin(), { recursive: true });
    make();
    expect(classifyLink({ home, wrapper })).toMatchObject({ kind: "foreign", foreignKind: kind });
  });
  it("install refuses a foreign file and leaves it untouched", async () => {
    mkdirSync(bin(), { recursive: true });
    writeFileSync(link(), "my own script");
    const r = await installCommand(opts());
    expect(r).toMatchObject({ ok: false, code: "foreign", path: link() });
    expect(readFileSync(link(), "utf8")).toBe("my own script");
  });
  it("install refuses a foreign symlink and keeps its target", async () => {
    mkdirSync(bin(), { recursive: true });
    symlinkSync("/usr/local/bin/other-council", link());
    expect((await installCommand(opts())).ok).toBe(false);
    expect(readlinkSync(link())).toBe("/usr/local/bin/other-council");
  });
});

describe("Requirement: command install", () => {
  it("first install creates the dir and the link", async () => {
    const r = await installCommand(opts({ shell: stubShell("sh1", "exit 1") }));
    expect(r).toMatchObject({ ok: true, changed: true, updated: false });
    expect(readlinkSync(link())).toBe(wrapper);
  });
  it("is idempotent: same result and unchanged mtime", async () => {
    const shell = stubShell("sh1", "exit 1");
    const a = await installCommand(opts({ shell }));
    const m1 = lstatSync(link()).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    const b = await installCommand(opts({ shell }));
    expect(b).toMatchObject({ ok: true, changed: false, updated: false });
    expect(b).toMatchObject({ status: (a as { status: object }).status });
    expect(lstatSync(link()).mtimeMs).toBe(m1);
  });
  it("rewrites a stale link to the current wrapper", async () => {
    mkdirSync(bin(), { recursive: true });
    symlinkSync(join(root, "B", "Osen.app", "Contents", "Resources", "bin", "council"), link());
    const r = await installCommand(opts({ shell: stubShell("sh1", "exit 1") }));
    expect(r).toMatchObject({ ok: true, changed: true, updated: true });
    expect(readlinkSync(link())).toBe(wrapper);
    expect(readdirSync(bin())).toEqual(["council"]);
  });
  it("no_wrapper creates nothing", async () => {
    const missing = join(root, "none", "council");
    const r = await installCommand(opts({ wrapper: missing }));
    expect(r).toMatchObject({ ok: false, code: "no_wrapper", path: missing });
    expect(existsSync(join(home, ".local"))).toBe(false);
  });
  it("non-executable wrapper is no_wrapper", async () => {
    chmodSync(wrapper, 0o644);
    expect(await installCommand(opts())).toMatchObject({ ok: false, code: "no_wrapper" });
  });
  it("~/.local/bin as a regular file gives create_failed and leaves nothing", async () => {
    mkdirSync(join(home, ".local"));
    writeFileSync(bin(), "i am a file");
    const r = await installCommand(opts());
    expect(r).toMatchObject({ ok: false, code: "create_failed", path: link() });
    expect((r as { detail?: string }).detail).toBeTruthy();
    expect(readFileSync(bin(), "utf8")).toBe("i am a file");
    expect(readdirSync(join(home, ".local"))).toEqual(["bin"]);
  });
  it("failed create removes the dirs this call created", async () => {
    chmodSync(home, 0o500);
    try {
      const r = await installCommand(opts());
      expect(r).toMatchObject({ ok: false, code: "create_failed" });
    } finally {
      chmodSync(home, 0o700);
    }
    expect(readdirSync(home)).toEqual([]);
  });
});

describe("Requirement: only the own link is removed", () => {
  it("removes own link, keeps siblings and the dir", async () => {
    mkdirSync(bin(), { recursive: true });
    writeFileSync(join(bin(), "other"), "x");
    mkdirSync(join(bin(), "subdir"));
    symlinkSync(wrapper, link());
    expect(removeCommand(opts())).toEqual({ ok: true, removed: true });
    expect(readdirSync(bin()).sort()).toEqual(["other", "subdir"]);
  });
  it("removes a stale link", () => {
    mkdirSync(bin(), { recursive: true });
    symlinkSync("/x/Osen.app/Contents/Resources/bin/council", link());
    expect(removeCommand(opts())).toEqual({ ok: true, removed: true });
    expect(existsSync(link())).toBe(false);
  });
  it("refuses a foreign object", () => {
    mkdirSync(bin(), { recursive: true });
    writeFileSync(link(), "mine");
    expect(removeCommand(opts())).toMatchObject({ ok: false, code: "foreign", path: link() });
    expect(readFileSync(link(), "utf8")).toBe("mine");
  });
  it("missing link is ok without changes", () => {
    expect(removeCommand(opts())).toEqual({ ok: true, removed: false });
    expect(existsSync(join(home, ".local"))).toBe(false);
  });
});

describe("Requirement: PATH availability check (real zsh)", () => {
  const zdot = () => join(root, "zdot");
  const probeEnv = () => ({ HOME: home, ZDOTDIR: zdot(), PATH: "/usr/bin:/bin" });
  const setup = (zprofile: string) => {
    mkdirSync(zdot(), { recursive: true });
    writeFileSync(join(zdot(), ".zprofile"), zprofile);
    writeFileSync(join(zdot(), ".zshrc"), "echo 'WELCOME BANNER council /fake/path'\n");
    mkdirSync(bin(), { recursive: true });
    symlinkSync(wrapper, link());
  };
  const sha = () => createHash("sha256").update(readFileSync(join(zdot(), ".zprofile"))).digest("hex");
  const st = () => commandStatus(opts({ env: probeEnv(), shell: "/bin/zsh" }));

  it("found when ~/.local/bin is in PATH (banner noise ignored)", async () => {
    setup(`${LINK_HINT_LINE}\n`);
    expect(await st()).toMatchObject({ state: "found", link: link(), target: wrapper });
  });
  it("not_in_path with the hint, .zprofile untouched", async () => {
    setup('export PATH="/usr/bin:/bin"\n');
    const before = sha();
    expect(await st()).toMatchObject({ state: "not_in_path", hint: { file: "~/.zprofile", line: 'export PATH="$HOME/.local/bin:$PATH"' } });
    expect(sha()).toBe(before);
  });
  it("shadowed by another council earlier in PATH", async () => {
    const other = join(root, "shadow");
    mkdirSync(other);
    writeFileSync(join(other, "council"), "#!/bin/sh\n");
    chmodSync(join(other, "council"), 0o755);
    setup(`export PATH="$HOME/.local/bin:$PATH"\nexport PATH="${other}:$PATH"\n`);
    expect(await st()).toMatchObject({ state: "shadowed", shadowedBy: join(other, "council") });
  });
  it("stale takes priority and needs no shell", async () => {
    rmSync(root + "/never", { force: true });
    mkdirSync(bin(), { recursive: true });
    symlinkSync("/x/Osen.app/Contents/Resources/bin/council", link());
    expect(await commandStatus(opts({ shell: "/nonexistent/shell" }))).toMatchObject({ state: "stale", expected: wrapper });
  });
});

describe("Requirement: unresponsive shell is check_failed, never not_in_path", () => {
  beforeEach(() => {
    mkdirSync(bin(), { recursive: true });
    symlinkSync(wrapper, link());
  });
  it.each([
    ["exit 3", "exit 3", 5000],
    ["sleep", "sleep 30", 500],
    ["no markers", "echo hello", 5000],
  ])("%s", async (_n, body, timeoutMs) => {
    const s = await commandStatus(opts({ shell: stubShell("stub", body), timeoutMs }));
    expect(s.state).toBe("check_failed");
    expect(s).toHaveProperty("reason");
    expect(describeState(s, "en")).not.toContain("export PATH");
  });
  it("missing shell binary", async () => {
    expect((await commandStatus(opts({ shell: join(root, "nope") }))).state).toBe("check_failed");
  });
});

describe("Requirement: messages in the selected language", () => {
  it("has the same keys in en and ru", () => {
    expect(Object.keys(commandInstall("ru")).sort()).toEqual(Object.keys(commandInstall("en")).sort());
  });
  it("foreign refusal differs by language but keeps the path", async () => {
    mkdirSync(bin(), { recursive: true });
    writeFileSync(link(), "x");
    const en = await installCommand(opts({ language: "en" }));
    const ru = await installCommand(opts({ language: "ru" }));
    if (en.ok || ru.ok) throw new Error("expected refusals");
    expect(en.message).not.toBe(ru.message);
    expect(en.message).toContain(link());
    expect(ru.message).toContain(link());
    expect(en.code).toBe(ru.code);
  });
  it.each(["en", "ru"] as const)("not_in_path text keeps the hint line verbatim (%s)", (language) => {
    const text = describeState({ state: "not_in_path", link: link(), target: wrapper, hint: { file: "~/.zprofile", line: LINK_HINT_LINE } }, language);
    expect(text).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(text).toContain("~/.zprofile");
  });
});
