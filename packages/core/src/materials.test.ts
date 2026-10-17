import { chmodSync, closeSync, ftruncateSync, openSync, readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachedFolderPrefixes, collectMaterials, collectSessionMaterials, MaterialsError, selectMaterials, verifyMaterials } from "./materials.ts";
import type { CollectOptions } from "./materials.ts";
import { folderMap, folderStats } from "./protocol/folder.ts";
import { loadPreparedMaterials, savePreparedMaterials } from "./store/prepared-materials.ts";
import { PDF_LIMITS } from "./pdf/extract.ts";
import { makeEncryptedPdf, makeImageOnlyPdf, makeMalformedPdf, makePdf } from "./pdf/fixture.ts";

const hook = vi.hoisted(() => ({ beforeOpen: undefined as undefined | ((p: string) => void), fullReads: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    readFileSync: (...args: Parameters<typeof real.readFileSync>) => {
      if (typeof args[0] === "number") hook.fullReads++;
      return real.readFileSync(...args);
    },
    openSync: (...args: Parameters<typeof real.openSync>) => {
      hook.beforeOpen?.(String(args[0]));
      return real.openSync(...args);
    },
  };
});

const opts: CollectOptions = { materialsChars: 10_000, materialsIgnore: ["node_modules", "dist"] };
let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "materials-")));
});
afterEach(() => {
  hook.beforeOpen = undefined;
  hook.fullReads = 0;
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, content: string | Uint8Array): string {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  return p;
}

function refusal(fn: () => unknown): MaterialsError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MaterialsError);
    return e as MaterialsError;
  }
  throw new Error("refusal expected");
}

const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

