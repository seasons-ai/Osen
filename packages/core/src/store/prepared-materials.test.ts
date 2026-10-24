import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPreparedMaterials, PREPARED_TTL_MS, preparedMaterialsDir, PreparedMaterialsError, savePreparedMaterials } from "./prepared-materials.ts";
import type { PreparedInput, PreparedProblem } from "./prepared-materials.ts";
import { collectSessionMaterials, sha256Of } from "../materials.ts";
import type { CollectedMaterial } from "../materials.ts";
import { symlinkSync } from "node:fs";
import type { MaterialSource } from "./material-sources.ts";
import { FOLDER_LIMITS } from "../protocol/folder.ts";

const mk = (id: number, name: string, text: string): CollectedMaterial => ({ id: `m${id}`, name, chars: text.length, sha256: sha256Of(text), text });
const base = (): PreparedInput => ({
  materials: [mk(1, "a.md", "Привет 😀"), mk(2, "б/в.md", "текст\n")],
  workspace: [{ name: "папка/x.ts", text: "const x = 1;\n" }],
  skipped: [{ name: "s", reason: "r" }],
  left: [{ name: "l", reason: "лимит" }],
  materialsChars: 1000,
  stamp: "stamp-1",
});
const sum = (s: string) => createHash("sha256").update(s).digest("hex");

