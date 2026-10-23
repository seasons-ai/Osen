import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCfb, makeDocx, makeRtf, makeZip, p } from "./documents/fixture.ts";
import type { ZipPart } from "./documents/fixture.ts";
import { makePdf } from "./pdf/fixture.ts";
import { setProcessLanguage } from "./i18n/process-language.ts";
import { materialsMessages } from "./messages/materials.ts";
import { setDocumentExtractorRuntime, DOC_NOT_CACHED } from "./documents/extract.ts";
import { writeExecutable } from "./executable.testutil.ts";
import { OCR_NOT_CACHED, setOcrRuntime } from "./ocr/run.ts";
import { PDF_NOT_CACHED, setPdfExtractorRuntime, setPdfOcrTesting } from "./pdf/extract.ts";
import { archiveEntryPath, expandArchive } from "./materials-archive.ts";
import { collectMaterials, collectSessionMaterials, MaterialsError, type CollectOptions } from "./materials.ts";
import { readWorkspaceSnapshot, workspaceDir, writeWorkspaceSnapshot } from "./store/journal.ts";

const SLOW = 30_000;
const opts: CollectOptions = { materialsChars: 100_000, materialsIgnore: ["node_modules", "dist"] };
const m = () => materialsMessages();
let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "materials-archive-"))); });
afterEach(() => { setOcrRuntime(); setDocumentExtractorRuntime(); setPdfExtractorRuntime(); setPdfOcrTesting(); setProcessLanguage("ru"); rmSync(root, { recursive: true, force: true }); });

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

  for (const lang of ["ru", "en"] as const) {
    it(`.ENV and .Env.local entries in another case are skipped, their text is not extracted (${lang})`, () => {
      setProcessLanguage(lang);
      const f = zipAt(`c-${lang}.zip`, [{ name: ".ENV", data: "SECRET_TOKEN=abc123" }, { name: "cfg/.Env.local", data: "SECRET_TOKEN=def456" }, { name: "a.txt", data: "a" }]);
      const set = collectSessionMaterials([f], opts);
      expect(names(set)).toEqual([`c-${lang}.zip/a.txt`]);
      expect(reasonOf(set, `c-${lang}.zip/.ENV`)).toBe(m().envSkipped);
      expect(reasonOf(set, `c-${lang}.zip/cfg/.Env.local`)).toBe(m().envSkipped);
      expect(JSON.stringify(set)).not.toMatch(/abc123|def456/);
    }, SLOW);
  }

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

  it("Архив ZIP как папка: имена без флага UTF-8 — CP866 или UTF-8", () => {
    const cp866 = Uint8Array.from([0x8e, 0xe2, 0xe7, 0xf1, 0xe2, 0x2e, 0x74, 0x78, 0x74]);
    const f = zipAt("n.zip", [{ name: cp866, data: "cp" }, { name: "readme.txt", data: "r" }]);
    expect(collectMaterials([f], opts).materials.map((x) => [x.name, x.text])).toEqual([["n.zip/readme.txt", "r"], ["n.zip/Отчёт.txt", "cp"]]);
    const u = zipAt("u.zip", [{ name: Buffer.from("Отчёт.txt"), data: "u" }]);
    expect(names(collectMaterials([u], opts))).toEqual(["u.zip/Отчёт.txt"]);
    const bad = zipAt("bad.zip", [{ name: cp866, utf8Flag: true, data: "cp" }]);
    expect(refusal(() => collectMaterials([bad], opts)).reasons).toEqual([`«${bad}»: ${m().archiveDamaged}`]);
    expect(m().archiveDamaged).toBe("архив повреждён");
  }, SLOW);

  it("Архив ZIP как папка: запись с неподдерживаемым методом пропущена с причиной, остальные собраны", () => {
    const reasons = { ru: "запись сжата неподдерживаемым методом — читаются только записи без сжатия и Deflate", en: "entry is compressed with an unsupported method — only stored and Deflate entries are read" };
    for (const lang of ["ru", "en"] as const) {
      setProcessLanguage(lang);
      for (const method of [12, 14, 93]) {
        const f = zipAt(`m${method}${lang}.zip`, [{ name: "a.txt", data: "a", method: 0 }, { name: "b.txt", data: "junk", method }]);
        const set = collectMaterials([f], opts);
        expect(names(set)).toEqual([`m${method}${lang}.zip/a.txt`]);
        expect(reasonOf(set, `m${method}${lang}.zip/b.txt`)).toBe(reasons[lang]);
      }
    }
  }, SLOW);

  it("Архив ZIP как папка: все записи с неподдерживаемым методом — отказ перечнем пропусков", () => {
    const f = zipAt("all.zip", [{ name: "a.txt", data: "a", method: 12 }, { name: "b.txt", data: "b", method: 14 }]);
    expect(refusal(() => collectMaterials([f], opts)).reasons).toEqual([`«${f}»: ${m().archiveNoFiles(2)}`, `«${f}»: all.zip/a.txt — ${m().archiveMethod}`, `«${f}»: all.zip/b.txt — ${m().archiveMethod}`]);
  }, SLOW);

  it("Архив ZIP как папка: .gitignore с неподдерживаемым методом — строка с причиной, правила не применены", () => {
    const f = zipAt("g.zip", [{ name: ".gitignore", data: "out/\n", method: 12 }, { name: "out/x.txt", data: "x", method: 0 }, { name: "a.txt", data: "a", method: 0 }]);
    const set = collectMaterials([f], opts);
    expect(names(set)).toEqual(["g.zip/a.txt", "g.zip/out/x.txt"]);
    expect(reasonOf(set, "g.zip/.gitignore")).toBe(m().archiveMethod);
  }, SLOW);

  it("an image entry whose helper answers an unknown code is skipped with catalog words, not the code", () => {
    ocrHelper({ ok: false, code: "vision" });
    const f = zipAt("v.zip", [{ name: "scan.png", data: png() }, { name: "a.txt", data: "a" }]);
    const set = collectMaterials([f], opts);
    expect(names(set)).toEqual(["v.zip/a.txt"]);
    expect(reasonOf(set, "v.zip/scan.png")).toBe("не удалось распознать текст изображения — помощник распознавания сообщил об ошибке");
    expect(JSON.stringify(set.skipped)).not.toContain("vision");
  }, SLOW);
});

