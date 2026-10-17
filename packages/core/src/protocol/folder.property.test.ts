import { describe, it, expect } from "vitest";
import { folderMap } from "./folder.ts";

// Own seeded generator: fast-check is not wired in.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface F { name: string; text: string }
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const depth = (n: string) => n.split("/").length;
const order = (a: F, b: F) => depth(a.name) - depth(b.name) || cmp(a.name, b.name);
const lineOf = (f: F) => `${f.name} — ${f.text.length}`;
const folded = (key: string, c: number, n: number) => `${key}/ — файлов: ${c}, знаков: ${n} (перечень по запросу)`;
const FOLDED = /^(.*)\/ — файлов: (\d+), знаков: (\d+) \(перечень по запросу\)$/;

// Trees: 1–4 attached folders, up to 6 levels, few name variants per level so that folders repeat.
function generate(seed: number): { files: F[]; limit: number } {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const seg = (pool: Map<string, string>, key: string) => {
    let s = pool.get(key);
    if (!s) {
      const len = rnd() < 0.2 ? 1 + int(100) : 1 + int(8);
      s = Array.from({ length: len }, () => "abc"[int(3)]).join("") + key.slice(-1);
      pool.set(key, s);
    }
    return s;
  };
  const pool = new Map<string, string>();
  const roots = Array.from({ length: 1 + int(4) }, (_, i) => seg(pool, `r${i}`) + i);
  const target = seed % 5 === 0 ? 4000 : seed % 3 === 0 ? 1 + int(60) : 1 + int(400);
  const names = new Set<string>();
  for (let tries = 0; names.size < target && tries < target * 4; tries++) {
    const parts = [roots[int(roots.length)]!];
    const dirs = int(5); // folders inside the attached one: 0–4, name depth 2–6
    for (let l = 0; l < dirs; l++) parts.push(seg(pool, `l${l}_${int(l < 2 ? 5 : 3)}`));
    parts.push(seg(pool, `f${int(60)}`) + ".t");
    names.add(parts.join("/"));
  }
  const files = [...names].map((name) => ({ name, text: "x".repeat(rnd() < 0.1 ? int(5000) : int(60)) }));
  const r = rnd();
  const limit = 50 + int(r < 0.25 ? 300 : r < 0.6 ? 1500 : 11951);
  return { files, limit };
}

// Previous rule: greedy names, collapsed lines over the limit.
function oldMap(files: F[], limit: number): string {
  const sorted = [...files].sort(order);
  const lines: string[] = [];
  let used = 0;
  let i = 0;
  for (; i < sorted.length; i++) {
    const l = lineOf(sorted[i]!);
    const next = used + l.length + (lines.length ? 1 : 0);
    if (next > limit) break;
    lines.push(l);
    used = next;
  }
  const g = new Map<string, [number, number]>();
  for (const x of sorted.slice(i)) {
    const d = x.name.slice(0, x.name.lastIndexOf("/"));
    const e = g.get(d) ?? [0, 0];
    e[0]++;
    e[1] += x.text.length;
    g.set(d, e);
  }
  for (const d of [...g.keys()].sort(cmp)) lines.push(folded(d, g.get(d)![0], g.get(d)![1]));
  return lines.join("\n");
}

// Collapsed tail lines at level L, recomputed from scratch without increments.
function foldLines(tail: F[], level: number): string[] {
  const g = new Map<string, [number, number]>();
  for (const x of tail) {
    const dir = x.name.split("/").slice(0, -1);
    const key = dir.slice(0, level).join("/");
    const e = g.get(key) ?? [0, 0];
    e[0]++;
    e[1] += x.text.length;
    g.set(key, e);
  }
  return [...g.keys()].sort(cmp).map((k) => folded(k, g.get(k)![0], g.get(k)![1]));
}

// Full enumeration of levels and k per the spec: the deepest level, where k is largest.
function brute(files: F[], limit: number): string | null {
  const sorted = [...files].sort(order);
  const maxL = Math.max(1, ...sorted.map((x) => depth(x.name) - 1));
  for (let L = maxL; L >= 1; L--)
    for (let k = sorted.length; k >= 0; k--) {
      const out = [...sorted.slice(0, k).map(lineOf), ...foldLines(sorted.slice(k), L)].join("\n");
      if (out.length <= limit) return out;
    }
  return null;
}

describe("Section 'Owner's folder'", () => {
  it("list properties on random trees: limit, name prefix, counting of collapsed lines, previous text", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { files, limit } = generate(seed);
      const out = folderMap(files, "ru", limit);
      const ctx = `seed ${seed}, files ${files.length}, limit ${limit}`;
      expect(out.length, ctx).toBeLessThanOrEqual(limit);
      const sorted = [...files].sort(order);
      const lines = out === "" ? [] : out.split("\n");
      const isFold = lines.map((l) => FOLDED.test(l));
      const k = isFold.indexOf(true) === -1 ? lines.length : isFold.indexOf(true);
      expect(isFold.slice(k).every(Boolean), `${ctx}: свёрнутые строки в конце`).toBe(true);
      expect(lines.slice(0, k), `${ctx}: имена — префикс порядка`).toEqual(sorted.slice(0, k).map(lineOf));
      const tail = sorted.slice(k);
      const got = lines.slice(k).map((l) => FOLDED.exec(l)!);
      const keys = got.map((m) => m[1]!);
      expect(keys, `${ctx}: ключи по порядку`).toEqual([...keys].sort(cmp));
      const totalCount = got.reduce((s, m) => s + Number(m[2]), 0);
      if (totalCount === tail.length) {
        // level is the largest key depth; each file on one line: its own folder or an ancestor
        const level = Math.max(1, ...keys.map(depth));
        expect(lines.slice(k), ctx).toEqual(foldLines(tail, level));
        for (const x of tail) {
          const dir = x.name.split("/").slice(0, -1).join("/");
          expect(keys.filter((key) => dir === key || dir.startsWith(key + "/")).length, `${ctx}: ${x.name}`).toBeGreaterThanOrEqual(1);
        }
      } else {
        // truncation: no names, only whole level-1 lines, and the full level-1 list would not fit
        expect(k, ctx).toBe(0);
        const l1 = foldLines(sorted, 1);
        expect(lines, ctx).toEqual(l1.slice(0, lines.length));
        expect(l1.join("\n").length, ctx).toBeGreaterThan(limit);
      }
      const old = oldMap(files, limit);
      if (old.length <= limit) expect(out, `${ctx}: прежний текст`).toBe(old);
      if (files.length <= 60) {
        const b = brute(files, limit);
        if (b !== null) expect(out, `${ctx}: перебор`).toBe(b);
      }
    }
  });
});
