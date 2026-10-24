import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { setProcessLanguage } from "../i18n/process-language.ts";
import { htmlToText } from "../url/html-text.ts";
import { extractDocument } from "./detect.ts";
import { DOC_LIMITS, documentReason, extractDocumentText } from "./extract.ts";
import { makeEpub, xhtml, type EpubChapter } from "./epub-fixture.ts";

const run = (bytes: Uint8Array) => extractDocument(bytes, DOC_LIMITS);
const ch = (n: number, body = `<p>Глава ${n}</p>`, extra: Partial<EpubChapter> = {}): EpubChapter =>
  ({ path: `OEBPS/ch${n}.xhtml`, html: xhtml(body), ...extra });
const enc = (uri: string, alg = "http://www.w3.org/2001/04/xmlenc#aes128-cbc"): string =>
  `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="${alg}"/><enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData></enc:EncryptedData></encryption>`;

describe("EPUB text", () => {
  it("Порядок глав по спайну", () => {
    const chapters = [ch(1), ch(2), ch(3)];
    const r = run(makeEpub({ chapters, archiveOrder: ["OEBPS/ch3.xhtml", "OEBPS/ch1.xhtml", "OEBPS/ch2.xhtml"] }));
    expect(r).toEqual({ ok: true, text: "Глава 1\n\nГлава 2\n\nГлава 3", format: "epub" });
  });

  it("Правила HTML-текста и служебное", () => {
    const body = '<h1>Заголовок</h1><p>Абзац <b>один</b></p><table><tr><td>a</td><td>б</td></tr></table><pre>  код\n  строка</pre>' +
      '<p hidden>СКРЫТО1</p><p style="display:none">СКРЫТО2</p><script>var СКРИПТ=1</script><style>p{}</style><img src="x.png" alt="картинка">';
    const html = xhtml(body);
    const r = run(makeEpub({ chapters: [{ path: "OEBPS/a.xhtml", html }] }));
    expect(r).toMatchObject({ ok: true, text: htmlToText(html) });
    for (const bad of ["СКРЫТО", "СКРИПТ", "p{}", "картинка"]) expect((r as { text: string }).text).not.toContain(bad);
    expect((r as { text: string }).text).toContain("Абзац один");
  });

  it("linear=no is included, a non-XHTML spine item is skipped", () => {
    const chapters = [ch(1), ch(2, "<p>Глава 2</p>", { linear: "no" }), { path: "OEBPS/pic.svg", html: "<svg/>", mediaType: "image/svg+xml" }];
    expect(run(makeEpub({ chapters }))).toMatchObject({ ok: true, text: "Глава 1\n\nГлава 2" });
  });

  it("Обфускация шрифтов и DRM", () => {
    const font = enc("OEBPS/f.otf", "http://www.idpf.org/2008/embedding");
    const fontPart = { name: "OEBPS/f.otf", data: "font" };
    expect(run(makeEpub({ chapters: [ch(1)], encryption: font, extraParts: [fontPart] }))).toMatchObject({ ok: true });
    const drm = run(makeEpub({ chapters: [ch(1)], encryption: enc("OEBPS/ch1.xhtml") }));
    expect(drm).toEqual({ ok: false, code: "drm" });
    expect(run(makeEpub({ chapters: [ch(1)], encryption: enc("OEBPS/%63h1.xhtml") }))).toEqual({ ok: false, code: "drm" });
    setProcessLanguage("ru");
    expect(documentReason({ code: "drm" })).toBe("книга защищена DRM — содержимое недоступно");
  });

  it("Битая книга", () => {
    setProcessLanguage("ru");
    const one = [ch(1)];
    const missing = run(makeEpub({ chapters: [ch(1), ch(2)], archiveOrder: ["OEBPS/ch1.xhtml"] }));
    expect(missing).toEqual({ ok: false, code: "damaged", detail: "OEBPS/ch2.xhtml" });
    expect(documentReason(missing as { code: "damaged"; detail: string })).toBe("документ повреждён — OEBPS/ch2.xhtml");
    expect(run(makeEpub({ chapters: [{ ...ch(1), path: "OEBPS/x.xhtml" }], spine: ["nope"] }))).toEqual({ ok: false, code: "damaged", detail: "nope" });
    const opfWith = (href: string): string => `<package><manifest><item id="c1" href="${href}" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
    for (const href of ["../../etc/passwd", "/etc/passwd", "%2e%2e/%2e%2e/x.xhtml", "%zz.xhtml"])
      expect(run(makeEpub({ chapters: one, opf: opfWith(href) }))).toEqual({ ok: false, code: "damaged", detail: href });
    expect(run(makeEpub({ chapters: one, opf: opfWith("ch1.xhtml#frag") }))).toMatchObject({ ok: true });
    expect(run(makeEpub({ chapters: one, container: false }))).toEqual({ ok: false, code: "damaged", detail: "META-INF/container.xml" });
    const noRoot = '<container><rootfiles><rootfile full-path="a.opf" media-type="text/plain"/></rootfiles></container>';
    expect(run(makeEpub({ chapters: one, container: noRoot }))).toEqual({ ok: false, code: "damaged", detail: "META-INF/container.xml" });
    expect(run(makeEpub({ chapters: one, container: '<!DOCTYPE container [<!ENTITY x "y">]><container/>' }))).toEqual({ ok: false, code: "damaged", detail: "META-INF/container.xml" });
    expect(run(makeEpub({ chapters: one, opf: '<!DOCTYPE package><package/>' }))).toEqual({ ok: false, code: "damaged", detail: "OEBPS/content.opf" });
    // a chapter is an HTML part even when stored as .xml: its <!DOCTYPE html> does not damage the book
    const xmlChapter = makeEpub({ chapters: [{ path: "OEBPS/ch1.xml", html: "<!DOCTYPE html><html><body><p>Глава в xml</p></body></html>" }] });
    expect(run(xmlChapter)).toEqual({ ok: true, text: "Глава в xml", format: "epub" });
    expect(run(makeEpub({ chapters: one, opf: "<package" }))).toEqual({ ok: false, code: "damaged", detail: "OEBPS/content.opf" });
    const cp1251 = '<?xml version="1.0" encoding="windows-1251"?><html><body><p>x</p></body></html>';
    expect(run(makeEpub({ chapters: [{ path: "OEBPS/ch1.xhtml", html: cp1251 }] }))).toEqual({ ok: false, code: "damaged", detail: "OEBPS/ch1.xhtml" });
    const invalid = makeEpub({ chapters: [{ path: "OEBPS/ch1.xhtml", html: "" }], archiveOrder: [], extraParts: [{ name: "OEBPS/ch1.xhtml", data: Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe]) }] });
    expect(run(invalid)).toEqual({ ok: false, code: "damaged", detail: "OEBPS/ch1.xhtml" });
    const bom = makeEpub({ chapters: [{ path: "OEBPS/ch1.xhtml", html: "﻿" + xhtml("<p>Текст</p>") }] });
    expect(run(bom)).toMatchObject({ ok: true, text: "Текст" });
  });

  it("chars and no_text", () => {
    const bytes = makeEpub({ chapters: [ch(1, "<p>первая глава</p>"), ch(2, "<p>вторая глава</p>")] });
    expect(extractDocument(bytes, { ...DOC_LIMITS, chars: 10 })).toEqual({ ok: false, code: "chars" });
    expect(extractDocument(bytes, { ...DOC_LIMITS, chars: 1000 })).toMatchObject({ ok: true });
    expect(run(makeEpub({ chapters: [ch(1, ""), ch(2, "<p> </p><script>x</script>")] }))).toEqual({ ok: false, code: "no_text" });
  });

  it("goes through a real child process", () => {
    const bytes = makeEpub({ chapters: [ch(1), ch(2)] });
    expect(extractDocumentText(bytes)).toEqual({ ok: true, text: "Глава 1\n\nГлава 2", format: "epub" });
  }, 20_000);

  it("Текст EPUB: порядок глав", () => {
    let seed = 20261022;
    const rnd = (): number => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const shuffle = <T>(a: T[]): T[] => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [r[i], r[j]] = [r[j]!, r[i]!]; } return r; };
    for (let it = 0; it < 200; it++) {
      const n = 1 + Math.floor(rnd() * 12);
      const chapters = Array.from({ length: n }, (_, i) => ch(i + 1, rnd() < 0.25 ? "" : `<p>глава-${it}-${i}</p>`));
      const spine = shuffle(chapters.map((c) => c.id ?? `c${chapters.indexOf(c) + 1}`));
      const byId = new Map(chapters.map((c, i) => [`c${i + 1}`, c]));
      const expected = spine.map((id) => htmlToText(byId.get(id)!.html)).filter((t) => t !== "").join("\n\n");
      const r = run(makeEpub({ chapters, spine, archiveOrder: shuffle(chapters.map((c) => c.path)) }));
      if (expected === "") expect(r).toEqual({ ok: false, code: "no_text" });
      else expect(r, `iteration ${it}`).toEqual({ ok: true, text: expected, format: "epub" });
    }
  });

  it("Текст EPUB: Самозакрытый служебный тег в главе", () => {
    const first = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title/></head><body><p>Hello chapter</p></body></html>';
    const second = '<html xmlns="http://www.w3.org/1999/xhtml"><head><script/><style/></head><body><textarea/><p>Second chapter</p><TITLE  lang="en" /><p>Tail</p></body></html>';
    expect(run(makeEpub({ chapters: [{ path: "OEBPS/ch1.xhtml", html: first }, { path: "OEBPS/ch2.xhtml", html: second }] })))
      .toEqual({ ok: true, text: "Hello chapter\n\nSecond chapter\n\nTail", format: "epub" });
    expect(run(makeEpub({ chapters: [{ path: "OEBPS/ch1.xhtml", html: first }] }))).toEqual({ ok: true, text: "Hello chapter", format: "epub" });
  });

  // The attack runs only in a child with a finite watchdog: a vitest timeout cannot interrupt synchronous regex work.
  it("Текст EPUB: линейное раскрытие на длинном входе", async () => {
    const probe = `
      const { epubText } = await import(${JSON.stringify(new URL("./epub.ts", import.meta.url).href)});
      const enc = new TextEncoder();
      const forms = [
        (n) => "<title" + " ".repeat(n),
        (n) => "<script ".repeat(n / 8),
        (n) => "<title" + "/".repeat(n),
        (n) => "<title/>".repeat(n / 8) + "<p>B</p>",
      ];
      const parts = (html) => new Map([
        ["META-INF/container.xml", '<container><rootfiles><rootfile full-path="c.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
        ["c.opf", '<package><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>'],
        ["a.xhtml", "<html><body><p>A</p>" + html + "</body></html>"],
      ].map(([k, v]) => [k, enc.encode(v)]));
      const brief = (s) => s.length > 200 ? "length " + s.length : s;
      const text = (n, f) => { const m = parts(forms[f](n)); try { return brief(epubText({ entries: m, read: (k) => m.get(k) }, 1e9)); } catch (e) { return "error " + e.code; } };
      const small = forms.map((_, f) => text(1024, f));
      const N = ${1 << 20};
      const samples = [];
      let big;
      for (let i = 0; i < 3; i++) { const t = performance.now(); big = forms.map((_, f) => text(N, f)); samples.push(performance.now() - t); }
      console.log(JSON.stringify({ samples, median: [...samples].sort((a, b) => a - b)[1], small, big }));`;
    const pending = promisify(execFile)(process.execPath, ["--input-type=module", "-e", probe], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
    pending.child.stdin?.end();
    const r = JSON.parse((await pending).stdout) as { samples: number[]; median: number; small: string[]; big: string[] };
    expect(r.samples).toHaveLength(3);
    expect(r.median).toBeLessThanOrEqual(1_000);
    expect(r.big).toEqual(r.small);
    expect(r.big[3]).toBe("A\n\nB");
  }, 10_000);
});
