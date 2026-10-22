import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/** Files of the source templates folder (including language subfolders) that are missing from the image folder: paths like `en/neutral.md`. */
export function missingTemplateFiles(source: string, installed: string, sub = ""): string[] {
  return readdirSync(join(source, sub), { withFileTypes: true }).flatMap((e) => {
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) return missingTemplateFiles(source, installed, rel);
    return existsSync(join(installed, rel)) ? [] : [rel];
  });
}

/** Report line about unpacking the HTML text extraction next to app.asar. */
export function htmlWorkerLine(unpackedMain: string): { ok: boolean; text: string } {
  // the worker loads shared parts by a relative path: they must be unpacked too
  const imports = (f: string) => [...readFileSync(join(unpackedMain, f), "utf8").matchAll(/(?:from|import)\s*"\.\/([^"]+)"/g)].map((m) => m[1]!);
  const worker = ["html-worker.mjs"].filter((f) => existsSync(join(unpackedMain, f)));
  const missing = ["html-worker.mjs", ...worker.flatMap(imports)].filter((f) => !existsSync(join(unpackedMain, f)));
  return { ok: missing.length === 0, text: `HTML text extraction is unpacked next to app.asar${missing.length ? `, missing: ${missing.join(", ")}` : ""}` };
}

/** Report line about unpacking the document extractor next to app.asar: out/main/doc-extract.mjs found only inside the archive fails. */
export function docExtractLine(unpackedMain: string, asarListing: string[]): { ok: boolean; text: string } {
  const name = "doc-extract.mjs";
  const onDisk = existsSync(join(unpackedMain, name));
  const inArchive = asarListing.some((p) => p.replace(/\\/g, "/").endsWith(`/out/main/${name}`));
  const imports = onDisk ? [...readFileSync(join(unpackedMain, name), "utf8").matchAll(/(?:from|import)\s*"\.\/([^"]+)"/g)].map((m) => m[1]!) : [];
  const missing = [...(onDisk ? [] : [name]), ...imports.filter((f) => !existsSync(join(unpackedMain, f)))];
  const where = !onDisk && inArchive ? " (found only inside app.asar)" : "";
  return { ok: missing.length === 0, text: `Document text extraction is unpacked next to app.asar${missing.length ? `, missing: ${missing.join(", ")}${where}` : ""}` };
}

/** Report line of the package Info.plist check: identifier com.osen.desktop and display name Osen. */
export function bundleIdentityLine(plist: string): { ok: boolean; text: string } {
  const info = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" })) as Record<string, unknown>;
  const id = info["CFBundleIdentifier"];
  const name = info["CFBundleDisplayName"];
  const ok = id === "com.osen.desktop" && name === "Osen";
  return { ok, text: `Info.plist: CFBundleIdentifier ${String(id)}, CFBundleDisplayName ${String(name)}${ok ? "" : " (expected com.osen.desktop and Osen)"}` };
}

/** Report line of the package icon check: Contents/Resources/icon.icns exists, CFBundleIconFile in Info.plist points to it. */
export function appIconLine(contents: string): { ok: boolean; text: string } {
  const info = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", join(contents, "Info.plist")], { encoding: "utf8" })) as Record<string, unknown>;
  const file = String(info["CFBundleIconFile"]);
  const has = existsSync(join(contents, "Resources/icon.icns"));
  const ok = has && file === "icon.icns";
  return { ok, text: `icon: Contents/Resources/icon.icns${has ? "" : " is missing"}, CFBundleIconFile ${file}${ok ? "" : " (expected icon.icns)"}` };
}

/** @fontsource fonts that the build must carry: file name without the Vite hash and extension. */
export const FONT_FILES = [
  ...["cyrillic", "latin"].flatMap((s) => ["400", "500", "600"].map((w) => `ibm-plex-sans-${s}-${w}-normal`)),
  ...["cyrillic", "latin"].flatMap((s) => ["400", "500"].map((w) => `jetbrains-mono-${s}-${w}-normal`)),
];

/** Fonts from FONT_FILES that have no `<name>[-hash].woff2` file in the folder (with subfolders). */
export function missingFontFiles(dir: string): string[] {
  const names = readdirSync(dir, { recursive: true, encoding: "utf8" }).map((p) => p.split("/").pop()!).filter((n) => n.endsWith(".woff2"));
  return FONT_FILES.filter((f) => !names.some((n) => n === `${f}.woff2` || n.startsWith(`${f}-`)));
}

/** Report line of the fuse check: GrantFileProtocolExtraPrivileges is disabled, RunAsNode is enabled (PDF text extraction runs with it). `wire` is the getCurrentFuseWire result: key is the fuse number, value is the state code. */
export function fuseLine(wire: Record<number, unknown>): { ok: boolean; text: string } {
  // the package does not export FuseState, take it from its constants
  const req = createRequire(import.meta.url);
  const { FuseV1Options: { RunAsNode: RUN_AS_NODE, GrantFileProtocolExtraPrivileges: GRANT_FILE } } = req("@electron/fuses");
  const { FuseState: { DISABLE, ENABLE } } = req("@electron/fuses/dist/constants");
  const name = (v: unknown) => (v === ENABLE ? "enabled" : v === DISABLE ? "disabled" : v === undefined ? "not found" : `state ${String(v)}`);
  const grant = wire[GRANT_FILE], run = wire[RUN_AS_NODE];
  const ok = grant === DISABLE && run === ENABLE;
  return { ok, text: `fuses: GrantFileProtocolExtraPrivileges ${name(grant)}, RunAsNode ${name(run)}${ok ? "" : " (expected: GrantFileProtocolExtraPrivileges disabled, RunAsNode enabled)"}` };
}
