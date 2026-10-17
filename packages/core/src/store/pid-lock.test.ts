import { spawn, spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { tryPidLock } from "./pid-lock.ts";

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "pidlock-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ME = String(process.pid);
const clean = (dir: string) => expect(readdirSync(dir).filter((f) => f !== "lock" && f !== "lock.takeover")).toEqual([]);

describe("tryPidLock", () => {
  it("no lock: takes it, writes pid, leaves no junk", () => {
    const dir = tmp();
    expect(tryPidLock(join(dir, "lock"), () => true)).toBe(true);
    expect(readFileSync(join(dir, "lock"), "utf8")).toBe(ME);
    expect(readdirSync(dir)).toEqual(["lock"]);
  });

  it("live process lock: false, file untouched", () => {
    const dir = tmp();
    writeFileSync(join(dir, "lock"), String(process.pid));
    expect(tryPidLock(join(dir, "lock"), () => true)).toBe(false);
    expect(readFileSync(join(dir, "lock"), "utf8")).toBe(ME);
    expect(readdirSync(dir)).toEqual(["lock"]);
  });

  it.each(["99999999", "", "abc", "0", "-5"])("lock of a dead process (%j): taken over", (content) => {
    const dir = tmp();
    writeFileSync(join(dir, "lock"), content);
    expect(tryPidLock(join(dir, "lock"), () => false)).toBe(true);
    expect(readFileSync(join(dir, "lock"), "utf8")).toBe(ME);
    expect(readdirSync(dir)).toEqual(["lock"]);
  });

  it("watchdog lock of live process with dead main: false, main not removed", () => {
    const dir = tmp();
    writeFileSync(join(dir, "lock"), "7");
    writeFileSync(join(dir, "lock.takeover"), "8");
    expect(tryPidLock(join(dir, "lock"), (p) => p === 8)).toBe(false);
    expect(readFileSync(join(dir, "lock"), "utf8")).toBe("7");
    expect(readFileSync(join(dir, "lock.takeover"), "utf8")).toBe("8");
  });

  it("watchdog lock of dead process with dead main: takeover succeeds", () => {
    const dir = tmp();
    writeFileSync(join(dir, "lock"), "7");
    writeFileSync(join(dir, "lock.takeover"), "8");
    expect(tryPidLock(join(dir, "lock"), () => false)).toBe(true);
    expect(readFileSync(join(dir, "lock"), "utf8")).toBe(ME);
    clean(dir);
    expect(existsSync(join(dir, "lock.takeover"))).toBe(false);
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

const WORKER = `import { tryPidLock } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "pid-lock.ts")).href)};
import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
const [lock, marker, violations, doneFile, dead, iters, hold] = process.argv.slice(1);
const alive = (pid) => { if (pid === Number(dead)) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const wait = (ms) => ms > 0 && Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let done = 0;
for (let i = 0; i < Number(iters); i++) {
  while (!tryPidLock(lock, alive)) await new Promise((r) => setImmediate(r));
  try { writeFileSync(marker, String(process.pid), { flag: "wx" }); } catch (e) {
    if (e.code !== "EEXIST") throw e;
    appendFileSync(violations, process.pid + " iter " + i + "\\n");
  }
  wait(Number(hold));
  try { unlinkSync(marker); } catch (e) { if (e.code !== "ENOENT") throw e; }
  try { unlinkSync(lock); } catch (e) { if (e.code !== "ENOENT") throw e; }
  done++;
}
writeFileSync(doneFile, String(done));`;

type Round = { workers: number; iters: number; hold: number; planter: boolean };

function plan(): Round[] {
  const rnd = mulberry32(51052);
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const rounds: Round[] = [
    { workers: 2, iters: 40, hold: 1, planter: true },
    { workers: 10, iters: 30, hold: 1, planter: true },
    { workers: 10, iters: 40, hold: 2, planter: true },
    { workers: 8, iters: 40, hold: 0, planter: true },
    { workers: 6, iters: 40, hold: 0, planter: true },
    { workers: 10, iters: 40, hold: 0, planter: false },
    { workers: 10, iters: 40, hold: 0, planter: true },
  ];
  for (let i = 0; i < 5; i++) rounds.push({ workers: int(2, 10), iters: int(10, 40), hold: int(0, 3), planter: i % 2 === 0 });
  return rounds;
}

async function runRound(r: Round, deadPid: number): Promise<{ codes: (number | null)[]; dir: string; done: number }> {
  const dir = tmp();
  const [lock, marker, violations] = ["lock", "marker", "violations"].map((f) => join(dir, f)) as [string, string, string];
  let timer: NodeJS.Timeout | undefined;
  if (r.planter) {
    let n = 0;
    const tick = () => {
      const mine = join(dir, `plant.${n++}`);
      try {
        writeFileSync(mine, String(deadPid));
        linkSync(mine, lock);
      } catch { /* EEXIST: lock exists */ }
      rmSync(mine, { force: true });
      timer = setTimeout(tick, 1 + (n % 3));
    };
    tick();
  }
  const codes = await Promise.all(
    Array.from({ length: r.workers }, (_, n) => new Promise<number | null>((res) => {
      const args = [lock, marker, violations, join(dir, `done-${n}`), String(deadPid), String(r.iters), String(r.hold)];
      spawn(process.execPath, ["--input-type=module", "-e", WORKER, ...args], { stdio: "inherit" }).on("close", res);
    })),
  );
  clearTimeout(timer);
  await new Promise((res) => setTimeout(res, 20));
  rmSync(lock, { force: true });
  const done = readdirSync(dir).filter((f) => f.startsWith("done-")).reduce((s, f) => s + Number(readFileSync(join(dir, f), "utf8")), 0);
  return { codes, dir, done };
}

describe("mutual exclusion on real processes", () => {
  it("Single continuation executor: never two owners, locks of dead ones are taken over", async () => {
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
    const rounds = plan();
    expect(rounds.map((r) => r.workers)).toEqual(expect.arrayContaining([2, 10]));
    expect(rounds.filter((r) => r.planter).length).toBeGreaterThanOrEqual(rounds.length / 2);
    for (const r of rounds) {
      const label = `раунд ${JSON.stringify(r)}`;
      const { codes, dir, done } = await runRound(r, deadPid);
      expect(codes, label).toEqual(Array(r.workers).fill(0));
      const v = join(dir, "violations");
      expect(existsSync(v) ? readFileSync(v, "utf8") : "", label).toBe("");
      expect(done, label).toBe(r.workers * r.iters);
      expect(readdirSync(dir).filter((f) => !f.startsWith("done-")), label).toEqual([]);
    }
  }, 120000);
});
