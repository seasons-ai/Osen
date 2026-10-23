import { chmodSync, closeSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { OCR_LIMITS, runOcrHelper, setOcrRuntime } from "../ocr/run.ts";
import { extractPdfText, mergePages, PDF_OCR_LIMITS, pdfReason, readPdfText } from "./extract.ts";
import { makeOwnerPasswordPdf } from "../ocr/fixture.ts";
import { makeEncryptedPdf, makePdf, makeScanPdf } from "./fixture.ts";
import { writeExecutable } from "../executable.testutil.ts";

const SLOW = 30_000;
let dir: string;
beforeAll(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "pdf-ocr-"))); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => setOcrRuntime());

// one executable stub per file, rewritten in place: a new inode per call pays the macOS first-launch check
// (seconds under load) inside the helper deadline; a non-executable stub goes to its own path by a plain write
function stub(body: string, mode = 0o755): string {
  const text = `#!/bin/sh\n${body}\n`;
  if (mode & 0o111) return writeExecutable(join(dir, "stub.sh"), text, mode);
  const f = join(dir, "stub-plain.sh");
  writeFileSync(f, text);
  chmodSync(f, mode);
  return f;
}
const printing = (obj: unknown) => stub(`C=$(/bin/cat)\nprintf '%s\\n' '${JSON.stringify(obj)}'`);
const line = (t: string, y = 0) => ({ t, x: 0, y, w: 0.5, h: 0.1 });
const page = (num: number, ...texts: string[]) => ({ n: num, lines: texts.map((t, i) => line(t, i / 10)) });
const use = (helper: string) => setOcrRuntime({ helper });
const blankPdf = (count: number) => makePdf(Array.from({ length: count }, () => ""));

