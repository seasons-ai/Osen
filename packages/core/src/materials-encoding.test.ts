import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "./i18n/process-language.ts";
import { collectMaterials, MaterialsError, type CollectOptions } from "./materials.ts";
import { materialsMessages } from "./messages/materials.ts";
import { enc1251, encKoi8r, utf16be, utf16le } from "./text-encoding.testutil.ts";

const opts: CollectOptions = { materialsChars: 100_000, materialsIgnore: [] };
const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const RU = "Привет, мир! Это обычный русский текст для проверки кодировки.\nВторая строка.";
const UNKNOWN_RU = "кодировка не распознана — нужен UTF-8, UTF-16 с BOM или Windows-1251";
const UNKNOWN_EN = "encoding not recognized — UTF-8, UTF-16 with BOM or Windows-1251 is required";
let root: string;
beforeEach(() => { setProcessLanguage("ru"); root = realpathSync(mkdtempSync(join(tmpdir(), "materials-enc-"))); });
afterEach(() => { setProcessLanguage("ru"); rmSync(root, { recursive: true, force: true }); });

function put(rel: string, content: Uint8Array | string): string {
  const f = join(root, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, content);
  return f;
}
const one = (f: string) => collectMaterials([f], opts).materials[0]!;
function reasonOf(f: string): string {
  try { collectMaterials([f], opts); } catch (e) { expect(e).toBeInstanceOf(MaterialsError); return (e as MaterialsError).reasons[0]!; }
  throw new Error("refusal expected");
}
const refusedWith = (f: string, reason: string) => expect(reasonOf(f)).toBe(`«${f}»: ${reason}`);
const NON_TEXT = "двоичный файл неизвестного формата";
// bytes b[i] each followed by a space: never valid UTF-8 for b >= 0x80
const spaced = (bytes: number[]) => Buffer.from(bytes.flatMap((b) => [b, 0x20]));

