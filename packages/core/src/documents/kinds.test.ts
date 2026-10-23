import { mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "../i18n/process-language.ts";
import { collectMaterials, MaterialsError, type CollectOptions } from "../materials.ts";
import { materialsMessages } from "../messages/materials.ts";
import { encKoi8r } from "../text-encoding.testutil.ts";
import { makeDocx, makeZip, p } from "./fixture.ts";
import { KIND_FIXTURES } from "./kind-fixtures.ts";
import { fileKind, KIND_SIGNATURES, nonTextReason, type FileKindId } from "./kinds.ts";

const SLOW = 60_000;
const opts: CollectOptions = { materialsChars: 100_000, materialsIgnore: [] };
const KINDS: FileKindId[] = ["mp3", "aac", "m4a", "wav", "aiff", "flac", "ogg", "video", "rar", "7z", "tar", "gzip", "bzip2", "xz", "zstd", "dmg", "program", "sqlite", "font", "xls", "ppt", "iwork", "xlsb", "unknown"];
const EN: Record<FileKindId, string> = {
  mp3: "MP3 audio — transcription is not performed", aac: "AAC audio — transcription is not performed", m4a: "M4A audio — transcription is not performed",
  wav: "WAV audio — transcription is not performed", aiff: "AIFF audio — transcription is not performed", flac: "FLAC audio — transcription is not performed",
  ogg: "OGG audio — transcription is not performed", video: "video — the content is not passed on",
  rar: "RAR archive — only ZIP is unpacked", "7z": "7z archive — only ZIP is unpacked", tar: "tar archive — only ZIP is unpacked", gzip: "gzip archive — only ZIP is unpacked",
  bzip2: "bzip2 archive — only ZIP is unpacked", xz: "xz archive — only ZIP is unpacked", zstd: "zstd archive — only ZIP is unpacked",
  dmg: "DMG disk image — only ZIP is unpacked", program: "program — not a material", sqlite: "SQLite database — not supported", font: "font — not a material",
  xls: "Excel 97 spreadsheet — save it as XLSX", ppt: "PowerPoint 97 presentation — save it as PPTX",
  iwork: "Apple iWork document (Pages, Numbers, Keynote) — export it to DOCX, XLSX, PPTX or PDF", xlsb: "Excel binary workbook (XLSB) — save it as XLSX", unknown: "binary file of an unknown format",
};
const RU: Record<FileKindId, string> = {
  mp3: "аудио MP3 — расшифровка не выполняется", aac: "аудио AAC — расшифровка не выполняется", m4a: "аудио M4A — расшифровка не выполняется",
  wav: "аудио WAV — расшифровка не выполняется", aiff: "аудио AIFF — расшифровка не выполняется", flac: "аудио FLAC — расшифровка не выполняется",
  ogg: "аудио OGG — расшифровка не выполняется", video: "видео — содержимое не передаётся",
  rar: "архив RAR — раскрывается только ZIP", "7z": "архив 7z — раскрывается только ZIP", tar: "архив tar — раскрывается только ZIP", gzip: "архив gzip — раскрывается только ZIP",
  bzip2: "архив bzip2 — раскрывается только ZIP", xz: "архив xz — раскрывается только ZIP", zstd: "архив zstd — раскрывается только ZIP",
  dmg: "образ диска DMG — раскрывается только ZIP", program: "программа — не материал", sqlite: "база SQLite — не поддерживается", font: "шрифт — не материал",
  xls: "таблица Excel 97 — сохраните как XLSX", ppt: "презентация PowerPoint 97 — сохраните как PPTX",
  iwork: "документ Apple iWork (Pages, Numbers, Keynote) — экспортируйте в DOCX, XLSX, PPTX или PDF", xlsb: "двоичная книга Excel (XLSB) — сохраните как XLSX", unknown: "двоичный файл неизвестного формата",
};
const ALL_REASONS = new Set([...Object.values(EN), ...Object.values(RU)]);

let root: string;
beforeEach(() => { setProcessLanguage("ru"); root = realpathSync(mkdtempSync(join(tmpdir(), "kinds-"))); });
afterEach(() => { setProcessLanguage("ru"); rmSync(root, { recursive: true, force: true }); });

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
const explicit = (f: string): string => refusal(() => collectMaterials([f], opts)).reasons[0]!;
// mulberry32: a seeded generator, the same sequence on every run
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Kind table", () => {
  it("every kind has an exact en and ru reason", () => {
    for (const kind of KINDS) {
      setProcessLanguage("en");
      expect(materialsMessages().kindReason(kind)).toBe(EN[kind]);
      setProcessLanguage("ru");
      expect(materialsMessages().kindReason(kind)).toBe(RU[kind]);
    }
  });

  it("the fixtures cover every kind", () => {
    expect(new Set(KIND_FIXTURES.map((f) => f.kind))).toEqual(new Set(KINDS));
  });

  it("fileKind names the table kinds from the first bytes", () => {
    for (const f of KIND_FIXTURES) {
      if (["xls", "ppt", "iwork", "xlsb", "unknown"].includes(f.kind)) continue;
      const b = Buffer.from(f.bytes);
      expect(fileKind(b.subarray(0, 8192), b.subarray(b.length - 512)), f.name).toBe(f.kind);
    }
  });

  it("DMG trailer wins over a compressed start; a signature at the wrong place does not count", () => {
    const dmg = KIND_FIXTURES.find((f) => f.name === "dmg")!.bytes;
    expect(fileKind(Buffer.from(dmg).subarray(0, 8192))).toBe("bzip2");
    expect(fileKind(Buffer.from(dmg).subarray(0, 8192), Buffer.from(dmg).subarray(512))).toBe("dmg");
    expect(fileKind(Buffer.from("xxID3"))).toBeUndefined();
    expect(fileKind(Buffer.from([0xff, 0xfe, 0x00, 0xd8]))).toBeUndefined(); // UTF-16 LE BOM is not an MPEG frame
    expect(fileKind(Buffer.from([0xff, 0xfb, 0xf0, 0x00]))).toBeUndefined(); // bitrate index 15
    expect(fileKind(Buffer.from("BZh0"))).toBeUndefined();
  });
});