describe("collectMaterials", () => {
  it("file and folder with nested subfolders", () => {
    const f = put("single.txt", "один");
    put("dir/b.md", "bb");
    put("dir/sub/deep/c.txt", "ccc");
    const set = collectMaterials([f, join(root, "dir")], opts);
    expect(set.materials).toEqual([
      { id: "m1", name: "single.txt", chars: 4, sha256: sha("один"), text: "один" },
      { id: "m2", name: "dir/b.md", chars: 2, sha256: sha("bb"), text: "bb" },
      { id: "m3", name: "dir/sub/deep/c.txt", chars: 3, sha256: sha("ccc"), text: "ccc" },
    ]);
    expect(verifyMaterials(set.materials, opts.materialsChars)).toEqual([]);
  });

  it("hidden and ignored names are skipped and not walked", () => {
    put("d/ok.txt", "ok");
    put("d/.hidden/in.txt", "x");
    put("d/node_modules/in.txt", "x");
    put("d/a/b/vendor/in.txt", "x");
    const set = collectMaterials([join(root, "d")], { ...opts, materialsIgnore: ["node_modules", "vendor"] });
    expect(set.materials.map((m) => m.name)).toEqual(["d/ok.txt"]);
    expect(set.skipped).toEqual([
      { name: "d/.hidden", reason: "скрытое имя" },
      { name: "d/a/b/vendor", reason: "в списке игнорирования" },
      { name: "d/node_modules", reason: "в списке игнорирования" },
    ]);
  });

  it("gitignore rule: file excluded by one entry, .gitignore itself is a hidden name", () => {
    put("d/.gitignore", "a.txt\n");
    put("d/a.txt", "aaa");
    put("d/b.txt", "bbb");
    const set = collectMaterials([join(root, "d")], opts);
    expect(set.materials.map((m) => m.name)).toEqual(["d/b.txt"]);
    expect(set.skipped).toEqual([
      { name: "d/.gitignore", reason: "скрытое имя" },
      { name: "d/a.txt", reason: "исключён правилом .gitignore: a.txt", excludedPath: join(root, "d/a.txt"), rule: "a.txt" },
    ]);
  });

  it("order does not depend on creation order", () => {
    for (const n of ["z.txt", "s/y.txt", "s/a.txt", "B.txt", "a.txt"]) put(`d/${n}`, n);
    const first = collectMaterials([join(root, "d")], opts).materials.map((m) => [m.id, m.name]);
    const second = collectMaterials([join(root, "d")], opts).materials.map((m) => [m.id, m.name]);
    expect(second).toEqual(first);
    expect(first.map((x) => x[1])).toEqual(["d/B.txt", "d/a.txt", "d/s/a.txt", "d/s/y.txt", "d/z.txt"]);
  });

  it("overlapping paths and duplicates are taken once", () => {
    const f = put("d/a.txt", "abc");
    put("d/b.txt", "de");
    const set = collectMaterials([f, join(root, "d"), f, join(root, "d", "..", "d", "a.txt")], opts);
    expect(set.materials.map((m) => m.name)).toEqual(["d/a.txt", "d/b.txt"]);
    expect(set.materials.reduce((s, m) => s + m.chars, 0)).toBe(5);
    expect(collectMaterials([f, f], { ...opts, materialsChars: 3 }).materials).toHaveLength(1);
  });

  it("explicit hidden file and a file from the ignore list are accepted", () => {
    const h = put(".notes", "скрыт");
    const n = put("node_modules", "имя из списка");
    expect(collectMaterials([h, n], opts).materials.map((m) => m.name)).toEqual([".notes", "node_modules"]);
  });

  const bad: [string, Buffer][] = [
    ["невалидный UTF-8", Buffer.from([0x61, 0xff, 0xfe, 0x62])],
    ["NUL", Buffer.from("a\0b")],
  ];
  for (const [label, bytes] of bad) {
    it(`non-text (${label}): explicit file refused, skipped in a folder`, () => {
      const f = put("bad.txt", bytes);
      const err = refusal(() => collectMaterials([f], opts));
      expect(err.reasons).toEqual([`«${f}»: нетекстовый файл (не UTF-8 или бинарные данные)`]);
      put("d/bad.bin", bytes);
      put("d/ok.txt", "ok");
      const set = collectMaterials([join(root, "d")], opts);
      expect(set.materials.map((m) => m.name)).toEqual(["d/ok.txt"]);
      expect(set.skipped).toEqual([{ name: "d/bad.bin", reason: "нетекстовый файл" }]);
    });
  }

  it("large binary file is skipped by its head without full reading", () => {
    put("d/big.bin", Buffer.concat([Buffer.alloc(10, 0x41), Buffer.from([0]), Buffer.alloc(100_000, 0x41)]));
    const set = collectMaterials([join(root, "d")], opts);
    expect(set.materials).toEqual([]);
    expect(set.skipped).toEqual([{ name: "d/big.bin", reason: "нетекстовый файл" }]);
    expect(hook.fullReads).toBe(0);
  });

  it("NUL beyond the head still makes the file non-text", () => {
    const bytes = Buffer.alloc(10_000, 0x41);
    bytes[9000] = 0;
    const f = put("tail.bin", bytes);
    expect(refusal(() => collectMaterials([f], opts)).reasons[0]).toContain("нетекстовый файл");
    expect(hook.fullReads).toBe(1);
  });

  it(".env.local: refusal without leaking content and without reading", () => {
    const f = put(".env.local", "SECRET_MARKER_123");
    const err = refusal(() => collectMaterials([f], opts));
    expect(err.reasons).toEqual([`«${f}»: файлы окружения (.env, .env.*) прикладывать нельзя — защита секретов`]);
    expect(JSON.stringify([err.message, err.reasons])).not.toContain("SECRET_MARKER_123");
    const opened: string[] = [];
    hook.beforeOpen = (p) => opened.push(p);
    refusal(() => collectMaterials([f], opts));
    expect(opened).toEqual([]);
  });

  it(".env in a folder — skipped without reading; folder .env is a hidden name", () => {
    put("d/.env", "SECRET_MARKER_123");
    put("d/.env.example", "SECRET_MARKER_123");
    put("d/a.txt", "a");
    const opened: string[] = [];
    hook.beforeOpen = (p) => opened.push(p);
    const first = collectMaterials([join(root, "d")], opts);
    expect(first.materials.map((m) => m.name)).toEqual(["d/a.txt"]);
    expect(first.skipped).toEqual([
      { name: "d/.env", reason: "файл окружения — защита секретов" },
      { name: "d/.env.example", reason: "файл окружения — защита секретов" },
    ]);
    expect(opened).toEqual([join(root, "d/a.txt")]);
    expect(JSON.stringify(first)).not.toContain("SECRET_MARKER_123");
    hook.beforeOpen = undefined;
    rmSync(join(root, "d/.env"));
    rmSync(join(root, "d/.env.example"));
    put("d/.env/x.txt", "x");
    const set = collectMaterials([join(root, "d")], opts);
    expect(set.materials.map((m) => m.name)).toEqual(["d/a.txt"]);
    expect(set.skipped).toEqual([{ name: "d/.env", reason: "скрытое имя" }]);
  });

  it("two missing paths — two reasons", () => {
    const a = join(root, "no1");
    const b = join(root, "no2", "x.txt");
    expect(refusal(() => collectMaterials([a, b], opts)).reasons).toEqual([
      `«${a}»: путь не найден`,
      `«${b}»: путь не найден`,
    ]);
  });

  it.skipIf(process.getuid?.() === 0)("нечитаемое: явный файл и корень папки — отказ, внутри папки — пропуск", () => {
    const f = put("d/secret.txt", "SECRET_MARKER_123");
    put("d/a.txt", "a");
    put("d/closed/x.txt", "x");
    chmodSync(f, 0o000);
    chmodSync(join(root, "d/closed"), 0o000);
    try {
      const e1 = refusal(() => collectMaterials([f], opts));
      expect(e1.reasons[0]).toBe(`«${f}»: не удалось прочитать — EACCES`);
      const e2 = refusal(() => collectMaterials([join(root, "d/closed")], opts));
      expect(e2.reasons).toEqual(["«closed»: не удалось прочитать — EACCES"]);
      const set = collectMaterials([join(root, "d")], opts);
      expect(set.materials.map((m) => m.name)).toEqual(["d/a.txt"]);
      expect(set.skipped).toEqual([
        { name: "d/closed", reason: "не удалось прочитать — EACCES" },
        { name: "d/secret.txt", reason: "не удалось прочитать — EACCES" },
      ]);
    } finally {
      chmodSync(f, 0o600);
      chmodSync(join(root, "d/closed"), 0o700);
    }
  });

  describe("symbolic links", () => {
    it("explicit link refused", () => {
      const target = put("t.txt", "SECRET_MARKER_123");
      const link = join(root, "l.txt");
      symlinkSync(target, link);
      const err = refusal(() => collectMaterials([link], opts));
      expect(err.reasons).toEqual([`«${link}»: путь проходит через символическую ссылку ${link}; укажите путь без ссылок`]);
      expect(err.message).not.toContain("SECRET_MARKER_123");
    });

    it("link in the path parents", () => {
      put("real/a.txt", "a");
      const link = join(root, "lnk");
      symlinkSync(join(root, "real"), link);
      const p = join(link, "a.txt");
      expect(refusal(() => collectMaterials([p], opts)).reasons).toEqual([
        `«${p}»: путь проходит через символическую ссылку ${link}; укажите путь без ссылок`,
      ]);
    });

    it("link inside a folder is skipped, target not read", () => {
      const target = put("outside/t.txt", "SECRET_MARKER_123");
      put("d/a.txt", "a");
      symlinkSync(target, join(root, "d/l.txt"));
      symlinkSync(join(root, "outside"), join(root, "d/ldir"));
      const opened: string[] = [];
      hook.beforeOpen = (p) => opened.push(p);
      const set = collectMaterials([join(root, "d")], opts);
      expect(set.materials.map((m) => m.name)).toEqual(["d/a.txt"]);
      expect(set.skipped).toEqual([
        { name: "d/l.txt", reason: "символическая ссылка" },
        { name: "d/ldir", reason: "символическая ссылка" },
      ]);
      expect(opened).toEqual([join(root, "d/a.txt")]);
    });

    it("swapping a file for a link between check and read does not read the target", () => {
      const target = put("t.txt", "SECRET_MARKER_123");
      const f = put("d/a.txt", "a");
      hook.beforeOpen = (p) => {
        if (p !== f) return;
        rmSync(f);
        symlinkSync(target, f);
      };
      const e1 = refusal(() => collectMaterials([f], opts));
      expect(e1.reasons[0]).toContain("не удалось прочитать");
      expect(e1.message).not.toContain("SECRET_MARKER_123");
      rmSync(f);
      put("d/a.txt", "a");
      const set = collectMaterials([join(root, "d")], opts);
      expect(set.materials).toEqual([]);
      expect(set.skipped[0]).toMatchObject({ name: "d/a.txt" });
      expect(set.skipped[0]!.reason).toContain("не удалось прочитать");
      expect(JSON.stringify(set)).not.toContain("SECRET_MARKER_123");
    });
  });

  it("empty folder — empty set", () => {
    mkdirSync(join(root, "empty"));
    expect(collectMaterials([join(root, "empty")], opts)).toEqual({ materials: [], skipped: [] });
  });

  it("empty file — valid text", () => {
    const set = collectMaterials([put("e.txt", "")], opts);
    expect(set.materials[0]).toMatchObject({ chars: 0, text: "", sha256: sha("") });
  });

  it("limit boundary", () => {
    const a = put("a.txt", "12345");
    const b = put("b.txt", "1234");
    const c = put("c.txt", "123456");
    const d = put("d.txt", "12");
    expect(collectMaterials([a, b], { ...opts, materialsChars: 9 }).materials).toHaveLength(2);
    const err = refusal(() => collectMaterials([a, b, c, d], { ...opts, materialsChars: 16 }));
    expect(err.reasons).toEqual([
      "Материалы: объём 17 символов превышает лимит 16. Крупнейшие файлы: c.txt — 6, a.txt — 5, b.txt — 4",
    ]);
    expect(err.message).not.toContain("d.txt");
    expect(collectMaterials([a, b, c, d], { ...opts, materialsChars: 17 }).materials).toHaveLength(4);
  });

  it("characters are counted in UTF-16 units", () => {
    const f = put("e.txt", "😀");
    const set = collectMaterials([f], { ...opts, materialsChars: 2 });
    expect(set.materials[0]?.chars).toBe(2);
    expect(refusal(() => collectMaterials([f], { ...opts, materialsChars: 1 })).reasons[0]).toContain("объём 2 символов превышает лимит 1");
  });
});