// header-valid PNG without pixels: enough for a stub helper
function png(): Buffer {
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from("IHDR"), u32(10), u32(10), Buffer.alloc(5)]);
}
let stubN = 0;
const OCR_OK = { ok: true, lines: [{ t: "stub text", x: 0, y: 0, w: 1, h: 0.1 }] };
function ocrHelper(reply: unknown): void {
  setOcrRuntime({ helper: writeExecutable(join(root, `stub-${stubN++}.sh`), `#!/bin/sh\nC=$(/bin/cat)\nprintf '%s\\n' '${JSON.stringify(reply)}'\n`) });
}
const noHelper = (): void => setOcrRuntime({ helper: join(root, "absent-osen-ocr") });
function unstartableHelper(): void {
  const f = join(root, `stub-${stubN++}.sh`);
  writeFileSync(f, "#!/bin/sh\nexit 0\n");
  chmodSync(f, 0o644);
  setOcrRuntime({ helper: f });
}
// Substitute extractor: a document entry starting with PK\x03\x04BOOM gets REPLY, everything else (the archive itself, list and read modes) goes to the real extractor.
const BOOM = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from("BOOM")]);
const DOC_STUB = `import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const arg = process.argv[2];
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = Buffer.concat(chunks);
if (process.env.COUNT_FILE) appendFileSync(process.env.COUNT_FILE, "x\\n");
if (!JSON.parse(arg).mode && input.subarray(4, 8).toString() === "BOOM") { process.stdout.write(process.env.REPLY + "\\n"); process.exit(0); }
const r = spawnSync(process.execPath, [process.env.REAL, arg], { input, env: {}, maxBuffer: 2 ** 28 });
process.stdout.write(r.stdout);
process.exit(r.status ?? 1);
`;
function docExtractor(reply: unknown, countFile?: string): void {
  const script = join(root, "doc-stub.mjs");
  writeFileSync(script, DOC_STUB);
  setDocumentExtractorRuntime({ script, env: { REPLY: JSON.stringify(reply), REAL: join(import.meta.dirname, "documents/doc-extract.ts"), ...(countFile ? { COUNT_FILE: countFile } : {}) } });
}
const DOC_OK = { ok: true, text: "doc text", format: "docx" };
const PDF_STUB = `for await (const c of process.stdin);\nprocess.stdout.write(process.env.REPLY + "\\n");\n`;
function pdfExtractor(reply: unknown): void {
  const script = join(root, "pdf-stub.mjs");
  writeFileSync(script, PDF_STUB);
  setPdfExtractorRuntime({ script, env: { REPLY: JSON.stringify(reply) } });
}
const PDF_OK = { ok: true, text: "pdf text", pages: 1 };
const PDF_SCAN = { ok: true, pages: 1, parts: [""], blank: [1] };

