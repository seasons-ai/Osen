import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DOC_LIMITS } from "../documents/limits.ts";
import { materialsMessages } from "../messages/materials.ts";
import { makeImage } from "./fixture.ts";
import { writeExecutable } from "../executable.testutil.ts";
import { setProcessLanguage } from "../i18n/process-language.ts";
import { pdfReason } from "../pdf/extract.ts";
import { imageReason, OCR_LIMITS, runOcrHelper, setOcrRuntime, type OcrImageRequest, type OcrPdfRequest } from "./run.ts";

const REQ: OcrImageRequest = { mode: "image", ms: 10_000, rssBytes: OCR_LIMITS.rssBytes };
const REAL = join(import.meta.dirname, "bin/osen-ocr");
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\n ]/gu, "");
let dir: string;
beforeAll(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "ocr-run-"))); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => { setOcrRuntime(); setProcessLanguage("ru"); delete process.env.COUNCIL_OCR_HELPER; });

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
const line = (t: string, x = 0, y = 0) => ({ t, x, y, w: 0.5, h: 0.1 });
const printing = (obj: unknown) => stub(`C=$(/bin/cat)\nprintf '%s\\n' '${JSON.stringify(obj)}'`);
const run = (helper: string, req: OcrImageRequest = REQ) => { setOcrRuntime({ helper }); return runOcrHelper(req, Buffer.from("x")); };

