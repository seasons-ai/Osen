import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { copyDirFor } from "./image-copy.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "image-copy-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

it("clean copy without .council-data: copyDirFor creates the parent and a temp dir inside it", () => {
  expect(existsSync(join(root, ".council-data"))).toBe(false);
  const dir = copyDirFor(root);
  expect(statSync(dir).isDirectory()).toBe(true);
  expect(dirname(dir)).toBe(join(root, ".council-data"));
  expect(basename(dir).startsWith("headless-image-")).toBe(true);
});

it("existing .council-data: two calls give two different dirs", () => {
  mkdirSync(join(root, ".council-data"));
  const a = copyDirFor(root);
  const b = copyDirFor(root);
  expect(a).not.toBe(b);
  expect(statSync(b).isDirectory()).toBe(true);
});
