import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DOC_LIMITS, documentReason, extractDocumentText, setDocumentExtractorRuntime } from "./extract.ts";
import { makeCfb, makeRtf } from "./fixture.ts";
import { runTextutil, SANDBOX_PROFILE, SYSTEM_TOOLS } from "./textutil.ts";

const mac = process.platform === "darwin";
const run = promisify(execFile);
const lim = (over: Partial<{ ms: number; rssBytes: number; chars: number }> = {}) => ({ ms: DOC_LIMITS.ms, rssBytes: DOC_LIMITS.rssBytes, chars: DOC_LIMITS.chars, ...over });
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "textutil-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  setDocumentExtractorRuntime();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A .doc made at test time by the system converter from generated RTF (nothing binary is stored in git)
async function makeDoc(rtf: string): Promise<Buffer> {
  const dir = tmp();
  writeFileSync(join(dir, "x.rtf"), rtf);
  await run("/usr/bin/textutil", ["-convert", "doc", "-output", join(dir, "x.doc"), join(dir, "x.rtf")]);
  return readFileSync(join(dir, "x.doc"));
}

describe.skipIf(!mac)("RTF and DOC through textutil", () => {
  const paragraphs = ["Первая строка", "漢字 語 text", "Смайл 😀 {скобки} \\слэш", "Последняя"];

  it("RTF: Cyrillic, CJK and astral symbols, paragraph order", async () => {
    const r = await runTextutil(Buffer.from(makeRtf(paragraphs)), "rtf", lim());
    expect(r).toMatchObject({ ok: true, format: "rtf" });
    expect(r.ok && r.text.split("\n").filter(Boolean)).toEqual(paragraphs);
  });

  it("RTF with a leading UTF-8 BOM is read", async () => {
    const r = await runTextutil(Buffer.from("﻿" + makeRtf(["а"])), "rtf", lim());
    expect(r).toMatchObject({ ok: true, text: "а" });
  });

  it("DOC made by textutil: same text; through the real child process for RTF and DOC", async () => {
    const rtf = makeRtf(paragraphs);
    const doc = await makeDoc(rtf);
    expect(doc.subarray(0, 8).toString("hex")).toBe("d0cf11e0a1b11ae1");
    const direct = await runTextutil(doc, "doc", lim());
    expect(direct).toMatchObject({ ok: true, format: "doc" });
    expect(direct.ok && direct.text.split("\n").filter(Boolean)).toEqual(paragraphs);
    expect(extractDocumentText(Buffer.from(rtf))).toMatchObject({ ok: true, format: "rtf", text: paragraphs.join("\n") });
    expect(extractDocumentText(doc)).toMatchObject({ ok: true, format: "doc" });
  }, 30_000);

  it("limits: characters, timeout, memory", async () => {
    const rtf = Buffer.from(makeRtf(["слово слово слово"]));
    expect(await runTextutil(rtf, "rtf", lim({ chars: 5 }))).toEqual({ ok: false, code: "chars" });
    expect(await runTextutil(rtf, "rtf", lim({ ms: 1 }))).toEqual({ ok: false, code: "timeout" });
    // a large input keeps textutil alive past the first 100 ms poll of ps
    const big = Buffer.from(makeRtf(Array.from({ length: 200_000 }, (_, i) => `строка номер ${i} с некоторым текстом`)));
    expect(await runTextutil(big, "rtf", lim({ rssBytes: 2 ** 20 }))).toEqual({ ok: false, code: "memory" });
  }, 60_000);

  it("time limit through the child process on an input it has not finished reading names the limit", () => {
    // the extractor answers "timeout" and exits while the parent is still writing: the parent gets EPIPE and must read the reply
    const big = Buffer.from(makeRtf(Array.from({ length: 60_000 }, (_, i) => `строка ${i}`)));
    expect(extractDocumentText(big, { ...DOC_LIMITS, ms: 1 })).toEqual({ ok: false, code: "timeout" });
  }, 30_000);

  it("damaged and empty documents", async () => {
    expect(await runTextutil(Buffer.from("{\\rtf1 {"), "rtf", lim())).toEqual({ ok: false, code: "damaged" });
    expect(await runTextutil(Buffer.from("{\\rtf1}"), "rtf", lim())).toEqual({ ok: false, code: "no_text" });
    expect(await runTextutil(Buffer.from(makeRtf(["  ", ""])), "rtf", lim())).toEqual({ ok: false, code: "no_text" });
    const garbage = Buffer.concat([makeCfb({ streams: ["WordDocument"] }), Buffer.alloc(2048, 7)]);
    expect(await runTextutil(garbage, "doc", lim())).toMatchObject({ ok: false, code: "damaged" });
    expect(extractDocumentText(garbage)).toMatchObject({ ok: false, code: "damaged" });
  }, 30_000);

  it("unavailable tools: a closed refusal, and textutil never runs without the sandbox", async () => {
    const dir = tmp();
    const counter = join(dir, "counter");
    writeFileSync(counter, "");
    const stub = join(dir, "textutil-stub");
    writeFileSync(stub, `#!/bin/sh\necho ran >> '${counter}'\necho stub text\n`);
    chmodSync(stub, 0o755);
    const rtf = Buffer.from(makeRtf(["а"]));
    const gone = { code: "textutil_unavailable" };
    expect(await runTextutil(rtf, "rtf", lim(), { sandbox: join(dir, "missing"), textutil: stub })).toMatchObject(gone);
    expect(readFileSync(counter, "utf8")).toBe("");
    expect(await runTextutil(rtf, "rtf", lim(), { sandbox: SYSTEM_TOOLS.sandbox, textutil: join(dir, "missing") })).toMatchObject(gone);
    // the stub through the real sandbox runs, but its write is denied
    expect(await runTextutil(rtf, "rtf", lim(), { sandbox: SYSTEM_TOOLS.sandbox, textutil: stub })).toMatchObject({ ok: true, text: "stub text" });
    expect(readFileSync(counter, "utf8")).toBe("");
    // the same seam through the child process: the reason is the textutil one
    setDocumentExtractorRuntime({ tools: { sandbox: join(dir, "missing"), textutil: stub } });
    const r = extractDocumentText(rtf);
    expect(r).toEqual({ ok: false, code: "textutil_unavailable" });
    expect(documentReason(r as { code: "textutil_unavailable" })).toBe("не удалось извлечь текст — системная утилита textutil недоступна");
    expect(readFileSync(counter, "utf8")).toBe("");
  }, 30_000);
});

