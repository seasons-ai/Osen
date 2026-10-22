import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCfb, makeRtf } from "./documents/fixture.ts";
import { setDocumentExtractorRuntime } from "./documents/extract.ts";
import { collectMaterials, collectSessionMaterials, MaterialsError, sha256Of, type CollectOptions } from "./materials.ts";
import { getProcessLanguage, setProcessLanguage } from "./i18n/process-language.ts";
import { materialsMessages } from "./messages/materials.ts";

const mac = process.platform === "darwin";
const opts: CollectOptions = { materialsChars: 10_000, materialsIgnore: ["node_modules", "dist"] };
let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "materials-legacy-"))); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(rel: string, content: string | Uint8Array): string {
  const f = join(root, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, content);
  return f;
}
function refusal(fn: () => unknown): MaterialsError {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(MaterialsError); return e as MaterialsError; }
  throw new Error("refusal expected");
}
function docBytes(paras: string[]): Uint8Array {
  put("src.rtf", makeRtf(paras));
  execFileSync("/usr/bin/textutil", ["-convert", "doc", "-output", join(root, "made.doc"), join(root, "src.rtf")], { stdio: "ignore" });
  return new Uint8Array(execFileSync("/bin/cat", [join(root, "made.doc")], { maxBuffer: 2 ** 24 }));
}

const TEXT = "Первая строка\nВторая строка";
const enc = (): Uint8Array => makeCfb({ streams: ["EncryptedPackage", "EncryptionInfo"] });
const ENC = "документ зашифрован — пароль не запрашивается";

describe("Материалы RTF и DOC", () => {
  it.skipIf(!mac)("RTF saved as .txt and DOC saved as .bin are read by content", () => {
    const rtf = put("a.txt", makeRtf(["Первая строка", "Вторая строка"]));
    const doc = put("b.bin", docBytes(["Первая строка", "Вторая строка"]));
    expect(collectMaterials([rtf], opts).materials[0]).toMatchObject({ text: TEXT });
    expect(collectMaterials([doc], opts).materials[0]).toMatchObject({ text: TEXT, chars: TEXT.length, sha256: sha256Of(TEXT) });
  }, 30_000);

  it("fake.rtf with plain text stays plain text", () => {
    const f = put("fake.rtf", "just notes, not RTF\n");
    expect(collectMaterials([f], opts).materials[0]).toMatchObject({ text: "just notes, not RTF\n" });
  });

  it("encrypted Office file: explicit file refused with the reason, in a folder skipped, README collected", () => {
    const f = put("secret.docx", enc());
    const reasons = refusal(() => collectMaterials([f], opts)).reasons;
    expect(reasons).toEqual([`«${f}»: ${ENC}`]);
    expect(reasons[0]).not.toContain("не текстовый");
    put("d/README.md", "читай");
    put("d/secret.docx", enc());
    const set = collectMaterials([join(root, "d")], opts);
    expect(set.materials.map((m) => m.name)).toEqual(["d/README.md"]);
    expect(set.skipped).toEqual([{ name: "d/secret.docx", reason: ENC }]);
  });

  it("encrypted reason in English", () => {
    const prev = getProcessLanguage();
    setProcessLanguage("en");
    try {
      const f = put("secret.docx", enc());
      expect(refusal(() => collectMaterials([f], opts)).reasons).toEqual([`«${f}»: document is encrypted — no password is requested`]);
    } finally {
      setProcessLanguage(prev);
    }
  });

  it("a CFB without WordDocument is a non-text file as before; a looping CFB is damaged, fast", () => {
    const f = put("sheet.bin", makeCfb({ streams: ["Workbook"] }));
    expect(refusal(() => collectMaterials([f], opts)).reasons).toEqual([`«${f}»: нетекстовый файл (не UTF-8 или бинарные данные)`]);
    const loop = put("loop.doc", makeCfb({ streams: ["WordDocument"], loop: true }));
    const t0 = Date.now();
    expect(refusal(() => collectMaterials([loop], opts)).reasons).toEqual([`«${loop}»: документ повреждён`]);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it.skipIf(!mac)("in a folder a damaged RTF and an RTF without the converter are skipped with their reasons, README collected", () => {
    put("d/README.md", "читай");
    put("d/broken.rtf", "{\\rtf1 {");
    put("d/note.rtf", makeRtf(["Первая строка"]));
    setDocumentExtractorRuntime({ tools: { sandbox: join(root, "missing-sandbox-exec"), textutil: "/usr/bin/textutil" } });
    try {
      const set = collectMaterials([join(root, "d")], opts);
      expect(set.materials.map((m) => m.name)).toEqual(["d/README.md"]);
      expect(set.skipped).toEqual([
        { name: "d/broken.rtf", reason: "не удалось извлечь текст — системная утилита textutil недоступна" },
        { name: "d/note.rtf", reason: "не удалось извлечь текст — системная утилита textutil недоступна" },
      ]);
    } finally {
      setDocumentExtractorRuntime();
    }
    const broken = join(root, "d", "broken.rtf");
    expect(refusal(() => collectMaterials([broken], opts)).reasons).toEqual([`«${broken}»: документ повреждён`]);
    const set = collectMaterials([join(root, "d")], opts);
    expect(set.materials.map((m) => m.name)).toEqual(["d/README.md", "d/note.rtf"]);
    expect(set.skipped).toEqual([{ name: "d/broken.rtf", reason: "документ повреждён" }]);
  }, 30_000);

  it.skipIf(!mac)("folder over the limit: notes.rtf and spec.doc are descriptions next to source", () => {
    put("d/README.md", "r".repeat(10));
    put("d/notes.rtf", makeRtf(["Первая строка"]));
    put("d/spec.doc", docBytes(["Вторая строка"]));
    put("d/code.ts", "c".repeat(50));
    const r = collectSessionMaterials([join(root, "d")], { ...opts, materialsChars: 50 });
    expect(r.materials.map((m) => m.name)).toEqual(["d/README.md", "d/notes.rtf", "d/spec.doc"]);
    expect(r.left.map((l) => l.name)).toEqual(["d/code.ts"]);
  }, 30_000);
});

describe("Каталог причин", () => {
  it("no two string messages of the document reasons are equal, ru and en", () => {
    for (const lang of ["ru", "en"] as const) {
      const m = materialsMessages(lang) as Record<string, unknown>;
      const values = Object.entries(m).filter(([k, v]) => k.startsWith("doc") && typeof v === "string").map(([, v]) => v);
      expect(new Set(values).size, lang).toBe(values.length);
      expect(values).toContain(lang === "ru" ? "не удалось извлечь текст — системная утилита textutil недоступна" : "text could not be extracted — the system utility textutil is unavailable");
    }
  });
});
