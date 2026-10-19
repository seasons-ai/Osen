import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { collectSessionMaterials } from "./materials.ts";
import type { CollectOptions } from "./materials.ts";

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEEDS = 300;

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

interface Case {
  paths: string[];
  folders: string[];
}

function build(seed: number, base: string): Case {
  const rnd = mulberry32(seed);
  const pick = (n: number) => Math.floor(rnd() * n);
  const folders: string[] = [];
  const explicit: string[] = [];
  let uid = 0;
  const nFolders = 1 + pick(3);
  for (let f = 0; f < nFolders; f++) {
    const dir = join(base, `dir${f}`);
    folders.push(dir);
    const ignoreRule = rnd() < 0.3;
    const files: string[] = [];
    const nFiles = 1 + pick(4);
    for (let i = 0; i < nFiles; i++) {
      const depth = pick(3);
      const rel = [...Array.from({ length: depth }, (_, d) => `s${d}`), `f${f}_${uid++}.ts`].join("/");
      files.push(rel);
    }
    if (rnd() < 0.4) files.push(`.hid${f}_${uid++}.ts`);
    if (ignoreRule) files.push(`ign${f}_${uid++}.log`);
    mkdirSync(dir, { recursive: true });
    if (ignoreRule) writeFileSync(join(dir, ".gitignore"), "*.log\n");
    for (const rel of files) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), `text ${seed} ${rel} ${"x".repeat(pick(40))}`);
    }
    // explicit: none, some or all folder files
    const mode = pick(3);
    for (const rel of files) {
      const special = rel.startsWith(".hid") || rel.endsWith(".log");
      if (mode === 2 || (mode === 1 && rnd() < 0.5) || (special && rnd() < 0.7)) explicit.push(join(dir, rel));
    }
  }
  for (let i = 0; i < pick(3); i++) {
    const p = join(base, `out${i}_${uid++}.md`);
    writeFileSync(p, `outside ${i} ${"y".repeat(pick(30))}`);
    explicit.push(p);
  }
  // no more than 5 paths: exhaustive permutations
  const paths = [...folders, ...explicit.slice(0, Math.max(0, 5 - folders.length))];
  return { paths, folders };
}

const opts = (materialsChars: number): CollectOptions => ({ materialsChars, materialsIgnore: ["node_modules", "dist"] });

describe("Attached folder snapshot: the position of an explicit file does not change the snapshot", () => {
  it("properties on random sets of paths and all their permutations", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "mat-order-")));
    try {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const base = join(tmp, `s${seed}`);
        mkdirSync(base, { recursive: true });
        const c = build(seed, base);
        let ref: { workspace: string; names: string } | undefined;
        for (const perm of permutations(c.paths)) {
          const ctx = `seed ${seed}: ${JSON.stringify(perm.map((p) => p.slice(base.length)))}`;
          // limit above any set: the initial set includes all materials in collection order
          const r = collectSessionMaterials(perm, opts(1_000_000));
          const full = r.materials;
          const names = full.map((m) => m.name);
          expect(new Set(names).size, ctx).toBe(names.length);
          // folder order in the snapshot follows path order, so the content is compared by names
          const workspace = JSON.stringify([...r.workspace].sort((a, b) => (a.name < b.name ? -1 : 1)));
          const key = { workspace, names: JSON.stringify([...names].sort()) };
          ref ??= key;
          expect(key, ctx).toEqual(ref);
          // the input path index does not decrease along the materials order
          const idx = full.map((m) => {
            if (m.name.includes("/")) {
              const folder = c.folders.find((f) => m.name.startsWith(`${f.slice(f.lastIndexOf(sep) + 1)}/`))!;
              return perm.indexOf(folder);
            }
            return perm.findIndex((p) => p.endsWith(sep + m.name));
          });
          for (let i = 1; i < idx.length; i++) expect(idx[i]!, `${ctx} materials ${JSON.stringify(names)}`).toBeGreaterThanOrEqual(idx[i - 1]!);
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 180_000); // CPU-bound: the ceiling only guards against a hang, a busy machine slows it several times

  it("permutations moving only explicit files do not change the initial set under a tight limit", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "mat-order-")));
    try {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const base = join(tmp, `s${seed}`);
        mkdirSync(base, { recursive: true });
        const c = build(seed, base);
        const explicit = c.paths.filter((p) => !c.folders.includes(p));
        const limit = 60 + (seed % 5) * 40;
        let ref: string | undefined;
        for (const perm of permutations(explicit)) {
          // folders stay in their order, in the first positions; explicit files are placed across all permutations
          for (const at of [0, c.folders.length]) {
            const paths = [...perm.slice(0, at === 0 ? 0 : perm.length), ...c.folders, ...(at === 0 ? perm : [])];
            const ctx = `seed ${seed}: ${JSON.stringify(paths.map((p) => p.slice(base.length)))}`;
            let names: string;
            try {
              names = JSON.stringify(collectSessionMaterials(paths, opts(limit)).materials.map((m) => m.name).sort());
            } catch (e) {
              names = `refused ${(e as Error).constructor.name}`;
            }
            ref ??= names;
            expect(names, ctx).toBe(ref);
          }
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 180_000); // CPU-bound: the ceiling only guards against a hang, a busy machine slows it several times
});