describe("Reasons through collectMaterials", () => {
  it("each fixture: explicit file refused with its reason, same file in a folder skipped, en and ru", () => {
    for (const lang of ["en", "ru"] as const) {
      setProcessLanguage(lang);
      const table = lang === "en" ? EN : RU;
      for (const f of KIND_FIXTURES) {
        const file = put(`explicit/${lang}-${f.name}.bin`, f.bytes);
        expect(explicit(file), f.name).toBe(`«${file}»: ${table[f.kind]}`);
        put(`dir-${lang}/${f.name}.bin`, f.bytes);
      }
      put(`dir-${lang}/ok.txt`, "ok");
      const set = collectMaterials([join(root, `dir-${lang}`)], opts);
      expect(set.materials.map((x) => x.name)).toEqual([`dir-${lang}/ok.txt`]);
      for (const f of KIND_FIXTURES) expect(set.skipped.find((s) => s.name === `dir-${lang}/${f.name}.bin`)?.reason, f.name).toBe(table[f.kind]);
    }
  }, SLOW);

  it("the kind comes from the content, not the extension", () => {
    const mp3 = KIND_FIXTURES.find((f) => f.name === "mp3-id3")!.bytes;
    const notes = put("notes.txt", mp3);
    expect(explicit(notes)).toBe(`«${notes}»: ${RU.mp3}`);
    const track = put("track.mp3", "Это обычный текст.");
    expect(collectMaterials([track], opts).materials[0]!.text).toBe("Это обычный текст.");
  });

  it("KOI8-R text keeps the encoding reason, not a kind reason; a broken UTF-16 LE file too", () => {
    const koi = put("koi.txt", encKoi8r("Привет, мир! Это русский текст в KOI8-R."));
    expect(explicit(koi)).toBe(`«${koi}»: кодировка не распознана — нужен UTF-8, UTF-16 с BOM или Windows-1251`);
    const broken = put("broken.txt", Buffer.from([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00]));
    expect(explicit(broken)).toBe(`«${broken}»: кодировка не распознана — нужен UTF-8, UTF-16 с BOM или Windows-1251`);
  });

  it("KOI8-R text starting with a short signature (MZ, ID3, BZh9) keeps the encoding reason; a 4+ byte signature names the kind (design limit)", () => {
    const reason = "кодировка не распознана — нужен UTF-8, UTF-16 с BOM или Windows-1251";
    for (const start of ["MZ", "ID3", "BZh9"]) {
      const f = put(`koi-${start}.txt`, Buffer.concat([Buffer.from(start, "latin1"), encKoi8r(" Привет, мир! Это русский текст в KOI8-R.")]));
      expect(explicit(f)).toBe(`«${f}»: ${reason}`);
    }
    const riff = put("koi-riff.txt", Buffer.concat([Buffer.from("RIFF1234WAVE", "latin1"), encKoi8r(" Привет, мир!")]));
    expect(explicit(riff)).toBe(`«${riff}»: ${RU.wav}`);
  });

  it("a CFB over 100 MiB gets the document size reason, as inside an archive; an iWork over 100 MiB gets the ZIP size reason", () => {
    const cfb = put("big.xls", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    truncateSync(cfb, 150 * 2 ** 20);
    expect(explicit(cfb)).toBe(`«${cfb}»: ${materialsMessages().docBytes(100)}`);
    const iwork = put("big.pages", KIND_FIXTURES.find((f) => f.name === "iwork")!.bytes);
    truncateSync(iwork, 150 * 2 ** 20);
    expect(explicit(iwork)).toBe(`«${iwork}»: ${materialsMessages().zipTooLarge(100)}`);
  }, SLOW);

  it("iWork renamed .zip is not expanded, in a folder it is skipped with the iWork reason", () => {
    const iwork = KIND_FIXTURES.find((f) => f.name === "iwork")!.bytes;
    const f = put("deck.zip", iwork);
    expect(refusal(() => collectMaterials([f], opts)).reasons).toEqual([`«${f}»: ${RU.iwork}`]);
    put("d/a.md", "a");
    put("d/deck.zip", iwork);
    const set = collectMaterials([join(root, "d")], opts);
    expect(set.materials.map((x) => x.name)).toEqual(["d/a.md"]);
    expect(set.skipped).toEqual([{ name: "d/deck.zip", reason: RU.iwork }]);
  }, SLOW);

  it("a ZIP over 100 MiB gets the size reason, a plain ZIP is still expanded", () => {
    const big = put("big.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    truncateSync(big, 150 * 2 ** 20);
    expect(explicit(big)).toBe(`«${big}»: ${materialsMessages().zipTooLarge(100)}`);
    const plain = put("plain.zip", makeZip([{ name: "a.txt", data: "a" }]));
    expect(collectMaterials([plain], opts).materials.map((x) => x.name)).toEqual(["plain.zip/a.txt"]);
  }, SLOW);

  it("a damaged DOCX keeps its document reason", () => {
    const f = put("bad.docx", makeDocx({ body: "<w:p>" }));
    expect(explicit(f)).toBe(`«${f}»: ${materialsMessages().docDamaged}`);
    const ok = put("ok.docx", makeDocx({ body: p("Первая строка") }));
    expect(collectMaterials([ok], opts).materials[0]!.text).toContain("Первая строка");
  }, SLOW);

  it("archive entries get the kind reasons; a nested ZIP stays a nested archive", () => {
    const by = (name: string) => KIND_FIXTURES.find((f) => f.name === name)!.bytes;
    const f = put("pack.zip", makeZip([
      { name: "a.txt", data: "a" }, { name: "song.mp3", data: by("mp3-id3") }, { name: "app.exe", data: by("pe") }, { name: "deck.key", data: by("iwork") },
      { name: "sheet.xls", data: by("xls") }, { name: "disk.dat", data: by("dmg") }, { name: "inner.zip", data: makeZip([{ name: "b.txt", data: "b" }]) },
    ]));
    const set = collectMaterials([f], opts);
    expect(set.materials.map((x) => x.name)).toEqual(["pack.zip/a.txt"]);
    const reason = (n: string) => set.skipped.find((s) => s.name === `pack.zip/${n}`)?.reason;
    expect(reason("song.mp3")).toBe(RU.mp3);
    expect(reason("app.exe")).toBe(RU.program);
    expect(reason("deck.key")).toBe(RU.iwork);
    expect(reason("sheet.xls")).toBe(RU.xls);
    expect(reason("disk.dat")).toBe(RU.dmg);
    expect(reason("inner.zip")).toBe(materialsMessages().archiveNested);
  }, SLOW);
});

describe("Properties (seeded)", () => {
  it("text starting with a signature prefix is accepted as text", () => {
    const next = rng(216);
    const words = ["alpha", "beta", "привет", "мир", "x = 1;", "- item", "tail"];
    for (const prefix of ["ID3", "MZ", "BZh", "BZh9", "OggS", "RIFF", "PK", "fLaC", "Rar!", "true", "OTTO", "ttcf", "wOFF", "SQLite format 3", "!<arch>"]) {
      for (let i = 0; i < 4; i++) {
        const body = Array.from({ length: 1 + Math.floor(next() * 40) }, () => words[Math.floor(next() * words.length)]).join(" ");
        const text = `${prefix} ${body}\n`;
        const m = collectMaterials([put(`t/${prefix.replace(/\W/g, "_")}-${i}.txt`, text)], opts).materials[0]!;
        expect(m.text, prefix).toBe(text);
      }
    }
  });

  it("any bytes: text, or a kind reason, or the encoding fallback, never anything else", () => {
    const next = rng(2161);
    const prefixes = KIND_SIGNATURES.map((s) => Buffer.concat([Buffer.alloc(s.offset), s.bytes]));
    const fallback = "кодировка не распознана — нужен UTF-8, UTF-16 с BOM или Windows-1251";
    for (let i = 0; i < 150; i++) {
      const tail = Buffer.from(Array.from({ length: Math.floor(next() * 600) }, () => Math.floor(next() * 256)));
      const bytes = next() < 0.7 ? Buffer.concat([prefixes[Math.floor(next() * prefixes.length)]!, tail]) : tail;
      const head = bytes.subarray(0, 8192);
      expect(ALL_REASONS.has(nonTextReason(head, bytes.length >= 512 ? bytes.subarray(bytes.length - 512) : undefined)), `case ${i}`).toBe(true);
      expect(nonTextReason(head, undefined, fallback) === fallback || ALL_REASONS.has(nonTextReason(head, undefined, fallback))).toBe(true);
    }
  });

  it("random files through collectMaterials: accepted, or one of the known reasons", () => {
    const next = rng(21611);
    const starts = [Buffer.from("ID3"), Buffer.from("MZ"), Buffer.from("BZh"), Buffer.from("OggS"), Buffer.from("RIFF"), Buffer.from([0x1f, 0x8b]), Buffer.from("fLaC"), Buffer.alloc(0)];
    for (let i = 0; i < 60; i++) {
      const tail = Buffer.from(Array.from({ length: Math.floor(next() * 400) }, () => Math.floor(next() * 256)));
      const f = put(`rnd/${i}.bin`, Buffer.concat([starts[Math.floor(next() * starts.length)]!, tail]));
      try {
        collectMaterials([f], opts);
      } catch (e) {
        const reason = (e as MaterialsError).reasons[0]!.replace(`«${f}»: `, "");
        expect(ALL_REASONS.has(reason) || reason.startsWith("кодировка не распознана"), `case ${i}: ${reason}`).toBe(true);
      }
    }
  });
});
