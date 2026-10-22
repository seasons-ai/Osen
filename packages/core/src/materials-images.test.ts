import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "./i18n/process-language.ts";
import { collectMaterials, collectSessionMaterials, MaterialsError, sha256Of, type CollectOptions } from "./materials.ts";
import { makeImage } from "./ocr/fixture.ts";
import { setOcrRuntime } from "./ocr/run.ts";

const opts: CollectOptions = { materialsChars: 100_000, materialsIgnore: ["node_modules", "dist"] };
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\n ]/gu, "");
let root: string;
let stubDir: string;
beforeAll(() => { stubDir = realpathSync(mkdtempSync(join(tmpdir(), "materials-img-stubs-"))); });
afterAll(() => rmSync(stubDir, { recursive: true, force: true }));
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "materials-img-"))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); setOcrRuntime(); setProcessLanguage("ru"); });

function put(rel: string, content: string | Uint8Array): string {
  const f = join(root, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, content);
  return f;
}
let n = 0;
function stubHelper(reply: unknown): void {
  const f = join(stubDir, `stub-${n++}.sh`);
  writeFileSync(f, `#!/bin/sh\nC=$(/bin/cat)\nprintf '%s\\n' '${JSON.stringify(reply)}'\n`);
  chmodSync(f, 0o755);
  setOcrRuntime({ helper: f });
}
const okReply = { ok: true, lines: [{ t: "stub text", x: 0, y: 0, w: 1, h: 0.1 }] };
// header-valid PNG without pixels: enough for the stub helper
function png(w = 10, h = 10): Buffer {
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from("IHDR"), u32(w), u32(h), Buffer.alloc(5)]);
}
function refusal(fn: () => unknown): MaterialsError {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(MaterialsError); return e as MaterialsError; }
  throw new Error("refusal expected");
}

describe("image materials: missing helper", () => {
  it("skips the folder image with the helper reason and keeps the other materials", () => {
    setOcrRuntime({ helper: join(stubDir, "absent-osen-ocr") });
    put("d/README.md", "# Project\n");
    put("d/shot.png", png());
    const set = collectMaterials([join(root, "d")], opts);
    expect(set.materials.map((m) => [m.name, m.text])).toEqual([["d/README.md", "# Project\n"]]);
    expect(set.skipped).toEqual([{ name: "d/shot.png", reason: "распознавание текста недоступно — нет помощника osen-ocr" }]);
  });
});

describe("image materials: real helper", () => {
  it("recognizes a JPEG named photo.txt and a PNG named scan.dat, attached and in a folder", () => {
    const lines = ["Договор поставки", "Срок оплаты"];
    const photo = put("d/photo.txt", makeImage("jpeg", lines));
    const scan = put("d/scan.dat", makeImage("png", lines));
    for (const p of [photo, scan]) {
      const set = collectMaterials([p], opts);
      expect(norm(set.materials[0]!.text)).toBe("договор поставки\nсрок оплаты");
      expect(set.materials[0]!.sha256).toBe(sha256Of(set.materials[0]!.text));
    }
    const folder = collectMaterials([join(root, "d")], opts);
    expect(folder.materials.map((m) => m.name)).toEqual(["d/photo.txt", "d/scan.dat"]);
    expect(folder.skipped).toEqual([]);
    const session = collectSessionMaterials([join(root, "d")], opts);
    expect(session.materials.map((m) => [m.text, m.sha256])).toEqual(folder.materials.map((m) => [m.text, m.sha256]));
  });
});

describe("image materials: stub helper", () => {
  it("keeps a text file that starts with BM as text", () => {
    put("note.txt", "BM is a plain note");
    const set = collectMaterials([join(root, "note.txt")], opts);
    expect(set.materials[0]!.text).toBe("BM is a plain note");
  });

  it("refuses an unusable explicit image and skips it in a folder with the same reason", () => {
    stubHelper({ ok: false, code: "no_text" });
    const file = put("d/blank.png", png());
    const reason = "на изображении не найден текст";
    expect(refusal(() => collectMaterials([file], opts)).reasons).toEqual([`«${file}»: ${reason}`]);
    expect(collectMaterials([join(root, "d"), put("t.txt", "x")], opts).skipped).toEqual([{ name: "d/blank.png", reason }]);
  });

  it("names the reason in English and Russian", () => {
    stubHelper({ ok: false, code: "no_text" });
    const file = put("blank.png", png());
    setProcessLanguage("en");
    expect(refusal(() => collectMaterials([file], opts)).reasons[0]).toContain("no text found in the image");
    setProcessLanguage("ru");
    expect(refusal(() => collectMaterials([file], opts)).reasons[0]).toContain("на изображении не найден текст");
  });

  it("refuses an image with a damaged header and an oversized canvas before the helper", () => {
    stubHelper(okReply);
    expect(refusal(() => collectMaterials([put("a.png", png(0, 5))], opts)).reasons[0]).toContain("изображение повреждено");
    expect(refusal(() => collectMaterials([put("b.png", png(20000, 20000))], opts)).reasons[0]).toContain("изображение больше 100 мегапикселей");
  });

  it("recognizes the first 50 images of a folder in name order and skips the rest", () => {
    stubHelper(okReply);
    const names = Array.from({ length: 60 }, (_, i) => `img-${String(i).padStart(2, "0")}.png`);
    // written in reverse: the order of the limit is by name, not by creation or readdir
    [...names].reverse().forEach((nm) => put(`d/${nm}`, png()));
    put("d/a-damaged.png", Buffer.concat([png().subarray(0, 8), Buffer.from("garbage")]));
    const set = collectMaterials([join(root, "d")], { ...opts, materialsChars: 1_000_000 });
    expect(set.materials.map((m) => m.name)).toEqual(names.slice(0, 50).map((nm) => `d/${nm}`));
    const skipped = new Map(set.skipped.map((s) => [s.name, s.reason]));
    expect(skipped.get("d/a-damaged.png")).toBe("изображение повреждено");
    for (const nm of names.slice(50)) expect(skipped.get(`d/${nm}`)).toBe("в папке больше 50 изображений — распознаны первые 50");
    expect(skipped.size).toBe(11);
  });

  it("does not limit explicitly attached images", () => {
    stubHelper(okReply);
    const files = Array.from({ length: 55 }, (_, i) => put(`f/i${i}.png`, png()));
    expect(collectMaterials(files, { ...opts, materialsChars: 1_000_000 }).materials).toHaveLength(55);
  });
});