describe("verifyMaterials", () => {
  const good = () => collectMaterials([put("a.txt", "aa"), put("b.txt", "bbb")], opts).materials;

  it("clean set", () => {
    expect(verifyMaterials(good(), 5)).toEqual([]);
    expect(verifyMaterials([], undefined)).toEqual([]);
  });

  it("finds a swap", () => {
    const text = good();
    text[0] = { ...text[0]!, text: "xx" };
    expect(verifyMaterials(text, 5)).toEqual(["Материал m1: контрольная сумма не совпадает с текстом"]);

    const chars = good();
    chars[1] = { ...chars[1]!, chars: 9 };
    expect(verifyMaterials(chars, 100)).toEqual(["Материал m2: число символов не совпадает с текстом"]);

    const hash = good();
    hash[0] = { ...hash[0]!, sha256: "0".repeat(64) };
    expect(verifyMaterials(hash, 5)).toEqual(["Материал m1: контрольная сумма не совпадает с текстом"]);

    const ids = good().reverse();
    expect(verifyMaterials(ids, 5)).toHaveLength(2);

    expect(verifyMaterials(good(), undefined)).toEqual(["лимит материалов не задан"]);
    expect(verifyMaterials(good(), 4)).toEqual([
      "Материалы: объём 5 символов превышает лимит 4. Крупнейшие файлы: b.txt — 3, a.txt — 2",
    ]);

    const blank = good();
    blank[0] = { ...blank[0]!, name: "  " };
    expect(verifyMaterials(blank, 5)).toEqual(["Материал m1: пустое имя"]);
  });
});

describe("collectSessionMaterials", () => {
  const lim = (materialsChars: number): CollectOptions => ({ materialsChars, materialsIgnore: ["node_modules", "dist"] });
  const x = (n: number) => "x".repeat(n);

  it("explicit file inside an attached folder: once and whole in both orders, even if the folder is over the limit", () => {
    const f = put("proj/a.txt", x(30));
    put("proj/b.txt", x(500));
    const dir = join(root, "proj");
    for (const paths of [[f, dir], [dir, f]]) {
      const r = collectSessionMaterials(paths, lim(100));
      const hits = r.materials.filter((m) => m.name.endsWith("a.txt"));
      expect(hits).toHaveLength(1);
      expect(hits[0]!.text).toBe(x(30));
      expect(r.materials.map((m) => m.id)).toEqual(r.materials.map((_, i) => `m${i + 1}`));
    }
  });

  it("folder over the limit: descriptions closer to the root are taken, left with reasons, source order, ids m1..mN", () => {
    put("d/README.md", x(40));
    put("d/code.ts", x(10));
    put("d/deep/more.md", x(40));
    put("d/z.md", x(40));
    const r = collectSessionMaterials([join(root, "d")], lim(85));
    expect(r.materials.map((m) => [m.id, m.name])).toEqual([["m1", "d/README.md"], ["m2", "d/z.md"]]);
    expect(r.left).toEqual([
      { name: "d/code.ts", reason: "не описание — из папки больше лимита берутся только описания" },
      { name: "d/deep/more.md", reason: "не поместился в лимит — 40 знаков" },
    ]);
    expect(r.workspace.map((f) => f.name).sort()).toEqual(["d/README.md", "d/code.ts", "d/deep/more.md", "d/z.md"]);
  });

  it("folder over the limit without descriptions: files closer to the root are taken while they fit", () => {
    put("d/a.ts", x(50));
    put("d/sub/b.ts", x(50));
    put("d/c.ts", x(50));
    const r = collectSessionMaterials([join(root, "d")], lim(100));
    expect(r.materials.map((m) => m.name)).toEqual(["d/a.ts", "d/c.ts"]);
    expect(r.left).toEqual([{ name: "d/sub/b.ts", reason: "не поместился в лимит — 50 знаков" }]);
  });

  it("selectMaterials: same objects, without renumbering", () => {
    put("e/a.md", "aa");
    put("e/b.md", "bb");
    const set2 = collectMaterials([join(root, "e")], lim(100));
    const { taken } = selectMaterials(set2.materials, [join(root, "e")], 2);
    expect(taken).toHaveLength(1);
    expect(taken[0]).toBe(set2.materials[0]);
  });

  it("ignored, hidden, .env.local, link and binary file: in skipped, not in workspace or materials", () => {
    put("p/ok.txt", "ok");
    put("p/node_modules/x.txt", "x");
    put("p/.hid/y.txt", "y");
    put("p/.env.local", "SECRET=1");
    put("p/bin.dat", Buffer.from([0, 1, 2, 0]));
    symlinkSync(join(root, "p/ok.txt"), join(root, "p/link.txt"));
    const r = collectSessionMaterials([join(root, "p")], lim(1000));
    const names = r.skipped.map((s) => s.name).sort();
    expect(names).toEqual(["p/.env.local", "p/.hid", "p/bin.dat", "p/link.txt", "p/node_modules"]);
    expect(r.materials.map((m) => m.name)).toEqual(["p/ok.txt"]);
    expect(r.workspace.map((f) => f.name)).toEqual(["p/ok.txt"]);
  });

  it("explicit .env: MaterialsError", () => {
    expect(() => collectSessionMaterials([put(".env", "SECRET=1")], lim(1000))).toThrow(MaterialsError);
  });

  it("explicit files exactly at the limit pass whole, one character over — refusal with sizes and names without text", () => {
    const a = put("a.txt", x(30000));
    const b = put("b.txt", "y".repeat(30000));
    const ok = collectSessionMaterials([a, b], lim(60000));
    expect(ok.materials.map((m) => m.text)).toEqual([x(30000), "y".repeat(30000)]);
    const c = put("c.txt", "z");
    const e = refusal(() => collectSessionMaterials([a, b, c], lim(60000)));
    const msg = e.reasons.join("\n");
    expect(msg).toContain("60001");
    expect(msg).toContain("60000");
    for (const n of ["a.txt", "b.txt", "c.txt"]) expect(msg).toContain(n);
    expect(msg).not.toContain("xxxxx");
  });

  it("non-BMP characters count as code units; explicit file is not truncated", () => {
    const f = put("e.txt", "😀");
    expect(collectSessionMaterials([f], lim(2)).materials[0]!.chars).toBe(2);
    expect(() => collectSessionMaterials([f], lim(1))).toThrow(MaterialsError);
  });

  it("folder of 100000 characters: materials not above the limit, workspace has everything", () => {
    for (let i = 0; i < 10; i++) put(`big/d${i}.md`, x(10000));
    const r = collectSessionMaterials([join(root, "big")], lim(60000));
    expect(r.materials.reduce((s, m) => s + m.chars, 0)).toBeLessThanOrEqual(60000);
    expect(folderStats(r.workspace).chars).toBe(100000);
  });

  it("folder snapshot limit: 20000000 passes, 20000001 — refusal without text", () => {
    put("s/a.txt", x(10_000_000));
    const b = put("s/b.txt", "y".repeat(10_000_000));
    const ok = collectSessionMaterials([join(root, "s")], lim(60000));
    expect(folderStats(ok.workspace).chars).toBe(20_000_000);
    writeFileSync(b, "y".repeat(10_000_001));
    const msg = refusal(() => collectSessionMaterials([join(root, "s")], lim(60000))).reasons.join("\n");
    expect(msg).toContain("20000001");
    expect(msg).toContain("20000000");
    expect(msg).not.toContain("xxxxx");
    expect(msg).not.toContain("yyyyy");
  });

  it("absolute paths do not leak into reasons and names", () => {
    const miss = refusal(() => collectSessionMaterials([join(root, "нет.txt")], lim(1000)));
    expect(miss.reasons.join("\n")).not.toContain(root);
    put("real/a.txt", "a");
    symlinkSync(join(root, "real"), join(root, "lnk"));
    const viaLink = refusal(() => collectSessionMaterials([join(root, "lnk/a.txt")], lim(1000)));
    expect(viaLink.reasons.join("\n")).not.toContain(root);
    put("q/a.txt", "a");
    put("q/.h", "h");
    const r = collectSessionMaterials([put("single.txt", "s"), join(root, "q")], lim(1));
    for (const n of [...r.materials, ...r.workspace, ...r.skipped, ...r.left].map((i) => i.name)) expect(n.startsWith("/")).toBe(false);
  });
});

