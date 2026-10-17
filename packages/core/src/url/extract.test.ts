import { afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import { join } from "node:path";
import { extractUrlText, UrlTextError } from "./extract.ts";
import { readFileSync } from "node:fs";

const PAGE = '<html><head><title>T</title><script>var a=1</script><style>p{}</style></head><body><h1>Заголовок</h1><p>Первый <b>абзац</b>.</p><script>alert("X")</script><img src="http://example.com/a.png" alt="ALT"><p>Второй абзац.</p></body></html>';
const EXPECTED = "Заголовок\n\nПервый абзац.\n\nВторой абзац.";
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s));
const html = (s: string) => ({ bytes: bytes(s), contentType: "text/html" as const });
const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try { await p; } catch (e) { return e instanceof UrlTextError ? e.code : "other"; }
  return undefined;
};

describe("extractUrlText", () => {
  it("plain and markdown are returned as is, BOM is stripped", async () => {
    expect(await extractUrlText({ bytes: bytes("# Привет\n\nтекст"), contentType: "text/markdown" })).toBe("# Привет\n\nтекст");
    expect(await extractUrlText({ bytes: bytes("﻿abc  d"), contentType: "text/plain" })).toBe("abc  d");
  });

  it("html via the real worker", async () => {
    expect(await extractUrlText(html(PAGE))).toBe(EXPECTED);
  });

  it("empty result: only script and whitespace text", async () => {
    expect(await codeOf(extractUrlText(html("<script>x()</script>")))).toBe("empty");
    expect(await codeOf(extractUrlText({ bytes: bytes(" \n\t "), contentType: "text/plain" }))).toBe("empty");
  });

  it("encoding and binary data", async () => {
    const cp1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    expect(await codeOf(extractUrlText({ bytes: cp1251, contentType: "text/plain" }))).toBe("not-text");
    expect(await codeOf(extractUrlText({ bytes: cp1251, contentType: "text/plain", charset: "windows-1251" }))).toBe("charset");
    expect(await extractUrlText({ bytes: bytes("ok"), contentType: "text/plain", charset: "UTF-8" })).toBe("ok");
  });

  it("deadline: the worker ends, an expired deadline gives an immediate timeout", async () => {
    const worker = join(import.meta.dirname, "fixtures", "spin-worker.ts");
    const t0 = Date.now();
    expect(await codeOf(extractUrlText(html(PAGE), { worker, deadline: Date.now() + 300 }))).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await codeOf(extractUrlText(html(PAGE), { deadline: Date.now() - 1 }))).toBe("timeout");
  });

  describe("resources are not loaded", () => {
    let hits = 0;
    const server = http.createServer((_q, r) => { hits++; r.end(""); });
    afterAll(() => new Promise<void>((res) => server.close(() => res())));
    it("img, link, script, iframe are not requested", async () => {
      await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const page = `<html><head><link rel="stylesheet" href="${base}/s.css"><script src="${base}/s.js"></script></head>` +
        `<body><p>текст</p><img src="${base}/a.png"><iframe src="${base}/f"></iframe></body></html>`;
      expect(await extractUrlText(html(page))).toBe("текст");
      await new Promise((r) => setTimeout(r, 200));
      expect(hits).toBe(0);
    });
  });

  it("a 2 MiB document is extracted in under 10 s", async () => {
    const chunk = "<p>абзац</p>";
    const doc = chunk.repeat(Math.ceil((2 * 2 ** 20) / Buffer.byteLength(chunk)));
    const t0 = Date.now();
    const text = await extractUrlText(html(doc));
    expect(text.startsWith("абзац")).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);

  it("the main module does not pull in the parser", () => {
    const src = readFileSync(join(import.meta.dirname, "extract.ts"), "utf8");
    expect(src).not.toContain("parse5");
    expect(src).not.toContain("html-text");
  });
});
