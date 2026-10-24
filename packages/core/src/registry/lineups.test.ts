import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry, configPath } from "./config.ts";
import { LineupsError, lineupsPath, readLineups, saveLineup } from "./lineups.ts";
import type { Lineup, LineupParticipant } from "./lineups.ts";
import { resumeLockPath } from "../store/journal.ts";
import { acquireResumeLock } from "../store/resume.ts";

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "council-lineups-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) {
    try { chmodSync(join(d, "lineups.json"), 0o644); } catch { /* no file */ }
    rmSync(d, { recursive: true, force: true });
  }
});

const two: LineupParticipant[] = [
  { providerId: "claude", model: "a", role: null },
  { providerId: "claude", model: "b", role: "критик" },
];
const bytes = (dir: string) => readFileSync(lineupsPath(dir), "utf8");
const rejected = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LineupsError);
    return (e as Error).message;
  }
  throw new Error("ошибка не брошена");
};

describe("Local named lineups: lineups.json file", () => {
  it("1. no file: empty list, file not created, config.json untouched", async () => {
    const dir = tmp();
    createRegistry(dir, ["claude", "codex"]);
    const before = readFileSync(configPath(dir));
    expect(readLineups(dir)).toEqual([]);
    expect(existsSync(lineupsPath(dir))).toBe(false);
    await saveLineup(dir, { name: "x", participants: two });
    expect(readFileSync(configPath(dir)).equals(before)).toBe(true);
  });

  it("2. two participants of one provider: positions, roles and order kept", async () => {
    const dir = tmp();
    const a = await saveLineup(dir, { name: "первый", participants: two });
    const b = await saveLineup(dir, { name: "второй", participants: [...two].reverse() });
    expect(a.id).toBeTruthy();
    expect(b.id).not.toBe(a.id);
    expect(readLineups(dir)).toEqual([
      { id: a.id, name: "первый", participants: two },
      { id: b.id, name: "второй", participants: [...two].reverse() },
    ]);
  });

  it("3. taken name, including with spaces: refused with id, file unchanged", async () => {
    const dir = tmp();
    const a = await saveLineup(dir, { name: "Дуэт", participants: two });
    const before = bytes(dir);
    for (const name of ["Дуэт", "  Дуэт "]) {
      const m = await rejected(saveLineup(dir, { name, participants: two }));
      expect(m).toContain("«Дуэт»");
      expect(m).toContain(a.id);
    }
    expect(bytes(dir)).toBe(before);
  });

  it("4. invalid input: file and lock not created; 100 characters allowed", async () => {
    const dir = tmp();
    const bad: [string, { name: string; participants: LineupParticipant[] }][] = [
      ["пусто", { name: "", participants: two }],
      ["пробелы", { name: "   ", participants: two }],
      ["перевод строки", { name: "а\nб", participants: two }],
      ["101 знак", { name: "я".repeat(101), participants: two }],
      ["один участник", { name: "n", participants: [two[0]!] }],
      ["пустой providerId", { name: "n", participants: [{ providerId: "", model: "m", role: null }, two[1]!] }],
    ];
    for (const [, input] of bad) {
      await rejected(saveLineup(dir, input));
      expect(existsSync(lineupsPath(dir))).toBe(false);
      expect(existsSync(join(dir, "lineups.lock"))).toBe(false);
    }
    const ok = await saveLineup(dir, { name: "я".repeat(100), participants: two });
    expect(readLineups(dir)[0]!.id).toBe(ok.id);
  });

  it("5. broken file: reading and saving rejected, bytes unchanged", async () => {
    const good = { id: "i", name: "n", participants: [{ providerId: "p", model: "m", role: null }, { providerId: "p", model: "m2", role: null }] };
    const variants = [
      "{не json",
      JSON.stringify({ id: "i" }),
      JSON.stringify([{ ...good, participants: [{ ...good.participants[0], extra: 1 }, good.participants[1]] }]),
    ];
    for (const text of variants) {
      const dir = tmp();
      writeFileSync(lineupsPath(dir), text);
      expect(() => readLineups(dir)).toThrow(/^lineups\.json: /);
      expect(await rejected(saveLineup(dir, { name: "новый", participants: two }))).toMatch(/^lineups\.json: /);
      expect(bytes(dir)).toBe(text);
      expect(existsSync(join(dir, "lineups.lock"))).toBe(false);
    }
  });

  it("6. write error (read-only file): bytes unchanged, no tmp or lock left", async () => {
    const dir = tmp();
    await saveLineup(dir, { name: "a", participants: two });
    const before = bytes(dir);
    chmodSync(lineupsPath(dir), 0o444);
    expect(await rejected(saveLineup(dir, { name: "b", participants: two }))).toMatch(/^lineups\.json: не удалось записать/);
    expect(bytes(dir)).toBe(before);
    expect(existsSync(`${lineupsPath(dir)}.tmp`)).toBe(false);
    expect(existsSync(join(dir, "lineups.lock"))).toBe(false);
  });

  it("7a. lock: a live resume.lock (data folder or session) does not block saving a lineup", async () => {
    const dir = tmp();
    const session = join(dir, "sessions", "s1");
    mkdirSync(session, { recursive: true });
    for (const p of [join(dir, "resume.lock"), join(session, "resume.lock")]) writeFileSync(p, String(process.pid));
    await saveLineup(dir, { name: "a", participants: two }, { lockWaitMs: 100 });
    expect(readLineups(dir).map((l) => l.name)).toEqual(["a"]);
    expect(existsSync(join(dir, "lineups.lock"))).toBe(false);
    expect(readFileSync(join(session, "resume.lock"), "utf8")).toBe(String(process.pid));

    // And back: a live lineups.lock does not block taking a session's resume lock.
    writeFileSync(join(dir, "lineups.lock"), String(process.pid));
    const lock = resumeLockPath(dir, "s2");
    mkdirSync(join(dir, "sessions", "s2"), { recursive: true });
    expect(() => acquireResumeLock(lock, () => true)).not.toThrow();
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
  });

  it("7. lock: dead one removed, live foreign one waits and refuses", async () => {
    const dir = tmp();
    const dead = spawnSyncPid();
    writeFileSync(join(dir, "lineups.lock"), String(dead));
    await saveLineup(dir, { name: "a", participants: two });
    expect(existsSync(join(dir, "lineups.lock"))).toBe(false);

    const before = bytes(dir);
    writeFileSync(join(dir, "lineups.lock"), String(process.pid));
    expect(await rejected(saveLineup(dir, { name: "b", participants: two }, { lockWaitMs: 100 }))).toContain("файл занят другим сохранением");
    expect(bytes(dir)).toBe(before);
    expect(readFileSync(join(dir, "lineups.lock"), "utf8")).toBe(String(process.pid));
    rmSync(join(dir, "lineups.lock"));
    for (const junk of ["", "abc"]) {
      writeFileSync(join(dir, "lineups.lock"), junk);
      await saveLineup(dir, { name: `junk${junk}`, participants: two });
      expect(readdirSync(dir).filter((f) => f.startsWith("lineups.lock"))).toEqual([]);
    }
  });

  it("8. race of ten real processes: 120 lineups without loss", async () => {
    const dir = tmp();
    const url = pathToFileURL(join(import.meta.dirname, "lineups.ts")).href;
    const code = `import { saveLineup } from ${JSON.stringify(url)};
const [dir, w] = process.argv.slice(1);
const p = [{ providerId: "p", model: "m1", role: null }, { providerId: "p", model: "m2", role: "r" }];
for (let i = 0; i < 12; i++) await saveLineup(dir, { name: "w" + w + "-" + i, participants: p }, { lockWaitMs: 20000 });`;
    const codes = await Promise.all(
      Array.from({ length: 10 }, (_, w) => w).map((w) => new Promise<number | null>((res) => {
        const c = spawn(process.execPath, ["--input-type=module", "-e", code, dir, String(w)], { stdio: "inherit" });
        c.on("close", res);
      })),
    );
    expect(codes).toEqual(Array(10).fill(0));
    const list = readLineups(dir);
    expect(list).toHaveLength(120);
    expect(readdirSync(dir).filter((f) => f.startsWith("lineups.lock"))).toEqual([]);
    expect(new Set(list.map((l) => l.id)).size).toBe(120);
    const names = list.map((l) => l.name).sort();
    expect(names).toEqual(Array.from({ length: 10 }, (_, w) => w).flatMap((w) => Array.from({ length: 12 }, (_, i) => i).map((i) => `w${w}-${i}`)).sort());
  }, 60000);

  it("9. Local named lineups: 150 generated ones saved without distortion", async () => {
    const rnd = mulberry32(20261009);
    const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
    const pick = <T,>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
    const providers = ["claude", "codex", "or-1"];
    const models = ["vendor/model:free", "модель-ё:1", "a/b/c:d", "gpt 5.1 ☃", "x"];
    const roles = ["критик", "Ты — архитектор. ".repeat(40), "role: «q»/\\", "😀"];
    const saved: Lineup[] = [];
    const dir = tmp();
    for (let i = 0; i < 150; i++) {
      const n = i === 0 ? 2 : i === 1 ? 8 : int(2, 8);
      const participants = Array.from({ length: n }, () => ({
        providerId: pick(providers), model: pick(models), role: rnd() < 0.4 ? null : pick(roles),
      }));
      const name = i === 0 ? "ы" : i === 1 ? "Ж".repeat(100) : `состав №${i} «${pick(["α", "β", "ё/:"])}»`;
      saved.push({ id: (await saveLineup(dir, { name, participants })).id, name, participants });
    }
    const sizes = saved.map((l) => l.participants.length);
    expect([Math.min(...sizes), Math.max(...sizes)]).toEqual([2, 8]);
    expect(readLineups(dir)).toEqual(saved);
  });
});

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// pid of a surely dead process: a spawned and finished child
function spawnSyncPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  return r.pid as number;
}
