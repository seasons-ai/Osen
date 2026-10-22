import { join } from "node:path";

export function resourceDirs(o: { packaged: boolean; appPath: string; resourcesPath: string; dev: boolean }): { builtinDir: string; scenariosDir: string | null } {
  const builtinDir = o.packaged ? join(o.resourcesPath, "templates") : join(o.appPath, "../../templates");
  const scenarios = o.packaged ? join(o.resourcesPath, "scenarios") : join(o.appPath, "../../packages/core/scenarios");
  return { builtinDir, scenariosDir: o.dev ? scenarios : null };
}

// The Electron window profile (cache, SingletonLock) is separate from the osen data folder: macOS is case-insensitive, and Osen is the app name.
// The development window gets its own profile so as not to hit the single-instance lock of the installed one; --user-data-dir wins.
export function profileDir(hasSwitch: boolean, isPackaged: boolean, appData: string): string | null {
  if (hasSwitch) return null;
  return join(appData, isPackaged ? "osen-electron" : "osen-electron-dev");
}

// The OCR helper binary: next to the other resources in the build, in the core source tree in development
export function ocrHelperPath(o: { packaged: boolean; appPath: string; resourcesPath: string }): string {
  return o.packaged ? join(o.resourcesPath, "ocr", "osen-ocr") : join(o.appPath, "../../packages/core/src/ocr/bin/osen-ocr");
}
