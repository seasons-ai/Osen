// Check of the .dmg contents: node apps/desktop/scripts/check-image.ts [path to .dmg]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ocrHelperLine } from "./ocr-in-image.ts";
import { reportHeadlessLines } from "./headless-in-image.ts";
import { appIconLine, bundleIdentityLine, FONT_FILES, docExtractLine, fuseLine, htmlWorkerLine, missingFontFiles, missingTemplateFiles } from "./templates-in-image.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const releaseDir = join(root, "apps/desktop/release.noindex");
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD/i;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) out.push(p, ...walk(p));
    else out.push(p);
  }
  return out;
}

function secretsFrom(env: Record<string, string | undefined>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) if (SECRET_NAME.test(k) && v && v.length >= 6) m.set(k, v);
  return m;
}

function parseDotenv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return env;
}

let failed = false;
const report = (ok: boolean, text: string) => {
  if (!ok) failed = true;
  console.log(`${ok ? "OK  " : "FAIL"} ${text}`);
};

let image = process.argv[2];
if (!image) {
  const dmgs = existsSync(releaseDir) ? readdirSync(releaseDir).filter((f) => f.startsWith("osen-") && f.endsWith(".dmg")) : [];
  const latest = dmgs.map((f) => join(releaseDir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!latest) { console.error(`FAIL no osen-*.dmg in ${releaseDir}`); process.exit(1); }
  image = latest;
}
image = resolve(image);

const work = mkdtempSync(join(tmpdir(), "check-image-"));
const mnt = join(work, "mnt");
const unpacked = join(work, "asar");
let mounted = false;
try {
  execFileSync("mkdir", [mnt]);
  execFileSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mnt, image], { stdio: "pipe" });
  mounted = true;

  const appName = "Osen.app";
  if (!existsSync(join(mnt, appName))) throw new Error(`the image has no ${appName}: ${readdirSync(mnt).join(", ")}`);
  const identity = bundleIdentityLine(join(mnt, appName, "Contents/Info.plist"));
  report(identity.ok, identity.text);
  const icon = appIconLine(join(mnt, appName, "Contents"));
  report(icon.ok, icon.text);
  // getCurrentFuseWire only reads the binary, the image is mounted read-only
  const { getCurrentFuseWire } = createRequire(import.meta.url)("@electron/fuses");
  const fuses = fuseLine(await getCurrentFuseWire(join(mnt, appName, "Contents/MacOS/Osen")));
  report(fuses.ok, fuses.text);
  const res = join(mnt, appName, "Contents/Resources");
  const asar = join(res, "app.asar");
  let appRoot: string;
  if (existsSync(asar)) {
    const { extractAll } = createRequire(import.meta.url)("@electron/asar");
    extractAll(asar, unpacked);
    appRoot = unpacked;
  } else {
    appRoot = join(res, "app");
    execFileSync("mkdir", [unpacked]);
  }

  const imageFiles = walk(mnt);
  const asarFiles = existsSync(appRoot) ? walk(appRoot) : [];
  const all: { path: string; shown: string }[] = [
    ...imageFiles.map((p) => ({ path: p, shown: p.slice(mnt.length + 1) })),
    ...(appRoot === unpacked ? asarFiles.map((p) => ({ path: p, shown: `app.asar:${p.slice(unpacked.length + 1)}` })) : []),
  ];
  const segs = (s: string) => s.split(/[/:]/);

  report(existsSync(join(res, "LICENSE")), "LICENSE is present in the app resources");

  const missing = missingTemplateFiles(join(root, "templates"), join(res, "templates"));
  report(missing.length === 0, `templates from templates/ (every language folder) are present${missing.length ? `, missing: ${missing.join(", ")}` : ""}`);

  const unpackedMain = join(res, "app.asar.unpacked/out/main");
  const noPdf = ["pdf-extract.mjs", "pdf-worker.mjs"].filter((f) => !existsSync(join(unpackedMain, f)));
  report(noPdf.length === 0, `PDF text extraction is unpacked next to app.asar${noPdf.length ? `, missing: ${noPdf.join(", ")}` : ""}`);
  const doc = docExtractLine(unpackedMain, existsSync(asar) ? (createRequire(import.meta.url)("@electron/asar").listPackage(asar, {}) as string[]) : []);
  report(doc.ok, doc.text);
  const html = htmlWorkerLine(unpackedMain);
  report(html.ok, html.text);
  // run on the mounted (read-only) image: --version reads nothing and writes nothing
  const ocr = ocrHelperLine(res);
  report(ocr.ok, ocr.text);

  const noFonts = missingFontFiles(appRoot);
  report(noFonts.length === 0, `IBM Plex Sans and JetBrains Mono fonts in app.asar: .woff2 ${FONT_FILES.length - noFonts.length} of ${FONT_FILES.length}${noFonts.length ? `, missing: ${noFonts.join(", ")}` : ""}`);

  // the image is read-only: run the entry points on a copy inside the project (no quarantine attribute: Gatekeeper would ask the owner)
  const copyDir = mkdtempSync(join(root, ".council-data", "headless-image-"));
  try {
    execFileSync("ditto", [join(mnt, appName), join(copyDir, appName)], { stdio: "pipe" });
    await reportHeadlessLines(join(copyDir, appName, "Contents"), copyDir, report);
  } finally {
    rmSync(copyDir, { recursive: true, force: true });
  }

  const bad = (re: (s: string) => boolean) => all.filter((f) => re(basename(f.shown))).map((f) => f.shown);
  const list = (a: string[]) => (a.length ? `: ${a.slice(0, 5).join(", ")}` : "");

  let r = bad((n) => n === ".env" || n.startsWith(".env."));
  report(r.length === 0, `no .env* files${list(r)}`);

  r = all.filter((f) => segs(f.shown).some((s) => s === ".council-data" || s === "sessions")).map((f) => f.shown);
  report(r.length === 0, `no paths with .council-data and sessions${list(r)}`);

  r = bad((n) => /\.(pem|key|p12)$/.test(n));
  report(r.length === 0, `no *.pem, *.key, *.p12 files${list(r)}`);

  r = asarFiles.filter((p) => segs(p.slice(appRoot.length + 1)).includes("node_modules")).slice(0, 5);
  report(r.length === 0, `no node_modules inside app.asar${list(r)}`);

  const secrets = secretsFrom(process.env);
  const envFile = join(root, ".env");
  if (existsSync(envFile)) for (const [k, v] of secretsFrom(parseDotenv(envFile))) secrets.set(k, v);
  const hits: string[] = [];
  for (const f of all) {
    if (!statSync(f.path).isFile()) continue;
    let text: string;
    try { text = readFileSync(f.path, "latin1"); } catch { continue; }
    for (const [name, value] of secrets) {
      if (text.includes(Buffer.from(value, "utf8").toString("latin1")) || text.includes(value)) hits.push(`${name} in ${f.shown}`);
    }
  }
  report(hits.length === 0, hits.length === 0 ? `no secret values found, names checked: ${secrets.size}` : `secret values found${list(hits)}`);
} catch (e) {
  report(false, `check not performed: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (mounted) { try { execFileSync("hdiutil", ["detach", mnt, "-force"], { stdio: "pipe" }); } catch { /* already detached */ } }
  rmSync(work, { recursive: true, force: true });
}
console.log(`${failed ? "CHECK FAILED" : "ALL CHECKS PASSED"}: ${image}`);
process.exit(failed ? 1 : 0);