let a: string;
let b: string;
beforeEach(() => {
  a = mkdtempSync(join(realpathSync(tmpdir()), "council-prep-a-"));
  b = mkdtempSync(join(realpathSync(tmpdir()), "council-prep-b-"));
});
afterEach(() => {
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

const problemOf = (fn: () => unknown): PreparedProblem | undefined => {
  try { fn(); } catch (e) { if (e instanceof PreparedMaterialsError) return e.problem; throw e; }
  return undefined;
};
const jsonPath = (dir: string, id: string) => join(preparedMaterialsDir(dir), id, "set.json");
const rewrite = (dir: string, id: string, f: (o: Record<string, unknown>) => void) => {
  const o = JSON.parse(readFileSync(jsonPath(dir, id), "utf8"));
  f(o);
  const s = JSON.stringify(o);
  writeFileSync(jsonPath(dir, id), s);
  writeFileSync(join(preparedMaterialsDir(dir), id, "set.sha256"), sum(s));
};

describe("prepared-materials", () => {
  it("saves files and does not touch sessions; read returns an equal set", () => {
    const set = savePreparedMaterials(a, base());
    expect(existsSync(jsonPath(a, set.id))).toBe(true);
    expect(existsSync(join(preparedMaterialsDir(a), set.id, "set.sha256"))).toBe(true);
    expect(existsSync(join(a, "sessions"))).toBe(false);
    expect(readdirSync(preparedMaterialsDir(a))).toEqual([set.id]);
    expect(loadPreparedMaterials(a, set.id)).toEqual(set);
  });

  it("unknown: no set and foreign data folder", () => {
    expect(problemOf(() => loadPreparedMaterials(a, "0".repeat(32)))).toBe("unknown");
    const set = savePreparedMaterials(a, base());
    expect(problemOf(() => loadPreparedMaterials(b, set.id))).toBe("unknown");
  });

  it("expired: exactly 24 hours — stale, one millisecond less — readable", () => {
    const t0 = new Date(Date.UTC(2026, 0, 1));
    const set = savePreparedMaterials(a, base(), { now: () => t0 });
    expect(problemOf(() => loadPreparedMaterials(a, set.id, { now: () => new Date(t0.getTime() + PREPARED_TTL_MS) }))).toBe("expired");
    expect(loadPreparedMaterials(a, set.id, { now: () => new Date(t0.getTime() + PREPARED_TTL_MS - 1) }).id).toBe(set.id);
  });

  describe("corrupt", () => {
    it("set.json byte changed", () => {
      const { id } = savePreparedMaterials(a, base());
      const p = jsonPath(a, id);
      const buf = readFileSync(p);
      buf[buf.length - 3] = buf[buf.length - 3]! ^ 1;
      writeFileSync(p, buf);
      expect(problemOf(() => loadPreparedMaterials(a, id))).toBe("corrupt");
    });
    it("no set.sha256", () => {
      const { id } = savePreparedMaterials(a, base());
      rmSync(join(preparedMaterialsDir(a), id, "set.sha256"));
      expect(problemOf(() => loadPreparedMaterials(a, id))).toBe("corrupt");
    });
    it("different JSON shape with correct sum", () => {
      const { id } = savePreparedMaterials(a, base());
      const s = JSON.stringify({ hello: 1 });
      writeFileSync(jsonPath(a, id), s);
      writeFileSync(join(preparedMaterialsDir(a), id, "set.sha256"), sum(s));
      expect(problemOf(() => loadPreparedMaterials(a, id))).toBe("corrupt");
    });
    it("version not 1", () => {
      const { id } = savePreparedMaterials(a, base());
      rewrite(a, id, (o) => { o.version = 2; });
      expect(problemOf(() => loadPreparedMaterials(a, id))).toBe("corrupt");
    });
    it("material text substituted", () => {
      const { id } = savePreparedMaterials(a, base());
      rewrite(a, id, (o) => { (o.materials as { text: string }[])[0]!.text = "подмена"; });
      expect(problemOf(() => loadPreparedMaterials(a, id))).toBe("corrupt");
    });
    it("identifier inside differs from folder name", () => {
      const { id } = savePreparedMaterials(a, base());
      const other = "f".repeat(32);
      cpSync(join(preparedMaterialsDir(a), id), join(preparedMaterialsDir(a), other), { recursive: true });
      expect(problemOf(() => loadPreparedMaterials(a, other))).toBe("corrupt");
    });
  });

  it("invalid: path traversal and wrong types, no disk access", () => {
    const { id } = savePreparedMaterials(a, base());
    mkdirSync(join(a, "sessions", "x"), { recursive: true });
    cpSync(join(preparedMaterialsDir(a), id, "set.json"), join(a, "sessions", "x", "set.json"));
    cpSync(join(preparedMaterialsDir(a), id, "set.sha256"), join(a, "sessions", "x", "set.sha256"));
    for (const bad of ["../sessions/x", "/etc/passwd", "", undefined, 5, id.toUpperCase(), id.slice(1), id + "0"]) {
      expect(problemOf(() => loadPreparedMaterials(a, bad))).toBe("invalid");
    }
    expect(problemOf(() => loadPreparedMaterials(join(a, "нет"), "../x"))).toBe("invalid");
  });

  it("limit: materials above limit and folder above bound — nothing written", () => {
    const over = { ...base(), materialsChars: 3 };
    expect(problemOf(() => savePreparedMaterials(a, over))).toBe("limit");
    const big = { ...base(), workspace: [{ name: "п/f", text: "x".repeat(FOLDER_LIMITS.snapshotChars + 1) }] };
    expect(problemOf(() => savePreparedMaterials(a, big))).toBe("limit");
    expect(existsSync(preparedMaterialsDir(a))).toBe(false);
  });

  it("environment file does not get into the set", () => {
    const d = join(a, "proj");
    mkdirSync(d);
    writeFileSync(join(d, "README.md"), "# проект\n");
    writeFileSync(join(d, ".env"), "KEY=СЕКРЕТ-КОНТРОЛЬНАЯ-СТРОКА\n");
    const c = collectSessionMaterials([d], { materialsChars: 60000, materialsIgnore: [] });
    const set = savePreparedMaterials(a, { materials: c.materials, workspace: [], skipped: c.skipped, left: [], materialsChars: 60000, stamp: "s" });
    expect(readFileSync(jsonPath(a, set.id), "utf8")).not.toContain("СЕКРЕТ-КОНТРОЛЬНАЯ-СТРОКА");
    expect(set.skipped.some((s) => s.name.includes(".env"))).toBe(true);
  });
});

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PIECES = ["а", "Я", "z", "😀", "👨‍👩‍👧", "\n", "\r\n", " ", '"', "\\", "'", " ", "\t", "{", "/"];
const NAMES = ["a.md", "папка/файл.md", "у/в/г.txt", "x y.md", "ё.md"];

function genInput(i: number, rnd: () => number): PreparedInput {
  const text = (n: number) => Array.from({ length: n }, () => PIECES[Math.floor(rnd() * PIECES.length)]).join("");
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const ws = (n: number) => Array.from({ length: n }, (_, k) => ({ name: `п/${pick(NAMES)}${k}`, text: text(Math.floor(rnd() * 8)) }));
  const texts = i === 0 || i === 1 ? [] : i === 2 ? ["😀", "", "a\n\\\""] : Array.from({ length: Math.floor(rnd() * 5) }, () => text(Math.floor(rnd() * 12)));
  const materials = texts.map((t, k) => mk(k + 1, `${pick(NAMES)}${k}`, t));
  const used = materials.reduce((s, m) => s + m.chars, 0);
  const materialsChars = i === 2 ? used : used + Math.floor(rnd() * 5);
  return {
    materials,
    workspace: i === 0 ? [] : ws(i === 1 ? 2 : Math.floor(rnd() * 4)),
    skipped: Array.from({ length: Math.floor(rnd() * 3) }, () => ({ name: text(3), reason: text(4) })),
    left: Array.from({ length: Math.floor(rnd() * 3) }, () => ({ name: text(3), reason: text(4) })),
    materialsChars,
    stamp: text(6),
  };
}

describe("Prepared sets: properties", () => {
  it("Requirement: Prepared snapshot for preview — read returns what was written (300 sets)", () => {
    const rnd = mulberry32(47);
    for (let i = 0; i < 300; i++) {
      const input = genInput(i, rnd);
      const saved = savePreparedMaterials(a, input);
      const loaded = loadPreparedMaterials(a, saved.id);
      expect(loaded).toEqual(saved);
      for (const k of ["materials", "workspace", "skipped", "left", "materialsChars", "stamp"] as const) {
        expect(loaded[k]).toEqual(input[k]);
      }
    }
  });

  it("Requirement: Prepared snapshot for preview — any id not matching the pattern gives invalid", () => {
    const rnd = mulberry32(48);
    const alphabet = "0123456789abcdefABCDEF/.\0 -_я😀";
    let n = 0;
    for (let i = 0; i < 500; i++) {
      const len = Math.floor(rnd() * 40);
      const s = Array.from({ length: len }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
      if (/^[0-9a-f]{32}$/.test(s)) continue;
      n++;
      expect(problemOf(() => loadPreparedMaterials(a, s))).toBe("invalid");
    }
    expect(n).toBeGreaterThan(400);
  });
});

describe("prepared-materials: sources", () => {
  const source = (id: string): MaterialSource => ({ id, scheme: "https", host: "docs.example.org", pathname: "/a", fetchedAt: "2026-01-01T00:00:00.000Z" });
  const sidecar = (dir: string, id: string) => join(preparedMaterialsDir(dir), id, "sources.json");

  it("6. source file lies alongside, set.json does not know it", () => {
    const set = savePreparedMaterials(a, { ...base(), sources: [source("m2")] });
    expect(existsSync(sidecar(a, set.id))).toBe(true);
    expect(readFileSync(jsonPath(a, set.id), "utf8")).not.toContain("docs.example.org");
    expect(loadPreparedMaterials(a, set.id).sources).toEqual([source("m2")]);
    expect(set.sources).toEqual([source("m2")]);
  });

  it("7. without a source file there is none, sources — empty list", () => {
    const set = savePreparedMaterials(a, base());
    expect(existsSync(sidecar(a, set.id))).toBe(false);
    expect(loadPreparedMaterials(a, set.id).sources).toEqual([]);
  });

  it("8. damaged source file — corrupt", () => {
    const bads: ((p: string) => void)[] = [
      (p) => writeFileSync(p, "мусор"),
      (p) => writeFileSync(p, JSON.stringify({ version: 1, sources: [{ ...source("m1"), query: "x=1" }] })),
      (p) => writeFileSync(p, JSON.stringify({ version: 1, sources: [source("m9")] })),
      (p) => { rmSync(p); writeFileSync(p + ".real", JSON.stringify({ version: 1, sources: [source("m1")] })); symlinkSync(p + ".real", p); },
    ];
    for (const bad of bads) {
      const set = savePreparedMaterials(a, { ...base(), sources: [source("m1")] });
      bad(sidecar(a, set.id));
      expect(problemOf(() => loadPreparedMaterials(a, set.id))).toBe("corrupt");
    }
  });

  it("sidecar is not part of the set checksum: a valid replaced sources.json is read and changes only sources", () => {
    const set = savePreparedMaterials(a, { ...base(), sources: [source("m1")] });
    const other = { ...source("m2"), host: "other.example.net" };
    writeFileSync(sidecar(a, set.id), JSON.stringify({ version: 1, sources: [other] }));
    const loaded = loadPreparedMaterials(a, set.id);
    expect(loaded.sources).toEqual([other]);
    expect(loaded.materials).toEqual(set.materials);
    expect(loaded.id).toBe(set.id);
  });

  it("9. source of a foreign material — refusal, no traces", () => {
    expect(problemOf(() => savePreparedMaterials(a, { ...base(), sources: [source("m5")] }))).toBe("limit");
    expect(existsSync(preparedMaterialsDir(a))).toBe(false);
  });
});

describe("gitignore exclusions in the prepared set", () => {
  it("Prepared set stores exclusions: excludedPath read back", () => {
    const skipped = [{ name: "proj/out/", reason: "исключён правилом .gitignore: out/", excludedPath: "/a/proj/out", rule: "out/" }, { name: "proj/.gitignore", reason: "скрытое имя" }];
    const set = savePreparedMaterials(a, { ...base(), skipped });
    expect(loadPreparedMaterials(a, set.id).skipped).toEqual(skipped);
  });

  it("Old prepared set: entry without excludedPath is read without the field", () => {
    const set = savePreparedMaterials(a, base());
    expect(readFileSync(join(preparedMaterialsDir(a), set.id, "set.json"), "utf8")).not.toContain("excludedPath");
    expect(loadPreparedMaterials(a, set.id).skipped).toEqual([{ name: "s", reason: "r" }]);
  });

  it("expired sets are removed on prepare", () => {
    const t0 = new Date("2026-01-10T12:00:00Z");
    const ago = (h: number) => () => new Date(t0.getTime() - h * 3600_000);
    const A = savePreparedMaterials(a, base(), { now: ago(25) });
    const B = savePreparedMaterials(a, base(), { now: ago(23) });
    const root = preparedMaterialsDir(a);
    const C = "c".repeat(32);
    mkdirSync(join(root, C));
    writeFileSync(join(root, C, "set.json"), "");
    const D = "d".repeat(32);
    mkdirSync(join(root, D));
    const old = JSON.stringify({ version: 1, id: D, createdAt: ago(25)().toISOString() });
    writeFileSync(join(root, D, "set.json"), old);
    writeFileSync(join(root, D, "set.sha256"), "0".repeat(64));
    const n = savePreparedMaterials(a, base(), { now: () => t0 });
    const left = readdirSync(root);
    expect(left).not.toContain(A.id);
    for (const id of [B.id, C, D, n.id]) expect(left).toContain(id);
    expect(problemOf(() => loadPreparedMaterials(a, A.id, { now: () => t0 }))).toBe("unknown");
  });

  it("a removal failure does not fail the prepare", () => {
    const t0 = new Date("2026-01-10T12:00:00Z");
    const A = savePreparedMaterials(a, base(), { now: () => new Date(t0.getTime() - 25 * 3600_000) });
    const dirA = join(preparedMaterialsDir(a), A.id);
    chmodSync(dirA, 0o555); // files inside cannot be unlinked, so rm fails
    try {
      expect(() => savePreparedMaterials(a, base(), { now: () => t0 })).not.toThrow();
    } finally {
      chmodSync(dirA, 0o755);
    }
    const root = preparedMaterialsDir(a);
    expect(existsSync(join(root, A.id))).toBe(true);
  });
});