describe("runOcrHelper protocol (stub helpers)", () => {
  it("orders recognized lines into text", () => {
    const r = run(printing({ ok: true, lines: [line("second", 0, 0.5), line("first", 0, 0.1)] }));
    expect(r).toEqual({ ok: true, text: "first\nsecond" });
  });

  it.each(["damaged", "no_text", "timeout", "memory"] as const)("passes the helper code %s", (code) => {
    expect(run(printing({ ok: false, code }))).toEqual({ ok: false, code });
  });

  it("keeps any other helper code as failed with the marked code as detail", () => {
    expect(run(printing({ ok: false, code: "vision" }))).toEqual({ ok: false, code: "failed", detail: "helper:vision" });
    expect(run(printing({ ok: false, code: "bad_request" }))).toEqual({ ok: false, code: "failed", detail: "helper:bad_request" });
  });

  it("treats an unparsable reply as failed with the catalog text", () => {
    const r = run(stub("C=$(/bin/cat)\necho not-json"));
    expect(r).toEqual({ ok: false, code: "failed", detail: materialsMessages().docBadReply });
  });

  it.each([[null], [{ x: 0 }], [7]])("refuses an image reply with an invalid line %j as not parsed, without throwing", (bad) => {
    const r = run(printing({ ok: true, lines: [line("fine"), bad] }));
    expect(r).toEqual({ ok: false, code: "failed", detail: materialsMessages().docBadReply });
  });

  it("treats blank recognized lines as no text", () => {
    expect(run(printing({ ok: true, lines: [line("   ")] }))).toEqual({ ok: false, code: "no_text" });
  });

  it("reports a missing helper without starting anything", () => {
    expect(run(join(dir, "absent"))).toEqual({ ok: false, code: "missing" });
  });

  it("reports a helper that crashed on a signal as failed, not as a launch error", () => {
    expect(run(stub("C=$(/bin/cat)\nkill -SEGV $$"))).toEqual({ ok: false, code: "failed", detail: "SIGSEGV" });
  });

  it("reports a helper that cannot be started", () => {
    expect(run(stub("echo hi", 0o644))).toEqual({ ok: false, code: "start" });
  });

  it("falls back to the parent timeout for a hanging helper", () => {
    const t0 = Date.now();
    expect(run(stub("/bin/sleep 30"), { ...REQ, ms: 100 })).toEqual({ ok: false, code: "timeout" });
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it("reports text over the character limit as chars", () => {
    const big = "a".repeat(1_000_000);
    const lines = Array.from({ length: DOC_LIMITS.chars / 1_000_000 + 1 }, (_, i) => line(big, 0, i / 100));
    const f = join(dir, "big.json");
    writeFileSync(f, JSON.stringify({ ok: true, lines }));
    expect(run(stub(`C=$(/bin/cat)\n/bin/cat ${f}`))).toEqual({ ok: false, code: "chars" });
  });

  it("gives the helper an empty environment and one argument without file paths", () => {
    process.env.SECRET_KEY = "top-secret";
    try {
      const r = run(stub(`C=$(/bin/cat)
E=$(/usr/bin/env | /usr/bin/tr '\\n' ',' | /usr/bin/tr -d '"\\\\')
A=$(printf '%s' "$*" | /usr/bin/tr -d '"\\\\')
printf '{"ok":true,"lines":[{"t":"argc=%s args=%s env=%s","x":0,"y":0,"w":1,"h":1}]}\\n' "$#" "$A" "$E"`));
      expect(r.ok).toBe(true);
      const text = r.ok ? r.text : "";
      expect(text).toContain("argc=1 ");
      expect(text).toContain("args={mode:image,ms:10000,rssBytes:536870912}");
      expect(text).not.toContain("SECRET_KEY");
      expect(text).not.toContain("top-secret");
      expect(text).not.toMatch(/(^|[ ,])PATH=/);
    } finally {
      delete process.env.SECRET_KEY;
    }
  });
});

describe("runOcrHelper pdf mode (stub helpers)", () => {
  it("passes the helper code encrypted instead of failed", () => {
    setOcrRuntime({ helper: printing({ ok: false, code: "encrypted" }) });
    expect(runOcrHelper({ mode: "pdf", pages: [1], pageMs: 5000, ms: 10_000, rssBytes: OCR_LIMITS.rssBytes }, Buffer.from("x"))).toEqual({ ok: false, code: "encrypted" });
  });
});

describe("helper lookup", () => {
  it("honors COUNCIL_OCR_HELPER only with COUNCIL_DEV=1", () => {
    const alt = printing({ ok: true, lines: [line("from-env")] });
    process.env.COUNCIL_OCR_HELPER = alt;
    const was = process.env.COUNCIL_DEV;
    try {
      process.env.COUNCIL_DEV = "1";
      expect(runOcrHelper(REQ, Buffer.from("x"))).toEqual({ ok: true, text: "from-env" });
      delete process.env.COUNCIL_DEV;
      expect(runOcrHelper(REQ, Buffer.from("x"))).toEqual({ ok: false, code: "damaged" }); // the real bin/osen-ocr answered
    } finally {
      if (was === undefined) delete process.env.COUNCIL_DEV; else process.env.COUNCIL_DEV = was;
    }
  });
});

describe("sandbox", () => {
  it("denies file writes from the helper", () => {
    const target = join(dir, "written.txt");
    const r = run(stub(`C=$(/bin/cat)
if echo x > ${target}; then R=wrote; else R=denied; fi
printf '{"ok":true,"lines":[{"t":"%s","x":0,"y":0,"w":1,"h":1}]}\\n' "$R"`));
    expect(r).toEqual({ ok: true, text: "denied" });
    expect(existsSync(target)).toBe(false);
  });

  it("denies network connections from the helper", async () => {
    const hits = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(`
      const { workerData, parentPort } = require("node:worker_threads");
      const http = require("node:http");
      const hits = new Int32Array(workerData);
      const server = http.createServer((req, res) => { Atomics.add(hits, 0, 1); res.end("ok"); });
      server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
    `, { eval: true, workerData: hits.buffer });
    try {
      const port = await new Promise<number>((resolve) => worker.once("message", resolve));
      const url = `http://127.0.0.1:${port}/`;
      const r = run(stub(`C=$(/bin/cat)
X=$(/usr/bin/curl -s -m 3 ${url} 2>&1)
printf '{"ok":true,"lines":[{"t":"done","x":0,"y":0,"w":1,"h":1}]}\\n'`));
      expect(r).toEqual({ ok: true, text: "done" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(Atomics.load(hits, 0)).toBe(0);
      // control: the same request outside the sandbox does reach the server
      spawnSync("/usr/bin/curl", ["-s", "-m", "3", url]);
      expect(Atomics.load(hits, 0)).toBe(1);
    } finally {
      await worker.terminate();
    }
  });
});

describe.runIf(process.platform === "darwin")("real helper", () => {
  it("is built (npm run build:ocr)", () => {
    expect(existsSync(REAL)).toBe(true);
  });

  it("prints its protocol version", () => {
    expect(spawnSync(REAL, ["--version"], { encoding: "utf8" }).stdout).toBe("osen-ocr 1\n");
  });

  it("rejects an unknown mode with bad_request", () => {
    const r = runOcrHelper({ ...REQ, mode: "docx" } as unknown as OcrImageRequest, Buffer.from("x"));
    expect(r).toEqual({ ok: false, code: "failed", detail: "helper:bad_request" });
  });

  it("recognizes a Russian image in reading order inside the sandbox", () => {
    const r = runOcrHelper(REQ, makeImage("png", ["Договор поставки", "Срок оплаты"]));
    expect(r.ok && norm(r.text)).toBe("договор поставки\nсрок оплаты");
  });

  it("recognizes Russian and English lines of one image", () => {
    const r = runOcrHelper(REQ, makeImage("png", ["Срок оплаты", "Payment terms"]));
    expect(r.ok && norm(r.text)).toBe("срок оплаты\npayment terms");
  });

  it("reports damaged and no_text", () => {
    expect(runOcrHelper(REQ, Buffer.from("not an image"))).toEqual({ ok: false, code: "damaged" });
    expect(runOcrHelper(REQ, makeImage("png", []))).toEqual({ ok: false, code: "no_text" });
  });

  it("supervisor stops on memory and on time", () => {
    const img = makeImage("png", ["Договор поставки"]);
    expect(runOcrHelper({ ...REQ, rssBytes: 1 }, img)).toEqual({ ok: false, code: "memory" });
    expect(runOcrHelper({ ...REQ, ms: 1 }, img)).toEqual({ ok: false, code: "timeout" });
  });
});

describe("imageReason", () => {
  it("takes numbers from the limits", () => {
    expect(imageReason({ code: "bytes" })).toBe("изображение больше 50 МиБ");
    expect(imageReason({ code: "pixels" })).toBe("изображение больше 100 мегапикселей");
    expect(imageReason({ code: "timeout" })).toBe("распознавание текста дольше 30 секунд");
    expect(imageReason({ code: "memory" })).toBe("распознавание текста заняло больше 512 МиБ памяти");
    expect(imageReason({ code: "chars" })).toBe("текст изображения больше 20000000 знаков");
    expect(imageReason({ code: "failed", detail: "helper:vision" })).toBe("не удалось распознать текст изображения — помощник распознавания сообщил об ошибке");
    expect(imageReason({ code: "failed" })).toBe("не удалось распознать текст изображения — ответ не разобран");
  });
});

// Own seeded generator: fast-check is not wired in.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PDF_REQ: OcrPdfRequest = { mode: "pdf", pages: [1], pageMs: 5000, ms: 10_000, rssBytes: OCR_LIMITS.rssBytes };
const runPdf = (helper: string) => { setOcrRuntime({ helper }); return runOcrHelper(PDF_REQ, Buffer.from("x")); };

describe("Image limits and refusals: unknown helper code", () => {
  const words = {
    en: { img: "could not recognize the image text — the recognition helper reported an error", pdf: "could not recognize the PDF text — the recognition helper reported an error" },
    ru: { img: "не удалось распознать текст изображения — помощник распознавания сообщил об ошибке", pdf: "не удалось распознать текст PDF — помощник распознавания сообщил об ошибке" },
  } as const;

  it.each(["en", "ru"] as const)("an unknown helper code gives the %s reason without the code", (lang) => {
    setProcessLanguage(lang);
    for (const code of ["vision", "bad_request"]) {
      const r = run(printing({ ok: false, code }));
      expect(r.ok).toBe(false);
      const reason = imageReason(r as { code: "failed"; detail?: string });
      expect(reason).toBe(words[lang].img);
      expect(reason).not.toContain(code);
    }
  });

  it.each(["en", "ru"] as const)("an empty or non-string code is still reply not parsed (%s)", (lang) => {
    setProcessLanguage(lang);
    for (const code of ["", 7, null]) {
      const r = run(printing({ ok: false, code }));
      expect(r).toEqual({ ok: false, code: "failed", detail: materialsMessages().docBadReply });
      expect(imageReason(r as { code: "failed"; detail?: string })).toBe(materialsMessages().imgFailed(materialsMessages().docBadReply));
    }
  });

  it("for any unknown code, image and PDF reasons on en and ru do not contain it and detail keeps helper:<code>", () => {
    const rnd = mulberry32(246);
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-";
    for (let i = 0; i < 12; i++) {
      const len = 1 + Math.floor(rnd() * 12);
      const code = "zq-" + Array.from({ length: len }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
      const helper = printing({ ok: false, code });
      const img = run(helper);
      const pdf = runPdf(helper);
      expect(img).toEqual({ ok: false, code: "failed", detail: `helper:${code}` });
      expect(pdf).toEqual({ ok: false, code: "failed", detail: `helper:${code}` });
      for (const lang of ["en", "ru"] as const) {
        setProcessLanguage(lang);
        const reasons = [imageReason(img as { code: "failed"; detail?: string }), pdfReason({ code: "ocr_failed", detail: (pdf as { detail?: string }).detail })];
        expect(reasons).toEqual([words[lang].img, words[lang].pdf]);
        for (const reason of reasons) expect(reason, `seed 246, case ${i}, ${lang}`).not.toContain(code);
      }
    }
  });
});