describe.skipIf(!mac)("Текст RTF и DOC", () => {
  // seeded LCG, no Math.random
  let state = 12345;
  const rnd = (n: number): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return Math.floor((state / 2 ** 32) * n); };
  const pieces = ["привет", "мир", "漢字", "語", "😀", "𝒳", "{", "}", "\\", "abc", "Ёлка", "x1", "п́"];

  it("generated paragraphs come back in the same order with the same words", async () => {
    for (let i = 0; i < 20; i++) {
      const paras = Array.from({ length: 2 + rnd(3) }, () => Array.from({ length: 1 + rnd(6) }, () => pieces[rnd(pieces.length)]!).join(rnd(2) ? " " : "  "));
      const rtf = makeRtf(paras);
      // RTF \uN is a signed 16-bit number: textutil also accepts unsigned ones, so the form is checked on the fixture itself
      for (const m of rtf.matchAll(/\\u(-?\d+)\?/g)) {
        expect(Number(m[1])).toBeGreaterThanOrEqual(-32768);
        expect(Number(m[1])).toBeLessThanOrEqual(32767);
      }
      if (paras.join("").includes("😀")) expect(rtf).toContain("\\u-10179?\\u-8704?");
      const r = await runTextutil(Buffer.from(rtf), "rtf", lim());
      expect(r.ok && norm(r.text), JSON.stringify(paras)).toBe(norm(paras.join(" ")));
    }
  }, 60_000);

  it("a DOC round trip keeps the text", async () => {
    const paras = ["Первая 語", "😀 Вторая"];
    const r = await runTextutil(await makeDoc(makeRtf(paras)), "doc", lim());
    expect(r.ok && norm(r.text)).toBe(norm(paras.join(" ")));
  }, 30_000);
});

describe.skipIf(!mac)("Изоляция системного преобразования", () => {
  const sandboxed = (...cmd: string[]) => run(SYSTEM_TOOLS.sandbox, ["-p", SANDBOX_PROFILE, ...cmd]).then(() => 0, (e: { code: number }) => e.code);

  it("the profile denies file writes", async () => {
    const f = join(tmp(), "created");
    expect(await sandboxed("/usr/bin/touch", f)).not.toBe(0);
    expect(existsSync(f)).toBe(false);
    // without the sandbox the same command creates the file
    await run("/usr/bin/touch", [f]);
    expect(existsSync(f)).toBe(true);
  });

  it("the profile denies network connections, a RTF with links makes none", async () => {
    let connections = 0;
    const server = net.createServer((s) => { connections++; s.destroy(); });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as net.AddressInfo).port;
    const pause = () => new Promise((ok) => setTimeout(ok, 300));
    try {
      await run("/usr/bin/nc", ["-z", "127.0.0.1", String(port)]);
      await pause();
      expect(connections).toBe(1);
      expect(await sandboxed("/usr/bin/nc", "-z", "127.0.0.1", String(port))).not.toBe(0);
      await pause();
      expect(connections).toBe(1);
      const url = `http://127.0.0.1:${port}/x`;
      const rtf = `{\\rtf1 {\\field{\\*\\fldinst HYPERLINK "${url}"}{\\fldrslt link}}{\\field{\\*\\fldinst INCLUDEPICTURE "${url}"}{\\fldrslt pic}}\\par}`;
      expect(await runTextutil(Buffer.from(rtf), "rtf", lim())).toMatchObject({ ok: true });
      await pause();
      expect(connections).toBe(1);
    } finally {
      server.close();
    }
  }, 30_000);

  it("the profile is one constant with both denials", () => {
    expect(SANDBOX_PROFILE).toBe("(version 1)(allow default)(deny network*)(deny file-write*)");
    expect(spawnSync(SYSTEM_TOOLS.sandbox, ["-p", SANDBOX_PROFILE, "/usr/bin/true"]).status).toBe(0);
  });
});
