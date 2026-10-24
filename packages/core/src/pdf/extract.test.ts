import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, ftruncateSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractPdfText, pdfReason, PDF_LIMITS, readPdfText, setPdfExtractorRuntime, setPdfOcrTesting, type PdfFailure, type PdfLimits,
} from "./extract.ts";
import { setProcessLanguage } from "../i18n/process-language.ts";
import { makeEncryptedPdf, makeImageOnlyPdf, makeMalformedPdf, makePdf } from "./fixture.ts";
import { extractText } from "./pdf-text.ts";
import type { PdfResult } from "./extract.ts";
import type { OcrPdfRequest } from "../ocr/run.ts";

const here = import.meta.dirname;
const data = (name: string): string => join(here, "testdata", name);
const SLOW = 20_000;
const inProcess = { pages: PDF_LIMITS.pages, chars: PDF_LIMITS.chars };
const small = (over: Partial<PdfLimits>): PdfLimits => ({ ...PDF_LIMITS, ...over });

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "pdf-extract-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  setPdfExtractorRuntime();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Limits and reasons", () => {
  it("constants and seventeen reason wordings", () => {
    expect(PDF_LIMITS).toEqual({ bytes: 104857600, pages: 2000, ms: 30000, rssBytes: 536870912, chars: 20000000 });
    const reasons: Record<PdfFailure, string> = {
      bytes: "PDF больше 100 МиБ",
      pages: "в PDF больше 2000 страниц",
      timeout: "извлечение текста PDF дольше 30 секунд",
      memory: "извлечение текста PDF заняло больше 512 МиБ памяти",
      chars: "текст PDF больше 20000000 знаков",
      encrypted: "PDF зашифрован — пароль не запрашивается",
      damaged: "PDF повреждён",
      no_text: "в PDF не найден текст",
      failed: "не удалось извлечь текст PDF — ошибка запуска",
      ocr_pages: "в PDF больше 200 страниц без текстового слоя",
      ocr_missing: "распознавание текста недоступно — нет помощника osen-ocr",
      ocr_start: "распознавание текста недоступно — не удалось запустить помощника osen-ocr",
      ocr_page_timeout: "распознавание текста PDF дольше 5 секунд на страницу",
      ocr_timeout: "распознавание текста PDF дольше 300 секунд",
      ocr_memory: "распознавание текста PDF заняло больше 512 МиБ памяти",
      ocr_failed: "не удалось распознать текст PDF — ответ не разобран",
      ocr_folder: "распознавание PDF в папке дольше 300 секунд — остальные PDF со сканами пропущены",
    };
    for (const [code, text] of Object.entries(reasons)) expect(pdfReason({ code: code as PdfFailure })).toBe(text);
    expect(pdfReason({ code: "failed", detail: "exit:3" })).toBe("не удалось извлечь текст PDF — код выхода 3");
    expect(pdfReason({ code: "failed", detail: "signal:SIGTERM" })).toBe("не удалось извлечь текст PDF — процесс извлечения остановлен сигналом SIGTERM");
    expect(pdfReason({ code: "failed", detail: "ENOENT" })).toBe("не удалось извлечь текст PDF — ENOENT");
    expect(pdfReason({ code: "ocr_failed", detail: "helper:bad_request" })).toBe("не удалось распознать текст PDF — помощник распознавания сообщил об ошибке");
  });
});

describe("Scanned PDF recognition: unknown helper code in a PDF scan", () => {
  afterEach(() => { setPdfOcrTesting(); setProcessLanguage("ru"); });

  it.each([
    ["ru", "не удалось распознать текст PDF — помощник распознавания сообщил об ошибке"],
    ["en", "could not recognize the PDF text — the recognition helper reported an error"],
  ] as const)("the %s reason has no helper code", (lang, text) => {
    setProcessLanguage(lang);
    // what runOcrHelper returns for {"ok":false,"code":"vision"} (run.test.ts)
    setPdfOcrTesting({ run: () => ({ ok: false, code: "failed", detail: "helper:vision" }) });
    const r = extractPdfText(makeImageOnlyPdf());
    expect(r).toEqual({ ok: false, code: "ocr_failed", detail: "helper:vision" });
    const reason = pdfReason(r as { code: PdfFailure; detail?: string });
    expect(reason).toBe(text);
    expect(reason).not.toContain("vision");
  }, SLOW);
});

