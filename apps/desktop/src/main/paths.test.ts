import { describe, expect, it } from "vitest";
import { profileDir, resourceDirs } from "./paths.ts";

const base = { appPath: "/repo/apps/desktop", resourcesPath: "/App/Contents/Resources" };

describe("resourceDirs", () => {
  it("build without dev", () => {
    expect(resourceDirs({ ...base, packaged: true, dev: false })).toEqual({ builtinDir: "/App/Contents/Resources/templates", scenariosDir: null });
  });
  it("build with dev", () => {
    expect(resourceDirs({ ...base, packaged: true, dev: true })).toEqual({ builtinDir: "/App/Contents/Resources/templates", scenariosDir: "/App/Contents/Resources/scenarios" });
  });
  it("development without dev", () => {
    expect(resourceDirs({ ...base, packaged: false, dev: false })).toEqual({ builtinDir: "/repo/templates", scenariosDir: null });
  });
  it("development with dev", () => {
    expect(resourceDirs({ ...base, packaged: false, dev: true })).toEqual({ builtinDir: "/repo/templates", scenariosDir: "/repo/packages/core/scenarios" });
  });
});

describe("profileDir", () => {
  const appData = "/Users/o/Library/Application Support";
  it("built without a key — osen-electron, not the data folder", () => {
    expect(profileDir(false, true, appData)).toBe(`${appData}/osen-electron`);
  });
  it("development without a key — osen-electron-dev", () => {
    expect(profileDir(false, false, appData)).toBe(`${appData}/osen-electron-dev`);
  });
  it("the --user-data-dir key wins in build and in development", () => {
    expect([profileDir(true, true, appData), profileDir(true, false, appData)]).toEqual([null, null]);
  });
});
