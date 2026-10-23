import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCfb, makeDocx, makeRtf, makeZip, p } from "./documents/fixture.ts";
import type { ZipPart } from "./documents/fixture.ts";
import { makePdf } from "./pdf/fixture.ts";
import { setProcessLanguage } from "./i18n/process-language.ts";
import { materialsMessages } from "./messages/materials.ts";
import { setOcrRuntime } from "./ocr/run.ts";
import { archiveEntryPath, expandArchive } from "./materials-archive.ts";
import { collectMaterials, collectSessionMaterials, MaterialsError, type CollectOptions } from "./materials.ts";
import { readWorkspaceSnapshot, workspaceDir, writeWorkspaceSnapshot } from "./store/journal.ts";

const SLOW = 30_000;
const opts: CollectOptions = { materialsChars: 100_000, materialsIgnore: ["node_modules", "dist"] };
const m = () => materialsMessages();
let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "materials-archive-"))); });
afterEach(() => { setOcrRuntime(); setProcessLanguage("ru"); rmSync(root, { recursive: true, force: true }); });

function put(rel: string, content: string | Uint8Array): string {
  const f = join(root, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, content);
  return f;
}
const zipAt = (rel: string, parts: ZipPart[]): string => put(rel, makeZip(parts));
function refusal(fn: () => unknown): MaterialsError {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(MaterialsError); return e as MaterialsError; }
  throw new Error("refusal expected");
}
const names = (set: { materials: { name: string }[] }) => set.materials.map((x) => x.name);
const reasonOf = (set: { skipped: { name: string; reason: string }[] }, name: string) => set.skipped.find((s) => s.name === name)?.reason;
function sparseZip(rel: string): string {
  const f = put(rel, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  truncateSync(f, 150 * 2 ** 20);
  return f;
}

describe("archiveEntryPath", () => {
  it("returns segments of safe names and undefined for unsafe ones", () => {
    expect(archiveEntryPath("a/b.txt")).toEqual(["a", "b.txt"]);
    expect(archiveEntryPath("dir/")).toEqual(["dir"]);
    for (const bad of ["../x", "a/../x", "/etc/x", "C:/x", "a\\b", "a\u0000b", "a//b", "./a", "a/./b", "", "/"]) expect(archiveEntryPath(bad), bad).toBeUndefined();
  });
});

describe("ZIP archive as a folder", () => {
  it("project archive: folder rules, document text, snapshot only under the archive name", () => {
    const f = zipAt("proj.zip", [
      { name: "README.md", data: "читай" }, { name: "src/a.ts", data: "const a = 1;" },
      { name: "docs/spec.docx", data: makeDocx({ body: p("Первая строка") }) },
      { name: ".gitignore", data: "out/\n" }, { name: "out/main.js", data: "x" }, { name: ".env", data: "SECRET=1" }, { name: "__MACOSX/x", data: "x" },
    ]);
    const set = collectMaterials([f], opts);
    expect(set.materials.map((x) => [x.name, x.text])).toEqual([
      ["proj.zip/README.md", "читай"], ["proj.zip/docs/spec.docx", "Первая строка"], ["proj.zip/src/a.ts", "const a = 1;"],
    ]);
    expect(reasonOf(set, "proj.zip/out/")).toBe(m().excludedByRule("out/"));
    expect(reasonOf(set, "proj.zip/.env")).toBe(m().envSkipped);
    expect(reasonOf(set, "proj.zip/.gitignore")).toBe(m().hiddenName);
    expect(reasonOf(set, "proj.zip/__MACOSX/")).toBe(m().archiveMacos);
    expect(set.skipped.some((s) => "excludedPath" in s)).toBe(false);

    const session = collectSessionMaterials([f], opts);
    expect(session.workspace.map((w) => w.name)).toEqual(["proj.zip/README.md", "proj.zip/docs/spec.docx", "proj.zip/src/a.ts"]);
    const dataDir = join(root, "data");
    writeWorkspaceSnapshot(dataDir, "s1", session.workspace);
    expect(readdirSync(workspaceDir(dataDir, "s1"))).toEqual(["proj.zip"]);
    expect(readWorkspaceSnapshot(dataDir, "s1").map((w) => w.name)).toEqual(session.workspace.map((w) => w.name));
  }, SLOW);

  it("nested archive is skipped, a DOCX inside is read as a document", () => {
    const f = zipAt("n.zip", [
      { name: "a.txt", data: "a" }, { name: "inner.zip", data: makeZip([{ name: "b.txt", data: "b" }]) },
      { name: "d.docx", data: makeDocx({ body: p("док") }) },
    ]);
    const set = collectMaterials([f], opts);
    expect(set.materials.map((x) => [x.name, x.text])).toEqual([["n.zip/a.txt", "a"], ["n.zip/d.docx", "док"]]);
    expect(reasonOf(set, "n.zip/inner.zip")).toBe(m().archiveNested);
  }, SLOW);

  it("unsafe names never become materials", () => {
    const f = zipAt("u.zip", ["../evil.txt", "/etc/x", "C:/x.txt", "a\\b.txt", "ok.txt"].map((name) => ({ name, data: "t" })));
    const set = collectMaterials([f], opts);
    expect(names(set)).toEqual(["u.zip/ok.txt"]);
    expect(set.skipped.filter((s) => s.reason === m().archiveUnsafeName).map((s) => s.name).sort())
      .toEqual(["u.zip/../evil.txt", "u.zip//etc/x", "u.zip/C:/x.txt", "u.zip/a\\b.txt"].sort());
  }, SLOW);

  it(".env entries are skipped and their text never reaches a material", () => {
    const f = zipAt("e.zip", [{ name: ".env", data: "TOPSECRET=1" }, { name: "cfg/.env.local", data: "TOPSECRET=2" }, { name: "a.txt", data: "a" }]);
    const set = collectMaterials([f], opts);
    expect(names(set)).toEqual(["e.zip/a.txt"]);
    expect(JSON.stringify(set)).not.toContain("TOPSECRET");
    expect(reasonOf(set, "e.zip/cfg/.env.local")).toBe(m().envSkipped);
  }, SLOW);

  it("encrypted entries and symlink entries are skipped, the rest is collected", () => {
    const f = zipAt("s.zip", [
      { name: "a.txt", data: "a" }, { name: "b.txt", data: "b" }, { name: "enc.txt", data: "z", encrypted: true },
      { name: "link", data: "a.txt", unixMode: 0o120777 },
    ]);
    const set = collectMaterials([f], opts);
    expect(names(set)).toEqual(["s.zip/a.txt", "s.zip/b.txt"]);
    expect(reasonOf(set, "s.zip/enc.txt")).toBe(m().docEncrypted);
    expect(reasonOf(set, "s.zip/link")).toBe(m().symlink);
  }, SLOW);

  it("duplicate names: the first entry is kept", () => {
    const f = zipAt("d.zip", [{ name: "a.txt", data: "first" }, { name: "a.txt", data: "second" }, { name: "A.TXT", data: "third" }, { name: "dir/x.txt", data: "x" }, { name: "dir", data: "file over dir" }]);
    const set = collectMaterials([f], opts);
    expect(set.materials.map((x) => [x.name, x.text])).toEqual([["d.zip/a.txt", "first"], ["d.zip/dir/x.txt", "x"]]);
    expect(set.skipped.filter((s) => s.reason === m().archiveDuplicate).length).toBe(3);
  }, SLOW);

  it("bombs and damaged archives refuse with the limit named", () => {
    const ratio = zipAt("ratio.zip", [{ name: "a.bin", data: "a", declaredSize: 1000 }]);
    expect(refusal(() => collectMaterials([ratio], opts)).reasons).toEqual([`«${ratio}»: ${m().archiveRatio(200)}`]);
    const big = zipAt("big.zip", [{ name: "a.bin", data: "a", declaredSize: 600 * 2 ** 20, method: 0 }]);
    expect(refusal(() => collectMaterials([big], opts)).reasons).toEqual([`«${big}»: ${m().archiveUnpacked(512)}`]);
    const many = zipAt("many.zip", Array.from({ length: 10_001 }, (_, i) => ({ name: `x${i}`, data: "a" })));
    expect(refusal(() => collectMaterials([many], opts)).reasons).toEqual([`«${many}»: ${m().archiveParts(10_000)}`]);
    const cut = put("cut.zip", Buffer.from(makeZip([{ name: "a.txt", data: "a" }, { name: "b.txt", data: "b" }])).subarray(0, -30));
    expect(refusal(() => collectMaterials([cut], opts)).reasons).toEqual([`«${cut}»: ${m().archiveDamaged}`]);
  }, SLOW);

  it("empty archive and archive without a usable file are refused", () => {
    const empty = zipAt("empty.zip", []);
    expect(refusal(() => collectMaterials([empty], opts)).reasons).toEqual([`«${empty}»: ${m().archiveEmpty}`]);
    const hidden = zipAt("hidden.zip", [{ name: ".env", data: "a" }, { name: ".hid", data: "b" }]);
    const reasons = refusal(() => collectMaterials([hidden], opts)).reasons;
    expect(reasons[0]).toBe(`«${hidden}»: ${m().archiveNoFiles(2)}`);
    expect(reasons).toContain(`«${hidden}»: hidden.zip/.env — ${m().envSkipped}`);
  }, SLOW);

  it("an archive inside a folder is not expanded", () => {
    put("d/notes.md", "n");
    put("d/export.zip", makeZip([{ name: "a.txt", data: "a" }]));
    const set = collectMaterials([join(root, "d")], opts);
    expect(names(set)).toEqual(["d/notes.md"]);
    expect(reasonOf(set, "d/export.zip")).toBe(m().archiveInFolder);
  }, SLOW);

  it("a ZIP over 100 MiB: refusal when explicit, skip in a folder, both languages", () => {
    const f = sparseZip("huge.zip");
    expect(refusal(() => collectMaterials([f], opts)).reasons).toEqual([`«${f}»: ZIP больше 100 МиБ — не раскрывается`]);
    put("d/a.md", "a");
    sparseZip("d/huge.zip");
    expect(reasonOf(collectMaterials([join(root, "d")], opts), "d/huge.zip")).toBe("ZIP больше 100 МиБ — не раскрывается");
    setProcessLanguage("en");
    expect(refusal(() => collectMaterials([f], opts)).reasons).toEqual([`«${f}»: ZIP is larger than 100 MiB — not expanded`]);
    expect(reasonOf(collectMaterials([join(root, "d")], opts), "d/huge.zip")).toBe("ZIP is larger than 100 MiB — not expanded");
  }, SLOW);

  it("content decides, not the extension", () => {
    const doc = put("x.zip", makeDocx({ body: p("док") }));
    expect(collectMaterials([doc], opts).materials.map((x) => [x.name, x.text])).toEqual([["x.zip", "док"]]);
    const arc = zipAt("y.docx", [{ name: "a.txt", data: "a" }]);
    expect(names(collectMaterials([arc], opts))).toEqual(["y.docx/a.txt"]);
  }, SLOW);

  it("same-named folders and archives get unique prefixes; the snapshot is written", () => {
    put("a/proj/check.ts", "folder");
    const z1 = zipAt("b/proj.zip", [{ name: "check.ts", data: "one" }]);
    const z2 = zipAt("c/proj.zip", [{ name: "check.ts", data: "two" }]);
    const set = collectSessionMaterials([join(root, "a/proj"), z1, z2], opts);
    expect(set.workspace.map((w) => [w.name, w.text])).toEqual([["proj/check.ts", "folder"], ["proj.zip/check.ts", "one"], ["proj.zip (2)/check.ts", "two"]]);
    writeWorkspaceSnapshot(join(root, "data"), "s", set.workspace);
    expect(readWorkspaceSnapshot(join(root, "data"), "s").length).toBe(3);
  }, SLOW);

  it("the overall deadline refuses the archive", () => {
    const f = zipAt("t.zip", [{ name: "a.txt", data: "a" }]);
    expect(expandArchive(f, "t.zip", opts, 0)).toEqual({ refused: [m().archiveTimeout(0)] });
    expect(names(collectMaterials([f], opts))).toEqual(["t.zip/a.txt"]);
  }, SLOW);

  it("the cache is separated by language", () => {
    const f = zipAt("l.zip", [{ name: ".env", data: "a" }, { name: "a.txt", data: "a" }]);
    expect(reasonOf(collectMaterials([f], opts), "l.zip/.env")).toBe(m().envSkipped);
    setProcessLanguage("en");
    const en = reasonOf(collectMaterials([f], opts), "l.zip/.env");
    expect(en).toBe(m().envSkipped);
    expect(en).not.toMatch(/[Ѐ-ӿ]/);
  }, SLOW);

  it("archive files over the initial set go to the snapshot and to left", () => {
    const f = zipAt("big.zip", [{ name: "README.md", data: "short" }, { name: "src/big.ts", data: "x".repeat(500) }]);
    const set = collectSessionMaterials([f], { ...opts, materialsChars: 50 });
    expect(names(set)).toEqual(["big.zip/README.md"]);
    expect(set.left.map((l) => l.name)).toEqual(["big.zip/src/big.ts"]);
    expect(set.workspace.map((w) => w.name)).toEqual(["big.zip/README.md", "big.zip/src/big.ts"]);
  }, SLOW);

  it("nested .gitignore of the archive applies to its folder only", () => {
    const f = zipAt("g.zip", [{ name: "sub/.gitignore", data: "*.log\n" }, { name: "sub/a.log", data: "a" }, { name: "sub/b.txt", data: "b" }, { name: "c.log", data: "c" }]);
    const set = collectMaterials([f], opts);
    expect(names(set)).toEqual(["g.zip/c.log", "g.zip/sub/b.txt"]);
    expect(reasonOf(set, "g.zip/sub/a.log")).toBe(m().excludedByRule("*.log"));
    expect(collectMaterials([f], { ...opts, gitignore: false }).materials.length).toBe(3);
  }, SLOW);

  it("materialsIgnore applies inside an archive", () => {
    const f = zipAt("i.zip", [{ name: "node_modules/x.js", data: "x" }, { name: "a.txt", data: "a" }]);
    const set = collectMaterials([f], { ...opts, materialsIgnore: ["node_modules"] });
    expect(names(set)).toEqual(["i.zip/a.txt"]);
    expect(reasonOf(set, "i.zip/node_modules")).toBe(m().ignoredByList);
  }, SLOW);

  it("a PDF entry is read by the PDF reader", () => {
    const f = zipAt("pdf.zip", [{ name: "doc.pdf", data: makePdf(["Hello archive"]) }, { name: "a.txt", data: "a" }]);
    const set = collectMaterials([f], opts);
    expect(names(set)).toEqual(["pdf.zip/a.txt", "pdf.zip/doc.pdf"]);
    expect(set.materials[1]!.text).toContain("Hello archive");
  }, SLOW);

  it("PDF в архиве без помощника: the fallback text is not cached, a helper that appears adds the recognized page", () => {
    const f = zipAt("late.zip", [{ name: "doc.pdf", data: makePdf(["текст", ""]) }]);
    setOcrRuntime({ helper: "/nonexistent/osen-ocr" });
    expect(collectMaterials([f], opts).materials.map((x) => x.text)).toEqual(["текст"]);
    const helper = put("helper.sh", `#!/bin/sh\nC=$(/bin/cat)\nprintf '%s\\n' '{"ok":true,"pages":[{"n":2,"lines":[{"t":"скан","x":0,"y":0,"w":0.5,"h":0.1}]}]}'\n`);
    chmodSync(helper, 0o755);
    setOcrRuntime({ helper });
    expect(collectMaterials([f], opts).materials.map((x) => x.text)).toEqual(["текст\n\nскан"]);
  }, SLOW);

  it("text entries are decoded with the encodings of change 212 (UTF-16 with BOM, Windows-1251)", () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Привет из UTF-16", "utf16le")]);
    const cp1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20, 0xe8, 0xe7, 0x20, 0xe0, 0xf0, 0xf5, 0xe8, 0xe2, 0xe0]);
    const f = zipAt("enc.zip", [{ name: "u16.txt", data: utf16 }, { name: "cp.txt", data: cp1251 }]);
    const set = collectMaterials([f], opts);
    expect(set.materials.map((x) => [x.name, x.text])).toEqual([["enc.zip/cp.txt", "Привет из архива"], ["enc.zip/u16.txt", "Привет из UTF-16"]]);
  }, SLOW);

  it("an empty nested ZIP is a nested archive too", () => {
    const f = zipAt("outer.zip", [{ name: "empty.zip", data: makeZip([]) }, { name: "a.txt", data: "a" }]);
    expect(reasonOf(collectMaterials([f], opts), "outer.zip/empty.zip")).toBe(m().archiveNested);
  }, SLOW);

  it("RTF and Compound File Binary entries go to the RTF/DOC readers of change 211", () => {
    const f = zipAt("legacy.zip", [
      { name: "note.dat", data: makeRtf(["Первая строка"]) },
      { name: "secret.docx", data: makeCfb({ streams: ["EncryptedPackage", "EncryptionInfo"] }) },
      { name: "sheet.xls", data: makeCfb({ streams: ["Workbook"] }) },
    ]);
    const set = collectMaterials([f], opts);
    expect(names(set)).toEqual(["legacy.zip/note.dat"]);
    expect(set.materials[0]!.text).toContain("Первая строка");
    expect(reasonOf(set, "legacy.zip/secret.docx")).toBe(m().docEncrypted);
    expect(reasonOf(set, "legacy.zip/sheet.xls")).toBe(m().kindReason("xls"));
  }, SLOW);

  it("a damaged DOCX entry is skipped with the document reason, the rest is collected", () => {
    const f = zipAt("bad.zip", [{ name: "bad.docx", data: makeDocx({ body: "<w:p>" }) }, { name: "a.txt", data: "a" }]);
    const set = collectMaterials([f], opts);
    expect(names(set)).toEqual(["bad.zip/a.txt"]);
    expect(reasonOf(set, "bad.zip/bad.docx")).toBe(m().docDamaged);
  }, SLOW);

  it("a .gitignore line of 200000 spaces then x does not stall collection", () => {
    const f = zipAt("redos.zip", [{ name: ".gitignore", data: `${" ".repeat(200_000)}x\n`, method: 0 }, { name: "a.txt", data: "a" }]);
    expect(names(collectMaterials([f], opts))).toEqual(["redos.zip/a.txt"]);
  }, 5000);
});
