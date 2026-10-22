import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractDocument } from "./detect.ts";
import {
  DOC_LIMITS, documentReason, extractDocumentText, readDocumentText, setDocumentExtractorRuntime, type DocFailure, type DocLimits,
} from "./extract.ts";
import { makeDocx, makeZip, p, table } from "./fixture.ts";

const here = import.meta.dirname;
const pdfData = (name: string): string => join(here, "..", "pdf", "testdata", name);
const SLOW = 20_000;
const small = (over: Partial<DocLimits>): DocLimits => ({ ...DOC_LIMITS, ...over });

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "doc-extract-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  setDocumentExtractorRuntime();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Limits and reasons", () => {
  it("constants and sixteen reason wordings", () => {
    expect(DOC_LIMITS).toMatchObject({ bytes: 104857600, ms: 30000, rssBytes: 536870912, chars: 20000000, parts: 10000, unpackedBytes: 536870912, ratio: 200, cells: 1000000 });
    const reasons: Record<DocFailure, string> = {
      bytes: "документ больше 100 МиБ",
      timeout: "извлечение текста документа дольше 30 секунд",
      memory: "извлечение текста документа заняло больше 512 МиБ памяти",
      chars: "текст документа больше 20000000 знаков",
      zip_parts: "в документе больше 10000 частей",
      zip_size: "документ распаковывается больше чем в 512 МиБ",
      zip_ratio: "часть документа сжата сильнее чем в 200 раз",
      cells: "в таблице больше 1000000 ячеек",
      encrypted: "документ зашифрован — пароль не запрашивается",
      damaged: "документ повреждён",
      no_text: "в документе нет текста",
      unsupported: "формат документа не поддерживается",
      failed: "не удалось извлечь текст документа — ошибка запуска",
      odf_kind: "формат не поддерживается — OpenDocument",
      drm: "книга защищена DRM — содержимое недоступно",
    };
    for (const [code, text] of Object.entries(reasons)) expect(documentReason({ code: code as DocFailure })).toBe(text);
    expect(documentReason({ code: "failed", detail: "exit 3" })).toBe("не удалось извлечь текст документа — exit 3");
    expect(documentReason({ code: "damaged", detail: "OEBPS/c1.xhtml" })).toBe("документ повреждён — OEBPS/c1.xhtml");
    expect(documentReason({ code: "odf_kind", detail: "graphics" })).toBe("формат не поддерживается — рисунок OpenDocument");
  });
});