describe("Архив ZIP как папка: повторный сбор после временного сбоя записи", () => {
  const archive = (rel: string, extra: ZipPart[]): string => zipAt(rel, [{ name: "note.txt", data: "n" }, ...extra]);

  it("a missing OCR helper is not cached: the scan becomes a material once the helper appears", () => {
    const f = archive("ocr.zip", [{ name: "scan.png", data: png() }]);
    noHelper();
    const first = collectMaterials([f], opts);
    expect(names(first)).toEqual(["ocr.zip/note.txt"]);
    expect(reasonOf(first, "ocr.zip/scan.png")).toBe(m().imgMissing);
    ocrHelper(OCR_OK);
    expect(collectMaterials([f], opts).materials.map((x) => [x.name, x.text])).toEqual([["ocr.zip/note.txt", "n"], ["ocr.zip/scan.png", "stub text"]]);
  }, SLOW);

  it("a helper that exceeds the deadline is not cached", () => {
    const f = archive("slow.zip", [{ name: "scan.png", data: png() }]);
    ocrHelper({ ok: false, code: "timeout" });
    expect(reasonOf(collectMaterials([f], opts), "slow.zip/scan.png")).toBe(m().imgTimeout(30));
    ocrHelper(OCR_OK);
    expect(names(collectMaterials([f], opts))).toEqual(["slow.zip/note.txt", "slow.zip/scan.png"]);
  }, SLOW);

  it("a document extractor timeout on an entry is not cached", () => {
    const f = archive("doc.zip", [{ name: "d.docx", data: BOOM }]);
    docExtractor({ ok: false, code: "timeout" });
    expect(reasonOf(collectMaterials([f], opts), "doc.zip/d.docx")).toBe(m().docTimeout(30));
    docExtractor(DOC_OK);
    expect(collectMaterials([f], opts).materials.map((x) => [x.name, x.text])).toEqual([["doc.zip/d.docx", "doc text"], ["doc.zip/note.txt", "n"]]);
  }, SLOW);

  it("an archive with only a scan and no helper is refused with the skip list, the next collection reads it", () => {
    const f = zipAt("only.zip", [{ name: "scan.png", data: png() }]);
    noHelper();
    expect(refusal(() => collectMaterials([f], opts)).reasons).toEqual([`«${f}»: ${m().archiveNoFiles(1)}`, `«${f}»: only.zip/scan.png — ${m().imgMissing}`]);
    ocrHelper(OCR_OK);
    expect(collectMaterials([f], opts).materials.map((x) => [x.name, x.text])).toEqual([["only.zip/scan.png", "stub text"]]);
  }, SLOW);

  it("an unchanged archive without transient skips is not read again", () => {
    const f = archive("cached.zip", [{ name: "d.docx", data: BOOM }]);
    const count = join(root, "count");
    docExtractor(DOC_OK, count);
    const first = collectMaterials([f], opts);
    const launches = readFileSync(count, "utf8");
    expect(launches.length).toBeGreaterThan(0);
    expect(collectMaterials([f], opts)).toEqual(first);
    expect(readFileSync(count, "utf8")).toBe(launches);
  }, SLOW);

  // Every code of the three exported lists: a second collection reads the entry again; damaged and no_text are served from the cache.
  // Excluded: PDF ocr_folder — an archive PDF gets no folder budget (extractPdfText is called without one), so the code cannot occur for an entry.
  const PDF_EXCLUDED = ["ocr_folder"];
  const PDF_VIA_HELPER: Record<string, "missing" | "start" | "page_timeout" | "timeout" | "memory" | "failed"> = {
    ocr_missing: "missing", ocr_start: "start", ocr_page_timeout: "page_timeout", ocr_timeout: "timeout", ocr_memory: "memory", ocr_failed: "failed",
  };
  const OCR_PRODUCE: Record<string, () => void> = {
    timeout: () => ocrHelper({ ok: false, code: "timeout" }), memory: () => ocrHelper({ ok: false, code: "memory" }), missing: noHelper, start: unstartableHelper,
    failed: () => ocrHelper({ ok: false, code: "vision" }), damaged: () => ocrHelper({ ok: false, code: "damaged" }), no_text: () => ocrHelper({ ok: false, code: "no_text" }),
  };
  const cases: { kind: string; code: string; transient: boolean; entry: ZipPart; produce: () => void; succeed: () => void }[] = [
    ...[...OCR_NOT_CACHED, "damaged", "no_text"].map((code) => ({
      kind: "ocr", code, transient: OCR_NOT_CACHED.includes(code as never), entry: { name: "scan.png", data: png() }, produce: OCR_PRODUCE[code]!, succeed: () => ocrHelper(OCR_OK),
    })),
    ...[...DOC_NOT_CACHED, "damaged", "no_text"].map((code) => ({
      kind: "doc", code, transient: DOC_NOT_CACHED.includes(code as never), entry: { name: "d.docx", data: BOOM }, produce: () => docExtractor({ ok: false, code }), succeed: () => docExtractor(DOC_OK),
    })),
    ...[...PDF_NOT_CACHED.filter((c) => !PDF_EXCLUDED.includes(c)), "damaged", "no_text"].map((code) => ({
      kind: "pdf", code, transient: PDF_NOT_CACHED.includes(code as never), entry: { name: "p.pdf", data: "%PDF-1.4 stub" },
      produce: () => {
        const via = PDF_VIA_HELPER[code];
        if (via) { pdfExtractor(PDF_SCAN); setPdfOcrTesting({ run: () => ({ ok: false, code: via }) }); } else pdfExtractor({ ok: false, code });
      },
      succeed: () => { setPdfOcrTesting(); pdfExtractor(PDF_OK); },
    })),
  ];

  it("every code of the exported lists has a producer", () => {
    const covered = new Set(cases.filter((c) => c.transient).map((c) => `${c.kind}:${c.code}`));
    const listed = [...OCR_NOT_CACHED.map((c) => `ocr:${c}`), ...DOC_NOT_CACHED.map((c) => `doc:${c}`), ...PDF_NOT_CACHED.filter((c) => !PDF_EXCLUDED.includes(c)).map((c) => `pdf:${c}`)];
    expect(listed.filter((k) => !covered.has(k))).toEqual([]);
    expect(OCR_PRODUCE).toBeDefined();
  });

  it.each(cases.map((c, i) => ({ ...c, i })))("$kind $code: transient=$transient", ({ i, kind, code, transient, entry, produce, succeed }) => {
    const f = archive(`c${i}.zip`, [entry]);
    produce();
    const first = collectMaterials([f], opts);
    expect(names(first), `${kind}:${code}`).toEqual([`c${i}.zip/note.txt`]);
    const reason = reasonOf(first, `c${i}.zip/${entry.name as string}`);
    expect(reason).toBeDefined();
    succeed();
    const second = collectMaterials([f], opts);
    if (transient) {
      expect(names(second)).toContain(`c${i}.zip/${entry.name as string}`);
      expect(reasonOf(second, `c${i}.zip/${entry.name as string}`)).toBeUndefined();
    } else {
      expect(names(second)).toEqual([`c${i}.zip/note.txt`]);
      expect(reasonOf(second, `c${i}.zip/${entry.name as string}`)).toBe(reason);
    }
  }, SLOW);
});

