import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { writeExecutable } from "../../../packages/core/src/executable.testutil.ts";
import { ocrHelperLine } from "./ocr-in-image.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ocr-img-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const helper = (body: string, mode: number) => {
  mkdirSync(join(dir, "ocr"), { recursive: true });
  const file = join(dir, "ocr/osen-ocr");
  if (mode & 0o111) { writeExecutable(file, body, mode); return; }
  writeFileSync(file, body); // never launched, so no warm-up
  chmodSync(file, mode);
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
  writeExecutable(join(dir, "ocr/osen-ocr"), readFileSync(built));
  expect(ocrHelperLine(dir).ok).toBe(true);
});