describe("PDF recognition: merge and limits (stub helper)", () => {
  it("puts recognized text on the blank pages in page order", () => {
    use(printing({ ok: true, pages: [page(2, "Вторая", "строка"), page(4)] }));
    expect(extractPdfText(makePdf(["Первая", "", "Третья", ""]))).toEqual({ ok: true, text: "Первая\n\nВторая\nстрока\n\nТретья", pages: 4 });
  }, SLOW);

  it("a reply that misses a requested page is a refusal, not partial text", () => {
    use(printing({ ok: true, pages: [page(2, "Вторая")] }));
    expect(extractPdfText(makePdf(["Первая", "", "Третья", ""]))).toEqual({ ok: false, code: "ocr_failed", detail: "ответ не разобран" });
  }, SLOW);

  it.each([[{ n: 2 }], [{ n: 2, lines: [null] }], [{ lines: [] }]])("a malformed page %j in the reply is a refusal", (bad) => {
    use(printing({ ok: true, pages: [page(1, "Первая"), bad] }));
    expect(extractPdfText(makePdf(["", ""]))).toEqual({ ok: false, code: "ocr_failed", detail: "ответ не разобран" });
  }, SLOW);

  it("a scan without any recognized text is no_text", () => {
    use(printing({ ok: true, pages: [page(1), page(2)] }));
    expect(extractPdfText(makePdf(["", ""]))).toEqual({ ok: false, code: "no_text" });
  }, SLOW);

  it("refuses more than 200 blank pages without starting the helper, accepts 200", () => {
    // the stub would return text: a launch would turn the refusal into success
    use(printing({ ok: true, pages: Array.from({ length: PDF_OCR_LIMITS.pages }, (_, i) => (i === 0 ? page(1, "текст") : page(i + 1))) }));
    expect(extractPdfText(blankPdf(PDF_OCR_LIMITS.pages + 1))).toEqual({ ok: false, code: "ocr_pages" });
    expect(extractPdfText(blankPdf(PDF_OCR_LIMITS.pages))).toEqual({ ok: true, text: "текст", pages: PDF_OCR_LIMITS.pages });
  }, SLOW);

  // one test per case: each spawns PDF.js and the helper, a single test of five overran 30 s under a loaded full run
  it.each([
    [{ ok: false, code: "page_timeout" }, { ok: false, code: "ocr_page_timeout" }, "распознавание текста PDF дольше 5 секунд на страницу"],
    [{ ok: false, code: "timeout" }, { ok: false, code: "ocr_timeout" }, "распознавание текста PDF дольше 300 секунд"],
    [{ ok: false, code: "memory" }, { ok: false, code: "ocr_memory" }, "распознавание текста PDF заняло больше 512 МиБ памяти"],
    [{ ok: false, code: "damaged" }, { ok: false, code: "damaged" }, "PDF повреждён"],
    [{ ok: false, code: "encrypted" }, { ok: false, code: "encrypted" }, "PDF зашифрован — пароль не запрашивается"],
    [{ ok: false, code: "bad_request" }, { ok: false, code: "ocr_failed", detail: "bad_request" }, "не удалось распознать текст PDF — bad_request"],
  ] as [unknown, object, string][])("maps the helper reply %j to a code and a reason", (reply, expected, reason) => {
    use(printing(reply));
    const r = extractPdfText(makePdf(["", "текст"]));
    expect(r).toEqual(expected);
    expect(r.ok ? "" : pdfReason(r)).toBe(reason);
  }, SLOW);

  it("a missing helper and a helper that cannot start give their own codes when no page has a text layer", () => {
    use(join(dir, "absent"));
    expect(extractPdfText(makePdf(["", ""]))).toEqual({ ok: false, code: "ocr_missing" });
    use(stub("echo hi", 0o644));
    expect(extractPdfText(makePdf(["", ""]))).toEqual({ ok: false, code: "ocr_start" });
  }, SLOW);

  it("without a usable helper the pages with a text layer are still read", () => {
    use(join(dir, "absent"));
    expect(extractPdfText(makePdf(["", "текст"]))).toEqual({ ok: true, text: "текст", pages: 2, fallback: true });
    use(stub("echo hi", 0o644));
    expect(extractPdfText(makePdf(["", "текст"]))).toEqual({ ok: true, text: "текст", pages: 2, fallback: true });
  }, SLOW);

  it("an encrypted PDF never starts the helper", () => {
    use(printing({ ok: true, pages: [page(1, "текст")] }));
    expect(extractPdfText(makeEncryptedPdf())).toEqual({ ok: false, code: "encrypted" });
  }, SLOW);

  it("sends the blank page numbers and the limits to the helper", () => {
    use(stub(`C=$(/bin/cat)\nA=$(printf '%s' "$1" | /usr/bin/tr -d '"')\nprintf '{"ok":true,"pages":[{"n":2,"lines":[{"t":"%s","x":0,"y":0,"w":1,"h":1}]}]}\\n' "$A"`));
    const r = extractPdfText(makePdf(["а", "", "б"]));
    expect(r.ok && r.text).toBe(`а\n\n{mode:pdf,pages:[2],pageMs:5000,ms:300000,rssBytes:${OCR_LIMITS.rssBytes}}\n\nб`);
  }, SLOW);
});

describe("PDF recognition: cache", () => {
  it("caches success, does not cache missing, start and timeouts", () => {
    const file = join(dir, "c.pdf");
    writeFileSync(file, makePdf(["", "текст"]));
    const read = () => { const fd = openSync(file, "r"); try { return readPdfText(fd); } finally { closeSync(fd); } };
    use(join(dir, "absent"));
    expect(read()).toEqual({ ok: true, text: "текст", pages: 2, fallback: true });
    use(printing({ ok: false, code: "timeout" }));
    expect(read()).toEqual({ ok: false, code: "ocr_timeout" });
    use(printing({ ok: true, pages: [page(1, "скан")] }));
    expect(read()).toEqual({ ok: true, text: "скан\n\nтекст", pages: 2 });
    use(join(dir, "absent"));
    expect(read()).toEqual({ ok: true, text: "скан\n\nтекст", pages: 2 });
  }, SLOW);
});

describe("Распознавание сканированного PDF: помощника нет", () => {
  it("a helper that appears after a collection without it is used: the fallback is not cached", () => {
    const file = join(dir, "late.pdf");
    writeFileSync(file, makePdf(["", "текст"]));
    const read = () => { const fd = openSync(file, "r"); try { return readPdfText(fd); } finally { closeSync(fd); } };
    use(join(dir, "absent"));
    const first = read();
    expect(first.ok && first.text).toBe("текст");
    use(printing({ ok: true, pages: [page(1, "скан")] }));
    const second = read();
    expect(second.ok && second.text).toBe("скан\n\nтекст");
  }, SLOW);
});

