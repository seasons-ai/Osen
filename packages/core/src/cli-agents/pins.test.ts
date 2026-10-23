import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeExecutable } from "../executable.testutil.ts";
import { setProcessLanguage } from "../i18n/process-language.ts";
import {
  activePin, cliDir, installPin, installedPath, listPins, pinConfigDir, pinsFileState, pinsPath, readPins, rollbackPin, usePin, versionDir,
  type PackageSource, type PinDeps
} from "./pins.ts";
import type { VerifiedEntry, VerifiedRecord } from "./verified-record.ts";

const real = (agent: "claude" | "codex", version: string): VerifiedEntry => ({ agent, version, level: "real", checkedAt: "2026-10-20", os: "darwin-arm64", osenVersion: "1.0.0", modelCalls: 2 });
const iface = (agent: "claude" | "codex", version: string): VerifiedEntry => ({ agent, version, level: "interface", checkedAt: "2026-10-20", os: "darwin-arm64", osenVersion: "1.0.0" });
const record: VerifiedRecord = { entries: [real("claude", "1.0.0"), real("claude", "1.1.0"), iface("claude", "2.0.0"), real("codex", "0.5.0")] };

let dir: string;
let calls: Array<{ agent: string; version: string; dir: string }>;
let sourceMode: "ok" | "throw" | "wrong-version" | "outside";
let t = 0;
const now = () => new Date(Date.UTC(2026, 9, 20, 10, 0, t++, 123));

function fakeSource(): PackageSource {
  return {
    async fetch(agent, version, d) {
      calls.push({ agent, version, dir: d });
      if (sourceMode === "throw") throw new Error("registry down");
      const exe = join(d, "node_modules", "pkg", "bin", agent);
      mkdirSync(join(d, "node_modules", "pkg", "bin"), { recursive: true });
      const reported = sourceMode === "wrong-version" ? "9.9.9" : version;
      writeExecutable(exe, `#!/bin/sh\necho "${reported} (fake)"\n`);
      if (sourceMode === "outside") return { executable: process.execPath, source: "fake" };
      return { executable: exe, source: `fake:${agent}@${version}` };
    }
  };
}
// The fake binary only echoes its version, so it is read from the file: a child process from the test worker costs ~0.4 s,
// and several seconds in a full parallel run (hooks with 3 installs hit their 10 s timeout). The real child probe keeps one test below.
const stubVersion = async (path: string) => /echo "([^"]*)"/.exec(readFileSync(path, "utf8"))![1]!;
const deps = (): PinDeps => ({ source: fakeSource(), record, now, readVersion: stubVersion });
const install = (agent: string, opts: { version?: string; candidate?: boolean } = {}) => installPin(dir, agent, opts, deps());
const pinsOf = () => JSON.parse(readFileSync(pinsPath(dir), "utf8"));
const claude = () => pinsOf().agents.claude;
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function treeHash(root: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(p).update(readFileSync(p));
    }
  };
  walk(root);
  return h.digest("hex");
}

beforeEach(() => {
  setProcessLanguage("en");
  dir = mkdtempSync(join(tmpdir(), "pins-"));
  calls = [];
  sourceMode = "ok";
  t = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Шов источника пакета", () => {
  it("calls the source once with agent, version and a temp folder inside the data folder", async () => {
    const r = await installPin(dir, "claude", { version: "1.1.0" }, { source: fakeSource(), record, now }); // the real --version child
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.agent).toBe("claude");
    expect(calls[0]!.version).toBe("1.1.0");
    expect(calls[0]!.dir.startsWith(join(cliDir(dir), "claude") + "/")).toBe(true);
  });

  it("the install-time --version probe runs as a pin: own config dir and self-update off, never the owner's config", async () => {
    const seen: Record<string, string | undefined>[] = [];
    const r = await installPin(dir, "claude", { version: "1.1.0" }, { ...deps(), readVersion: async (_p, vars) => (seen.push(vars), "1.1.0 (Claude Code)") });
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.CLAUDE_CONFIG_DIR).toMatch(/\/cli\/claude\/\.install-[^/]+\/config$/);
    expect(seen[0]!.DISABLE_AUTOUPDATER).toBe("1");
    expect(existsSync(pinConfigDir(dir, "claude", "1.1.0"))).toBe(true);
  });
});