describe("local PDFs", () => {
  const SLOW = 20_000;
  const lim = (materialsChars: number): CollectOptions => ({ materialsChars, materialsIgnore: ["node_modules", "dist"] });
  const TEXT = "Первая страница\n\nВторая страница";
  const R = {
    enc: "PDF зашифрован — пароль не запрашивается",
    scan: "в PDF нет текстового слоя — распознавание не выполняется",
    bad: "PDF повреждён",
  };
  const sparsePdf = (rel: string, size: number): string => {
    const f = put(rel, "%PDF-1.7\n");
    const fd = openSync(f, "r+");
    ftruncateSync(fd, size);
    closeSync(fd);
    return f;
  };

  it("explicit PDF: text layer, as for a text file", () => {
    const f = put("doc.pdf", makePdf(["Первая страница", "Вторая страница"]));
    const [m] = collectMaterials([f], opts).materials;
    expect(m).toEqual({ id: "m1", name: "doc.pdf", chars: TEXT.length, sha256: sha(TEXT), text: TEXT });
    expect(m!.text).not.toContain("%PDF");
  }, SLOW);

  it("explicit encrypted, scanned and damaged PDF: refusal, file unchanged", () => {
    const cases: [Uint8Array, string][] = [[makeEncryptedPdf(), R.enc], [makeImageOnlyPdf(), R.scan], [makeMalformedPdf(), R.bad]];
    for (const [bytes, reason] of cases) {
      const f = put("x.pdf", bytes);
      expect(refusal(() => collectMaterials([f], opts)).reasons).toEqual([`«${f}»: ${reason}`]);
      expect(readFileSync(f).equals(Buffer.from(bytes))).toBe(true);
    }
  }, SLOW);

  it("refusals accumulate: two bad PDFs and a missing path", () => {
    const a = put("a.pdf", makeEncryptedPdf());
    const b = put("b.pdf", makeMalformedPdf());
    const c = join(root, "нет.pdf");
    expect(refusal(() => collectMaterials([a, b, c], opts)).reasons).toEqual([
      `«${a}»: ${R.enc}`, `«${b}»: ${R.bad}`, `«${c}»: путь не найден`,
    ]);
  }, SLOW);

  it("folder: bad PDFs are skipped with a reason, the rest is collected", () => {
    put("d/README.md", "читай");
    put("d/good.pdf", makePdf(["Первая страница", "Вторая страница"]));
    put("d/broken.pdf", makeMalformedPdf());
    put("d/scan.pdf", makeImageOnlyPdf());
    put("d/locked.pdf", makeEncryptedPdf());
    const set = collectMaterials([join(root, "d")], opts);
    expect(set.materials.map((m) => [m.name, m.text])).toEqual([["d/README.md", "читай"], ["d/good.pdf", TEXT]]);
    expect(set.skipped).toEqual([
      { name: "d/broken.pdf", reason: R.bad },
      { name: "d/locked.pdf", reason: R.enc },
      { name: "d/scan.pdf", reason: R.scan },
    ]);
  }, SLOW);

  it("size above PDF_LIMITS.bytes: refusal without reading, fast", () => {
    const f = sparsePdf("big.pdf", PDF_LIMITS.bytes + 1);
    const t = Date.now();
    expect(refusal(() => collectMaterials([f], opts)).reasons).toEqual([`«${f}»: PDF больше 100 МиБ`]);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("link to a PDF: explicit refused, skipped in a folder", () => {
    const real = put("real.pdf", makePdf(["Первая страница"]));
    symlinkSync(real, join(root, "lnk.pdf"));
    const e = refusal(() => collectMaterials([join(root, "lnk.pdf")], opts));
    expect(e.reasons[0]).toContain("символическую ссылку");
    put("d/a.txt", "a");
    symlinkSync(real, join(root, "d/l.pdf"));
    expect(collectMaterials([join(root, "d")], opts).skipped).toEqual([{ name: "d/l.pdf", reason: "символическая ссылка" }]);
  }, SLOW);

  it("content decides, not the extension", () => {
    const t = put("plain.pdf", "просто текст");
    expect(collectMaterials([t], opts).materials[0]!.text).toBe("просто текст");
    const n = put("notes.txt", "%PDF-1.7\nмусор");
    expect(refusal(() => collectMaterials([n], opts)).reasons).toEqual([`«${n}»: ${R.bad}`]);
  }, SLOW);

  it("folder over the limit: pdf is a description, in the snapshot the text layer", () => {
    put("d/README.md", "r".repeat(10));
    put("d/spec.pdf", makePdf(["Первая страница"]));
    put("d/code.ts", "c".repeat(50));
    const r = collectSessionMaterials([join(root, "d")], lim(40));
    expect(r.materials.map((m) => m.name)).toEqual(["d/README.md", "d/spec.pdf"]);
    expect(r.left).toEqual([{ name: "d/code.ts", reason: "не описание — из папки больше лимита берутся только описания" }]);
    expect(r.workspace.find((f) => f.name === "d/spec.pdf")?.text).toBe("Первая страница");
  }, SLOW);

  it("explicit PDF over the limit: refusal by limit with name and size", () => {
    const f = put("big.pdf", makePdf(["Первая страница", "Вторая страница"]));
    const msg = refusal(() => collectMaterials([f], lim(5))).reasons.join("\n");
    expect(msg).toContain(`объём ${TEXT.length} символов превышает лимит 5`);
    expect(msg).toContain(`big.pdf — ${TEXT.length}`);
  }, SLOW);

  it("explicit PDF refusal via collectSessionMaterials without an absolute path", () => {
    const f = put("x.pdf", makeEncryptedPdf());
    const msg = refusal(() => collectSessionMaterials([f], lim(1000))).reasons.join("\n");
    expect(msg).toContain(R.enc);
    expect(msg).not.toContain(root);
  }, SLOW);
});

describe("collectSessionMaterials: extra", () => {
  const mk = (name: string, text: string) => ({ name, text, chars: text.length, sha256: createHash("sha256").update(text).digest("hex") });
  it("extra come last, ids in order", () => {
    writeFileSync(join(root, "a.md"), "aaa");
    const set = collectSessionMaterials([join(root, "a.md")], opts, [mk("h_x", "11"), mk("h_y", "2")]);
    expect(set.materials.map((m) => [m.id, m.name])).toEqual([["m1", "a.md"], ["m2", "h_x"], ["m3", "h_y"]]);
  });
  it("total attached limit: the message shows the real limit", () => {
    writeFileSync(join(root, "a.md"), "a".repeat(60));
    const e = (() => { try { collectSessionMaterials([join(root, "a.md")], { ...opts, materialsChars: 100 }, [mk("h_x", "x".repeat(50))]); } catch (x) { return x; } })();
    expect(e).toBeInstanceOf(MaterialsError);
    expect((e as MaterialsError).reasons[0]).toMatch(/110 символов превышает лимит 100.*a\.md — 60, h_x — 50/);
  });
  it("the rest of the limit goes to folder files", () => {
    mkdirSync(join(root, "d"));
    writeFileSync(join(root, "d", "a.md"), "a".repeat(40));
    writeFileSync(join(root, "d", "b.md"), "b".repeat(40));
    const set = collectSessionMaterials([join(root, "d")], { ...opts, materialsChars: 100 }, [mk("h_x", "x".repeat(30))]);
    expect(set.materials.map((m) => m.name)).toEqual(["d/a.md", "h_x"]);
    expect(set.left.map((l) => l.name)).toEqual(["d/b.md"]);
  });
  it("extra name with '/' — a programmer error", () => {
    expect(() => collectSessionMaterials([], opts, [mk("a/b", "x")])).toThrow(/«\/»/);
  });
  it("without extra the result is the same as with two arguments", () => {
    writeFileSync(join(root, "a.md"), "aaa");
    expect(collectSessionMaterials([join(root, "a.md")], opts, [])).toEqual(collectSessionMaterials([join(root, "a.md")], opts));
  });
});

describe("Exclusion by .gitignore rules", () => {
  const lim = (materialsChars: number, more: Partial<CollectOptions> = {}): CollectOptions => ({ materialsChars, materialsIgnore: ["node_modules", "dist"], ...more });
  const rule = (r: string) => `исключён правилом .gitignore: ${r}`;
  const hidden = (name: string) => ({ name, reason: "скрытое имя" });
  const ruled = (set: { skipped: { name: string; excludedPath?: string }[] }) => set.skipped.filter((s) => s.excludedPath !== undefined).map((s) => s.name);

  function proj() {
    put("proj/.gitignore", "out/\n");
    put("proj/src/a.ts", "a");
    put("proj/out/main.js", "x".repeat(500_000));
    put("proj/out/assets/b.js", "b");
    return join(root, "proj");
  }

  it("Build artifacts: out/ in one entry, not in the set, the snapshot or the 'Owner folder' listing", () => {
    const set = collectSessionMaterials([proj()], lim(1000));
    expect(set.materials.map((m) => m.name)).toEqual(["proj/src/a.ts"]);
    expect(set.workspace.map((f) => f.name)).toEqual(["proj/src/a.ts"]);
    expect(set.skipped).toEqual([hidden("proj/.gitignore"), { name: "proj/out/", reason: rule("out/"), excludedPath: join(root, "proj/out"), rule: "out/" }]);
    expect(folderMap(set.workspace, "ru")).not.toContain("out");
  });

  it("Nested rules file and negation", () => {
    put("d/.gitignore", "*.log\n");
    put("d/pkg/.gitignore", "gen/\n!keep.log\n");
    put("d/x.log", "x");
    put("d/pkg/keep.log", "k");
    put("d/pkg/gen/c.ts", "c");
    put("d/pkg/gen/deep/e.ts", "e");
    put("d/pkg/d.ts", "d");
    const set = collectSessionMaterials([join(root, "d")], lim(1000));
    expect(set.workspace.map((f) => f.name)).toEqual(["d/pkg/d.ts", "d/pkg/keep.log"]);
    expect(set.skipped.filter((s) => s.excludedPath !== undefined)).toEqual([
      { name: "d/pkg/gen/", reason: rule("gen/"), excludedPath: join(root, "d/pkg/gen"), rule: "gen/" },
      { name: "d/x.log", reason: rule("*.log"), excludedPath: join(root, "d/x.log"), rule: "*.log" },
    ]);
  });

  it("A nested rule brings back a folder excluded by a rule above", () => {
    put("d/.gitignore", "sub/\n");
    put("d/pkg/.gitignore", "!sub/\n");
    put("d/sub/a.ts", "a");
    put("d/pkg/sub/b.ts", "b");
    const set = collectSessionMaterials([join(root, "d")], lim(1000));
    expect(set.workspace.map((f) => f.name)).toEqual(["d/pkg/sub/b.ts"]);
    expect(ruled(set)).toEqual(["d/sub/"]);
  });

  it("Empty rules '!', '/' and '!/' of a nested file neither return nor exclude anything", () => {
    put("d/.gitignore", "gen/\n");
    put("d/pkg/.gitignore", "!\n/\n!/\n");
    put("d/pkg/gen/c.ts", "c");
    put("d/pkg/d.ts", "d");
    const set = collectSessionMaterials([join(root, "d")], lim(1000));
    expect(set.workspace.map((f) => f.name)).toEqual(["d/pkg/d.ts"]);
    expect(ruled(set)).toEqual(["d/pkg/gen/"]);
  });

  it("Folder without gitignore: set and skips unchanged", () => {
    put("d/a.txt", "a");
    put("d/.cache/x", "x");
    put("d/node_modules/m.js", "m");
    put("d/src/b.ts", "b");
    const set = collectMaterials([join(root, "d")], opts);
    expect(set.materials.map((m) => m.name)).toEqual(["d/a.txt", "d/src/b.ts"]);
    expect(set.skipped).toEqual([hidden("d/.cache"), { name: "d/node_modules", reason: "в списке игнорирования" }]);
  });

  it("A name from the ignore list keeps the previous reason, even if .gitignore names it", () => {
    put("d/.gitignore", "node_modules/\n");
    put("d/node_modules/m.js", "m");
    put("d/a.txt", "a");
    expect(collectMaterials([join(root, "d")], opts).skipped).toEqual([hidden("d/.gitignore"), { name: "d/node_modules", reason: "в списке игнорирования" }]);
  });

  it("Unreadable gitignore: collection succeeds, rules not applied, reason on the .gitignore entry", () => {
    const rules = put("d/.gitignore", "a.txt\n");
    put("d/a.txt", "aaa");
    chmodSync(rules, 0o000);
    try {
      const set = collectMaterials([join(root, "d")], opts);
      expect(set.materials.map((m) => m.name)).toEqual(["d/a.txt"]);
      expect(set.skipped).toEqual([{ name: "d/.gitignore", reason: "не удалось прочитать — EACCES" }]);
    } finally {
      chmodSync(rules, 0o600);
    }
  });

  it("gitignore link is not read: target rules are not applied", () => {
    put("rules.txt", "a.txt\n");
    put("d/a.txt", "aaa");
    symlinkSync(join(root, "rules.txt"), join(root, "d/.gitignore"));
    const set = collectMaterials([join(root, "d")], opts);
    expect(set.materials.map((m) => m.name)).toEqual(["d/a.txt"]);
    expect(set.skipped).toEqual([{ name: "d/.gitignore", reason: "не удалось прочитать — ELOOP" }]);
  });

  it("A broken character class in .gitignore does not reject collection, other rules apply", () => {
    const bad = "[!/\n[x-!]\n[$-!]\n[\\w-a]\n";
    put("d/.gitignore", `${bad}out/\n`);
    put("d/pkg/.gitignore", `${bad}gen/\n`);
    put("d/a.txt", "a");
    put("d/out/b.js", "b");
    put("d/pkg/gen/c.ts", "c");
    put("d/pkg/d.ts", "d");
    const set = collectSessionMaterials([join(root, "d")], lim(1000));
    expect(set.workspace.map((f) => f.name)).toEqual(["d/a.txt", "d/pkg/d.ts"]);
    expect(ruled(set)).toEqual(["d/out/", "d/pkg/gen/"]);
  });

  it("Character classes and '**' as in git: negation, POSIX class, dir/**/", () => {
    put("d/.gitignore", "*.[!ch]\nf[[:digit:]].md\na/**/\n");
    put("d/pkg/.gitignore", "*.py[!c]\n");
    for (const f of ["x.c", "x.h", "x.o", "f1.md", "fa.md", "a/f", "a/b/g", "pkg/m.pyc", "pkg/m.pyo"]) put(`d/${f}`, f);
    const set = collectSessionMaterials([join(root, "d")], lim(1000));
    expect(set.workspace.map((f) => f.name)).toEqual(["d/a/f", "d/fa.md", "d/pkg/m.pyc", "d/x.c", "d/x.h"]);
    expect(ruled(set)).toEqual(["d/a/b/", "d/f1.md", "d/pkg/m.pyo", "d/x.o"]);
  });

  it("Folder name with special characters: its .gitignore rules apply only within it", () => {
    for (const dir of ["q?", "s*r", "a[b]"]) {
      put(`d/${dir}/.gitignore`, "x.txt\n");
      put(`d/${dir}/x.txt`, "x");
      put(`d/${dir}/y.txt`, "y");
    }
    for (const twin of ["qq", "sor", "ab"]) put(`d/${twin}/x.txt`, "x");
    const set = collectSessionMaterials([join(root, "d")], lim(1000));
    expect(ruled(set)).toEqual(["d/a[b]/x.txt", "d/q?/x.txt", "d/s*r/x.txt"]);
    expect(set.workspace.map((f) => f.name)).toEqual(["d/a[b]/y.txt", "d/ab/x.txt", "d/q?/y.txt", "d/qq/x.txt", "d/s*r/y.txt", "d/sor/x.txt"]);
  });

  it("BOM, CRLF and trailing spaces: rules apply, the reason shows the rule as the owner wrote it", () => {
    put("d/.gitignore", "﻿out/\r\n*.log  \r\n");
    put("d/pkg/.gitignore", "﻿gen/  \r\nt.tmp\r\n");
    for (const f of ["out/a.js", "x.log", "pkg/gen/c.ts", "pkg/t.tmp", "pkg/d.ts"]) put(`d/${f}`, f);
    const set = collectSessionMaterials([join(root, "d")], lim(1000));
    expect(set.workspace.map((f) => f.name)).toEqual(["d/pkg/d.ts"]);
    expect(set.skipped.filter((s) => s.excludedPath !== undefined).map((s) => [s.name, s.rule, s.reason])).toEqual([
      ["d/out/", "out/", rule("out/")], ["d/pkg/gen/", "gen/", rule("gen/")], ["d/pkg/t.tmp", "t.tmp", rule("t.tmp")], ["d/x.log", "*.log", rule("*.log")],
    ]);
  });

  it("Return of a folder together with a path inside it is accepted", () => {
    const dir = proj();
    const set = collectSessionMaterials([dir], lim(600_000, { include: [join(dir, "out"), join(dir, "out/main.js")] }));
    expect(set.workspace.map((f) => f.name)).toEqual(["proj/out/assets/b.js", "proj/out/main.js", "proj/src/a.ts"]);
  });

  it("An explicitly attached file is not counted as excluded by rules, in both orders", () => {
    put("proj/.gitignore", "*.tmp\n");
    put("proj/a.ts", "a");
    const file = put("proj/x.tmp", "t");
    const dir = join(root, "proj");
    for (const paths of [[dir, file], [file, dir]]) {
      const set = collectSessionMaterials(paths, lim(1000));
      expect(set.materials.map((m) => m.name).sort()).toEqual(["proj/a.ts", "x.tmp"]);
      expect(ruled(set)).toEqual([]);
    }
  });

  it("Too large .gitignore is not read: rules not applied, reason on the entry", () => {
    put("d/.gitignore", `a.txt\n${"# x\n".repeat(270_000)}`);
    put("d/a.txt", "aaa");
    const set = collectMaterials([join(root, "d")], opts);
    expect(set.materials.map((m) => m.name)).toEqual(["d/a.txt"]);
    expect(set.skipped).toEqual([{ name: "d/.gitignore", reason: "не удалось прочитать — больше 1 МиБ" }]);
  });

  it("gitignore FIFO is not opened: collection does not hang", () => {
    put("d/a.txt", "aaa");
    execFileSync("mkfifo", [join(root, "d/.gitignore")]);
    const set = collectMaterials([join(root, "d")], opts);
    expect(set.materials.map((m) => m.name)).toEqual(["d/a.txt"]);
    expect(set.skipped).toEqual([hidden("d/.gitignore")]);
  });

  it("An explicit file is not excluded: included whole and once together with the folder, in both orders", () => {
    const dir = proj();
    const file = join(dir, "out/main.js");
    const alone = collectSessionMaterials([file], lim(600_000));
    expect(alone.materials.map((m) => [m.name, m.chars])).toEqual([["main.js", 500_000]]);
    for (const paths of [[dir, file], [file, dir]]) {
      const set = collectSessionMaterials(paths, lim(600_000));
      expect(set.materials.filter((m) => m.chars === 500_000).map((m) => m.name)).toEqual(["main.js"]);
      expect(set.workspace.map((f) => f.name)).toEqual(["proj/src/a.ts"]);
    }
  });

  it("Return and disabling", () => {
    const dir = proj();
    put("proj/.gitignore", "out/\n*.tmp\n");
    put("proj/x.tmp", "t");
    const back = collectSessionMaterials([dir], lim(600_000, { include: [join(dir, "out/main.js")] }));
    expect(back.workspace.map((f) => f.name)).toEqual(["proj/out/main.js", "proj/src/a.ts"]);
    expect(back.skipped.filter((s) => s.excludedPath !== undefined)).toEqual([
      { name: "proj/out/assets/", reason: rule("out/"), excludedPath: join(dir, "out/assets"), rule: "out/" },
      { name: "proj/x.tmp", reason: rule("*.tmp"), excludedPath: join(dir, "x.tmp"), rule: "*.tmp" },
    ]);

    const off = collectSessionMaterials([dir], lim(600_000, { gitignore: false }));
    expect(off.workspace.map((f) => f.name)).toEqual(["proj/out/assets/b.js", "proj/out/main.js", "proj/src/a.ts", "proj/x.tmp"]);
    expect(off.skipped).toEqual([hidden("proj/.gitignore")]);

    for (const bad of [join(dir, "src/a.ts"), join(dir, "нет.ts"), join(root, "чужое/out")]) {
      const e = refusal(() => collectSessionMaterials([dir], lim(600_000, { include: [bad] })));
      expect(e.reasons).toHaveLength(1);
      expect(e.reasons[0]).toContain("не найден среди исключённых правилами .gitignore");
      expect(e.reasons[0]).toContain(bad.split("/").pop());
      expect(e.reasons[0]).not.toContain(root);
    }
    const noRules = refusal(() => collectSessionMaterials([dir], lim(600_000, { gitignore: false, include: [join(dir, "out")] })));
    expect(noRules.reasons[0]).toContain("не найден среди исключённых правилами .gitignore");
  });

  it("Return of a whole folder: rules inside it do not apply, rules outside do", () => {
    put("proj/.gitignore", "out/\n*.map\n");
    put("proj/out/main.js", "m");
    put("proj/out/main.js.map", "mm");
    put("proj/out/.hidden", "h");
    put("proj/src/a.ts", "a");
    put("proj/src/a.ts.map", "am");
    const dir = join(root, "proj");
    const set = collectSessionMaterials([dir], lim(1000, { include: [join(dir, "out")] }));
    expect(set.workspace.map((f) => f.name)).toEqual(["proj/out/main.js", "proj/out/main.js.map", "proj/src/a.ts"]);
    expect(set.skipped).toEqual([hidden("proj/.gitignore"), hidden("proj/out/.hidden"), { name: "proj/src/a.ts.map", reason: rule("*.map"), excludedPath: join(dir, "src/a.ts.map"), rule: "*.map" }]);
  });

  it("Two folders with one name: excludedPath differs, returning one does not return the other, no absolute paths in the set", () => {
    for (const side of ["a", "b"]) {
      put(`${side}/proj/.gitignore`, "out/\n");
      put(`${side}/proj/out/${side}.js`, side);
      put(`${side}/proj/${side}.ts`, side);
    }
    const paths = [join(root, "a/proj"), join(root, "b/proj")];
    const first = collectSessionMaterials(paths, lim(1000));
    const excluded = first.skipped.filter((s) => s.excludedPath !== undefined);
    expect(excluded.map((s) => s.name)).toEqual(["proj/out/", "proj (2)/out/"]);
    expect(excluded.map((s) => s.excludedPath)).toEqual([join(root, "a/proj/out"), join(root, "b/proj/out")]);

    const back = collectSessionMaterials(paths, lim(1000, { include: [excluded[1]!.excludedPath!] }));
    expect(back.workspace.map((f) => f.name)).toEqual(["proj/a.ts", "proj (2)/b.ts", "proj (2)/out/b.js"]);
    expect(back.skipped.filter((s) => s.excludedPath !== undefined).map((s) => s.excludedPath)).toEqual([join(root, "a/proj/out")]);
    // only materials and workspace go into the session and the turn request
    expect(JSON.stringify([back.materials, back.workspace, back.left])).not.toContain(root);
    expect(JSON.stringify([first.materials, first.workspace, first.left])).not.toContain(root);
  });
});

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("Exclusion by .gitignore rules: excluded paths are absent everywhere (property)", () => {
  const SEEDS = 300;
  const NAMES = ["a", "ab", "a.b", "b", "out", "gen", "lib", "tmp.d", "keep.log", "x.log", "a.ts", "ab.ts", "b.txt", "out.txt"];
  const lim: CollectOptions = { materialsChars: 1_000_000, materialsIgnore: ["node_modules", "dist"] };

  interface Tree { dir: string; files: string[]; rules: number }

  // Tree: depth up to 4, names with shared prefixes and dots, empty folders, nested .gitignore with the name, dir/, *.ext, /root, **/x, a/b, dir/**/, character classes, negation, comments, empty rules, trailing spaces, CRLF and BOM.
  function generate(seed: number, at: string): Tree {
    const rnd = mulberry32(seed);
    const int = (n: number) => Math.floor(rnd() * n);
    const pick = <T,>(xs: readonly T[]) => xs[int(xs.length)]!;
    const files: string[] = [];
    let rules = 0;
    const pattern = (): string => {
      const n = pick(NAMES);
      const one = [n, `${n}/`, `*.${pick(["log", "ts", "txt", "b", "d"])}`, `/${n}`, `**/${n}`, `${pick(NAMES)}/${n}`, `${n}*`, "# комментарий", "", "/", "!", `*.[!${pick(["t", "l", "b"])}]*`, `[${pick(["ab", "a-k", "!o"])}]*`, `${n}/**/`, `${n}  `][int(15)]!;
      return rnd() < 0.25 && one !== "" && one !== "!" && !one.startsWith("#") ? `!${one}` : one;
    };
    const build = (rel: string, depth: number) => {
      mkdirSync(join(at, rel), { recursive: true });
      if (rnd() < (depth === 0 ? 0.9 : 0.35)) {
        const lines = Array.from({ length: 1 + int(4) }, pattern);
        rules += lines.length;
        const eol = rnd() < 0.2 ? "\r\n" : "\n";
        writeFileSync(join(at, rel, ".gitignore"), (rnd() < 0.1 ? "\uFEFF" : "") + lines.join(eol) + (rnd() < 0.5 ? eol : ""));
      }
      const used = new Set<string>();
      for (let i = int(5); i > 0; i--) {
        const name = pick(NAMES);
        if (used.has(name)) continue;
        used.add(name);
        const eRel = rel ? `${rel}/${name}` : name;
        if (depth < 4 && rnd() < 0.45) build(eRel, depth + 1);
        else {
          writeFileSync(join(at, eRel), `${seed}:${eRel}`);
          files.push(eRel);
        }
      }
    };
    build("", 0);
    return { dir: at, files, rules };
  }

  it.skipIf(!hasGit)("сборщик совпадает с git на порождённых деревьях и правилах", () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    // the owner's git settings (shared excludesFile) do not reach the oracle
    const env = { PATH: process.env.PATH ?? "", HOME: root, XDG_CONFIG_HOME: join(root, "xdg"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    execFileSync("git", ["init", "-q", repo], { env });
    const trees = Array.from({ length: SEEDS }, (_, seed) => generate(seed, join(repo, `s${seed}`, "t")));
    const asked = trees.flatMap((t, seed) => t.files.map((f) => `s${seed}/t/${f}`));
    let answer = "";
    try {
      answer = execFileSync("git", ["-C", repo, "check-ignore", "--no-index", "--stdin"], { env, input: asked.join("\n"), encoding: "utf8", maxBuffer: 64 * 2 ** 20 });
    } catch (e) {
      if ((e as { status?: number }).status !== 1) throw e; // 1 — no path is excluded
    }
    const ignored = new Set(answer.split("\n").filter(Boolean));
    expect(ignored.size).toBeGreaterThan(SEEDS / 2); // the generator reaches exclusions
    expect(asked.length - ignored.size).toBeGreaterThan(SEEDS);
    expect(trees.filter((t) => t.rules > 0).length).toBeGreaterThan(SEEDS / 2);

    const data = join(root, "data");
    let returnedCases = 0;
    trees.forEach((tree, seed) => {
      const rnd = mulberry32(seed ^ 0x9e3779b9);
      const where = `зерно ${seed}`;
      const isIgnored = (f: string) => ignored.has(`s${seed}/t/${f}`);
      const kept = tree.files.filter((f) => !isIgnored(f)).map((f) => `t/${f}`).sort();
      const all = tree.files.map((f) => `t/${f}`).sort();

      const set = collectSessionMaterials([tree.dir], lim);
      const names = (fs: readonly { name: string }[]) => fs.map((f) => f.name).sort();
      // excluded path is absent from the initial set, the snapshot and the 'Owner folder' listing
      expect(names(set.workspace), where).toEqual(kept);
      expect(names(set.materials), where).toEqual(kept);
      const map = folderMap(set.workspace, "ru").split("\n");
      for (const f of tree.files.filter(isIgnored)) expect(map.some((l) => l.startsWith(`t/${f} — `)), `${where}: ${f} в перечне`).toBe(false);
      // one entry for the topmost excluded path: each excluded file lies under exactly one
      const tops = set.skipped.filter((s) => s.excludedPath !== undefined).map((s) => s.excludedPath!);
      for (const f of tree.files) {
        const abs = join(tree.dir, f);
        expect(tops.filter((t) => abs === t || abs.startsWith(`${t}/`)).length, `${where}: ${f}`).toBe(isIgnored(f) ? 1 : 0);
      }
      // collecting an unchanged tree again gives the same result
      expect(collectSessionMaterials([tree.dir], lim), where).toEqual(set);
      // with rules disabled the result equals the previous: all files, .gitignore is only a hidden name
      const off = collectSessionMaterials([tree.dir], { ...lim, gitignore: false });
      expect(names(off.workspace), where).toEqual(all);
      expect(off.skipped.every((s) => s.reason === "скрытое имя" && s.name.endsWith("/.gitignore")), where).toBe(true);
      // saved skips are read back together with excludedPath
      if (seed % 10 === 0) {
        const saved = savePreparedMaterials(data, { materials: set.materials, workspace: set.workspace, skipped: set.skipped, left: set.left, materialsChars: lim.materialsChars, stamp: "p" });
        expect(loadPreparedMaterials(data, saved.id).skipped, where).toEqual(set.skipped);
      }
      // an explicitly attached file is always present exactly once, in any path order
      if (tree.files.length > 0) {
        const f = tree.files[Math.floor(rnd() * tree.files.length)]!;
        const paths = rnd() < 0.5 ? [tree.dir, join(tree.dir, f)] : [join(tree.dir, f), tree.dir];
        const withFile = collectSessionMaterials(paths, lim);
        expect(withFile.materials.filter((m) => m.text === `${seed}:${f}`).length, `${where}: явный ${f}`).toBe(1);
      }
      // returning excludedPath removes exactly that entry, the others stay; returned whole in the snapshot
      if (tops.length > 0) {
        returnedCases++;
        const back = tops[Math.floor(rnd() * tops.length)]!;
        const withBack = collectSessionMaterials([tree.dir], { ...lim, include: [back] });
        expect(withBack.skipped.filter((s) => s.excludedPath !== undefined).map((s) => s.excludedPath), where).toEqual(tops.filter((t) => t !== back));
        const under = (f: string) => join(tree.dir, f) === back || join(tree.dir, f).startsWith(`${back}/`);
        expect(names(withBack.workspace), where).toEqual(tree.files.filter((f) => !isIgnored(f) || under(f)).map((f) => `t/${f}`).sort());
      }
    });
    expect(returnedCases).toBeGreaterThan(SEEDS / 4);
  }, 120_000);
});

describe("Distinguishable names of same-named folders", () => {
  const dir = (...parts: string[]) => {
    const d = join(root, ...parts);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const put = (d: string, name: string, text: string) => {
    mkdirSync(join(d, name, ".."), { recursive: true });
    writeFileSync(join(d, name), text);
  };

  it("same-named folders get distinguishable names, and so do skipped ones", () => {
    const a = dir("a", "language");
    const b = dir("b", "language");
    put(a, "check.ts", "A");
    put(b, "check.ts", "B");
    put(a, ".hidden", "x");
    put(b, ".hidden", "x");
    const set = collectMaterials([a, b], opts);
    expect(set.materials.map((m) => m.name)).toEqual(["language/check.ts", "language (2)/check.ts"]);
    expect(set.skipped.map((s) => s.name)).toEqual(["language/.hidden", "language (2)/.hidden"]);
  });

  it("excluded by rules: name with a suffix, excludedPath — its own absolute path", () => {
    const a = dir("a", "proj");
    const b = dir("b", "proj");
    for (const d of [a, b]) {
      put(d, ".gitignore", "out/\n");
      put(d, "out/main.js", "x");
    }
    const set = collectMaterials([a, b], opts);
    expect(set.skipped.filter((s) => s.excludedPath !== undefined).map((s) => [s.name, s.excludedPath])).toEqual([
      ["proj/out/", join(a, "out")],
      ["proj (2)/out/", join(b, "out")],
    ]);
  });

  it("case matters: Docs and docs", () => {
    const a = dir("a", "Docs");
    const b = dir("b", "docs");
    put(a, "readme.md", "A");
    put(b, "readme.md", "B");
    expect(collectMaterials([a, b], opts).materials.map((m) => m.name)).toEqual(["Docs/readme.md", "docs (2)/readme.md"]);
  });

  it("the original name of another folder is reserved", () => {
    const a = dir("a", "proj");
    const b = dir("b", "proj");
    const c = dir("c", "proj (2)");
    expect([...attachedFolderPrefixes([a, b, c]).values()]).toEqual(["proj", "proj (3)", "proj (2)"]);
  });

  it("an explicit file from the second folder is counted once and always included", () => {
    const a = dir("a", "language");
    const b = dir("b", "language");
    put(a, "check.ts", "A".repeat(10));
    put(b, "check.ts", "B".repeat(10));
    const set = collectSessionMaterials([a, b, join(b, "check.ts")], { ...opts, materialsChars: 15 });
    expect(set.materials.map((m) => m.name)).toEqual(["language (2)/check.ts"]);
    expect(set.left.map((l) => l.name)).toEqual(["language/check.ts"]);
  });

  it("folders without a same-name pair keep their names", () => {
    const a = dir("a", "proj");
    const b = dir("b", "other");
    put(a, "x.md", "A");
    put(b, "y.md", "B");
    expect(collectMaterials([a, b], opts).materials.map((m) => m.name)).toEqual(["proj/x.md", "other/y.md"]);
  });
});

describe("Folder snapshot: explicit file before the folder", () => {
  const o = (materialsChars = 10_000): CollectOptions => ({ materialsChars, materialsIgnore: ["node_modules", "dist"] });
  const fixture = () => {
    put("proj/README.md", "readme");
    const a = put("proj/src/a.ts", "code");
    return { a, dir: join(root, "proj") };
  };

  it("an explicit file before and after the folder gives one snapshot, the same names and the same size", () => {
    const { a, dir } = fixture();
    const before = collectSessionMaterials([a, dir], o());
    const after = collectSessionMaterials([dir, a], o());
    expect(before.workspace.map((f) => f.name)).toEqual(["proj/README.md", "proj/src/a.ts"]);
    expect(before.workspace).toEqual(after.workspace);
    for (const r of [before, after]) expect(r.materials.filter((m) => m.name.endsWith("a.ts")).map((m) => m.name)).toEqual(["proj/src/a.ts"]);
    expect([...before.materials.map((m) => m.name)].sort()).toEqual([...after.materials.map((m) => m.name)].sort());
    expect(before.materials.reduce((s, m) => s + m.chars, 0)).toBe(after.materials.reduce((s, m) => s + m.chars, 0));
  });

  it("a hidden explicit file before the folder stays a material under its own name and is not in the snapshot", () => {
    const { dir } = fixture();
    const h = put("proj/.hidden.ts", "hid");
    const r = collectSessionMaterials([h, dir], o());
    expect(r.materials.filter((m) => m.name === ".hidden.ts")).toHaveLength(1);
    expect(r.workspace.map((f) => f.name)).toEqual(["proj/README.md", "proj/src/a.ts"]);
  });

  it("a file outside the folder keeps its place: first it, then the folder files, ids m1..", () => {
    const { dir } = fixture();
    const note = put("note.md", "note");
    const r = collectSessionMaterials([note, dir], o());
    expect(r.materials.map((m) => m.name)).toEqual(["note.md", "proj/README.md", "proj/src/a.ts"]);
    expect(r.materials.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });
});
