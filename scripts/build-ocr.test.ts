import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isStale } from "./build-ocr.ts";

const dir = mkdtempSync(join(tmpdir(), "build-ocr-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, mtimeSec: number): string {
  const p = join(dir, name);
  writeFileSync(p, "x");
  utimesSync(p, mtimeSec, mtimeSec);
  return p;
}

describe("isStale", () => {
  it("helpers missing: no output file is stale", () => {
    expect(isStale([file("a.swift", 1000)], join(dir, "missing"))).toBe(true);
  });

  it("source newer than the built file is stale", () => {
    const out = file("out1", 2000);
    expect(isStale([file("old.swift", 1000), file("new.swift", 3000)], out)).toBe(true);
  });

  it("helpers up to date: equal mtime or newer output is not stale", () => {
    const src = file("s.swift", 2000);
    expect(isStale([src], file("out-equal", 2000))).toBe(false);
    expect(isStale([src], file("out-newer", 3000))).toBe(false);
  });
});