describe("Распознавание сканированного PDF: порядок страниц", () => {
  let seed = 20261023;
  const rnd = (k: number): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * k);
  };
  const words = ["alpha", "Договор", "поставки", "😀", "x1", "Срок"];
  const text = (): string => Array.from({ length: 1 + rnd(3) }, () => words[rnd(words.length)]).join(" ");

  it("the result is the pages in number order joined by an empty line", () => {
    let cases = 0;
    for (const scanned of [0, 1, 2, 7, 200, 201]) {
      for (let rep = 0; rep < 4; rep++) {
        // kinds: layer page, scanned page (blank layer, recognized text), page with no text at all
        const kinds = [
          ...Array.from({ length: scanned }, () => "scan"),
          ...Array.from({ length: rnd(6) }, () => "layer"),
          ...Array.from({ length: rnd(3) }, () => "empty"),
        ];
        for (let i = kinds.length - 1; i > 0; i--) { const j = rnd(i + 1); [kinds[i], kinds[j]] = [kinds[j]!, kinds[i]!]; }
        const truth = kinds.map((k) => (k === "empty" ? "" : text()));
        const parts = kinds.map((k, i) => (k === "layer" ? truth[i]! : ""));
        const recognized = new Map(kinds.flatMap((k, i) => (k === "scan" ? [[i + 1, truth[i]!] as [number, string]] : k === "empty" ? [[i + 1, "  "] as [number, string]] : [])));
        expect(mergePages(parts, recognized)).toBe(truth.filter((t) => t !== "").join("\n\n"));
        cases++;
      }
    }
    expect(cases).toBe(24);
    expect(mergePages([], new Map())).toBe("");
  });
});

describe.runIf(process.platform === "darwin")("real helper in pdf mode", () => {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\n ]/gu, "");
  const REQ = { mode: "pdf", pageMs: 5000, ms: 60_000, rssBytes: OCR_LIMITS.rssBytes } as const;

  it("recognizes the page of a generated scan under sandbox-exec and refuses a page out of range", () => {
    const pdf = makeScanPdf([["Договор поставки"]]);
    const r = runOcrHelper({ ...REQ, pages: [1] }, pdf);
    expect(r.ok && r.pages.map((p) => [p.n, norm(p.text)])).toEqual([[1, "договор поставки"]]);
    expect(runOcrHelper({ ...REQ, pages: [2] }, pdf)).toEqual({ ok: false, code: "damaged" });
  }, SLOW);

  it("the real helper stops on the page budget and on the file budget", () => {
    const pdf = makeScanPdf([["Договор поставки"]]);
    expect(runOcrHelper({ ...REQ, pages: [1], pageMs: 1 }, pdf)).toEqual({ ok: false, code: "page_timeout" });
    expect(runOcrHelper({ ...REQ, pages: [1], ms: 1 }, pdf)).toEqual({ ok: false, code: "timeout" });
  }, SLOW);

  it("a PDF with an owner password is read like the same PDF without it", () => {
    const pages = ["Text layer page one", ""];
    const owner = makeOwnerPasswordPdf(pages);
    expect(owner.includes("/Encrypt")).toBe(true);
    const plain = extractPdfText(makeOwnerPasswordPdf(pages, { plain: true }));
    expect(plain).toEqual({ ok: true, text: "Text layer page one", pages: 2 });
    expect(extractPdfText(owner)).toEqual(plain);
  }, SLOW);

  it("a mixed document comes back in page order", () => {
    const r = extractPdfText(makeScanPdf(["Первая страница", ["Scan page two"], "Третья страница"]));
    expect(r.ok && r.pages).toBe(3);
    const parts = r.ok ? r.text.split("\n\n") : [];
    expect(parts[0]).toBe("Первая страница");
    expect(norm(parts[1] ?? "")).toBe("scan page two");
    expect(parts[2]).toBe("Третья страница");
    expect(parts).toHaveLength(3);
  }, SLOW);
});
