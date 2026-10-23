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
          const shown = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
          if (unsafe(name)) expect(set.skipped.find((x) => x.name === `${prefix}/${shown}`)?.reason, `seed ${seed}: ${JSON.stringify(name)}`).toBe(materialsMessages().archiveUnsafeName);
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

  it("Архив ZIP как папка: имена без флага UTF-8 никогда не делают архив повреждённым", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "mat-arc-prop-")));
    const strict = new TextDecoder("utf-8", { fatal: true });
    const cp866 = new TextDecoder("ibm866");
    try {
      for (let seed = 1; seed <= 25; seed++) {
        const rnd = mulberry32(seed);
        const int = (n: number) => Math.floor(rnd() * n);
        const pieces: (() => number[])[] = [
          () => [0x41 + int(26)], // ASCII letter
          () => [0x20 + int(0x5f)].filter((b) => b !== 0x2f && b !== 0x5c), // printable ASCII without separators
          () => [0xc2 + int(30), 0x80 + int(64)], // two-byte UTF-8 sequence
          () => [0xe0 + int(16), 0x80 + int(64), 0x80 + int(64)], // three-byte sequence, may be invalid
          () => [0xe0 + int(16), 0x80 + int(64)], // truncated three-byte sequence
          () => [0x80 + int(128)], // lone byte
          () => [0xa0 + int(0x30)], // CP866 Cyrillic capitals and small letters
          () => [0xe0 + int(16)], // CP866 small letters
        ];
        const parts = Array.from({ length: 10 }, (_, k) => {
          const bytes = [...Buffer.from(`i${k}_`)];
          for (let j = 1 + int(8); j > 0; j--) bytes.push(...pieces[int(pieces.length)]!());
          bytes.push(...Buffer.from(".txt"));
          const raw = Uint8Array.from(bytes);
          let expected: string;
          try { expected = strict.decode(raw); } catch { expected = cp866.decode(raw); }
          return { raw, expected };
        });
        const file = join(tmp, `n${seed}.zip`);
        writeFileSync(file, makeZip(parts.map((q, k) => ({ name: q.raw, data: `t${k}` }))));
        const set = collectMaterials([file], opts);
        expect(set.materials.map((x) => x.name).sort(), `seed ${seed}`).toEqual(parts.map((q) => `n${seed}.zip/${q.expected}`).sort());
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  it("Архив ZIP как папка: управляющие знаки в небезопасных именах показаны как \\uXXXX", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "mat-arc-prop-")));
    const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
    const back = (s: string) => s.replace(/\\u([0-9a-f]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    try {
      for (let seed = 1; seed <= 25; seed++) {
        const rnd = mulberry32(seed);
        const int = (n: number) => Math.floor(rnd() * n);
        const ctl = () => String.fromCharCode(rnd() < 0.5 ? int(0x20) : 0x7f + int(0x21));
        const piece = () => ["a", "Отчёт", "ü", "x.txt", "..", "-", "dir"][int(7)]!;
        const names: string[] = [];
        for (let k = 0; k < 6; k++) {
          // a NUL or a ".." segment keeps the name unsafe; other control characters of both ranges are sprinkled in
          const segs = [piece() + ctl() + piece(), rnd() < 0.5 ? `p${k}\u0000q` : "..", piece() + ctl()];
          names.push(segs.join("/"));
        }
        const parts = [...names, names[int(names.length)]!].map((name) => ({ name, data: "t" }));
        const unique = [...new Set(names)];
        const prefix = `c${seed}.zip`;
        const withOk = join(tmp, `c${seed}.zip`);
        writeFileSync(withOk, makeZip([...parts, { name: "ok.txt", data: "o" }]));
        const set = collectMaterials([withOk], opts);
        for (const x of set.skipped) expect(CONTROL.test(x.name), `seed ${seed}: ${JSON.stringify(x.name)}`).toBe(false);
        const shownBack = new Set(set.skipped.map((x) => back(x.name)));
        for (const n of unique) expect(shownBack.has(`${prefix}/${n}`), `seed ${seed}: ${JSON.stringify(n)}`).toBe(true);
        const only = join(tmp, `o${seed}.zip`);
        writeFileSync(only, makeZip(parts));
        let lines: string[] = [];
        try { collectMaterials([only], opts); } catch (e) { lines = (e as { reasons: string[] }).reasons; }
        expect(lines.length, `seed ${seed}`).toBeGreaterThan(1);
        for (const l of lines) expect(CONTROL.test(l), `seed ${seed}: ${JSON.stringify(l)}`).toBe(false);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
