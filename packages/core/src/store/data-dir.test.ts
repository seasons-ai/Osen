import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { DataDirError, ensureDataDir, peekDataDir, prepareDataDir, resolveDataDir } from "./data-dir.ts";
import { appendEvent, createSessionJournal } from "./journal.ts";
import type { Session, SessionEvent } from "../protocol/schema.ts";

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "council-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) {
    try { chmodSync(join(d, "ro"), 0o755); } catch { /* no such folder */ }
    try { chmodSync(join(d, "Library", "Application Support", "model-council", ".env"), 0o644); } catch { /* no such file */ }
    rmSync(d, { recursive: true, force: true });
  }
});

const tree = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [`${e.name}/`, ...tree(join(d, e.name)).map((x) => `${e.name}/${x}`)] : [e.name])).sort();

describe("resolveDataDir", () => {
  it("1. darwin without COUNCIL_HOME", () => {
    expect(resolveDataDir({}, "darwin", "/Users/x")).toBe("/Users/x/Library/Application Support/osen");
  });

  it("2. linux: with XDG_CONFIG_HOME and without it", () => {
    expect(resolveDataDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/x")).toBe("/xdg/osen");
    expect(resolveDataDir({}, "linux", "/home/x")).toBe("/home/x/.config/osen");
  });

  it("3. COUNCIL_HOME: relative path becomes absolute, empty and spaces ignored", () => {
    expect(resolveDataDir({ COUNCIL_HOME: ".council-data" }, "darwin", "/Users/x")).toBe(resolve(".council-data"));
    expect(resolveDataDir({ COUNCIL_HOME: "" }, "darwin", "/Users/x")).toBe("/Users/x/Library/Application Support/osen");
    expect(resolveDataDir({ COUNCIL_HOME: "   " }, "linux", "/home/x")).toBe("/home/x/.config/osen");
  });
});

describe("ensureDataDir", () => {
  it("4. creates folder and subfolders, does not create config.json and .env", () => {
    const dir = join(tmp(), "a", "data");
    expect(ensureDataDir(dir)).toBe(dir);
    expect(tree(dir)).toEqual(["logs/", "sessions/", "templates/"]);
    expect(existsSync(join(dir, "config.json"))).toBe(false);
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("5. existing data does not change", () => {
    const dir = tmp();
    mkdirSync(join(dir, "sessions", "abc"), { recursive: true });
    const files = { "config.json": "{}", ".env": "KEY=secret\n", "sessions/abc/events.jsonl": '{"a":1}\n' };
    for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
    const before = Object.fromEntries(Object.keys(files).map((f) => [f, statSync(join(dir, f)).mtimeMs]));
    ensureDataDir(dir);
    for (const [f, c] of Object.entries(files)) {
      expect(readFileSync(join(dir, f), "utf8")).toBe(c);
      expect(statSync(join(dir, f)).mtimeMs).toBe(before[f]);
    }
    expect(tree(dir)).toEqual([".env", "config.json", "logs/", "sessions/", "sessions/abc/", "sessions/abc/events.jsonl", "templates/"]);
  });

  it("6a. parent is a regular file: DataDirError with path", () => {
    const base = tmp();
    writeFileSync(join(base, "file.txt"), "x");
    const dir = join(base, "file.txt", "data");
    expect(() => ensureDataDir(dir)).toThrow(DataDirError);
    expect(() => ensureDataDir(dir)).toThrow(dir);
  });

  it.skipIf(process.getuid?.() === 0)("6б. папка без прав записи: DataDirError с путём", () => {
    const dir = join(tmp(), "ro");
    mkdirSync(dir);
    chmodSync(dir, 0o555);
    try {
      expect(() => ensureDataDir(dir)).toThrow(DataDirError);
      expect(() => ensureDataDir(dir)).toThrow(dir);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

// ---- prepareDataDir ----
const ts = "2026-01-01T00:00:00.000Z";
const mkSession = (id: string): Session => ({
  id, createdAt: ts, origin: "cli", topic: `Тема ${id}`, templateId: null, framing: "",
  participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: "scripted", model: "m", role: null })),
  limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
});
// Running session: pid of the live test process, without a completion event.
function addSession(dir: string, id: string, finished: boolean): void {
  createSessionJournal(dir, id);
  appendEvent(dir, id, { seq: 1, ts, type: "session_created", session: mkSession(id), pid: 1 } as SessionEvent);
  if (finished) appendEvent(dir, id, { seq: 2, ts, type: "session_finished", status: "consensus", version: 1, agreed: ["p1", "p2"], objectors: [] } as SessionEvent);
}
const BIN = Buffer.from([0, 1, 2, 255, 254, 10, 13, 200]);
function fill(dir: string, session: "none" | "finished" | "running"): void {
  mkdirSync(join(dir, "templates"), { recursive: true });
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(join(dir, ".env"), "KEY=secret\n");
  writeFileSync(join(dir, "config.json"), '{"a":1}');
  writeFileSync(join(dir, "templates", "my.md"), "шаблон");
  writeFileSync(join(dir, "bin.dat"), BIN);
  if (session !== "none") addSession(dir, "s1", session === "finished");
}
const layout = (home: string) => {
  const parent = join(home, "Library", "Application Support");
  mkdirSync(parent, { recursive: true });
  return { parent, old: join(parent, "model-council"), osen: join(parent, "osen"), lock: join(parent, "osen.migrating") };
};
const prep = (home: string, hooks = {}) => prepareDataDir({}, "darwin", home, hooks);
const backups = (parent: string) => readdirSync(parent).filter((n) => n.startsWith("model-council-backup-"));
const stable = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = join(d, e.name);
    const name = e.name.replace(/backup-\d{8}-\d{6}/, "backup-T");
    if (e.isSymbolicLink()) return [`${name}@${readlinkSync(p).startsWith("/") ? "внешняя цель" : readlinkSync(p)}`];
    return e.isDirectory() ? [`${name}/`, ...stable(p).map((x) => `${name}/${x}`)] : [e.name === "app.log" ? name : `${name}=${readFileSync(p).toString("hex")}`]; // log lines carry the copy's time and paths
  }).sort();
const content = (d: string, rel: string) => readFileSync(join(d, rel));

describe("prepareDataDir", () => {
  it("7. move: files byte for byte, link, one copy, log line with three paths", () => {
    const home = tmp();
    const { parent, old, osen } = layout(home);
    fill(old, "finished");
    writeFileSync(join(old, "logs", "app.log"), "прежняя строка\n");
    const before = stable(old);
    expect(prep(home)).toBe(osen);
    expect(lstatSync(old).isSymbolicLink()).toBe(true);
    expect(readlinkSync(old)).toBe("osen");
    expect(content(osen, "bin.dat").equals(BIN)).toBe(true);
    expect(backups(parent)).toHaveLength(1);
    const backup = join(parent, backups(parent)[0]!);
    expect(stable(backup)).toEqual(before);
    const log = readFileSync(join(osen, "logs", "app.log"), "utf8");
    expect(log).toContain("прежняя строка");
    const line = log.trim().split("\n").at(-1)!;
    for (const p of [old, osen, backup]) expect(line).toContain(p);
    expect(stable(osen).filter((x) => !x.startsWith("logs/"))).toEqual(before.filter((x) => !x.startsWith("logs/")));
  });

  it("7a. copy name — owner's local time, not UTC", () => {
    const tz = process.env.TZ;
    process.env.TZ = "Europe/Moscow"; // UTC+3 all year round: local and UTC differ
    try {
      const home = tmp();
      const { parent, old } = layout(home);
      fill(old, "none");
      const p2 = (n: number) => String(n).padStart(2, "0");
      const local = (d: Date) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      const from = new Date();
      prep(home);
      const to = new Date();
      const name = backups(parent)[0]!.replace("model-council-backup-", "");
      expect([local(from), local(to)]).toContain(name);
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
  });

  it("8. repeat after move: nothing changes, no warnings", () => {
    const home = tmp();
    const { parent, osen } = layout(home);
    fill(join(parent, "model-council"), "finished");
    prep(home);
    const before = stable(parent);
    expect(prep(home)).toBe(osen);
    expect(stable(parent)).toEqual(before);
  });

  it("9. link to osen: nothing is done and no log is written", () => {
    const home = tmp();
    const { parent, old, osen } = layout(home);
    fill(osen, "none");
    symlinkSync("osen", old);
    const before = stable(parent);
    expect(prep(home)).toBe(osen);
    expect(stable(parent)).toEqual(before);
    expect(existsSync(join(osen, "logs", "app.log"))).toBe(false);
  });

  it("10. link to another place: untouched, empty osen, warning with path and target", () => {
    const home = tmp();
    const { parent, old, osen } = layout(home);
    const other = join(tmp(), "other");
    fill(other, "none");
    symlinkSync(other, old);
    const snap = stable(other);
    expect(prep(home)).toBe(osen);
    expect(readlinkSync(old)).toBe(other);
    expect(stable(other)).toEqual(snap);
    expect(readdirSync(osen)).toEqual(["logs"]);
    const log = readFileSync(join(osen, "logs", "app.log"), "utf8");
    expect(log).toContain(old);
    expect(log).toContain(realpathSync(other));
    expect(backups(parent)).toEqual([]);
  });

  it("10a. Moving the previous data folder: dangling link names the target (absolute and relative)", () => {
    for (const [target, want] of [["/nonexistent/council-target", "/nonexistent/council-target"], ["нет/глубже", null]] as const) {
      const home = tmp();
      const { parent, old, osen } = layout(home);
      symlinkSync(target, old);
      expect(prep(home)).toBe(osen);
      expect(readlinkSync(old)).toBe(target);
      expect(readdirSync(osen)).toEqual(["logs"]);
      const log = readFileSync(join(osen, "logs", "app.log"), "utf8");
      expect(log).toContain(old);
      expect(log).toContain(`(ссылка на ${want ?? resolve(parent, target)})`);
      expect(log).not.toContain("(ссылка на ?)");
      expect(backups(parent)).toEqual([]);
    }
  });

  it("11. both real folders: nothing changes, warning with both paths", () => {
    const home = tmp();
    const { old, osen } = layout(home);
    fill(old, "none");
    fill(osen, "none");
    writeFileSync(join(osen, "only-osen"), "x");
    const a = stable(old);
    const b = stable(osen);
    expect(prep(home)).toBe(osen);
    expect(stable(old)).toEqual(a);
    expect(stable(osen).filter((x) => !x.startsWith("logs/app.log"))).toEqual(b);
    const log = readFileSync(join(osen, "logs", "app.log"), "utf8");
    expect(log).toContain(old);
    expect(log).toContain(osen);
  });

  it("12. session running: move deferred, model-council path, line with reason", () => {
    const home = tmp();
    const { parent, old, osen } = layout(home);
    fill(old, "running");
    expect(prep(home)).toBe(old);
    expect(lstatSync(old).isDirectory()).toBe(true);
    expect(existsSync(osen)).toBe(false);
    expect(backups(parent)).toEqual([]);
    expect(readFileSync(join(old, "logs", "app.log"), "utf8")).toContain(old);
  });

  it("13. session became running during copy: copy deleted, move deferred", () => {
    const home = tmp();
    const { parent, old, osen } = layout(home);
    fill(old, "none");
    expect(prep(home, { afterCopy: () => addSession(old, "late", false) })).toBe(old);
    expect(existsSync(osen)).toBe(false);
    expect(backups(parent)).toEqual([]);
    expect(lstatSync(old).isDirectory()).toBe(true);
    expect(existsSync(join(old, "sessions", "late"))).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("14. сбой копии: model-council прежняя, osen и копии нет, DataDirError с путём", () => {
    const home = tmp();
    const { parent, old, osen } = layout(home);
    fill(old, "finished");
    chmodSync(join(old, ".env"), 0o000);
    try {
      expect(() => prep(home)).toThrow(DataDirError);
      expect(() => prep(home)).toThrow(old);
      expect(lstatSync(old).isDirectory()).toBe(true);
      expect(existsSync(osen)).toBe(false);
      expect(backups(parent)).toEqual([]);
      expect(existsSync(join(parent, "osen.migrating"))).toBe(false);
    } finally {
      chmodSync(join(old, ".env"), 0o644);
    }
  });

  it("15. COUNCIL_HOME: disk not read, model-council untouched, osen not created", () => {
    const home = tmp();
    const { parent, old, osen } = layout(home);
    fill(old, "finished");
    const before = stable(parent);
    const custom = join(tmp(), "custom");
    expect(prepareDataDir({ COUNCIL_HOME: custom }, "darwin", home)).toBe(custom);
    expect(stable(parent)).toEqual(before);
    expect(existsSync(osen)).toBe(false);
    expect(existsSync(custom)).toBe(false);
  });

  it("16. linux: XDG_CONFIG_HOME/model-council is moved to osen", () => {
    const xdg = tmp();
    fill(join(xdg, "model-council"), "finished");
    expect(prepareDataDir({ XDG_CONFIG_HOME: xdg }, "linux", "/nonexistent")).toBe(join(xdg, "osen"));
    expect(content(join(xdg, "osen"), ".env").toString()).toBe("KEY=secret\n");
    expect(lstatSync(join(xdg, "model-council")).isSymbolicLink()).toBe(true);
  });

  it("17. lock of a dead process is taken over without waiting", () => {
    const home = tmp();
    const { parent, old, osen, lock } = layout(home);
    fill(old, "none");
    writeFileSync(lock, String(spawnSync(process.execPath, ["-e", ""]).pid));
    const t = Date.now();
    expect(prep(home)).toBe(osen);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(existsSync(lock)).toBe(false);
    expect(backups(parent)).toHaveLength(1);
  });

  it("18a. lock cannot be created (parent read-only): DataDirError with lock path, folder unchanged", () => {
    const home = tmp();
    const { parent, old, osen, lock } = layout(home);
    fill(old, "none");
    chmodSync(parent, 0o555);
    try {
      expect(() => prep(home)).toThrow(DataDirError);
      expect(() => prep(home)).toThrow(lock);
    } finally {
      chmodSync(parent, 0o755);
    }
    expect(lstatSync(old).isDirectory()).toBe(true);
    expect(existsSync(osen)).toBe(false);
  });

  it("18. lock of a live process: wait and DataDirError with lock path on expiry", () => {
    const home = tmp();
    const { old, lock } = layout(home);
    fill(old, "none");
    writeFileSync(lock, String(process.pid));
    const t = Date.now();
    expect(() => prep(home, { lockWaitMs: 400 })).toThrow(lock);
    expect(Date.now() - t).toBeGreaterThanOrEqual(400);
    expect(lstatSync(old).isDirectory()).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
  });

  it("19. state table: double call (with a rival under lock) gives the same tree as a single one, files not lost", () => {
    type O = "none" | "dir" | "running" | "toOsen" | "elsewhere";
    const olds: O[] = ["none", "dir", "running", "toOsen", "elsewhere"];
    const build = (o: O, osenDir: boolean) => {
      const home = tmp();
      const l = layout(home);
      const files = new Map<string, Buffer>();
      const note = (dir: string) => { for (const f of [".env", "config.json", "templates/my.md", "bin.dat"]) files.set(join(dir, f), content(dir, f)); };
      if (osenDir) { fill(l.osen, "none"); note(l.osen); }
      if (o === "dir" || o === "running") { fill(l.old, o === "running" ? "running" : "finished"); note(l.old); }
      if (o === "toOsen") symlinkSync("osen", l.old);
      if (o === "elsewhere") { const t = join(tmp(), "t"); fill(t, "none"); symlinkSync(t, l.old); }
      return { home, ...l, files, migrates: o === "dir" && !osenDir };
    };
    for (const o of olds) for (const osenDir of [false, true]) {
      const label = `${o}/${osenDir ? "osen" : "нет osen"}`;
      const one = build(o, osenDir);
      const two = build(o, osenDir);
      const r1 = prep(one.home);
      const r2 = prep(two.home, { beforeLock: () => prep(two.home) });
      expect(prep(two.home), label).toBe(r2);
      expect(stable(two.parent), label).toEqual(stable(one.parent));
      expect(r1.slice(one.parent.length), label).toBe(r2.slice(two.parent.length));
      for (const x of [one, two]) {
        expect(backups(x.parent).length, label).toBe(x.migrates ? 1 : 0);
        for (const [f, c] of x.files) expect(content("/", f).equals(c), `${label} ${f}`).toBe(true);
        if (x.migrates) {
          const b = join(x.parent, backups(x.parent)[0]!);
          for (const [f, c] of x.files) expect(content(b, f.slice(x.old.length + 1)).equals(c), `${label} backup ${f}`).toBe(true);
          expect(lstatSync(x.old).isSymbolicLink(), label).toBe(true);
          expect(readlinkSync(x.old), label).toBe("osen");
        }
      }
    }
  });
});

describe("Install preview: peekDataDir does not change disk", () => {
  // Exhaustive enumeration: the space is finite (4 × 6 × 2), enumeration is stronger than the generator.
  const snapshot = (d: string): string[] =>
    readdirSync(d, { recursive: true, encoding: "utf8" }).sort().map((rel) => {
      const p = join(d, rel);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) return `${rel} -> ${readlinkSync(p)}`;
      if (st.isDirectory()) return `${rel}/`;
      return `${rel} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
    });
  const osenStates = ["none", "dir", "file", "linkDir"] as const;
  const oldStates = ["none", "dir", "toOsen", "elsewhere", "dangling", "file"] as const;

  it("all combinations of osen × model-council × COUNCIL_HOME: path by rule, HOME tree unchanged, no log", () => {
    for (const o of osenStates) for (const m of oldStates) for (const custom of [false, true]) {
      const label = `osen=${o} model-council=${m} COUNCIL_HOME=${custom}`;
      const home = tmp();
      const parent = join(home, "Library", "Application Support");
      const osen = join(parent, "osen");
      const old = join(parent, "model-council");
      mkdirSync(parent, { recursive: true });
      const other = join(home, "other");
      mkdirSync(other);
      writeFileSync(join(other, "x.txt"), "чужое\n");
      if (o === "dir") { mkdirSync(osen); writeFileSync(join(osen, "config.json"), "{}"); }
      if (o === "file") writeFileSync(osen, "файл");
      if (o === "linkDir") symlinkSync(other, osen);
      if (m === "dir") {
        mkdirSync(join(old, "sessions", "x"), { recursive: true });
        writeFileSync(join(old, "preferences.json"), '{"language":"ru"}');
        writeFileSync(join(old, "sessions", "x", "events.jsonl"), "{}\n");
      }
      if (m === "toOsen") symlinkSync("osen", old);
      if (m === "elsewhere") symlinkSync(other, old);
      if (m === "dangling") symlinkSync(join(home, "нет"), old);
      if (m === "file") writeFileSync(old, "файл");
      const env = custom ? { COUNCIL_HOME: join(home, "custom") } : {};
      const before = snapshot(home);
      const want = custom ? join(home, "custom") : o !== "none" ? osen : m === "dir" ? old : osen;
      expect(peekDataDir(env, "darwin", home), label).toBe(want);
      expect(snapshot(home), label).toEqual(before);
    }
  });
});