describe("Установка закреплённой версии", () => {
  it("default version is the newest real one, not the newer interface one, and becomes active", async () => {
    const r = await install("claude");
    expect(r.ok).toBe(true);
    expect(calls[0]!.version).toBe("1.1.0");
    expect(claude().active).toBe("1.1.0");
    expect(existsSync(versionDir(dir, "claude", "1.1.0"))).toBe(true);
    expect(existsSync(pinConfigDir(dir, "claude", "1.1.0"))).toBe(true);
  });

  it("second real version does not change active or activatedAt", async () => {
    await install("claude", { version: "1.1.0" });
    const before = claude().activatedAt;
    await install("claude", { version: "1.0.0" });
    expect(claude().active).toBe("1.1.0");
    expect(claude().activatedAt).toBe(before);
    expect(claude().installed).toHaveLength(2);
  });

  it("refuses a non-real or unrecorded version with code 2 naming the level and creates no cli/", async () => {
    const a = await install("claude", { version: "2.0.0" });
    expect(a).toMatchObject({ ok: false, code: 2 });
    expect(a.text).toContain("interface");
    const b = await install("claude", { version: "3.0.0" });
    expect(b).toMatchObject({ ok: false, code: 2 });
    expect(b.text).toContain("not recorded");
    expect(existsSync(cliDir(dir))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("--candidate installs a non-real version but never activates", async () => {
    const r = await install("claude", { version: "2.0.0", candidate: true });
    expect(r.ok).toBe(true);
    expect(claude().active).toBeNull();
    expect(claude().activatedAt).toBeNull();
    await install("claude", { version: "1.0.0" });
    const at = claude().activatedAt;
    await install("claude", { version: "1.1.0", candidate: true });
    expect(claude().active).toBe("1.0.0");
    expect(claude().activatedAt).toBe(at);
  });

  it("no real version for the agent: code 2, nothing installed", async () => {
    const r = await installPin(dir, "claude", {}, { ...deps(), record: { entries: [iface("claude", "2.0.0")] } });
    expect(r).toMatchObject({ ok: false, code: 2 });
    expect(existsSync(cliDir(dir))).toBe(false);
  });

  it("unknown agent and bad version format: code 2 before touching the disk", async () => {
    expect(await install("gemini")).toMatchObject({ ok: false, code: 2 });
    expect(await install("claude", { version: "1.x" })).toMatchObject({ ok: false, code: 2 });
    expect(existsSync(cliDir(dir))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it.each(["throw", "wrong-version", "outside"] as const)("source failure (%s): code 1, no leftovers, pins.json unchanged", async (mode) => {
    sourceMode = mode;
    const r = await install("claude", { version: "1.1.0" });
    expect(r).toMatchObject({ ok: false, code: 1 });
    if (mode === "wrong-version") expect(r.text).toContain("9.9.9");
    if (mode === "wrong-version") expect(r.text).toContain("1.1.0");
    expect(existsSync(cliDir(dir))).toBe(false);
  });

  it("failure after a good install leaves the first install untouched and no temp folders", async () => {
    await install("claude", { version: "1.1.0" });
    const before = readFileSync(pinsPath(dir), "utf8");
    sourceMode = "throw";
    await install("claude", { version: "1.0.0" });
    expect(readFileSync(pinsPath(dir), "utf8")).toBe(before);
    expect(readdirSync(join(cliDir(dir), "claude"))).toEqual(["1.1.0"]);
  });

  it("pins.json write failure rolls back the renamed version folder", async () => {
    mkdirSync(pinsPath(dir), { recursive: true }); // a directory where the file must go: rename fails
    const r = await install("claude", { version: "1.1.0" });
    expect(r).toMatchObject({ ok: false, code: 1 });
    expect(existsSync(versionDir(dir, "claude", "1.1.0"))).toBe(false);
  });

  it("repeat install: source not called, nothing rewritten, code 0", async () => {
    await install("claude", { version: "1.1.0" });
    const bytes = readFileSync(pinsPath(dir));
    const mtime = statSync(pinsPath(dir)).mtimeMs;
    const r = await install("claude", { version: "1.1.0" });
    expect(r).toMatchObject({ ok: true, code: 0 });
    expect(r.text).toContain("already installed");
    expect(calls).toHaveLength(1);
    expect(readFileSync(pinsPath(dir)).equals(bytes)).toBe(true);
    expect(statSync(pinsPath(dir)).mtimeMs).toBe(mtime);
  });

  it("a use made while the source is still fetching is kept by the install", async () => {
    await install("claude", { version: "1.1.0" });
    await install("claude", { version: "1.0.0" });
    const base = fakeSource();
    const slow: PackageSource = {
      async fetch(agent, version, d) {
        expect(usePin(dir, "claude", "1.0.0", { record, now }).code).toBe(0);
        return base.fetch(agent, version, d);
      },
    };
    const r = await installPin(dir, "claude", { version: "2.0.0", candidate: true }, { source: slow, record, now });
    expect(r.code).toBe(0);
    const s = readPins(dir);
    expect(s.state === "loaded" && s.pins.agents.claude).toMatchObject({ active: "1.0.0", previous: "1.1.0" });
  });

  it("a leftover version folder not in pins.json: code 1 and not deleted", async () => {
    const left = versionDir(dir, "claude", "1.1.0");
    mkdirSync(left, { recursive: true });
    writeFileSync(join(left, "keep"), "x");
    const r = await install("claude", { version: "1.1.0" });
    expect(r).toMatchObject({ ok: false, code: 1 });
    expect(readFileSync(join(left, "keep"), "utf8")).toBe("x");
    expect(calls).toHaveLength(0);
  });

  it("everything is written under the data folder only", async () => {
    await install("claude", { version: "1.1.0" });
    expect(readdirSync(dir).sort()).toEqual(["cli", "logs"]);
  });
});

describe("Файл закреплений pins.json", () => {
  it("records path, source, version and the sha256 of the file on disk; path is relative", async () => {
    await install("claude", { version: "1.1.0" });
    const i = claude().installed[0];
    expect(i.path).toBe("node_modules/pkg/bin/claude");
    expect(i.source).toBe("fake:claude@1.1.0");
    expect(i.sha256).toBe(sha(installedPath(dir, "claude", i)));
    expect(i.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("activatedAt follows install, use, rollback and ignores candidate and repeat install", async () => {
    await install("claude", { version: "1.0.0" });
    const a1 = claude().activatedAt;
    await install("claude", { version: "1.1.0" });
    await install("claude", { version: "1.1.0" });
    await install("claude", { version: "2.0.0", candidate: true });
    expect(claude().activatedAt).toBe(a1);
    const installedAt = claude().installed.map((x: { installedAt: string }) => x.installedAt);
    usePin(dir, "claude", "1.1.0", { record, now });
    const a2 = claude().activatedAt;
    expect(a2).not.toBe(a1);
    rollbackPin(dir, "claude", { now });
    const a3 = claude().activatedAt;
    expect(a3).not.toBe(a2);
    expect(claude().installed.map((x: { installedAt: string }) => x.installedAt)).toEqual(installedAt);
  });

  it("a corrupted file: install, use and rollback refuse with path and reason, file unchanged", async () => {
    mkdirSync(cliDir(dir));
    writeFileSync(pinsPath(dir), "{ nope");
    for (const r of [await install("claude", { version: "1.1.0" }), usePin(dir, "claude", "1.1.0", { record }), rollbackPin(dir, "claude", {})]) {
      expect(r).toMatchObject({ ok: false, code: 1 });
      expect(r.text).toContain(pinsPath(dir));
    }
    expect(readFileSync(pinsPath(dir), "utf8")).toBe("{ nope");
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["newer schemaVersion", { schemaVersion: 2, agents: {} }, "schemaVersion"],
    ["unknown key", { schemaVersion: 1, agents: {}, extra: 1 }, "extra"],
    ["active not installed", { schemaVersion: 1, agents: { claude: { installed: [], active: "1.0.0", previous: null, activatedAt: null } } }, "agents.claude.active"],
    ["path with ..", { schemaVersion: 1, agents: { claude: { installed: [{ version: "1.0.0", path: "../x", source: "s", sha256: "a".repeat(64), installedAt: "2026-10-20T10:00:00Z" }], active: null, previous: null, activatedAt: null } } }, "path"],
    ["absolute path", { schemaVersion: 1, agents: { claude: { installed: [{ version: "1.0.0", path: "/bin/sh", source: "s", sha256: "a".repeat(64), installedAt: "2026-10-20T10:00:00Z" }], active: null, previous: null, activatedAt: null } } }, "path"],
    ["milliseconds in a date", { schemaVersion: 1, agents: { claude: { installed: [], active: null, previous: null, activatedAt: "2026-10-20T10:00:00.000Z" } } }, "activatedAt"]
  ])("rejects %s naming the place and never rewrites it", (_n, content, place) => {
    mkdirSync(cliDir(dir));
    writeFileSync(pinsPath(dir), JSON.stringify(content));
    const s = readPins(dir);
    expect(s.state).toBe("rejected");
    if (s.state === "rejected") {
      expect(s.reason).toContain(pinsPath(dir));
      expect(s.reason).toContain(place);
    }
    expect(activePin(dir, "claude").state).toBe("rejected");
  });

  it("unreadable file is rejected", () => {
    mkdirSync(pinsPath(dir), { recursive: true });
    expect(readPins(dir).state).toBe("rejected");
  });

  it("an absent file: reading creates nothing, activePin is none", () => {
    expect(readPins(dir)).toEqual({ state: "absent" });
    expect(activePin(dir, "claude")).toEqual({ state: "none" });
    expect(existsSync(cliDir(dir))).toBe(false);
    expect(pinsFileState(dir)).toBe("ENOENT");
  });

  it("activePin gives the absolute path and the per-install config dir", async () => {
    await install("claude", { version: "1.1.0" });
    const a = activePin(dir, "claude");
    expect(a).toEqual({ state: "pin", version: "1.1.0", path: join(versionDir(dir, "claude", "1.1.0"), "node_modules/pkg/bin/claude"), configDir: pinConfigDir(dir, "claude", "1.1.0"), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(activePin(dir, "codex")).toEqual({ state: "none" });
  });

  it("pinsFileState changes when the file is rewritten", async () => {
    await install("claude", { version: "1.1.0" });
    const s = pinsFileState(dir);
    await install("claude", { version: "1.0.0" });
    expect(pinsFileState(dir)).not.toBe(s);
  });

  it("holds no env values", async () => {
    process.env.PIN_TEST_SECRET_VALUE = "very-secret-value-123";
    try {
      await install("claude", { version: "1.1.0" });
      expect(readFileSync(pinsPath(dir), "utf8")).not.toContain("very-secret-value-123");
    } finally {
      delete process.env.PIN_TEST_SECRET_VALUE;
    }
  });
});

describe("Список закреплений", () => {
  it("no pins: code 0 and nothing created", () => {
    const r = listPins(dir, record);
    expect(r).toMatchObject({ ok: true, code: 0 });
    expect(r.text).toBe("No pinned installs");
    expect(existsSync(cliDir(dir))).toBe(false);
  });

  it("two versions with active and previous marks, level and date", async () => {
    await install("claude", { version: "1.0.0" });
    await install("claude", { version: "1.1.0" });
    await install("claude", { version: "2.0.0", candidate: true });
    usePin(dir, "claude", "1.1.0", { record, now });
    const text = listPins(dir, record).text;
    expect(text).toMatch(/1\.1\.0 \[active\]  level: real/);
    expect(text).toMatch(/1\.0\.0 \[previous\]  level: real/);
    expect(text).toMatch(/2\.0\.0  level: interface/);
    expect(text).toMatch(/installed: 2026-10-20T/);
    expect(calls).toHaveLength(3);
  });

  it("a rejected file: code 1", () => {
    mkdirSync(cliDir(dir));
    writeFileSync(pinsPath(dir), "[]");
    expect(listPins(dir, record)).toMatchObject({ ok: false, code: 1 });
  });
});

describe("Переключение и откат", () => {
  beforeEach(async () => {
    await install("claude", { version: "1.0.0" });
    await install("claude", { version: "1.1.0" });
    await install("claude", { version: "2.0.0", candidate: true });
  });

  it("use makes the version active and the old one previous; both stay on disk", () => {
    const r = usePin(dir, "claude", "1.1.0", { record, now });
    expect(r.ok).toBe(true);
    expect(claude()).toMatchObject({ active: "1.1.0", previous: "1.0.0" });
    expect(existsSync(versionDir(dir, "claude", "1.0.0"))).toBe(true);
  });

  it("use of the active version: code 0, no write at all", () => {
    const bytes = readFileSync(pinsPath(dir));
    const mtime = statSync(pinsPath(dir)).mtimeMs;
    const r = usePin(dir, "claude", "1.0.0", { record, now });
    expect(r).toMatchObject({ ok: true, code: 0 });
    expect(r.text).toContain("already active");
    expect(readFileSync(pinsPath(dir)).equals(bytes)).toBe(true);
    expect(statSync(pinsPath(dir)).mtimeMs).toBe(mtime);
  });

  it("use of a non-real, not-installed or file-less version: code 2, pins.json unchanged", () => {
    rmSync(versionDir(dir, "claude", "1.1.0"), { recursive: true });
    const bytes = readFileSync(pinsPath(dir));
    expect(usePin(dir, "claude", "2.0.0", { record, now })).toMatchObject({ ok: false, code: 2 });
    expect(usePin(dir, "claude", "7.7.7", { record, now })).toMatchObject({ ok: false, code: 2 });
    expect(usePin(dir, "claude", "1.1.0", { record, now })).toMatchObject({ ok: false, code: 2 });
    expect(usePin(dir, "gemini", "1.1.0", { record, now })).toMatchObject({ ok: false, code: 2 });
    expect(readFileSync(pinsPath(dir)).equals(bytes)).toBe(true);
  });

  it("rollback restores previous and empties it; a second rollback is refused", () => {
    usePin(dir, "claude", "1.1.0", { record, now });
    expect(rollbackPin(dir, "claude", { now }).ok).toBe(true);
    expect(claude()).toMatchObject({ active: "1.0.0", previous: null });
    expect(rollbackPin(dir, "claude", { now })).toMatchObject({ ok: false, code: 2 });
  });

  it("rollback with a missing previous file is refused with code 2", () => {
    usePin(dir, "claude", "1.1.0", { record, now });
    rmSync(versionDir(dir, "claude", "1.0.0"), { recursive: true });
    const bytes = readFileSync(pinsPath(dir));
    expect(rollbackPin(dir, "claude", { now })).toMatchObject({ ok: false, code: 2 });
    expect(readFileSync(pinsPath(dir)).equals(bytes)).toBe(true);
  });

  it("Переключение и откат: file changed after install: use is refused with version, path and both sums", () => {
    const inst = claude().installed.find((i: { version: string }) => i.version === "1.1.0");
    const file = installedPath(dir, "claude", inst);
    appendFileSync(file, "# changed\n");
    const bytes = readFileSync(pinsPath(dir));
    const r = usePin(dir, "claude", "1.1.0", { record, now });
    expect(r).toMatchObject({ ok: false, code: 2 });
    for (const part of ["1.1.0", file, inst.sha256, sha(file)]) expect(r.text).toContain(part);
    expect(readFileSync(pinsPath(dir)).equals(bytes)).toBe(true);
    expect(claude()).toMatchObject({ active: "1.0.0", previous: null });
  });

  it("Переключение и откат: file changed after install: rollback is refused and previous is kept", () => {
    usePin(dir, "claude", "1.1.0", { record, now });
    const inst = claude().installed.find((i: { version: string }) => i.version === "1.0.0");
    const file = installedPath(dir, "claude", inst);
    appendFileSync(file, "# changed\n");
    const bytes = readFileSync(pinsPath(dir));
    const r = rollbackPin(dir, "claude", { now });
    expect(r).toMatchObject({ ok: false, code: 2 });
    for (const part of ["1.0.0", file, inst.sha256, sha(file)]) expect(r.text).toContain(part);
    expect(readFileSync(pinsPath(dir)).equals(bytes)).toBe(true);
    expect(claude()).toMatchObject({ active: "1.1.0", previous: "1.0.0" });
  });

  it("Переключение и откат: a missing or changed file: text names the path for the terminal, textNoPath does not", () => {
    const inst = (v: string) => claude().installed.find((i: { version: string }) => i.version === v);
    const file11 = installedPath(dir, "claude", inst("1.1.0"));
    appendFileSync(file11, "# changed\n");
    const changed = usePin(dir, "claude", "1.1.0", { record, now });
    if (changed.ok) throw new Error("expected a refusal");
    expect(changed.text).toContain(file11);
    expect(changed.textNoPath).toContain(sha(file11));
    expect(changed.textNoPath).not.toContain(dir);
    rmSync(versionDir(dir, "claude", "1.1.0"), { recursive: true });
    const missing = usePin(dir, "claude", "1.1.0", { record, now });
    expect(missing).toMatchObject({ ok: false, code: 2, text: expect.stringContaining(file11), textNoPath: "The file of claude 1.1.0 is missing" });
  });

  it("Переключение и откат: rollback with a missing or changed previous file: textNoPath has no path", () => {
    usePin(dir, "claude", "1.1.0", { record, now });
    const file = installedPath(dir, "claude", claude().installed.find((i: { version: string }) => i.version === "1.0.0"));
    appendFileSync(file, "# changed\n");
    const changed = rollbackPin(dir, "claude", { now });
    if (changed.ok) throw new Error("expected a refusal");
    expect(changed.text).toContain(file);
    expect(changed.textNoPath).toMatch(/does not match/);
    expect(changed.textNoPath).not.toContain(dir);
    rmSync(versionDir(dir, "claude", "1.0.0"), { recursive: true });
    const missing = rollbackPin(dir, "claude", { now });
    if (missing.ok) throw new Error("expected a refusal");
    expect(missing.text).toContain(file);
    expect(missing.textNoPath).toBe("The file of claude 1.0.0 is missing");
    setProcessLanguage("ru");
    const ru = rollbackPin(dir, "claude", { now });
    if (ru.ok) throw new Error("expected a refusal");
    expect(ru.textNoPath).toBe("Файл claude 1.0.0 отсутствует");
  });

  it("switch and rollback: file without the execute bit: use and rollback are refused, pin unchanged", () => {
    const inst = (v: string) => claude().installed.find((i: { version: string }) => i.version === v);
    const check = (r: ReturnType<typeof usePin>, version: string, file: string, notExec: string) => {
      if (r.ok) throw new Error("expected a refusal");
      expect(r.code).toBe(2);
      for (const part of [version, file, notExec]) expect(r.text).toContain(part);
      expect(r.textNoPath).toContain(version);
      expect(r.textNoPath).toContain(notExec);
      expect(r.textNoPath).not.toContain(dir);
    };
    const file11 = installedPath(dir, "claude", inst("1.1.0"));
    chmodSync(file11, 0o644);
    const bytes = readFileSync(pinsPath(dir));
    check(usePin(dir, "claude", "1.1.0", { record, now }), "1.1.0", file11, "not executable");
    expect(readFileSync(pinsPath(dir)).equals(bytes)).toBe(true);
    chmodSync(file11, 0o755);
    expect(usePin(dir, "claude", "1.1.0", { record, now }).ok).toBe(true);
    const file10 = installedPath(dir, "claude", inst("1.0.0"));
    chmodSync(file10, 0o644);
    const bytes2 = readFileSync(pinsPath(dir));
    check(rollbackPin(dir, "claude", { now }), "1.0.0", file10, "not executable");
    expect(readFileSync(pinsPath(dir)).equals(bytes2)).toBe(true);
    expect(claude()).toMatchObject({ active: "1.1.0", previous: "1.0.0" });
    setProcessLanguage("ru");
    check(rollbackPin(dir, "claude", { now }), "1.0.0", file10, "не исполняемый");
  });

  it("use and rollback leave sessions/ and config.json byte-identical", () => {
    mkdirSync(join(dir, "sessions", "s1"), { recursive: true });
    writeFileSync(join(dir, "sessions", "s1", "journal.jsonl"), '{"a":1}\n');
    writeFileSync(join(dir, "config.json"), '{"x":1}');
    const before = [treeHash(join(dir, "sessions")), readFileSync(join(dir, "config.json"), "utf8")];
    usePin(dir, "claude", "1.1.0", { record, now });
    rollbackPin(dir, "claude", { now });
    expect([treeHash(join(dir, "sessions")), readFileSync(join(dir, "config.json"), "utf8")]).toEqual(before);
  });
});

describe("Установки CLI в папке данных", () => {
  it("reading, listing and refusals never create cli/", async () => {
    readPins(dir);
    listPins(dir, record);
    usePin(dir, "claude", "1.0.0", { record });
    rollbackPin(dir, "claude", {});
    await install("claude", { version: "2.0.0" });
    expect(existsSync(cliDir(dir))).toBe(false);
  });
});
