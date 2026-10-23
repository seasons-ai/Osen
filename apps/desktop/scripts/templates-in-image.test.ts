import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createRequire } from "node:module";
import { appIconLine, bundleIdentityLine, docExtractLine, fuseLine, htmlWorkerLine, missingTemplateFiles, parse5Line } from "./templates-in-image.ts";

const req = createRequire(import.meta.url);
const { FuseV1Options: F } = req("@electron/fuses");
const { FuseState: S } = req("@electron/fuses/dist/constants");

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "council-img-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const fill = (root: string, files: string[]) => {
  for (const f of files) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), "x"); }
};
const SET = ["en/neutral.md", "en/a.json", "ru/neutral.md", "ru/a.json"];

it("image with both language sets: nothing is missing", () => {
  fill(join(dir, "src"), SET);
  fill(join(dir, "Resources/templates"), SET);
  expect(missingTemplateFiles(join(dir, "src"), join(dir, "Resources/templates"))).toEqual([]);
});

it("a file of the English set (or a whole language folder) is missing: error with the file name", () => {
  fill(join(dir, "src"), SET);
  fill(join(dir, "Resources/templates"), SET.filter((f) => f !== "en/neutral.md"));
  expect(missingTemplateFiles(join(dir, "src"), join(dir, "Resources/templates"))).toEqual(["en/neutral.md"]);
  fill(join(dir, "R2/templates"), ["ru/neutral.md", "ru/a.json"]);
  expect(missingTemplateFiles(join(dir, "src"), join(dir, "R2/templates"))).toEqual(["en/a.json", "en/neutral.md"]);
});

it("a file in the root instead of the language subfolder does not count as present", () => {
  fill(join(dir, "src"), SET);
  fill(join(dir, "Resources/templates"), ["neutral.md", "a.json", "ru/neutral.md", "ru/a.json"]);
  expect(missingTemplateFiles(join(dir, "src"), join(dir, "Resources/templates"))).toEqual(["en/a.json", "en/neutral.md"]);
});

it("HTML text extraction: without html-worker.mjs next to app.asar — refusal with a report line, with the file — fine", () => {
  mkdirSync(join(dir, "main"), { recursive: true });
  expect(htmlWorkerLine(join(dir, "main"))).toEqual({ ok: false, text: "HTML text extraction is unpacked next to app.asar, missing: html-worker.mjs" });
  writeFileSync(join(dir, "main/html-worker.mjs"), 'import "./chunks/guard-x.js";\nimport { a } from "./chunks/materials-y.js";\n');
  expect(htmlWorkerLine(join(dir, "main"))).toEqual({ ok: false, text: "HTML text extraction is unpacked next to app.asar, missing: chunks/guard-x.js, chunks/materials-y.js" });
  fill(join(dir, "main"), ["chunks/guard-x.js", "chunks/materials-y.js"]);
  expect(htmlWorkerLine(join(dir, "main"))).toEqual({ ok: true, text: "HTML text extraction is unpacked next to app.asar" });
});

it("document extraction: doc-extract.mjs only inside app.asar fails, unpacked (with its chunks) passes", () => {
  mkdirSync(join(dir, "main"), { recursive: true });
  const listing = ["/out/main/index.js", "/out/main/doc-extract.mjs"];
  expect(docExtractLine(join(dir, "main"), listing)).toEqual({ ok: false, text: "Document text extraction is unpacked next to app.asar, missing: doc-extract.mjs (found only inside app.asar)" });
  writeFileSync(join(dir, "main/doc-extract.mjs"), 'import "./chunks/zip-x.js";\n');
  expect(docExtractLine(join(dir, "main"), listing)).toEqual({ ok: false, text: "Document text extraction is unpacked next to app.asar, missing: chunks/zip-x.js" });
  fill(join(dir, "main"), ["chunks/zip-x.js"]);
  expect(docExtractLine(join(dir, "main"), listing)).toEqual({ ok: true, text: "Document text extraction is unpacked next to app.asar" });
});