describe("Архив ZIP как папка: показ пропусков и причины", () => {
  it("an archive inside a folder that is also attached separately is expanded, not skipped", () => {
    put("d/notes.md", "n");
    const z = put("d/export.zip", makeZip([{ name: "a.txt", data: "a" }]));
    for (const paths of [[join(root, "d"), z], [z, join(root, "d")]]) {
      const set = collectMaterials(paths, opts);
      expect(names(set).sort()).toEqual(["d/notes.md", "export.zip/a.txt"]);
      expect(set.skipped.map((s) => s.name)).not.toContain("d/export.zip");
    }
    const alone = collectMaterials([join(root, "d")], opts);
    expect(reasonOf(alone, "d/export.zip")).toBe(m().archiveInFolder);
  }, SLOW);

  it("a NUL in an unsafe entry name is shown as \\u0000, also for a repeated name", () => {
    const one = zipAt("nul.zip", [{ name: "a/\u0000b.txt", data: "x" }, { name: "ok.txt", data: "o" }]);
    expect(collectMaterials([one], opts).skipped).toEqual([{ name: "nul.zip/a/\\u0000b.txt", reason: m().archiveUnsafeName }]);
    const two = zipAt("nul2.zip", [{ name: "a/\u0000b.txt", data: "x" }, { name: "a/\u0000b.txt", data: "y" }]);
    const lines = refusal(() => collectMaterials([two], opts)).reasons;
    expect(lines.join("\n")).not.toContain("\u0000");
    expect(lines.filter((l) => l.includes("nul2.zip/a/\\u0000b.txt"))).toHaveLength(2);
  }, SLOW);
});

