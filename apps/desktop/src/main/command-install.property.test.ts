import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyLink, installCommand, removeCommand } from "./command-install.ts";

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Recursive snapshot: names, kinds, file content, symlink targets; optionally lstat mtimes
function snap(path: string, mtimes: boolean): unknown {
  let st;
  try { st = lstatSync(path); } catch { return null; }
  const t = mtimes ? st.mtimeMs : 0;
  if (st.isSymbolicLink()) return ["l", readlinkSync(path), t];
  if (st.isDirectory()) return ["d", t, Object.fromEntries(readdirSync(path).sort().map((n) => [n, snap(join(path, n), mtimes)]))];
  return ["f", readFileSync(path, "utf8"), t];
}

const OWN = "/Osen.app/Contents/Resources/bin/council";

describe("Requirement: foreign council is not overwritten (property)", () => {
  it("never touches foreign objects or siblings, install is idempotent (seeded, 320 cases)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmd-prop-"));
    const shell = join(root, "sh");
    writeFileSync(shell, "#!/bin/sh\nexit 1\n");
    chmodSync(shell, 0o755);
    const wdir = join(root, "w", "Osen.app", "Contents", "Resources", "bin");
    mkdirSync(wdir, { recursive: true });
    const wrapper = join(wdir, "council");
    writeFileSync(wrapper, "#!/bin/sh\n");
    chmodSync(wrapper, 0o755);
    try {
      for (let seed = 1; seed <= 320; seed++) {
        const rnd = mulberry32(seed);
        const int = (n: number) => Math.floor(rnd() * n);
        const home = join(root, `h${seed}`);
        const bin = join(home, ".local", "bin");
        const link = join(bin, "council");
        mkdirSync(home);
        const init = int(9);
        if (init === 8) {
          mkdirSync(join(home, ".local"));
          writeFileSync(bin, "bin is a file");
        } else if (init > 0) {
          mkdirSync(bin, { recursive: true });
          for (let i = int(4); i > 0; i--) writeFileSync(join(bin, `sib${i}`), `s${int(1000)}`);
          if (init === 2) writeFileSync(link, `mine${int(1000)}`);
          if (init === 3) { mkdirSync(link); writeFileSync(join(link, "inner"), "x"); }
          if (init === 4) symlinkSync(rnd() < 0.5 ? "/usr/local/bin/other-council" : join(root, "nowhere"), link);
          if (init === 5) symlinkSync(wrapper, link);
          if (init === 6) symlinkSync(join(root, "gone", OWN), link);
          if (init === 7) symlinkSync(`/nonexistent${OWN}`, link);
        }
        const ctx = (step: number) => `seed=${seed} init=${init} step=${step}`;
        const foreignBefore = (): unknown => {
          const c = classifyLink({ home, wrapper });
          return c.kind === "foreign" ? snap(link, false) : undefined;
        };
        const siblings = () => {
          let names: string[] = [];
          try { names = readdirSync(bin).filter((n) => n.startsWith("sib")); } catch { /* none */ }
          return Object.fromEntries(names.map((n) => [n, readFileSync(join(bin, n), "utf8")]));
        };
        const sibBefore = siblings();
        for (let step = 0, n = 1 + int(8); step < n; step++) {
          const fb = foreignBefore();
          const isInstall = rnd() < 0.6;
          if (isInstall) {
            const r = await installCommand({ home, wrapper, shell, language: "en" });
            if (fb !== undefined) expect(r.ok, ctx(step)).toBe(false);
            if (r.ok) {
              const s1 = snap(home, true);
              const again = await installCommand({ home, wrapper, shell, language: "en" });
              expect(again.ok && !again.changed, `idempotent ${ctx(step)}`).toBe(true);
              expect(snap(home, true), `idempotent snapshot ${ctx(step)}`).toEqual(s1);
            }
          } else {
            const r = removeCommand({ home, wrapper, language: "en" });
            if (fb !== undefined) expect(r.ok, ctx(step)).toBe(false);
          }
          if (fb !== undefined) expect(snap(link, false), `foreign changed ${ctx(step)}`).toEqual(fb);
          expect(siblings(), `siblings changed ${ctx(step)}`).toEqual(sibBefore);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