it("parse5 boundary: marker in doc-extract through a chunk passes; reachable from index.js or missing from doc-extract fails", () => {
  const MARK = "abrupt-closing-of-empty-comment";
  const main = join(dir, "main");
  fill(main, ["council.mjs", "osen-mcp.mjs", "chunks/html.js"]);
  writeFileSync(join(main, "doc-extract.mjs"), 'import "./chunks/html.js";\n');
  writeFileSync(join(main, "chunks/html.js"), `"${MARK}"`);
  writeFileSync(join(main, "index.js"), 'import "./chunks/other.js";\n');
  writeFileSync(join(main, "chunks/other.js"), "x");
  expect(parse5Line(main).ok).toBe(true);
  writeFileSync(join(main, "chunks/other.js"), 'import "./html.js";\n');
  const bad = parse5Line(main);
  expect(bad.ok).toBe(false);
  expect(bad.text).toContain("reachable from index.js");
  writeFileSync(join(main, "chunks/other.js"), "x");
  writeFileSync(join(main, "chunks/html.js"), "x");
  expect(parse5Line(main).text).toContain("missing from doc-extract.mjs");
});

const plist = (id: string, name: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleDisplayName</key><string>${name}</string></dict></plist>`;

it("Info.plist: correct identifier and name — OK", () => {
  writeFileSync(join(dir, "Info.plist"), plist("com.osen.desktop", "Osen"));
  expect(bundleIdentityLine(join(dir, "Info.plist")).ok).toBe(true);
});

it("Info.plist: old identifier or name — FAIL with the found values", () => {
  writeFileSync(join(dir, "Info.plist"), plist("com.model-council.desktop", "Osen"));
  const r = bundleIdentityLine(join(dir, "Info.plist"));
  expect(r.ok).toBe(false);
  expect(r.text).toContain("com.model-council.desktop");
  writeFileSync(join(dir, "Info.plist"), plist("com.osen.desktop", "Мозговой штурм"));
  expect(bundleIdentityLine(join(dir, "Info.plist")).ok).toBe(false);
});

const iconPlist = (file: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIconFile</key><string>${file}</string></dict></plist>`;

it("icon: icon.icns in Resources and CFBundleIconFile pointing to it — OK", () => {
  fill(join(dir, "Contents"), ["Resources/icon.icns"]);
  writeFileSync(join(dir, "Contents/Info.plist"), iconPlist("icon.icns"));
  expect(appIconLine(join(dir, "Contents"))).toEqual({ ok: true, text: "icon: Contents/Resources/icon.icns, CFBundleIconFile icon.icns" });
});

it("icon: no icon.icns or CFBundleIconFile names another file — FAIL", () => {
  mkdirSync(join(dir, "Contents/Resources"), { recursive: true });
  writeFileSync(join(dir, "Contents/Info.plist"), iconPlist("icon.icns"));
  expect(appIconLine(join(dir, "Contents")).ok).toBe(false);
  fill(join(dir, "Contents"), ["Resources/icon.icns", "Resources/electron.icns"]);
  writeFileSync(join(dir, "Contents/Info.plist"), iconPlist("electron.icns"));
  const r = appIconLine(join(dir, "Contents"));
  expect(r.ok).toBe(false);
  expect(r.text).toContain("electron.icns");
});

// a fuse set like getCurrentFuseWire: the key is the fuse number, the value is the state code
const wire = (over: Record<number, number | undefined> = {}) => ({ version: "1", [F.RunAsNode]: S.ENABLE, [F.GrantFileProtocolExtraPrivileges]: S.DISABLE, ...over });

it("fuses: GrantFileProtocolExtraPrivileges off, RunAsNode on — OK", () => {
  const r = fuseLine(wire());
  expect(r.ok).toBe(true);
  expect(r.text).toContain("GrantFileProtocolExtraPrivileges disabled");
  expect(r.text).toContain("RunAsNode enabled");
});

it("fuses: GrantFileProtocolExtraPrivileges on — FAIL", () => {
  const r = fuseLine(wire({ [F.GrantFileProtocolExtraPrivileges]: S.ENABLE }));
  expect(r.ok).toBe(false);
  expect(r.text).toContain("expected");
});

it("fuses: RunAsNode off — FAIL", () => {
  expect(fuseLine(wire({ [F.RunAsNode]: S.DISABLE })).ok).toBe(false);
});

it("fuses: field missing or fuse removed — FAIL", () => {
  expect(fuseLine(wire({ [F.GrantFileProtocolExtraPrivileges]: undefined })).ok).toBe(false);
  expect(fuseLine(wire({ [F.RunAsNode]: undefined })).ok).toBe(false);
  expect(fuseLine(wire({ [F.GrantFileProtocolExtraPrivileges]: S.REMOVED })).ok).toBe(false);
});
