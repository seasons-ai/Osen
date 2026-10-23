import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { killOwnedExecutor } from "./owned-executor.ts";

const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const c of spawned.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
});

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitGone = async (pid: number) => { for (let i = 0; i < 100 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 50)); };

async function launch(alive: boolean, arg: string): Promise<ChildProcess> {
  const code = alive ? "setInterval(()=>{},1000)" : "0";
  const c = spawn(process.execPath, ["-e", code, arg], { stdio: "ignore" });
  spawned.push(c);
  await new Promise((r) => c.once("spawn", r));
  if (!alive) await new Promise((r) => c.once("exit", r));
  return c;
}

const base = mkdtempSync(join(tmpdir(), "owned-exec-"));
const dir = join(base, "Мозговой штурм");
const other = join(base, "Другая папка");

for (const form of [["NFC", "NFD"], ["NFD", "NFC"]] as const) {
  for (const locale of [true, false]) {
    describe(`process argv ${form[0]}, module dir ${form[1]}, ${locale ? "inherited" : "no LANG/LC_ALL"} locale`, () => {
      for (const alive of [true, false]) for (const folder of [true, false]) for (const confirmed of [true, false]) {
        it(`alive=${alive} folder=${folder} confirmed=${confirmed}`, async () => {
          const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
          if (!locale) { delete process.env.LANG; delete process.env.LC_ALL; }
          try {
            const c = await launch(alive, (folder ? dir : other).normalize(form[0]));
            const pid = c.pid!;
            const expectKill = alive && folder && !confirmed;
            const got = killOwnedExecutor(pid, dir.normalize(form[1]), new Set(confirmed ? [pid] : []));
            expect(got).toBe(expectKill);
            if (expectKill) await waitGone(pid);
            else await new Promise((r) => setTimeout(r, 100));
            expect(isAlive(pid)).toBe(alive && !expectKill);
          } finally {
            for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
          }
        });
      }
    });
  }
}
it("cleanup", () => rmSync(base, { recursive: true, force: true }));