describe("text encodings in materials", () => {
  it("UTF-16 LE and BE with BOM: decoded text equals source, chars counts decoded text", () => {
    for (const buf of [utf16le(RU), utf16be(RU)]) {
      const m = one(put("a.txt", buf));
      expect(m.text).toBe(RU);
      expect(m.chars).toBe(RU.length);
      expect(m.sha256).toBe(sha(RU));
    }
  });

  it("UTF-8 with BOM: no U+FEFF, sha256 of text without BOM", () => {
    const m = one(put("a.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(RU)])));
    expect(m.text[0]).not.toBe("﻿");
    expect(m.text).toBe(RU);
    expect(m.sha256).toBe(sha(RU));
  });

  it("Windows-1251 is accepted as the source text", () => {
    const m = one(put("a.csv", enc1251(RU)));
    expect(m).toMatchObject({ text: RU, chars: RU.length, sha256: sha(RU) });
  });

  it("UTF-16 without BOM stays non-text, not encodingUnknown", () => {
    refusedWith(put("a.txt", Buffer.from(RU, "utf16le")), NON_TEXT);
    refusedWith(put("latin.txt", Buffer.from("Hello, world.", "utf16le")), NON_TEXT);
  });

  it("UTF-8 BOM followed by invalid UTF-8 is encodingUnknown, not Windows-1251 with the BOM bytes", () => {
    refusedWith(put("b8.txt", Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])), UNKNOWN_RU);
  });

  it("KOI8-R Russian text with realistic lowercase share, odd UTF-16, lone surrogate, UTF-32, controls in UTF-16", () => {
    refusedWith(put("k.txt", encKoi8r("Привет, Мир. Это Обычный русский Текст")), UNKNOWN_RU);
    refusedWith(put("o.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("abc")])), UNKNOWN_RU);
    refusedWith(put("s.txt", Buffer.from([0xff, 0xfe, 0x00, 0xd8, 0x61, 0x00])), UNKNOWN_RU);
    refusedWith(put("u32.txt", Buffer.from([0xff, 0xfe, 0, 0, 0x61, 0, 0, 0])), UNKNOWN_RU);
    refusedWith(put("u32be.txt", Buffer.from([0, 0, 0xfe, 0xff, 0, 0, 0, 0x61])), UNKNOWN_RU);
  });

  it("UTF-16 LE and BE with BOM and a control char get the same non-text reason as UTF-8 with that text", () => {
    const t = "при\u0001вет";
    const u8 = reasonOf(put("u8.txt", t)).replace(/^«[^»]*»: /, "");
    expect(u8).toBe(NON_TEXT);
    refusedWith(put("le.txt", utf16le(t)), NON_TEXT);
    refusedWith(put("be.txt", utf16be(t)), NON_TEXT);
  });

  it("Western 8-bit (Latin-1) text is encodingUnknown, explicit and in a folder", () => {
    const csv = "Prénom;Ville;Remarque\nRené;Genève;très bien, déjà payé\nJürgen;München;schön, Grüße\n";
    refusedWith(put("latin1.csv", Buffer.from(csv, "latin1")), UNKNOWN_RU);
    put("w/latin1.csv", Buffer.from(csv, "latin1"));
    put("w/ok.txt", "plain");
    const r = collectMaterials([join(root, "w")], opts);
    expect(r.materials.map((m) => m.text)).toEqual(["plain"]);
    expect(r.skipped).toEqual([{ name: "w/latin1.csv", reason: UNKNOWN_RU }]);
  });

  it("Russian Windows-1251 with Latin words and addresses, and Ukrainian, are accepted verbatim", () => {
    const ru = "Имя;Город;Комментарий\nИван;Москва;оплачено, ivan@mail.ru, PDF-файл через Wi-Fi роутер, API\n";
    const ua = "Олеся;Київ;їжак ґанок Європа\n";
    expect(one(put("ru.csv", enc1251(ru))).text).toBe(ru);
    expect(one(put("ua.csv", enc1251(ua))).text).toBe(ua);
  });

  it("threshold: exactly 20 % of Cyrillic letters next to a Latin letter accepted, just above rejected", () => {
    const ok = "аx бx в г д е ж з и к";
    expect(one(put("ok20.txt", enc1251(ok))).text).toBe(ok);
    refusedWith(put("bad20.txt", enc1251("аx бx в г д е ж з и")), UNKNOWN_RU);
  });

  it("threshold: exactly 90 % Cyrillic accepted, just below rejected", () => {
    const cyr = Array(9).fill(0xe0);
    const ok = put("ok.txt", spaced([...cyr, 0xa3]));
    expect(one(ok).text).toBe(("а ".repeat(9) + "Ј "));
    const bad = put("bad.txt", spaced([...Array(17).fill(0xe0), 0xa3, 0xa3]));
    refusedWith(bad, UNKNOWN_RU);
  });

  it("a control byte with a high Cyrillic share: non-text", () => {
    refusedWith(put("c.txt", Buffer.concat([enc1251(RU), Buffer.from([0x01])])), NON_TEXT);
    refusedWith(put("d.txt", Buffer.concat([enc1251(RU), Buffer.from([0x7f])])), NON_TEXT);
  });

  it("typographic bytes are neutral: Cyrillic below 90 % of all high bytes is accepted", () => {
    const t = "«а» — «б» — «в» … №5 «г» — «д» … №6";
    const buf = enc1251(t);
    const high = buf.filter((b) => b >= 0x80).length, cyr = buf.filter((b) => b >= 0xe0).length;
    expect(cyr / high).toBeLessThan(0.9);
    expect(one(put("t.txt", buf)).text).toBe(t);
  });

  it("Ukrainian letters count as Cyrillic", () => {
    const t = "їжак ґанок Європа Іван Ўзбек";
    expect(one(put("u.txt", enc1251(t))).text).toBe(t);
  });

  it("all-uppercase text and only « » high bytes are not recognized", () => {
    refusedWith(put("up.txt", enc1251("ПРИВЕТ МИР ЭТО ТЕКСТ")), UNKNOWN_RU);
    refusedWith(put("q.txt", enc1251("«quote» and «more»")), UNKNOWN_RU);
  });

  it("in a folder the same file is skipped with the same reason, other files are collected", () => {
    put("d/ok.txt", "plain");
    put("d/koi.txt", encKoi8r("Привет, Мир. Это Обычный русский Текст"));
    put("d/w.txt", enc1251(RU));
    const r = collectMaterials([join(root, "d")], opts);
    expect(r.materials.map((m) => m.text).sort()).toEqual(["plain", RU].sort());
    expect(r.skipped).toEqual([{ name: "d/koi.txt", reason: UNKNOWN_RU }]);
  });

  it("reason text in en and ru", () => {
    expect(materialsMessages().encodingUnknown).toBe(UNKNOWN_RU);
    setProcessLanguage("en");
    expect(materialsMessages().encodingUnknown).toBe(UNKNOWN_EN);
    refusedWith(put("k.txt", encKoi8r("Привет, Мир. Это Обычный русский Текст")), UNKNOWN_EN);
  });
});