describe("Local DOCX text", () => {
  const body = p("Первая строка") + p("") + table([["a", "б"]]) + p("Смайл 😀");
  const inProcess = (bytes: Uint8Array) => extractDocument(bytes, DOC_LIMITS);

  it("DOCX and DOCM through a real child process give the in-process text", () => {
    for (const macro of [false, true]) {
      const bytes = makeDocx({ body, macro });
      const r = extractDocumentText(bytes);
      expect(r).toEqual({ ok: true, text: "Первая строка\n\na\tб\nСмайл 😀", format: "docx" });
      expect(inProcess(bytes)).toEqual(r);
    }
  }, SLOW);

  it("a plain ZIP and a non-ZIP are unsupported, not damaged", () => {
    expect(extractDocumentText(makeZip([{ name: "a.txt", data: "hi" }]))).toEqual({ ok: false, code: "unsupported" });
    expect(extractDocumentText(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]))).toEqual({ ok: false, code: "unsupported" });
    const noType = makeZip([{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "word/document.xml", data: "<x/>" }]);
    expect(extractDocumentText(noType)).toEqual({ ok: false, code: "unsupported" });
  }, SLOW);

  it("Документ с внешней сущностью: a DOCTYPE, broken XML or encryption in [Content_Types].xml or _rels/.rels is a damaged document, not a non-text file", () => {
    const doc = { name: "word/document.xml", data: "<w:document><w:body><w:p><w:r><w:t>а</w:t></w:r></w:p></w:body></w:document>" };
    const dtd = '<!DOCTYPE Types [<!ENTITY x SYSTEM "file:///etc/passwd">]><Types>&x;</Types>';
    expect(inProcess(makeZip([{ name: "[Content_Types].xml", data: dtd }, doc]))).toEqual({ ok: false, code: "damaged" });
    expect(inProcess(makeZip([{ name: "[Content_Types].xml", data: "<Types" }, doc]))).toEqual({ ok: false, code: "damaged" });
    expect(inProcess(makeZip([{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "_rels/.rels", data: dtd }, doc]))).toEqual({ ok: false, code: "damaged" });
    expect(inProcess(makeZip([{ name: "[Content_Types].xml", data: "<Types/>", encrypted: true }, doc]))).toEqual({ ok: false, code: "encrypted" });
    // a part the DOCX builder never parses still makes the document damaged
    for (const decl of [dtd, '<!ENTITY x "y">'])
      expect(inProcess(makeDocx({ body: p("а"), extraParts: [{ name: "word/styles.xml", data: `<?xml version="1.0"?>${decl}<w:styles/>` }] }))).toEqual({ ok: false, code: "damaged" });
    const utf16 = (t: string, be: boolean): Uint8Array => { const b = Buffer.from("\ufeff" + t, "utf16le"); return be ? b.swap16() : b; };
    for (const part of [
      { name: "word/vmlDrawing1.vml", data: `<xml>${dtd}</xml>` },
      { name: "docProps/custom.xml", data: utf16(`<?xml version="1.0" encoding="UTF-16"?>${dtd}`, false) },
      { name: "docProps/app.xml", data: utf16(`<?xml version="1.0" encoding="UTF-16"?>${dtd}`, true) },
    ]) expect(inProcess(makeDocx({ body: p("а"), extraParts: [part] }))).toEqual({ ok: false, code: "damaged" });
    // an SVG picture with its usual DOCTYPE is an image, not an XML part of the document
    expect(inProcess(makeDocx({ body: p("а"), extraParts: [{ name: "word/media/image1.svg", data: '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x"><svg/>' }] }))).toMatchObject({ ok: true });
  });

  it("Ограниченное извлечение: [Content_Types].xml declared over 512 MiB is refused before inflation, within the ratio", () => {
    const junk = new Uint8Array(3 * 2 ** 20 + 1).map((_, i) => (i * 2654435761) >>> 24);
    const lie = makeZip([{ name: "[Content_Types].xml", data: junk, method: 0, declaredSize: 600 * 2 ** 20 }]);
    expect(inProcess(lie)).toEqual({ ok: false, code: "zip_size" });
  });

  it("refusal codes through the process", () => {
    expect(extractDocumentText(makeDocx({ body: "<w:p>" }))).toEqual({ ok: false, code: "damaged" });
    expect(extractDocumentText(makeDocx({ body: p("") + p("  ") }))).toEqual({ ok: false, code: "no_text" });
    expect(extractDocumentText(makeDocx({ body: p("текст"), extraParts: [{ name: "x.bin", data: "a", encrypted: true }] }))).toEqual({ ok: false, code: "encrypted" });
  }, SLOW);

  it("characters: exactly the limit passes, one less is refused", () => {
    const bytes = makeDocx({ body: p("слово слово") });
    expect(extractDocument(bytes, { ...DOC_LIMITS, chars: 11 })).toMatchObject({ ok: true });
    expect(extractDocument(bytes, { ...DOC_LIMITS, chars: 10 })).toEqual({ ok: false, code: "chars" });
    expect(extractDocumentText(bytes, small({ chars: 10 }))).toEqual({ ok: false, code: "chars" });
  }, SLOW);

  it("parts, unpacked size and ratio are refused from the directory", () => {
    const many = Array.from({ length: 10_001 }, (_, i) => ({ name: `x/${i}.bin`, data: "a" }));
    expect(inProcess(makeDocx({ body: p("а"), extraParts: many }))).toEqual({ ok: false, code: "zip_parts" });
    expect(inProcess(makeDocx({ body: p("а"), extraParts: [{ name: "lie.bin", data: "a", declaredSize: 600 * 2 ** 20 }] }))).toEqual({ ok: false, code: "zip_size" });
    expect(inProcess(makeDocx({ body: p("а"), extraParts: [{ name: "bomb.bin", data: "a".repeat(1_000_000) }] }))).toEqual({ ok: false, code: "zip_ratio" });
  }, SLOW);
});

