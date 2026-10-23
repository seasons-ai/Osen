import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DOC_LIMITS } from "../documents/limits.ts";
import { materialsMessages } from "../messages/materials.ts";
import { makeImage } from "./fixture.ts";
import { imageReason, OCR_LIMITS, runOcrHelper, setOcrRuntime, type OcrImageRequest } from "./run.ts";

const REQ: OcrImageRequest = { mode: "image", ms: 10_000, rssBytes: OCR_LIMITS.rssBytes };
const REAL = join(import.meta.dirname, "bin/osen-ocr");
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\n ]/gu, "");
let dir: string;
beforeAll(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "ocr-run-"))); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => { setOcrRuntime(); delete process.env.COUNCIL_OCR_HELPER; });

let n = 0;
function stub(body: string, mode = 0o755): string {
  const f = join(dir, `stub-${n++}.sh`);
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
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

  it("keeps any other helper code as failed with the code as detail", () => {
    expect(run(printing({ ok: false, code: "vision" }))).toEqual({ ok: false, code: "failed", detail: "vision" });
    expect(run(printing({ ok: false, code: "bad_request" }))).toEqual({ ok: false, code: "failed", detail: "bad_request" });
  });

  it("treats an unparsable reply as failed with the catalog text", () => {
    const r = run(stub("C=$(/bin/cat)\necho not-json"));
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
    expect(r).toEqual({ ok: false, code: "failed", detail: "bad_request" });
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
    expect(imageReason({ code: "failed", detail: "vision" })).toBe("не удалось распознать текст изображения — vision");
  });
});
