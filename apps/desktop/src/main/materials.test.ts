import { afterAll, afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import { mkdirSync, mkdtempSync, existsSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaterialsError, collectMaterials, materialFromText, selectMaterials, sha256Of, verifyMaterials } from "@model-council/core";
import { makeEncryptedPdf, makeMalformedPdf, makePdf } from "../../../../packages/core/src/pdf/fixture.ts";
import type { UrlResponse, UrlTransport } from "@model-council/core";
import { setupMain } from "../shared/messages/setup-main.ts";
import { DRAFT_FACTOR, MaterialsDraftError, createMaterialsDraft } from "./materials.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "council-materials-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(root, `t${++n}`);
const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const draft = (materialsChars = 1000) => {
  const lim = { materialsChars, materialsIgnore: ["node_modules", "dist", "build"] };
  return { d: createMaterialsDraft({ limits: () => lim }), lim };
};
const noError = <T extends { error: unknown }>(v: T) => ({ ...v, error: undefined });

describe("materials draft", () => {
  it("file and folder: names, sizes, ids, total; the view has no texts, sha256 or paths", () => {
    const t = fresh();
    const a = put(join(t, "a.txt"), "альфа");
    const folder = join(t, "folder");
    put(join(folder, "b.txt"), "бета!!");
    put(join(folder, "c.txt"), "г");
    const { d } = draft();
    const v = d.attach([a, folder]);
    expect(v.items).toEqual([{ id: "m1", name: "a.txt", chars: 5, source: null }, { id: "m2", name: "folder/b.txt", chars: 6, source: null }, { id: "m3", name: "folder/c.txt", chars: 1, source: null }]);
    expect(v).toMatchObject({ chars: 12, limit: 1000, over: 0, error: null });
    const json = JSON.stringify(v);
    for (const bad of [t, "альфа", "бета", "sha256"]) expect(json).not.toContain(bad);
  });

  it("skips: node_modules, hidden, a binary file", () => {
    const t = fresh();
    const folder = join(t, "proj");
    put(join(folder, "ok.txt"), "текст");
    put(join(folder, "node_modules", "x.txt"), "x");
    put(join(folder, ".cache", "y.txt"), "y");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "bin.dat"), Buffer.from([0, 1, 2, 0, 255, 254]));
    const { d } = draft();
    const v = d.attach([folder]);
    expect(v.items.map((i) => i.name)).toEqual(["proj/ok.txt"]);
    const reasons = Object.fromEntries(v.skipped.map((s) => [s.name, s.reason]));
    expect(reasons["proj/node_modules"]).toBe("в списке игнорирования");
    expect(reasons["proj/.cache"]).toBe("скрытое имя");
    expect(reasons["proj/bin.dat"]).toBe("нетекстовый файл");
  });

  it(".env: an error with the name, without path and content, the list unchanged", () => {
    const t = fresh();
    const a = put(join(t, "a.txt"), "альфа");
    const env = put(join(t, ".env"), "SECRET=КЛЮЧ-123");
    const { d } = draft();
    const before = d.attach([a]);
    const v = d.attach([env]);
    expect(v.error).toContain(".env");
    expect(v.error).not.toContain(t);
    expect(v.error).not.toContain("КЛЮЧ-123");
    expect(noError(v)).toEqual(noError(before));
  });

  it("re-adding a file and a file from an added folder does not duplicate the material", () => {
    const t = fresh();
    const folder = join(t, "folder");
    const b = put(join(folder, "b.txt"), "бета");
    const { d } = draft();
    d.attach([folder]);
    d.attach([b]);
    const v = d.attach([folder, b]);
    expect(v.items).toEqual([{ id: "m1", name: "folder/b.txt", chars: 4, source: null }]);
    expect(v.chars).toBe(4);
  });

  it("remove: renumbering, the file is intact, does not come back; take passes verifyMaterials", () => {
    const t = fresh();
    const [a, b, c] = ["a", "b", "c"].map((x) => put(join(t, `${x}.txt`), `текст ${x}`));
    const { d, lim } = draft();
    d.attach([a!, b!, c!]);
    const v = d.remove("m2");
    expect(v.items.map((i) => [i.id, i.name])).toEqual([["m1", "a.txt"], ["m2", "c.txt"]]);
    expect(existsSync(b!)).toBe(true);
    const e = put(join(t, "e.txt"), "ещё");
    const v2 = d.attach([e]);
    expect(v2.items.map((i) => i.name)).toEqual(["a.txt", "c.txt", "e.txt"]);
    const set = d.take();
    expect(verifyMaterials(set, lim.materialsChars)).toEqual([]);
    expect(set.map((m) => m.name)).toEqual(v2.items.map((i) => i.name));
    expect(d.remove("m99")).toEqual(v2);
    const afterB = d.attach([b!]);
    expect(afterB.items.map((i) => i.name)).toEqual(["a.txt", "b.txt", "c.txt", "e.txt"]);
    expect(afterB.error).toBeNull();
    expect(afterB.chars).toBe(afterB.items.reduce((s, i) => s + i.chars, 0));
  });

  it("deleted file: comes back only by adding the file itself explicitly", () => {
    const t = fresh();
    const [a, b, c] = ["a", "b", "c"].map((x) => put(join(t, `${x}.txt`), `текст ${x}`));
    const { d } = draft();
    d.attach([a!, b!]);
    d.remove("m2");
    expect(d.attach([c!]).items.map((i) => i.name)).toEqual(["a.txt", "c.txt"]);
    expect(d.refresh().items.map((i) => i.name)).toEqual(["a.txt", "c.txt"]);
    expect(d.attach([b!]).items.map((i) => i.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
    const again = d.remove("m2");
    expect(again.items.map((i) => i.name)).toEqual(["a.txt", "c.txt"]);
    expect(d.attach([c!]).items.map((i) => i.name)).toEqual(["a.txt", "c.txt"]);
  });

  it("deleted file of a folder: re-adding the folder does not bring it back, adding the file itself does", () => {
    const t = fresh();
    const folder = join(t, "folder");
    const x = put(join(folder, "x.txt"), "икс");
    put(join(folder, "y.txt"), "игрек");
    const { d } = draft();
    d.attach([folder]);
    d.remove("m1");
    expect(d.attach([folder]).items.map((i) => i.name)).toEqual(["folder/y.txt"]);
    const v = d.attach([x]);
    expect(v.items.map((i) => i.name).sort()).toEqual(["folder/x.txt", "folder/y.txt"]);
    expect(v.chars).toBe(8);
    expect(v.error).toBeNull();
  });

  it("same-named files of different folders: restoring one does not restore the other", () => {
    const t = fresh();
    const p = put(join(t, "p", "same.txt"), "первый");
    const q = put(join(t, "q", "same.txt"), "второй!");
    const { d } = draft();
    d.attach([p, q]);
    d.remove("m1");
    d.remove("m1");
    const v = d.attach([q]);
    expect(v.items.map((i) => i.chars)).toEqual([7]);
  });

  it("restoring a file on an add refusal does not change the deleted", () => {
    const t = fresh();
    const a = put(join(t, "a.txt"), "x".repeat(30));
    const b = put(join(t, "b.txt"), "y".repeat(30));
    const big = put(join(t, "big.txt"), "z".repeat(200));
    const { d } = draft(10);
    d.attach([a, b]);
    d.remove("m2");
    expect(d.attach([b, big]).error).not.toBeNull();
    expect(d.take().map((m) => m.name)).toEqual(["a.txt"]);
    expect(d.attach([a]).items.map((i) => i.name)).toEqual(["a.txt"]);
  });

  it("session limit exceeded within the boundary: the list is visible, over is computed", () => {
    const t = fresh();
    const files = [1, 2, 3, 4, 5].map((i) => put(join(t, `f${i}.txt`), "x".repeat(10)));
    const { d } = draft(10);
    const v = d.attach(files);
    expect(v).toMatchObject({ chars: 50, limit: 10, over: 40, error: null });
    expect(v.items).toHaveLength(5);
  });

  it("add boundary: refusal as a whole, the previous state", () => {
    const t = fresh();
    const a = put(join(t, "a.txt"), "x".repeat(30));
    const b = put(join(t, "b.txt"), "y".repeat(30));
    const big = put(join(t, "big.txt"), "z".repeat(60));
    const { d } = draft(10);
    const before = d.attach([a, b]);
    const v = d.attach([big]);
    expect(DRAFT_FACTOR).toBe(10);
    expect(v.error).toBe("Не добавлено: объём 120 знаков больше границы 100 (10 × лимит сессии 10)");
    expect(noError(v)).toEqual(noError(before));
    expect(d.take().map((m) => m.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("nonexistent, relative path and a non-string: refusal with a reason, the draft unchanged", () => {
    const t = fresh();
    const a = put(join(t, "a.txt"), "альфа");
    const { d } = draft();
    const before = d.attach([a]);
    const miss = d.attach([join(t, "нет.txt")]);
    expect(miss.error).toContain("путь не найден");
    expect(miss.error).toContain("нет.txt");
    expect(miss.error).not.toContain(t);
    expect(d.attach(["rel/a.txt"]).error).toBe("Путь должен быть абсолютным");
    expect(d.attach([""]).error).toBe("Путь должен быть непустой строкой");
    const v = d.attach([42 as unknown as string]);
    expect(v.error).toBe("Путь должен быть непустой строкой");
    expect(noError(v)).toEqual(noError(before));
  });

  const canLink = (() => {
    try {
      const t = fresh();
      mkdirSync(join(t, "real"), { recursive: true });
      symlinkSync(join(t, "real"), join(t, "link"));
      return true;
    } catch {
      return false;
    }
  })();
  // without rights to create links (e.g. Windows without developer mode) there is nothing to check
  it.skipIf(!canLink)("символическая ссылка в пути: в ошибке нет абсолютных путей", () => {
    const t = fresh();
    put(join(t, "real", "a.txt"), "альфа");
    symlinkSync(join(t, "real"), join(t, "link"));
    const { d } = draft();
    const v = d.attach([join(t, "link", "a.txt")]);
    expect(v.error).toContain("символическую ссылку");
    expect(v.error).toContain("link");
    expect(v.error).not.toContain(t);
    expect(v.items).toEqual([]);
  });

  it("clear and a limit change without re-adding", () => {
    const t = fresh();
    const a = put(join(t, "a.txt"), "x".repeat(30));
    let materialsChars = 100;
    const d = createMaterialsDraft({ limits: () => ({ materialsChars, materialsIgnore: [] }) });
    expect(d.attach([a])).toMatchObject({ limit: 100, over: 0 });
    materialsChars = 10;
    expect(d.view()).toMatchObject({ limit: 10, over: 20 });
    expect(d.clear()).toEqual({ items: [], skipped: [], ignored: [], left: [], error: null, chars: 0, limit: 10, over: 0, folder: null, stamp: expect.any(String) });
    expect(d.take()).toEqual([]);
  });
});

describe("materials draft: carried records", () => {
  const mat = (name: string, text: string) => materialFromText("x", name, text);
  const names = (v: { items: { name: string }[] }) => v.items.map((i) => i.name);

  it("carry: consecutive ids, names and sizes, no texts or sha256; take passes verifyMaterials", () => {
    const { d, lim } = draft();
    const v = d.carry([mat("a.txt", "секрет-альфа"), mat("b.txt", "бета")], []);
    expect(v.items).toEqual([{ id: "m1", name: "a.txt", chars: 12, source: null }, { id: "m2", name: "b.txt", chars: 4, source: null }]);
    expect(v).toMatchObject({ chars: 16, error: null, over: 0 });
    const json = JSON.stringify(v);
    for (const bad of ["секрет", "sha256"]) expect(json).not.toContain(bad);
    expect(verifyMaterials(d.take(), lim.materialsChars)).toEqual([]);
  });

  it("carry with remarks: error — lines joined by newlines", () => {
    const { d } = draft();
    expect(d.carry([mat("a.txt", "a")], ["один", "два"]).error).toBe("один\nдва");
  });

  it("carry replaces the draft: attached, previous carried and deleted ones are forgotten", () => {
    const t = fresh();
    const a = put(join(t, "a.txt"), "альфа");
    const { d } = draft();
    d.attach([a]);
    d.remove("m1");
    d.carry([mat("p.txt", "первый")], []);
    const v = d.carry([mat("q.txt", "второй"), mat("a.txt", "альфа")], []);
    expect(names(v)).toEqual(["q.txt", "a.txt"]);
    expect(names(d.attach([a]))).toEqual(["q.txt", "a.txt"]);
  });

  it("a duplicate by name and hash collapses", () => {
    const { d } = draft();
    const v = d.carry([mat("a.txt", "один"), mat("a.txt", "один"), mat("a.txt", "другой")], []);
    expect(v.items.map((i) => [i.id, i.chars])).toEqual([["m1", 4], ["m2", 6]]);
  });

  it("attach after carry: carried ones first, consecutive ids, a matching file is not duplicated", () => {
    const t = fresh();
    const same = put(join(t, "same.txt"), "тот же");
    const other = put(join(t, "other.txt"), "новый");
    const { d } = draft();
    d.carry([mat("z.txt", "зет"), mat("same.txt", "тот же")], []);
    const v = d.attach([other, same]);
    expect(v.items.map((i) => [i.id, i.name])).toEqual([["m1", "z.txt"], ["m2", "same.txt"], ["m3", "other.txt"]]);
  });

  it("remove of a carried one: it disappears, the rest are renumbered, attach does not bring it back", () => {
    const t = fresh();
    const extra = put(join(t, "e.txt"), "ещё");
    const { d, lim } = draft();
    d.carry([mat("a.txt", "а"), mat("b.txt", "б"), mat("c.txt", "в")], []);
    const v = d.remove("m2");
    expect(v.items.map((i) => [i.id, i.name])).toEqual([["m1", "a.txt"], ["m2", "c.txt"]]);
    expect(names(d.attach([extra]))).toEqual(["a.txt", "c.txt", "e.txt"]);
    expect(verifyMaterials(d.take(), lim.materialsChars)).toEqual([]);
  });

  it("limit exceeded by carried ones: the list is visible, over > 0, error null", () => {
    const { d } = draft(10);
    const v = d.carry([mat("a.txt", "x".repeat(30))], []);
    expect(v).toMatchObject({ chars: 30, over: 20, error: null });
    expect(v.items).toHaveLength(1);
  });

  it("rejected add after carry: carried ones and the total are intact", () => {
    const t = fresh();
    const big = put(join(t, "big.txt"), "z".repeat(200));
    const { d } = draft(10);
    const before = d.carry([mat("a.txt", "x".repeat(30))], []);
    const miss = d.attach([join(t, "нет.txt")]);
    expect(miss.error).toContain("путь не найден");
    expect(noError(miss)).toEqual(noError(before));
    const over = d.attach([big]);
    expect(over.error).toContain("Не добавлено");
    expect(noError(over)).toEqual(noError(before));
    expect(d.take().map((m) => m.name)).toEqual(["a.txt"]);
  });

  it("clear after carry — an empty view", () => {
    const { d } = draft();
    d.carry([mat("a.txt", "а")], ["замечание"]);
    expect(d.clear()).toEqual({ items: [], skipped: [], ignored: [], left: [], error: null, chars: 0, limit: 1000, over: 0, folder: null, stamp: expect.any(String) });
    expect(d.take()).toEqual([]);
  });
});

describe("materials draft: selection under the limit", () => {
  const SKIP_DOC = "не описание — из папки больше лимита берутся только описания";
  const names = (v: { items: { name: string }[] }) => v.items.map((i) => i.name);
  const proj = () => {
    const t = fresh();
    const dir = join(t, "proj");
    put(join(dir, "README.md"), "r".repeat(30));
    put(join(dir, "docs", "guide.md"), "g".repeat(30));
    put(join(dir, "docs", "deep", "x.md"), "x".repeat(30));
    put(join(dir, "src", "a.ts"), "a".repeat(30));
    return dir;
  };
  const leftOver = [{ name: "proj/docs/deep/x.md", reason: "не поместился в лимит — 30 знаков" }, { name: "proj/src/a.ts", reason: SKIP_DOC }];

  it("folder with .env: not a refusal, .env in skipped, no content", () => {
    const t = fresh();
    const dir = join(t, "envdir");
    put(join(dir, ".env"), "SECRET=КЛЮЧ-123");
    put(join(dir, "a.txt"), "текст");
    const { d } = draft();
    const v = d.attach([dir]);
    expect(v.error).toBeNull();
    expect(names(v)).toEqual(["envdir/a.txt"]);
    expect(v.skipped).toContainEqual({ name: "envdir/.env", reason: "файл окружения — защита секретов" });
    expect(JSON.stringify(v)).not.toContain("КЛЮЧ-123");
  });

  it("folder larger than the limit: only descriptions by depth, the rest in left", () => {
    const { d } = draft(70);
    const v = d.attach([proj()]);
    expect(names(v)).toEqual(["proj/README.md", "proj/docs/guide.md"]);
    expect(v).toMatchObject({ over: 0, error: null });
    expect(v.left).toEqual(leftOver);
  });

  it("folder fits entirely: all files, left is empty", () => {
    const { d } = draft(1000);
    const v = d.attach([proj()]);
    expect(names(v)).toEqual(["proj/README.md", "proj/docs/deep/x.md", "proj/docs/guide.md", "proj/src/a.ts"]);
    expect(v.left).toEqual([]);
  });

  it("folder without descriptions larger than the limit: shallower ones are taken", () => {
    const t = fresh();
    const dir = join(t, "code");
    put(join(dir, "a.ts"), "a".repeat(30));
    put(join(dir, "deep", "b.ts"), "b".repeat(30));
    put(join(dir, "z.ts"), "z".repeat(30));
    const { d } = draft(60);
    const v = d.attach([dir]);
    expect(names(v)).toEqual(["code/a.ts", "code/z.ts"]);
    expect(v.left).toEqual([{ name: "code/deep/b.ts", reason: "не поместился в лимит — 30 знаков" }]);
  });

  it("the walk continues after one that did not fit", () => {
    const t = fresh();
    const dir = join(t, "p");
    put(join(dir, "a.md"), "a".repeat(80));
    put(join(dir, "b.md"), "b".repeat(20));
    put(join(dir, "c.ts"), "c".repeat(500));
    const { d } = draft(50);
    const v = d.attach([dir]);
    expect(names(v)).toEqual(["p/b.md"]);
    expect(v.left).toEqual([{ name: "p/a.md", reason: "не поместился в лимит — 80 знаков" }, { name: "p/c.ts", reason: SKIP_DOC }]);
  });

  it("an explicit file from a folder is always included", () => {
    const dir = proj();
    const { d } = draft(70);
    d.attach([dir]);
    const v = d.attach([join(dir, "src", "a.ts")]);
    expect(names(v)).toContain("proj/src/a.ts");
    expect(v.left.map((l) => l.name)).not.toContain("proj/src/a.ts");
  });

  it("remove recomputes the selection: the next one takes the place, the deleted one does not come back", () => {
    const { d } = draft(70);
    d.attach([proj()]);
    const v = d.remove("m1");
    expect(names(v)).toEqual(["proj/docs/deep/x.md", "proj/docs/guide.md"]);
    expect(v.left.map((l) => l.name)).toEqual(["proj/src/a.ts"]);
  });

  it("a limit change recomputes the composition", () => {
    const { d, lim } = draft(70);
    d.attach([proj()]);
    lim.materialsChars = 1000;
    let v = d.view();
    expect(v.items).toHaveLength(4);
    expect(v.left).toEqual([]);
    lim.materialsChars = 35;
    v = d.view();
    expect(names(v)).toEqual(["proj/README.md"]);
    expect(v.left.map((l) => l.name)).toEqual(["proj/docs/deep/x.md", "proj/docs/guide.md", "proj/src/a.ts"]);
  });

  it("boundary: a large folder is added, a large explicit file is rejected", () => {
    const t = fresh();
    const dir = join(t, "big");
    for (let i = 0; i < 5; i++) put(join(dir, `f${i}.md`), "x".repeat(30));
    const { d } = draft(10);
    const v = d.attach([dir]);
    expect(v.error).toBeNull();
    expect(v.left.length).toBe(5);
    const big = put(join(t, "big.txt"), "z".repeat(200));
    expect(d.attach([big]).error).toContain("Не добавлено");
  });

  it("take: exactly the materials from items, passes verifyMaterials", () => {
    const { d, lim } = draft(70);
    const v = d.attach([proj()]);
    const set = d.take();
    expect(set.map((m) => m.name)).toEqual(names(v));
    expect(verifyMaterials(set, lim.materialsChars)).toEqual([]);
  });

  describe("folder snapshot", () => {
    it("folder larger than the limit: all files in the snapshot, take — only the selection", () => {
      const { d } = draft(70);
      const v = d.attach([proj()]);
      expect(d.workspace().map((f) => [f.name, f.text.length])).toEqual([
        ["proj/README.md", 30], ["proj/docs/deep/x.md", 30], ["proj/docs/guide.md", 30], ["proj/src/a.ts", 30],
      ]);
      expect(d.workspace().find((f) => f.name === "proj/README.md")!.text).toBe("r".repeat(30));
      expect(v.folder).toEqual({ files: 4, chars: 120 });
      expect(d.take().map((m) => m.name)).toEqual(["proj/README.md", "proj/docs/guide.md"]);
    });

    it("explicit files only: the snapshot is empty, folder null", () => {
      const t = fresh();
      const { d } = draft();
      const v = d.attach([put(join(t, "a.txt"), "альфа")]);
      expect(d.workspace()).toEqual([]);
      expect(v.folder).toBeNull();
    });

    it("remove of a folder file: it disappears from the snapshot", () => {
      const { d } = draft();
      d.attach([proj()]);
      const v = d.remove("m1");
      expect(d.workspace().map((f) => f.name)).not.toContain("proj/README.md");
      expect(v.folder?.files).toBe(3);
    });

    it("an explicit file from a folder: once in the snapshot", () => {
      const dir = proj();
      const { d } = draft(70);
      d.attach([dir]);
      d.attach([join(dir, "src", "a.ts")]);
      expect(d.workspace().filter((f) => f.name === "proj/src/a.ts")).toHaveLength(1);
      expect(d.workspace()).toHaveLength(4);
    });

    it("carry and clear: the snapshot is empty", () => {
      const { d } = draft();
      d.attach([proj()]);
      const v = d.carry([materialFromText("x", "p.txt", "п")], []);
      expect(d.workspace()).toEqual([]);
      expect(v.folder).toBeNull();
      d.attach([proj()]);
      expect(d.clear().folder).toBeNull();
      expect(d.workspace()).toEqual([]);
    });

    it("changing the result does not affect the draft", () => {
      const { d } = draft(70);
      d.attach([proj()]);
      const ws = d.workspace();
      ws[0]!.text = "изменено";
      expect(d.workspace()[0]!.text).toBe("r".repeat(30));
      expect(d.take()[0]!.text).toBe("r".repeat(30));
    });

    it(".env inside a folder does not get into the snapshot", () => {
      const t = fresh();
      const dir = join(t, "envdir");
      put(join(dir, ".env"), "SECRET=КЛЮЧ-123");
      put(join(dir, "a.txt"), "текст");
      const { d } = draft();
      d.attach([dir]);
      expect(d.workspace().map((f) => f.name)).toEqual(["envdir/a.txt"]);
      expect(JSON.stringify(d.workspace())).not.toContain("КЛЮЧ-123");
    });
  });

  it("noAsar is set for the duration of collect and restored, including on an exception", () => {
    const proc = process as unknown as { noAsar?: boolean };
    const before = proc.noAsar;
    const t = fresh();
    const a = put(join(t, "a.txt"), "а");
    let seen: unknown;
    const ok = createMaterialsDraft({
      limits: () => ({ materialsChars: 1000, materialsIgnore: [] }),
      collect: () => {
        seen = proc.noAsar;
        return { materials: [], skipped: [] };
      },
    });
    ok.attach([a]);
    expect(seen).toBe(true);
    expect(proc.noAsar).toBe(before);
    const bad = createMaterialsDraft({
      limits: () => ({ materialsChars: 1000, materialsIgnore: [] }),
      collect: () => {
        seen = proc.noAsar;
        throw new MaterialsError(["x"]);
      },
    });
    expect(bad.attach([a]).error).toBe("x");
    expect(seen).toBe(true);
    expect(proc.noAsar).toBe(before);
  });
});

describe("materials draft: stamp, refresh, snapshot", () => {
  it("the stamp changes after attach, remove, carry, clear and a limit change", () => {
    const t = fresh();
    const a = put(join(t, "a.txt"), "альфа");
    const b = put(join(t, "b.txt"), "бета");
    const lim = { materialsChars: 1000, materialsIgnore: [] as string[] };
    const d = createMaterialsDraft({ limits: () => lim });
    const seen = [d.stamp()];
    const step = (f: () => unknown) => { f(); const s = d.stamp(); expect(seen).not.toContain(s); seen.push(s); };
    step(() => d.attach([a, b]));
    step(() => d.remove("m1"));
    step(() => d.carry([materialFromText("m1", "перенос", "текст")], []));
    step(() => d.clear());
    step(() => { lim.materialsChars = 2000; });
    step(() => { lim.materialsIgnore = ["x"]; });
  });

  it("the stamp does not change after view, take, workspace, snapshot, a rejected attach, remove of an unknown id", () => {
    const t = fresh();
    const { d } = draft();
    d.attach([put(join(t, "a.txt"), "альфа")]);
    const s = d.stamp();
    d.view(); d.take(); d.workspace(); d.snapshot();
    d.attach(["относительный"]);
    d.attach([join(t, "нет-такого")]);
    d.remove("m99");
    expect(d.stamp()).toBe(s);
    expect(d.view().stamp).toBe(s);
  });

  it("stamps of two drafts with the same composition differ", () => {
    expect(draft().d.stamp()).not.toBe(draft().d.stamp());
  });

  it("refresh rereads the source: before it the old text, after it the new, the stamp changed", () => {
    const t = fresh();
    const a = put(join(t, "a.txt"), "старый");
    const { d } = draft();
    d.attach([a]);
    const s = d.stamp();
    writeFileSync(a, "новый текст");
    expect(d.take()[0]!.text).toBe("старый");
    expect(d.refresh().items[0]!.chars).toBe("новый текст".length);
    expect(d.take()[0]!.text).toBe("новый текст");
    expect(d.stamp()).not.toBe(s);
  });

  it("refresh without roots changes nothing", () => {
    const { d } = draft();
    const s = d.stamp();
    expect(d.refresh()).toEqual(d.view());
    expect(d.stamp()).toBe(s);
  });

  it("failed refresh: MaterialsDraftError without an absolute path, the state unchanged", () => {
    const t = fresh();
    const a = put(join(t, "a.txt"), "альфа");
    const { d } = draft();
    d.attach([a]);
    const before = d.view();
    rmSync(a);
    let err: unknown;
    try { d.refresh(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(MaterialsDraftError);
    expect((err as Error).message).not.toContain(root);
    expect(d.view()).toEqual(before);
    expect(d.take().map((m) => m.text)).toEqual(["альфа"]);
  });

  it("snapshot agrees with take, workspace and view, including with a folder larger than the limit", () => {
    const t = fresh();
    const folder = join(t, "f");
    put(join(folder, "README.md"), "коротко");
    put(join(folder, "src/big.ts"), "x".repeat(500));
    const { d } = draft(100);
    const v = d.attach([folder]);
    const snap = d.snapshot();
    expect(snap.materials).toEqual(d.take());
    expect(snap.workspace).toEqual(d.workspace());
    expect(snap.skipped).toEqual(v.skipped);
    expect(snap.left).toEqual(v.left);
    expect(snap.materialsChars).toBe(100);
    expect(snap.stamp).toBe(d.stamp());
    expect(snap.workspace.map((f) => f.name)).toContain("f/src/big.ts");
    expect(snap.materials.map((m) => m.name)).not.toContain("f/src/big.ts");
    expect(snap.left.map((l) => l.name)).toContain("f/src/big.ts");
  });
});

describe("materials draft: PDF", () => {
  it("encrypted PDF after a text one: an error with a reason, the previous material stays in place", () => {
    const t = fresh();
    const a = put(join(t, "a.txt"), "альфа");
    const enc = join(t, "enc.pdf");
    writeFileSync(enc, makeEncryptedPdf());
    const { d } = draft();
    d.attach([a]);
    const v = d.attach([enc]);
    expect(v.error).toContain("PDF зашифрован");
    expect(v.items.map((i) => i.name)).toEqual(["a.txt"]);
  }, 20_000);

  it("folder with README and a corrupted PDF: README in the list, the PDF in skipped", () => {
    const t = fresh();
    const folder = join(t, "f");
    put(join(folder, "README.md"), "коротко");
    writeFileSync(join(folder, "bad.pdf"), makeMalformedPdf());
    const { d } = draft();
    const v = d.attach([folder]);
    expect(v.items.map((i) => i.name)).toEqual(["f/README.md"]);
    expect(v.skipped).toContainEqual({ name: "f/bad.pdf", reason: "PDF повреждён" });
  }, 20_000);

  it("valid PDF: chars equals the length of the extracted text", () => {
    const t = fresh();
    const f = join(t, "ok.pdf");
    mkdirSync(t, { recursive: true });
    writeFileSync(f, makePdf(["Первая страница", "Вторая страница"]));
    const v = draft().d.attach([f]);
    expect(v.items).toEqual([{ id: "m1", name: "ok.pdf", chars: "Первая страница\n\nВторая страница".length, source: null }]);
  }, 20_000);
});

describe("materials: language", () => {
  afterEach(() => setProcessLanguage("ru"));
  const cyr = /[А-Яа-яЁё]/;

  it("draft boundary at en: the same numbers, the draft does not change; after switching to ru the previous wording", () => {
    const t = fresh();
    const a = put(join(t, "a.txt"), "x".repeat(30));
    const b = put(join(t, "b.txt"), "y".repeat(30));
    const big = put(join(t, "big.txt"), "z".repeat(60));
    const { d } = draft(10);
    const before = d.attach([a, b]);
    setProcessLanguage("en");
    const v = d.attach([big]);
    expect(v.error).toBe("Not added: 120 characters exceed the bound of 100 (10 × session limit 10)");
    expect(noError(v)).toEqual(noError(before));
    setProcessLanguage("ru");
    expect(d.attach([big]).error).toBe("Не добавлено: объём 120 знаков больше границы 100 (10 × лимит сессии 10)");
    expect(d.take().map((m) => m.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("path not a string and not absolute in both languages, the draft unchanged", () => {
    const a = put(join(fresh(), "a.txt"), "abc");
    const { d } = draft();
    const before = d.attach([a]);
    setProcessLanguage("en");
    expect(d.attach([""]).error).toBe("The path must be a non-empty string");
    expect(d.attach(["rel/x.txt"]).error).toBe("The path must be absolute");
    setProcessLanguage("ru");
    expect(d.attach([""]).error).toBe("Путь должен быть непустой строкой");
    expect(d.attach(["rel/x.txt"]).error).toBe("Путь должен быть абсолютным");
    expect(noError(d.view())).toEqual(noError(before));
  });

  it("skipped and not included reasons from the core go into the view verbatim at en and at ru", () => {
    const t = fresh();
    const dir = join(t, "proj");
    put(join(dir, ".env"), "SECRET=1");
    put(join(dir, "README.md"), "r".repeat(30));
    put(join(dir, "docs", "deep", "x.md"), "x".repeat(30));
    put(join(dir, "src", "a.ts"), "a".repeat(30));
    for (const lang of ["en", "ru"] as const) {
      setProcessLanguage(lang);
      const set = collectMaterials([dir], { materialsChars: Number.MAX_SAFE_INTEGER, materialsIgnore: [] });
      const expectedLeft = selectMaterials(set.materials, [dir], 70).left.map((l) => l.reason);
      const { d } = draft(70);
      const v = d.attach([dir]);
      expect(v.skipped.map((s) => s.reason)).toEqual(set.skipped.map((s) => s.reason));
      expect(v.skipped.length).toBeGreaterThan(0);
      expect(v.left.map((l) => l.reason)).toEqual(expectedLeft);
      expect(v.left.length).toBeGreaterThan(0);
      if (lang === "en") expect(JSON.stringify([...v.skipped.map((s) => s.reason), ...v.left.map((l) => l.reason)])).not.toMatch(cyr);
    }
  });
});

describe("excluded by .gitignore rules and include", () => {
  // the real core on a temporary folder: .gitignore with out/, a built directory out/main.js
  const proj = (t: string, name = "proj") => {
    const p = join(t, name);
    put(join(p, ".gitignore"), "out/\n");
    put(join(p, "src/a.txt"), "исходник");
    put(join(p, "out/main.js"), "собранный");
    put(join(p, "out/lib/util.js"), "утилита");
    return p;
  };
  const names = (v: { items: { name: string }[] }) => v.items.map((i) => i.name);
  const noStamp = <T extends { stamp: string }>(v: T) => ({ ...v, stamp: "" });

  it("excluded by a rule: in ignored with the rule from rule, not in skipped; the view has no absolute path", () => {
    const t = fresh();
    const { d } = draft();
    const v = d.attach([proj(t)]);
    expect(v.ignored).toEqual([{ id: "x1", name: "proj/out/", rule: "out/", returned: false }]);
    expect(v.skipped.map((s) => s.name)).not.toContain("proj/out/");
    expect(names(v)).toEqual(["proj/src/a.txt"]);
    expect(JSON.stringify(v)).not.toContain(t);
  });

  it("snapshot().skipped keeps excludedPath and rule, view().skipped does not", () => {
    const t = fresh();
    const p = proj(t);
    put(join(p, "node_modules/x.txt"), "x");
    const { d } = draft();
    d.attach([p]);
    const snap = d.snapshot().skipped;
    expect(snap.find((s) => s.name === "proj/out/")).toMatchObject({ excludedPath: join(p, "out"), rule: "out/" });
    expect(snap.find((s) => s.name === "proj/node_modules")?.excludedPath).toBeUndefined();
    expect(JSON.stringify(d.view().skipped)).not.toContain("excludedPath");
  });

  it("returnIgnored: files of the returned one in the set, workspace and folder; the row stays with returned: true", () => {
    const t = fresh();
    const { d } = draft();
    const before = d.attach([proj(t)]);
    const v = d.returnIgnored("x1");
    expect(names(v)).toEqual(["proj/out/lib/util.js", "proj/out/main.js", "proj/src/a.txt"]);
    expect(d.workspace().map((f) => f.name)).toContain("proj/out/main.js");
    expect(v.folder!.files).toBe(3);
    expect(v.ignored).toEqual([{ id: "x1", name: "proj/out/", rule: "out/", returned: true }]);
    expect(v.stamp).not.toBe(before.stamp);
    expect(d.snapshot().workspace.map((f) => f.name)).toContain("proj/out/main.js");
  });

  it("excludeIgnored: restores the original view; on a row that was not returned it changes nothing", () => {
    const t = fresh();
    const { d } = draft();
    const v0 = d.attach([proj(t)]);
    expect(d.excludeIgnored("x1")).toEqual(v0);
    d.returnIgnored("x1");
    const v2 = d.excludeIgnored("x1");
    expect(noStamp(v2)).toEqual(noStamp(v0));
    expect(v2.stamp).not.toBe(v0.stamp);
  });

  it("an unknown identifier and a repeated include change nothing (and the stamp is unchanged)", () => {
    const t = fresh();
    const { d } = draft();
    const v0 = d.attach([proj(t)]);
    expect(d.returnIgnored("x9")).toEqual(v0);
    expect(d.excludeIgnored("x9")).toEqual(v0);
    const v1 = d.returnIgnored("x1");
    expect(d.returnIgnored("x1")).toEqual(v1);
  });

  it("clear() and carry() reset the include", () => {
    const t = fresh();
    const { d } = draft();
    d.attach([proj(t)]);
    d.returnIgnored("x1");
    d.clear();
    expect(d.view().ignored).toEqual([]);
    expect(names(d.attach([proj(t)]))).toEqual(["proj/src/a.txt"]); // the include did not survive clear
    d.returnIgnored("x1");
    d.carry([], []);
    expect(d.view().ignored).toEqual([]);
    expect(names(d.attach([join(t, "proj")]))).toEqual(["proj/src/a.txt"]);
  });

  it("an explicit file from an excluded directory is not in ignored", () => {
    const t = fresh();
    const p = proj(t);
    const { d } = draft();
    const v = d.attach([join(p, "out/main.js")]);
    expect(names(v)).toEqual(["main.js"]);
    expect(v.ignored).toEqual([]);
  });

  it("two folders a/proj and b/proj: the path of the one whose row was pressed is returned", () => {
    const t = fresh();
    const a = proj(join(t, "a"));
    const b = proj(join(t, "b"));
    const { d } = draft();
    const v = d.attach([a, b]);
    // the names are distinguishable: the second folder gets a suffix; row order by name — "proj (2)/" before "proj/"
    expect(v.ignored.map((x) => x.name)).toEqual(["proj (2)/out/", "proj/out/"]);
    const w = d.returnIgnored("x1");
    expect(w.ignored.map((x) => x.returned)).toEqual([true, false]);
    expect(d.workspace().filter((f) => f.name.endsWith("/out/main.js")).map((f) => f.name)).toEqual(["proj (2)/out/main.js"]);
    expect(d.workspace().find((f) => f.name === "proj (2)/out/main.js")!.text).toBe("собранный");
    expect(JSON.stringify(w)).not.toContain(t);
    // the returned b does not prevent adding one more folder: rows are rebuilt, the include stayed in place
    const c = proj(join(t, "c"));
    expect(d.attach([c]).ignored.map((x) => [x.name, x.returned])).toEqual([["proj (2)/out/", true], ["proj (3)/out/", false], ["proj/out/", false]]);
  });

  it("core refusal on include (the rule disappeared): the reason is shown, the include is rolled back, excludeIgnored not needed", () => {
    const t = fresh();
    const p = proj(t);
    const { d } = draft();
    d.attach([p]);
    d.returnIgnored("x1");
    writeFileSync(join(p, ".gitignore"), ""); // the owner fixed .gitignore: out/ is no longer excluded
    expect(() => d.refresh()).toThrow(MaterialsDraftError);
    const v = d.excludeIgnored("x1"); // way out: remove the include
    expect(v.error).toBeNull();
    expect(names(v)).toEqual(["proj/out/lib/util.js", "proj/out/main.js", "proj/src/a.txt"]);
    expect(v.ignored).toEqual([]);
  });

  it("include log: the displayed name, without path and content", () => {
    const t = fresh();
    const lines: string[] = [];
    const d = createMaterialsDraft({ limits: () => ({ materialsChars: 1000, materialsIgnore: [] }), logger: { info: (m) => { lines.push(m); } } });
    d.attach([proj(t)]);
    d.returnIgnored("x1");
    expect(lines.join("\n")).toContain("proj/out/");
    expect(lines.join("\n")).not.toContain(t);
    expect(lines.join("\n")).not.toContain("собранный");
  });
});

// Property "Excluded by rules and include in session setup": the total depends only on the set of returned paths.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Excluded by rules and include in session setup: the set total depends only on the set of returned paths", () => {
  // six excludable paths: three each in two folders with the same name proj
  const ROOTS = ["/fx/a/proj", "/fx/b/proj"];
  const ENTRIES = ["out/", "dist.log", "tmp/"];
  const absOf = (r: string, e: string) => `${r}/${e.replace(/\/$/, "")}`;
  const stub = ((paths: readonly string[], options: { include?: readonly string[] }) => {
    const include = new Set(options.include ?? []);
    const materials: { id: string; name: string; chars: number; sha256: string; text: string }[] = [];
    const skipped: { name: string; reason: string; excludedPath?: string; rule?: string }[] = [];
    const all = new Set<string>();
    for (const r of paths) {
      materials.push({ id: "", name: "proj/src.txt", chars: 3, sha256: sha256Of(`s${r}`), text: `s${r}` });
      for (const e of ENTRIES) {
        const abs = absOf(r, e);
        all.add(abs);
        if (include.has(abs)) materials.push({ id: "", name: `proj/${e}x`, chars: 3, sha256: sha256Of(abs), text: abs });
        else skipped.push({ name: `proj/${e}`, reason: "исключено", excludedPath: abs, rule: e });
      }
    }
    for (const p of include) if (!all.has(p)) throw new MaterialsError(["не исключён"]); // like the core: a path not from the excluded rejects the collection
    return { materials, skipped };
  }) as unknown as typeof collectMaterials;
  const mk = () => createMaterialsDraft({ limits: () => ({ materialsChars: 100000, materialsIgnore: [] }), collect: stub });
  const strip = <T extends { stamp: string }>(v: T) => ({ ...v, stamp: "" });

  it("sequences of attach, returnIgnored, excludeIgnored, remove, clear (300 seeds)", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = mulberry32(seed);
      const int = (n: number) => Math.floor(rnd() * n);
      const d = mk();
      let roots: string[] = [];
      let returned = new Set<string>(); // model: returned absolute paths
      let hadRemove = false;
      const expectedRows = () =>
        roots.flatMap((r) => ENTRIES.map((e) => ({ name: `proj/${e}`, abs: absOf(r, e), rule: e })))
          .sort((a, b) => (a.name !== b.name ? (a.name < b.name ? -1 : 1) : a.abs < b.abs ? -1 : 1));
      const steps = int(12); // 0 — an empty sequence
      for (let i = 0; i < steps; i++) {
        const rows = expectedRows();
        const op = int(5);
        if (op === 0) {
          const r = ROOTS[int(2)]!;
          if (!roots.includes(r)) roots = [...roots, r];
          d.attach([r]);
        } else if (op === 1 || op === 2) {
          const outside = rows.length === 0 || rnd() < 0.2; // a path outside the section: there is no such id
          const idx = outside ? -1 : int(rows.length);
          const id = outside ? "x99" : `x${idx + 1}`;
          const before = d.view();
          const after = op === 1 ? d.returnIgnored(id) : d.excludeIgnored(id);
          if (outside) expect(after, `seed ${seed}: путь вне раздела`).toEqual(before);
          else if (op === 1) returned.add(rows[idx]!.abs);
          else returned.delete(rows[idx]!.abs);
        } else if (op === 3) {
          const items = d.view().items;
          if (items.length > 0) { d.remove(items[int(items.length)]!.id); hadRemove = true; }
        } else {
          d.clear();
          roots = [];
          returned = new Set();
          hadRemove = false;
          expect(d.view().ignored, `seed ${seed}: clear`).toEqual([]);
        }
      }
      const v = d.view();
      const rows = expectedRows();
      expect(v.ignored, `seed ${seed}`).toEqual(rows.map((r, i) => ({ id: `x${i + 1}`, name: r.name, rule: r.rule, returned: returned.has(r.abs) })));
      expect(v.error, `seed ${seed}`).toBeNull();
      if (!hadRemove) {
        // the view equals the view rebuilt from the final set of returned ones
        const fresh = mk();
        fresh.attach(roots);
        rows.forEach((r, i) => { if (returned.has(r.abs)) fresh.returnIgnored(`x${i + 1}`); });
        expect(strip(v), `seed ${seed}: вид по множеству`).toEqual(strip(fresh.view()));
        expect(d.workspace(), `seed ${seed}: workspace`).toEqual(fresh.workspace());
      }
      // returnIgnored twice equals once; excludeIgnored after returnIgnored restores the original view
      const free = rows.findIndex((r) => !returned.has(r.abs));
      if (free >= 0) {
        const id = `x${free + 1}`;
        const base = d.view();
        const once = d.returnIgnored(id);
        expect(d.returnIgnored(id), `seed ${seed}: дважды`).toEqual(once);
        expect(strip(d.excludeIgnored(id)), `seed ${seed}: обратно`).toEqual(strip(base));
      }
    }
  });
});

describe("materials draft: links", () => {
  const PUB = { address: "93.184.215.14", family: 4 } as const;
  type Reply = { status?: number; body?: string; delay?: number };
  const fake = (handler: (u: URL) => Reply = () => ({})) => {
    const t = { requests: [] as URL[], transport: undefined as unknown as UrlTransport };
    t.transport = {
      async resolve(h) { return [h === "private.test" ? { address: "10.0.0.1", family: 4 } : PUB]; },
      async request(url): Promise<UrlResponse> {
        t.requests.push(url);
        const r = handler(url);
        if (r.delay) await new Promise((res) => setTimeout(res, r.delay));
        const text = r.body ?? "текст ссылки";
        return { status: r.status ?? 200, headers: { "content-type": "text/plain" }, body: (async function* () { yield new TextEncoder().encode(text); })(), destroy() {} };
      },
    };
    return t;
  };
  const at = new Date("2026-02-03T04:05:06.000Z");
  const withUrls = (t: ReturnType<typeof fake>, materialsChars = 1000) => {
    const lim = { materialsChars, materialsIgnore: [] as string[] };
    return { d: createMaterialsDraft({ limits: () => lim, transport: t.transport, now: () => at }), lim };
  };

  it("link added: name, size, source without query, the total counts the size", async () => {
    const t = fake();
    const { d } = withUrls(t);
    const stamp0 = d.stamp();
    const v = await d.addUrl("  https://example.com/docs/a.txt?token=SECRET#frag ");
    expect(v.items).toEqual([{ id: "m1", name: "example.com_docs_a.txt", chars: 12, source: { label: "example.com/docs/a.txt", fetchedAt: at.toISOString() } }]);
    expect(v).toMatchObject({ chars: 12, over: 0, error: null });
    expect(v.stamp).not.toBe(stamp0);
    expect(JSON.stringify(v)).not.toMatch(/SECRET|frag|текст ссылки/);
    const s = d.snapshot();
    expect(s.sources).toEqual([{ id: "m1", scheme: "https", host: "example.com", pathname: "/docs/a.txt", fetchedAt: at.toISOString() }]);
    expect(JSON.stringify(s.sources)).not.toMatch(/SECRET|token/);
    expect(d.take().map((m) => m.id)).toEqual(["m1"]);
  });

  it("deleting a link removes the row and the source; a link stands after files, numbering is continuous", async () => {
    const t = fake();
    const { d } = withUrls(t);
    const a = put(join(fresh(), "a.txt"), "альфа");
    await d.addUrl("https://example.com/x");
    const v = d.attach([a]);
    expect(v.items.map((i) => [i.id, i.name, i.source === null])).toEqual([["m1", "a.txt", true], ["m2", "example.com_x", false]]);
    expect(d.snapshot().sources.map((s) => s.id)).toEqual(["m2"]);
    const before = d.stamp();
    const after = d.remove("m2");
    expect(after.items.map((i) => i.name)).toEqual(["a.txt"]);
    expect(d.snapshot().sources).toEqual([]);
    expect(d.stamp()).not.toBe(before);
    expect(t.requests).toHaveLength(1); // attach and remove do not touch the network
    d.refresh();
    expect(t.requests).toHaveLength(1);
  });

  it("a repeat of the same link: no row is added; a same-named name gets a suffix", async () => {
    const t = fake((u) => ({ body: u.search ? "другой" : "один" }));
    const { d } = withUrls(t);
    await d.addUrl("https://example.com/p");
    expect((await d.addUrl("https://example.com/p")).items).toHaveLength(1);
    const v = await d.addUrl("https://example.com/p?v=2");
    expect(v.items.map((i) => i.name)).toEqual(["example.com_p", "example.com_p (2)"]);
    expect(d.snapshot().sources.map((s) => s.id)).toEqual(["m1", "m2"]);
  });

  it("404 refusal and a non-public address: the list and stamp unchanged, an error with the core reason and the address without query", async () => {
    const t = fake((u) => (u.pathname === "/gone" ? { status: 404 } : {}));
    const { d } = withUrls(t);
    await d.addUrl("https://example.com/ok");
    const base = d.view();
    const nf = await d.addUrl("https://example.com/gone?k=SECRET");
    expect(nf.error).toMatch(/^«https:\/\/example\.com\/gone»: /);
    expect(nf.error).not.toContain("SECRET");
    expect(nf.error!.length).toBeGreaterThan("«https://example.com/gone»: ".length);
    expect({ ...nf, error: null }).toEqual(base);
    const priv = await d.addUrl("https://private.test/x?k=SECRET");
    expect(priv.error).toMatch(/^«https:\/\/private\.test\/x»: /);
    expect({ ...priv, error: null }).toEqual(base);
    expect(d.stamp()).toBe(base.stamp);
    expect(t.requests.map((u) => u.host)).toEqual(["example.com", "example.com"]); // the private address was rejected before the request
  });

  it("link over the limit: over is computed as for a file", async () => {
    const t = fake(() => ({ body: "x".repeat(50) }));
    const { d } = withUrls(t, 30);
    const v = await d.addUrl("https://example.com/big");
    expect(v).toMatchObject({ chars: 50, limit: 30, over: 20, error: null });
    expect(v.items).toHaveLength(1); // always included, like a carried one
  });

  it("empty string and a non-string: no request", async () => {
    const t = fake();
    const { d } = withUrls(t);
    expect((await d.addUrl("   ")).items).toEqual([]);
    expect((await d.addUrl(5 as unknown as string)).error).toBeNull();
    expect(t.requests).toHaveLength(0);
  });

  it("second link during loading: urlBusy, one request, the set unchanged", async () => {
    const t = fake(() => ({ delay: 30 }));
    const { d } = withUrls(t);
    const first = d.addUrl("https://example.com/a");
    const second = await d.addUrl("https://example.com/b");
    expect(second.error).toBe(setupMain().urlBusy);
    expect(second.items).toEqual([]);
    expect((await first).items).toHaveLength(1);
    expect(t.requests).toHaveLength(1);
    expect((await d.addUrl("https://example.com/b")).error).toBeNull(); // the flag is reset
  });

  it("clear during loading: the result is discarded", async () => {
    const t = fake(() => ({ delay: 30 }));
    const { d } = withUrls(t);
    const p = d.addUrl("https://example.com/a");
    d.clear();
    const v = await p;
    expect(v.items).toEqual([]);
    expect(d.snapshot().sources).toEqual([]);
  });

  it("carry during loading: the result is discarded", async () => {
    const t = fake(() => ({ delay: 30 }));
    const { d } = withUrls(t);
    const p = d.addUrl("https://example.com/a");
    d.carry([{ id: "m1", name: "c.txt", chars: 1, sha256: sha256Of("c"), text: "c" }], []);
    expect((await p).items.map((i) => i.name)).toEqual(["c.txt"]);
  });

  it("carry with sources: a row with a source, the number in the snapshot recomputed", () => {
    const { d } = withUrls(fake());
    const mk = (id: string, name: string) => ({ id, name, chars: name.length, sha256: sha256Of(name), text: name });
    const v = d.carry([mk("m1", "a.txt"), mk("m2", "link"), mk("m3", "link2")], [], [{ id: "m3", scheme: "https", host: "h.test", pathname: "/p", fetchedAt: at.toISOString() }]);
    expect(v.items.map((i) => i.source)).toEqual([null, null, { label: "h.test/p", fetchedAt: at.toISOString() }]);
    const after = d.remove("m1");
    expect(after.items.map((i) => i.id)).toEqual(["m1", "m2"]);
    expect(d.snapshot().sources).toEqual([{ id: "m2", scheme: "https", host: "h.test", pathname: "/p", fetchedAt: at.toISOString() }]);
  });
});

describe("Numbers, dates and plural forms of the preparation screens by language: the declension of \"size N characters\" for any n", () => {
  // An independent oracle of endings: by remainders, without Intl.PluralRules and plural.
  const nom3 = (n: number): string => (n % 10 === 1 && n % 100 !== 11 ? "знак" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "знака" : "знаков");
  it("ru: nominative case after the sum; en as before", () => {
    for (let n = 0; n <= 1200; n++) expect(setupMain("ru").overBound(n, 10, 2, 5)).toBe(`Не добавлено: объём ${n} ${nom3(n)} больше границы 10 (2 × лимит сессии 5)`);
    expect([1, 21].map((n) => setupMain("en").overBound(n, 10, 2, 5))).toEqual(["Not added: 1 characters exceed the bound of 10 (2 × session limit 5)", "Not added: 21 characters exceed the bound of 10 (2 × session limit 5)"]);
  });
});