describe("Parent safeguard", () => {
  const docx = makeDocx({ body: p("а") });
  const limits = small({ ms: 300 });

  it("child process not reading stdin: timeout and the process is killed", () => {
    const pidFile = join(tmp(), "pid");
    setDocumentExtractorRuntime({ script: pdfData("child-hang.ts"), env: { PID_FILE: pidFile } });
    const t0 = Date.now();
    expect(extractDocumentText(docx, limits)).toEqual({ ok: false, code: "timeout" });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
  }, SLOW);

  it("garbage in stdout and exit with code 3 give failed", () => {
    setDocumentExtractorRuntime({ script: pdfData("child-garbage.ts") });
    expect(extractDocumentText(docx)).toEqual({ ok: false, code: "failed", detail: "ответ не разобран" });
    setDocumentExtractorRuntime({ script: pdfData("child-exit3.ts") });
    expect(extractDocumentText(docx)).toEqual({ ok: false, code: "failed", detail: "exit 3" });
    expect(documentReason({ code: "failed", detail: "exit 3" })).toBe("не удалось извлечь текст документа — exit 3");
    expect(documentReason({ code: "damaged", detail: "OEBPS/c1.xhtml" })).toBe("документ повреждён — OEBPS/c1.xhtml");
    expect(documentReason({ code: "odf_kind", detail: "graphics" })).toBe("формат не поддерживается — рисунок OpenDocument");
  }, SLOW);

  const supervise = (extra: object, worker: string, env: Record<string, string> = {}) => {
    const arg = JSON.stringify({ ...DOC_LIMITS, ...extra, worker: join(here, "..", "pdf", "testdata", worker) });
    return spawnSync(process.execPath, [join(here, "doc-extract.ts"), arg], { input: docx, timeout: 15_000, env: { ...process.env, ...env } });
  };

  it("Отказы документов: an unexpected worker failure or exit is «could not extract document text — <code>», not «damaged»", () => {
    const own = (worker: string) => spawnSync(process.execPath, [join(here, "doc-extract.ts"), JSON.stringify({ ...DOC_LIMITS, worker: join(here, "testdata", worker) })], { input: docx, timeout: 15_000 });
    expect(JSON.parse(own("worker-crash.ts").stdout.toString())).toEqual({ ok: false, code: "failed", detail: "worker error" });
    expect(JSON.parse(own("worker-exit.ts").stdout.toString())).toEqual({ ok: false, code: "failed", detail: "worker exit" });
  }, SLOW);

  it("worker without a response: one line with timeout; growing worker: memory", () => {
    const hang = supervise({ ms: 400 }, "worker-hang.ts");
    expect(hang.status).toBe(0);
    expect(hang.stdout.toString()).toBe('{"ok":false,"code":"timeout"}\n');
    const mem = supervise({ ms: 15_000, rssBytes: 300 * 2 ** 20 }, "worker-memory.ts");
    expect(mem.status).toBe(0);
    expect(mem.stdout.toString()).toBe('{"ok":false,"code":"memory"}\n');
  }, SLOW);
});

describe("Isolation", () => {
  it("child process does not get the parent's environment", () => {
    process.env.OPENAI_API_KEY = "stand-secret";
    try {
      setDocumentExtractorRuntime({ script: pdfData("child-env.ts") });
      const r = extractDocumentText(makeDocx({ body: p("а") }));
      expect(r.ok && r.text).not.toContain("OPENAI_API_KEY");
      expect(r.ok && r.text).not.toContain("PATH");
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  }, SLOW);

  it("the extraction thread of doc-extract.ts has fetch and sockets closed", async () => {
    let connections = 0;
    const server = net.createServer((s) => { connections++; s.destroy(); });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as net.AddressInfo).port;
    const arg = JSON.stringify({ ...DOC_LIMITS, worker: join(here, "testdata", "worker-net.ts") });
    const r = spawnSync(process.execPath, [join(here, "doc-extract.ts"), arg], {
      input: new Uint8Array(), timeout: 15_000, env: { ...process.env, NET_PORT: String(port) },
    });
    await new Promise((ok) => setTimeout(ok, 200));
    server.close();
    expect(JSON.parse(JSON.parse(r.stdout.toString()).text)).toEqual({ fetch: "refused", net: "refused" });
    expect(connections).toBe(0);
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
    const file = join(dir, "a.docx");
    writeFileSync(count, "");
    setDocumentExtractorRuntime({ script: pdfData("child-count.ts"), env: { COUNT_FILE: count } });
    writeFileSync(file, "первое содержимое");
    open(file, (fd) => { readDocumentText(fd); readDocumentText(fd); });
    expect(lines(count)).toBe(1);
    writeFileSync(file, "другое содержимое, длиннее");
    open(file, (fd) => readDocumentText(fd));
    expect(lines(count)).toBe(2);
  }, SLOW);

  it("failed is not cached", () => {
    const dir = tmp();
    const count = join(dir, "count");
    const file = join(dir, "b.docx");
    writeFileSync(count, "");
    writeFileSync(file, "содержимое для отказа");
    setDocumentExtractorRuntime({ script: pdfData("child-count.ts"), env: { COUNT_FILE: count, MODE: "fail" } });
    open(file, (fd) => { expect(readDocumentText(fd)).toMatchObject({ code: "failed" }); readDocumentText(fd); });
    expect(lines(count)).toBe(2);
  }, SLOW);
});
