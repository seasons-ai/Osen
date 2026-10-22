import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ocrHelperLine } from "./ocr-in-image.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ocr-img-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const helper = (body: string, mode: number) => {
  mkdirSync(join(dir, "ocr"), { recursive: true });
  writeFileSync(join(dir, "ocr/osen-ocr"), body);
  chmodSync(join(dir, "ocr/osen-ocr"), mode);
};

it("fails when the helper is missing", () => {
  const r = ocrHelperLine(dir);
  expect(r.ok).toBe(false);
  expect(r.text).toContain("missing");
});
it("fails when the helper is not executable", () => {
  helper("#!/bin/sh\necho 'osen-ocr 1'\n", 0o644);
  const r = ocrHelperLine(dir);
  expect(r.ok).toBe(false);
  expect(r.text).toContain("not executable");
});
it("fails when the helper prints a wrong version", () => {
  helper("#!/bin/sh\necho 'osen-ocr 2'\n", 0o755);
  const r = ocrHelperLine(dir);
  expect(r.ok).toBe(false);
  expect(r.text).toContain("osen-ocr 2");
});
it("passes with a stub that prints the version", () => {
  helper("#!/bin/sh\necho 'osen-ocr 1'\n", 0o755);
  expect(ocrHelperLine(dir).ok).toBe(true);
});
it("passes with the real built helper", () => {
  const built = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/core/src/ocr/bin/osen-ocr");
  mkdirSync(join(dir, "ocr"));
  copyFileSync(built, join(dir, "ocr/osen-ocr"));
  expect(ocrHelperLine(dir).ok).toBe(true);
});