describe("Local PDF text", () => {
  it("two pages via a real child process and the same text in the process", async () => {
    const pdf = makePdf(["Первая страница", "Вторая страница"]);
    const r = extractPdfText(pdf);
    expect(r).toEqual({ ok: true, text: "Первая страница\n\nВторая страница", pages: 2 });
    expect(await extractText(pdf, inProcess)).toEqual(r);
  }, SLOW);

  it("Local PDF text: page order", async () => {
    let seed = 20260801;
    const rnd = (n: number): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    const words = ["alpha", "beta", "Gamma", "привет", "мир", "Страница", "😀", "x1"];
    const line = (): string => Array.from({ length: 1 + rnd(3) }, () => words[rnd(words.length)]).join(" ");
    const sets: string[][] = [["одна"], ["", "после пустой"], ["до пустой", "", "после"]];
    while (sets.length < 70) {
      sets.push(Array.from({ length: 1 + rnd(6) }, () => Array.from({ length: rnd(4) }, line).join("\n")));
    }
    let withText = 0;
    for (const pages of sets) {
      const r = await extractText(makePdf(pages), inProcess);
      const blank = pages.flatMap((p, i) => (p === "" ? [i + 1] : []));
      if (blank.length === 0) {
        withText++;
        expect(r).toEqual({ ok: true, text: pages.join("\n\n"), pages: pages.length });
      } else {
        expect(r).toEqual({ ok: true, pages: pages.length, parts: pages, blank });
      }
    }
    expect(withText).toBeGreaterThanOrEqual(20);
  }, 60_000);

  it("PDF.js stage: blank pages between non-blank ones are numbered, all-blank lists every page", async () => {
    expect(await extractText(makePdf(["а", "", "в", "", ""]), inProcess)).toEqual({ ok: true, pages: 5, parts: ["а", "", "в", "", ""], blank: [2, 4, 5] });
    expect(await extractText(makePdf(["", ""]), inProcess)).toEqual({ ok: true, pages: 2, parts: ["", ""], blank: [1, 2] });
    expect(await extractText(makePdf(["а", "б"]), inProcess)).toEqual({ ok: true, text: "а\n\nб", pages: 2 });
  }, SLOW);
});

describe("Refusals", () => {
  afterEach(() => { setPdfOcrTesting(); });

  it("encrypted, without text even after recognition, and damaged PDF", () => {
    // the real helper's reply to a blank page; the real osen-ocr misses its 5 s page deadline on a loaded runner (scenarios/pdf covers it)
    const requests: OcrPdfRequest[] = [];
    setPdfOcrTesting({ run: (request) => { requests.push(request); return { ok: true, pages: [{ n: 1, text: "" }] }; } });
    for (const [make, code] of [[makeEncryptedPdf, "encrypted"], [makeImageOnlyPdf, "no_text"], [makeMalformedPdf, "damaged"]] as const) {
      const bytes = make();
      const copy = bytes.slice();
      expect(extractPdfText(bytes)).toEqual({ ok: false, code });
      expect(bytes).toEqual(copy);
    }
    expect(requests).toMatchObject([{ mode: "pdf", pages: [1] }]);
  }, SLOW);
});

describe("Boundaries", () => {
  it("pages: at the boundary passes, above it refused", () => {
    const pdf = makePdf(["а", "б", "в"]);
    expect(extractPdfText(pdf, small({ pages: 2 }))).toEqual({ ok: false, code: "pages" });
    expect(extractPdfText(pdf, small({ pages: 3 }))).toMatchObject({ ok: true, pages: 3 });
  }, SLOW);

  it("characters: exactly the limit passes, one less is refused", () => {
    const text = "слово ".repeat(10).trim();
    const pdf = makePdf([text]);
    expect(extractPdfText(pdf, small({ chars: text.length }))).toMatchObject({ ok: true, text });
    expect(extractPdfText(pdf, small({ chars: text.length - 1 }))).toEqual({ ok: false, code: "chars" });
  }, SLOW);

  it("2001 pages at the real limit: refusal before reading pages", () => {
    const t0 = Date.now();
    expect(extractPdfText(makePdf(Array.from({ length: 2001 }, () => "слово")))).toEqual({ ok: false, code: "pages" });
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, SLOW);

  it("size: a file above the limit is not read, the boundary is in bytes", () => {
    const dir = tmp();
    const file = join(dir, "big.pdf");
    writeFileSync(file, "%PDF-");
    ftruncateSync(openSync(file, "r+"), PDF_LIMITS.bytes + 1);
    const fd = openSync(file, "r");
    const t0 = Date.now();
    expect(readPdfText(fd)).toEqual({ ok: false, code: "bytes" });
    expect(Date.now() - t0).toBeLessThan(500);
    closeSync(fd);
    const pdf = makePdf(["текст"]);
    expect(extractPdfText(pdf, small({ bytes: pdf.length }))).toMatchObject({ ok: true });
    expect(extractPdfText(pdf, small({ bytes: pdf.length - 1 }))).toEqual({ ok: false, code: "bytes" });
  }, SLOW);

  it("a large response is not truncated", async () => {
    const page = (n: number): string => Array.from({ length: 10 }, (_, i) => `строка ${n}.${i} ${"слово ".repeat(15)}`.trim()).join("\n");
    const pdf = makePdf(Array.from({ length: 400 }, (_, n) => page(n)));
    const mine = await extractText(pdf.slice(), inProcess) as PdfResult;
    const r = extractPdfText(pdf);
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.text.length).toBeGreaterThan(300_000);
    const sha = (v: typeof r): string => createHash("sha256").update(v.ok ? v.text : "").digest("hex");
    expect(sha(r)).toBe(sha(mine));
    expect(r.ok && mine.ok && r.text.length).toBe(mine.ok ? mine.text.length : -1);
  }, SLOW);
});