describe("Архив ZIP как папка: причина сбоя процесса извлечения на языке сессии", () => {
  const STUB = `for await (const c of process.stdin);
if (!JSON.parse(process.argv[2]).mode) { process.stdout.write('{"ok":false,"code":"unsupported"}\\n'); process.exit(0); }
if (process.env.MODE === "exit") process.exit(3);
if (process.env.MODE === "signal") process.kill(process.pid, "SIGKILL");
process.stdout.write('{"ok":false,"code":"failed","detail":"worker exit"}\\n');
`;
  const expected = {
    ru: { exit: "процесс извлечения завершился с кодом 3", signal: "процесс извлечения остановлен сигналом SIGKILL", reply: "рабочий поток извлечения остановился" },
    en: { exit: "the extraction process exited with code 3", signal: "the extraction process was stopped by signal SIGKILL", reply: "the extraction worker stopped" },
  };
  it.each(["ru", "en"] as const)("%s: exit code, signal and worker failure come from the catalog", (lang) => {
    setProcessLanguage(lang);
    const script = join(root, "fail-stub.mjs");
    writeFileSync(script, STUB);
    for (const mode of ["exit", "signal", "reply"] as const) {
      setDocumentExtractorRuntime({ script, env: { MODE: mode } });
      const f = zipAt(`${lang}${mode}.zip`, [{ name: "a.txt", data: "a" }]);
      const reasons = refusal(() => collectMaterials([f], opts)).reasons;
      expect(reasons).toEqual([`«${f}»: ${m().archiveFailed(expected[lang][mode])}`]);
      expect(reasons[0]).not.toMatch(/\bexit \d|worker error|worker exit/);
    }
  }, SLOW);
});
