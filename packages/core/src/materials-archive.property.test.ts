import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { makeZip } from "./documents/fixture.ts";
import { materialsMessages } from "./messages/materials.ts";
import { collectMaterials } from "./materials.ts";
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

const opts: CollectOptions = { materialsChars: 1_000_000, materialsIgnore: [] };
// independent oracle of the safety rule
const unsafe = (name: string): boolean => {
  const body = name.endsWith("/") ? name.slice(0, -1) : name;
  return /[\\\u0000]/.test(name) || name.startsWith("/") || /^[A-Za-z]:/.test(name) || body.split("/").some((s) => s === "" || s === "." || s === "..");
};
const SEGMENTS = ["a", "b", "..", ".", "", "/", "C:", "\\", "\u0000", "é", "ü.txt", "x.txt", "dir"];

describe("ZIP archive as a folder: property tests", () => {
  it("Архив ZIP как папка: имена не выходят за префикс", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "mat-arc-prop-")));
    try {
      for (let seed = 1; seed <= 20; seed++) {
        const rnd = mulberry32(seed);
        const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
        // fixed unsafe and safe names keep the set non-empty and the traversal case always present
        const nameList = ["../evil.txt", "a/../../evil2.txt", "ok.txt"];
        for (let i = 0; i < 8; i++) {
          const depth = 1 + Math.floor(rnd() * 3);
          nameList.push(Array.from({ length: depth }, () => pick(SEGMENTS)).join("/"));
        }
        const unique = [...new Set(nameList)].filter((n) => n !== "");
        const file = join(tmp, `s${seed}.zip`);
        writeFileSync(file, makeZip(unique.map((name) => ({ name, data: `t ${name}` }))));
        const set = collectMaterials([file], opts);
        const prefix = `s${seed}.zip`;
        const base = join(tmp, "snapshot");
        for (const x of [...set.materials, ...set.skipped]) {
          const ctx = `seed ${seed}: ${JSON.stringify(x.name)}`;
          expect(x.name.startsWith(`${prefix}/`), ctx).toBe(true);
        }
        for (const x of set.materials) {
          const ctx = `seed ${seed}: ${JSON.stringify(x.name)}`;
          const rel = x.name.slice(prefix.length + 1);
          expect(rel.split("/").some((s) => s === "" || s === "." || s === ".."), ctx).toBe(false);
          expect(/[\\\u0000]/.test(rel) || rel.startsWith("/"), ctx).toBe(false);
          expect(resolve(base, x.name).startsWith(join(base, prefix) + sep), ctx).toBe(true);
        }
        for (const name of unique) {
          if (unsafe(name)) expect(set.skipped.find((x) => x.name === `${prefix}/${name}`)?.reason, `seed ${seed}: ${JSON.stringify(name)}`).toBe(materialsMessages().archiveUnsafeName);
        }
        expect(set.materials.map((x) => x.name), `seed ${seed}`).toContain(`${prefix}/ok.txt`);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  it("Архив ZIP как папка: порядок и состав материалов не зависят от порядка записей", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "mat-arc-prop-")));
    try {
      const base = [
        { name: "README.md", data: "r" }, { name: "src/b.ts", data: "b" }, { name: "src/a.ts", data: "a" }, { name: "Zed.txt", data: "z" },
        { name: ".env", data: "s" }, { name: "docs/x.md", data: "x" }, { name: ".hidden", data: "h" }, { name: "../up.txt", data: "u" },
      ];
      const rnd = mulberry32(7);
      let ref: string | undefined;
      for (let i = 0; i < 8; i++) {
        const parts = [...base];
        for (let j = parts.length - 1; j > 0; j--) {
          const k = Math.floor(rnd() * (j + 1));
          [parts[j], parts[k]] = [parts[k]!, parts[j]!];
        }
        const file = join(tmp, `p${i}.zip`);
        writeFileSync(file, makeZip(parts));
        const set = collectMaterials([file], opts);
        // the prefix differs per file: compare without it
        const key = JSON.stringify({
          materials: set.materials.map((x) => [x.name.replace(`p${i}.zip/`, ""), x.text]),
          skipped: set.skipped.map((s) => [s.name.replace(`p${i}.zip/`, ""), s.reason]),
        });
        ref ??= key;
        expect(key, `permutation ${i}: ${parts.map((q) => q.name).join(",")}`).toBe(ref);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