describe("Child process supervision", () => {
  const supervise = (extra: object, worker: string, input: Uint8Array = new Uint8Array()) => {
    const arg = JSON.stringify({ pages: 2000, chars: 20_000_000, ms: 30_000, rssBytes: 512 * 2 ** 20, ...extra, worker: data(worker) });
    return spawnSync(process.execPath, [join(here, "pdf-extract.ts"), arg], { input, timeout: 15_000, maxBuffer: 2 ** 26 });
  };

  it("worker without a response: exactly one line with timeout and exit with code 0", () => {
    const r = supervise({ ms: 400 }, "worker-hang.ts");
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe('{"ok":false,"code":"timeout"}\n');
  }, SLOW);

  it("worker growing in memory: memory before the timer", () => {
    const t0 = Date.now();
    const r = supervise({ ms: 15_000, rssBytes: 300 * 2 ** 20 }, "worker-memory.ts");
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe('{"ok":false,"code":"memory"}\n');
    expect(Date.now() - t0).toBeLessThan(12_000);
  }, SLOW);
});

describe("Parent safeguard", () => {
  const limits = small({ ms: 300 });

  it("child process not reading stdin: timeout after ms + 2 s and the process is killed", () => {
    const pidFile = join(tmp(), "pid");
    setPdfExtractorRuntime({ script: data("child-hang.ts"), env: { PID_FILE: pidFile } });
    const t0 = Date.now();
    expect(extractPdfText(makePdf(["а"]), limits)).toEqual({ ok: false, code: "timeout" });
    expect(Date.now() - t0).toBeLessThan(5000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, SLOW);

  it("garbage in stdout and exit with code 3 give failed", () => {
    setPdfExtractorRuntime({ script: data("child-garbage.ts") });
    expect(extractPdfText(makePdf(["а"]))).toEqual({ ok: false, code: "failed", detail: "ответ не разобран" });
    setPdfExtractorRuntime({ script: data("child-exit3.ts") });
    expect(extractPdfText(makePdf(["а"]))).toEqual({ ok: false, code: "failed", detail: "exit:3" });
  }, SLOW);

  it("Explicit PDF refusals: exit code and signal of the extraction process are worded from the catalog", () => {
    const cases = [
      { script: "child-exit3.ts", detail: "exit:3", ru: "не удалось извлечь текст PDF — код выхода 3", en: "could not extract PDF text — exit code 3" },
      { script: "child-signal.ts", detail: "signal:SIGTERM", ru: "не удалось извлечь текст PDF — процесс извлечения остановлен сигналом SIGTERM", en: "could not extract PDF text — the extraction process was stopped by signal SIGTERM" },
    ];
    try {
      for (const c of cases) {
        setPdfExtractorRuntime({ script: data(c.script) });
        const r = extractPdfText(makePdf(["а"]));
        expect(r).toEqual({ ok: false, code: "failed", detail: c.detail });
        for (const lang of ["ru", "en"] as const) {
          setProcessLanguage(lang);
          const reason = pdfReason(r as { code: "failed"; detail: string });
          expect(reason).toBe(c[lang]);
          expect(reason).not.toMatch(/exit \d|signal:|exit:/);
        }
        setProcessLanguage("ru");
      }
    } finally {
      setProcessLanguage("ru");
    }
  }, SLOW);
});

describe("Isolation", () => {
  it("PDF extraction isolation: the extraction process runs in /, not in the parent's working directory", () => {
    const before = process.cwd();
    const dir = tmp();
    process.chdir(dir);
    try {
      setPdfExtractorRuntime({ script: data("child-cwd.ts") });
      expect(extractPdfText(makePdf(["а"]))).toMatchObject({ ok: true, text: "/" });
    } finally {
      process.chdir(before);
    }
  }, SLOW);

  it("child process does not get the parent's environment", () => {
    process.env.PDF_TEST_MARKER = "1";
    try {
      setPdfExtractorRuntime({ script: data("child-env.ts") });
      const r = extractPdfText(makePdf(["а"]));
      expect(r.ok && r.text).not.toContain("PDF_TEST_MARKER");
    } finally {
      delete process.env.PDF_TEST_MARKER;
    }
  }, SLOW);

  const listen = async () => {
    let connections = 0;
    const server = net.createServer((s) => { connections++; s.destroy(); });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    return { port: (server.address() as net.AddressInfo).port, count: () => connections, close: () => server.close() };
  };

  it("a link and JavaScript in a PDF open no connections", async () => {
    const srv = await listen();
    const pdf = makePdf(["Текст со ссылкой"], { link: `http://127.0.0.1:${srv.port}/x`, openActionJs: "app.alert('x')" });
    const r = extractPdfText(pdf);
    await new Promise((ok) => setTimeout(ok, 200));
    srv.close();
    expect(r).toEqual({ ok: true, text: "Текст со ссылкой", pages: 1 });
    expect(srv.count()).toBe(0);
  }, SLOW);

  it("after guard.ts fetch and net.connect refuse", async () => {
    const srv = await listen();
    const r = spawnSync(process.execPath, [data("guard-check.ts"), String(srv.port)], { timeout: 10_000 });
    await new Promise((ok) => setTimeout(ok, 200));
    srv.close();
    expect(JSON.parse(r.stdout.toString())).toEqual({ fetch: "отказ", net: "отказ" });
    expect(srv.count()).toBe(0);
  }, SLOW);
});

describe("Cache", () => {
  const open = (file: string, fn: (fd: number) => void): void => {
    const fd = openSync(file, "r");
    try { fn(fd); } finally { closeSync(fd); }
  };
  const lines = (file: string): number => readFileSync(file, "utf8").split("\n").filter(Boolean).length;

  it("re-reading the same file does not start a process, a changed file does", () => {
    const dir = tmp();
    const count = join(dir, "count");
    const file = join(dir, "a.pdf");
    writeFileSync(count, "");
    setPdfExtractorRuntime({ script: data("child-count.ts"), env: { COUNT_FILE: count } });
    writeFileSync(file, "первое содержимое");
    open(file, (fd) => { readPdfText(fd); readPdfText(fd); });
    expect(lines(count)).toBe(1);
    writeFileSync(file, "другое содержимое, длиннее");
    open(file, (fd) => readPdfText(fd));
    expect(lines(count)).toBe(2);
  }, SLOW);

  it("failed and timeout are not cached", () => {
    const dir = tmp();
    const count = join(dir, "count");
    const file = join(dir, "b.pdf");
    writeFileSync(count, "");
    writeFileSync(file, "содержимое для отказа");
    setPdfExtractorRuntime({ script: data("child-count.ts"), env: { COUNT_FILE: count, MODE: "fail" } });
    open(file, (fd) => { expect(readPdfText(fd)).toMatchObject({ code: "failed" }); readPdfText(fd); });
    expect(lines(count)).toBe(2);
    appendFileSync(count, "");
    setPdfExtractorRuntime({ script: data("child-hang.ts"), env: { PID_FILE: join(dir, "pid") } });
    // the cache key holds the limits, so the hang and the later success share one deadline: long enough for a slow start
    const limits = small({ ms: 8000 });
    open(file, (fd) => { expect(readPdfText(fd, limits)).toEqual({ ok: false, code: "timeout" }); });
    setPdfExtractorRuntime({ script: data("child-count.ts"), env: { COUNT_FILE: count } });
    open(file, (fd) => { expect(readPdfText(fd, limits)).toMatchObject({ ok: true }); });
    expect(lines(count)).toBe(3);
  }, 60_000);
});
