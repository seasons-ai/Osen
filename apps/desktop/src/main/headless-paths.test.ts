import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { headlessBinPath } from "./headless-paths.ts";

const root = mkdtempSync(join(realpathSync(tmpdir()), "headless-paths-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, "bin"));
writeFileSync(join(root, "bin", "council"), "#!/bin/sh\n");
chmodSync(join(root, "bin", "council"), 0o755);
writeFileSync(join(root, "bin", "osen-mcp"), "#!/bin/sh\n");
chmodSync(join(root, "bin", "osen-mcp"), 0o644);

describe("headlessBinPath", () => {
  it("returns the absolute path of an executable wrapper in a packaged app", () => {
    expect(headlessBinPath("council", { packaged: true, resourcesPath: root })).toBe(join(root, "bin", "council"));
  });
  it("returns null when the wrapper is missing", () => {
    expect(headlessBinPath("council", { packaged: true, resourcesPath: join(root, "nope") })).toBeNull();
  });
  it("returns null when the wrapper is not executable", () => {
    expect(headlessBinPath("osen-mcp", { packaged: true, resourcesPath: root })).toBeNull();
  });
  it("returns null outside the package", () => {
    expect(headlessBinPath("council", { packaged: false, resourcesPath: root })).toBeNull();
  });
});
