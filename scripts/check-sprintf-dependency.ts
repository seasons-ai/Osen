// Build-boundary guard for Dependabot alert #1, GHSA-hp3w-g68c-fv3c (sprintf-js <= 1.1.3, no patched release), 0 model calls:
//   node scripts/check-sprintf-dependency.ts [--app <Osen.app> | --app none] [--logger-dir <dir>] [--out-dir <dir>]
//   node scripts/check-sprintf-dependency.ts --self-check
// The vulnerable package is installed only through electron-builder -> @electron/get -> global-agent -> roarr -> sprintf-js.
// Containment holds while: every installed path is dev, every global-agent logger call passes a literal format,
// and neither apps/desktop/out (run `npm run build -w @model-council/desktop` first) nor the packaged app contains it.
// Any FAIL exits 1; missing evidence is FAIL, a missing packaged app is NOT_VERIFIED. node_modules is only read.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { parse } from "@babel/parser";

const repo = resolve(import.meta.dirname, "..");
const require = createRequire(join(repo, "package.json"));
const WATCHDOG_MS = 5_000;
const LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);
// Package names, the sprintf-js error prefix and the roarr and global-agent globals: string literals and property names survive minification
const RUNTIME_TOKENS = ["sprintf-js", "[sprintf]", "roarr", "ROARR", "global-agent", "GLOBAL_AGENT"];
// A require or import of roarr or of global-agent's Logger module, in any quote style
const LOGGER_USER = /(require\(\s*["'`]|from\s+["'`])(roarr|[./]*Logger(\.js)?)["'`]/;

type Status = "PASS" | "FAIL" | "NOT_VERIFIED" | "INFO";
type Line = { status: Status; text: string };

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const run = promisify(execFile);
async function supervised(args: string[], timeout = WATCHDOG_MS) {
  const pending = run(process.execPath, args, { cwd: repo, timeout, maxBuffer: 16 * 1024 * 1024 });
  pending.child.stdin?.end();
  try {
    const { stdout } = await pending;
    return { code: 0, stdout, why: "" };
  } catch (e) {
    const err = e as { killed?: boolean; code?: number; stdout?: string; message: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", why: err.killed ? `watchdog ${timeout} ms exceeded` : err.message };
  }
}

type Explained = { version: string; location: string; dev: boolean; optional: boolean; dependents: { from: { name: string } }[] };
const explain = (name: string): Explained[] => JSON.parse(execFileSync("npm", ["explain", name, "--json"], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] }).toString());
const dependents = (entries: Explained[]) => [...new Set(entries.flatMap((e) => e.dependents.map((d) => d.from.name)))];

// 1. Every installed sprintf-js must be dev-only, roarr its only dependent and global-agent roarr's only dependent:
// otherwise the format-call review below does not cover all callers.
function dependencyLines(): Line[] {
  const lines: Line[] = [];
  const sprintf = explain("sprintf-js");
  if (sprintf.length === 0) return [{ status: "FAIL", text: "dependency: npm explain sprintf-js returned nothing; evidence missing" }];
  for (const e of sprintf) lines.push({ status: e.dev ? "PASS" : "FAIL", text: `dependency: sprintf-js@${e.version} at ${e.location} dev=${e.dev} optional=${e.optional}` });
  const users = dependents(sprintf);
  lines.push({ status: users.length === 1 && users[0] === "roarr" ? "PASS" : "FAIL", text: `dependency: sprintf-js dependents: ${users.join(", ") || "none"} (reviewed: roarr only)` });
  const chain = execFileSync("npm", ["ls", "sprintf-js", "--all"], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  lines.push({ status: "INFO", text: `dependency: npm ls sprintf-js --all\n       ${chain.split("\n").slice(1).join("\n       ")}` });
  const roarr = explain("roarr");
  const callers = dependents(roarr);
  lines.push({ status: callers.length === 1 && callers[0] === "global-agent" ? "PASS" : "FAIL", text: `dependency: roarr@${roarr.map((e) => e.version).join(",")} dependents: ${callers.join(", ") || "none"} (reviewed: global-agent only)` });
  return lines;
}

// 2. Library defect: precision above 100 throws RangeError in Number#toFixed/toExponential/toPrecision.
async function primitiveLines(script = ""): Promise<Line[]> {
  const path = require.resolve("sprintf-js");
  const probe = script || `const { sprintf } = require(${JSON.stringify(path)});
const out = {};
for (const f of ["%.101f", "%.101e", "%.101g"]) { try { sprintf(f, 1); out[f] = "no error"; } catch (e) { out[f] = e.constructor.name; } }
out.controls = sprintf("%s|%.2f", "a", 1.25) === "a|1.25";
console.log(JSON.stringify(out));`;
  const r = await supervised(["-e", probe]);
  if (r.code !== 0) return [{ status: "FAIL", text: `primitive: probe did not finish (${r.why})` }];
  const out = JSON.parse(r.stdout) as Record<string, string | boolean>;
  const thrown = ["%.101f", "%.101e", "%.101g"].filter((f) => out[f] === "RangeError");
  return [
    { status: "INFO", text: `primitive: ${thrown.length === 3 ? "reproduced" : `not reproduced (${JSON.stringify(out)})`}: ${thrown.join(", ")} throw RangeError in ${relative(repo, path)}` },
    { status: out.controls ? "PASS" : "FAIL", text: `primitive: normal %s and %.2f controls ${out.controls ? "format" : "do not format"}` },
  ];
}

// 3. Every global-agent logger call passes a literal format. roarr formats the message argument
// (the first argument, or the second when the first is a context object); values never become a format.
// Level methods reached any other way (computed name, alias, destructuring, a direct roarr call) cannot be reviewed and fail.
type Node = { type?: string; loc?: { start: { line: number } }; [key: string]: unknown };
export function formatLines(dirs: string[]): Line[] {
  const missing = dirs.filter((d) => !existsSync(d));
  if (dirs.length === 0 || missing.length) return [{ status: "FAIL", text: `format: ${missing.join(", ") || "no global-agent"} missing; evidence missing` }];
  const files = dirs.flatMap(walk).filter((f) => /\.(c|m)?js$/.test(f) && LOGGER_USER.test(readFileSync(f, "utf8")));
  if (files.length === 0) return [{ status: "FAIL", text: `format: no logger users under ${dirs.join(", ")}; source shape changed` }];
  const lines: Line[] = [];
  let calls = 0;
  const levelOf = (m: Node) => {
    const prop = m.property as Node & { name?: string; value?: unknown };
    const name = m.computed ? (prop.type === "StringLiteral" ? String(prop.value) : undefined) : prop.name;
    return { name, unknown: m.computed && prop.type !== "StringLiteral" };
  };
  for (const file of files) {
    const at = (n: Node) => `${relative(repo, file)}:${n.loc?.start.line}`;
    const callees = new Set<unknown>();
    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      const n = node as Node;
      if (n.type === "CallExpression") {
        let callee = n.callee as Node;
        if (callee.type === "SequenceExpression") callee = (callee.expressions as Node[]).at(-1)!;
        callees.add(callee);
        if (callee.type === "MemberExpression") {
          const object = callee.object as Node & { name?: string };
          const { name, unknown } = levelOf(callee);
          if (object.type === "Identifier" && object.name === "console") { /* not the logger */ }
          else if (unknown) lines.push({ status: "FAIL", text: `format: ${at(n)} calls a computed method; cannot review` });
          else if (LEVELS.has(name ?? "")) {
            calls++;
            const [first, second] = n.arguments as (Node & { expressions?: unknown[] })[];
            const format = first?.type === "ObjectExpression" ? second : first;
            const literal = format?.type === "StringLiteral" || (format?.type === "TemplateLiteral" && format.expressions?.length === 0);
            if (!literal) lines.push({ status: "FAIL", text: `format: ${at(n)} passes ${format?.type ?? "no"} format` });
          } else if (name === "default" && object.type === "Identifier" && /roarr/i.test(object.name ?? "")) lines.push({ status: "FAIL", text: `format: ${at(n)} calls roarr directly; cannot review` });
        } else if (callee.type === "Identifier" && /roarr/i.test(String(callee.name))) lines.push({ status: "FAIL", text: `format: ${at(n)} calls roarr directly; cannot review` });
      }
      if (n.type === "MemberExpression" && !callees.has(n) && LEVELS.has(levelOf(n).name ?? "") && (n.object as Node & { name?: string }).name !== "console") lines.push({ status: "FAIL", text: `format: ${at(n)} takes a level method without calling it; cannot review` });
      if (n.type === "ObjectPattern" && (n.properties as (Node & { key?: { name?: string; value?: unknown } })[]).some((p) => LEVELS.has(String(p.key?.name ?? p.key?.value)))) lines.push({ status: "FAIL", text: `format: ${at(n)} destructures a level method; cannot review` });
      for (const v of Object.values(node)) if (v && typeof v === "object") visit(v);
    };
    visit(parse(readFileSync(file, "utf8"), { sourceType: "unambiguous" }).program);
  }
  if (calls === 0) lines.push({ status: "FAIL", text: `format: no logger calls found in ${files.length} files; source shape changed` });
  else if (lines.length === 0) lines.push({ status: "PASS", text: `format: ${calls} logger calls in ${files.length} files under ${dirs.map((d) => relative(repo, d)).join(", ")} pass literal formats` });
  return lines;
}

function hits(files: { name: string; text: () => string }[]): string[] {
  const found: string[] = [];
  for (const f of files) {
    if (RUNTIME_TOKENS.some((t) => f.name.includes(`/node_modules/${t}/`))) { found.push(`${f.name} (module)`); continue; }
    const text = f.text();
    for (const t of RUNTIME_TOKENS) if (text.includes(t)) found.push(`${f.name}: "${t}"`);
  }
  return found;
}

// 4. Runtime bundle: the freshly built apps/desktop/out must not contain the logger chain.
// An output older than notBefore (package-lock.json) predates the last dependency change and fails.
export function bundleLines(dir: string, notBefore = 0): Line[] {
  const files = existsSync(dir) ? walk(dir) : [];
  if (files.length === 0) return [{ status: "FAIL", text: `runtime: ${dir} is missing or empty; run npm run build -w @model-council/desktop` }];
  const found = hits(files.map((f) => ({ name: "/" + relative(dir, f), text: () => readFileSync(f, "latin1") })));
  const newest = Math.max(...files.map((f) => statSync(f).mtimeMs));
  const built = new Date(newest).toISOString();
  if (newest < notBefore) found.push(` is older than package-lock.json (built ${built}); rebuild it`);
  return found.length
    ? found.map((h) => ({ status: "FAIL" as const, text: `runtime: included in ${relative(repo, dir)}${h}` }))
    : [{ status: "PASS", text: `runtime: absent from ${files.length} files in ${relative(repo, dir)} (built ${built})` }];
}

// 5. Packaged app: app.asar, app.asar.unpacked and Resources. No app found by default is NOT_VERIFIED, never absent;
// an app named by --app that is missing or has no app.asar fails.
export function packagedLines(app: string | undefined, named = false): Line[] {
  if (!app || !existsSync(join(app, "Contents/Resources/app.asar"))) {
    return [{ status: named ? "FAIL" : "NOT_VERIFIED", text: `packaged: no app.asar${app ? ` in ${app}` : ""}; inclusion not checked` }];
  }
  const res = join(app, "Contents/Resources");
  const asarPath = join(res, "app.asar");
  const asar = require("@electron/asar") as { listPackage(p: string): string[]; extractFile(p: string, f: string): Buffer; statFile(p: string, f: string): { unpacked?: boolean; size?: number } };
  const entries = asar.listPackage(asarPath).filter((f) => { const s = asar.statFile(asarPath, f.slice(1)); return !s.unpacked && "size" in s; });
  const packed = entries.map((f) => ({ name: `app.asar${f}`, text: () => asar.extractFile(asarPath, f.slice(1)).toString("latin1") }));
  const loose = walk(res).filter((f) => !f.endsWith("app.asar")).map((f) => ({ name: "/" + relative(res, f), text: () => readFileSync(f, "latin1") }));
  const version = execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", join(app, "Contents/Info.plist")]).toString().trim();
  const hash = createHash("sha256").update(readFileSync(asarPath)).digest("hex");
  const where = `${app} v${version}, app.asar sha256 ${hash.slice(0, 16)}, built ${statSync(asarPath).mtime.toISOString()}`;
  const found = hits([...packed, ...loose]);
  return found.length
    ? found.map((h) => ({ status: "FAIL" as const, text: `packaged: included in ${h} (${where})` }))
    : [{ status: "PASS", text: `packaged: absent from ${packed.length + loose.length} files (${where})` }];
}

function arg(name: string): string | undefined {
  const i = process.argv.lastIndexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

async function guard(): Promise<number> {
  const defaultApp = join(repo, "apps/desktop/release.noindex/mac-arm64/Osen.app");
  const named = arg("--app");
  const app = named === "none" ? undefined : named ?? (existsSync(defaultApp) ? defaultApp : undefined);
  const loggerDirs = arg("--logger-dir") ? [arg("--logger-dir")!] : explain("global-agent").map((e) => join(repo, e.location, "dist"));
  const lines = [
    ...dependencyLines(),
    ...(await primitiveLines()),
    ...formatLines(loggerDirs),
    ...bundleLines(arg("--out-dir") ?? join(repo, "apps/desktop/out"), statSync(join(repo, "package-lock.json")).mtimeMs),
    ...packagedLines(app, named !== undefined && named !== "none"),
  ];
  for (const l of lines) console.log(`${l.status.padEnd(12)} ${l.text}`);
  const failed = lines.some((l) => l.status === "FAIL");
  console.log(failed
    ? "RESULT FAIL: the build boundary does not hold; the alert stays unresolved and needs a fresh review"
    : "RESULT PASS: contained to build-time use with literal formats; upstream sprintf-js has no patched release and the alert stays open");
  return failed ? 1 : 0;
}

async function selfCheck(): Promise<number> {
  const work = mkdtempSync(join(tmpdir(), "check-sprintf-"));
  let failed = 0;
  const check = (name: string, ok: boolean, detail = "") => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       ${detail.slice(0, 800)}`}`); };
  const write = (p: string, text: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
  const self = join(repo, "scripts/check-sprintf-dependency.ts");
  try {
    const primitive = await primitiveLines();
    console.log(primitive.map((l) => `     ${l.status} ${l.text}`).join("\n"));
    check("primitive probe reproduces RangeError and formats controls", primitive[0]!.text.startsWith("primitive: reproduced") && primitive[1]!.status === "PASS", JSON.stringify(primitive));
    const hang = await primitiveLines("setInterval(() => {}, 1000)");
    check("watchdog stops a hanging probe after 5 s", hang[0]!.status === "FAIL" && hang[0]!.text.includes("watchdog"), JSON.stringify(hang));

    const loggerDir = join(work, "global-agent");
    write(join(loggerDir, "Logger.js"), `const roarr = require("roarr"); module.exports = roarr.child({});`);
    write(join(loggerDir, "classes/Agent.js"), `const log = require("../Logger"); log.info({ url }, "proxying request"); log.debug("created socket");`);
    const dynamicDir = join(work, "dynamic");
    write(join(dynamicDir, "classes/Agent.js"), `const log = require("../Logger"); log.info({ url }, "proxying request"); log.error({}, request.url);`);
    const evasions = {
      "computed method": `const log = require('../Logger'); log[level]({}, "x");`,
      "alias": `import log from "../Logger.js"; const f = log.info; f(request.url);`,
      "destructuring": `const log = require("../Logger"); const { warn } = log; warn(request.url);`,
      "direct roarr call": `const _roarr = require("roarr"); (0, _roarr.default)({}, request.url);`,
    };
    for (const [name, code] of Object.entries(evasions)) {
      write(join(work, "evasion", name, "classes/Agent.js"), code);
      const r = formatLines([join(work, "evasion", name)]);
      check(`${name} fails`, r.some((l) => l.status === "FAIL" && l.text.includes("cannot review")), JSON.stringify(r));
    }
    const shapeDir = join(work, "shape");
    write(join(shapeDir, "index.js"), `module.exports = 1;`);
    const outDir = join(work, "out");
    write(join(outDir, "main/index.js"), `console.log("clean");`);
    const runtimeDir = join(work, "runtime");
    write(join(runtimeDir, "main/index.js"), `const { sprintf } = require("sprintf-js");`);
    const emptyOut = join(work, "empty-out");
    mkdirSync(emptyOut);

    check("literal formats pass", formatLines([loggerDir]).every((l) => l.status === "PASS"));
    check("dynamic format fails", formatLines([dynamicDir]).some((l) => l.status === "FAIL" && l.text.includes("MemberExpression")), JSON.stringify(formatLines([dynamicDir])));
    check("changed logger shape fails", formatLines([shapeDir]).some((l) => l.status === "FAIL"));
    const installed = formatLines(explain("global-agent").map((e) => join(repo, e.location, "dist")));
    check("installed global-agent passes", installed.every((l) => l.status === "PASS"), JSON.stringify(installed));
    check("runtime import fails", bundleLines(runtimeDir).some((l) => l.status === "FAIL" && l.text.includes("sprintf-js")));
    const inlinedDir = join(work, "inlined");
    write(join(inlinedDir, "main/chunk.js"), readFileSync(join(dirname(require.resolve("sprintf-js")), "../dist/sprintf.min.js"), "utf8"));
    write(join(inlinedDir, "main/logger.js"), readFileSync(join(dirname(require.resolve("roarr")), "log.js"), "utf8"));
    const inlined = bundleLines(inlinedDir);
    check("inlined minified sprintf-js and roarr fail without package paths", ["chunk.js", "logger.js"].every((f) => inlined.some((l) => l.status === "FAIL" && l.text.includes(f))), JSON.stringify(inlined));
    check("empty build output fails", bundleLines(emptyOut).some((l) => l.status === "FAIL"));
    check("output older than package-lock.json fails", bundleLines(outDir, Date.now() + 60_000).some((l) => l.status === "FAIL" && l.text.includes("older")));

    const asar = require("@electron/asar") as { createPackage(src: string, dest: string): Promise<void> };
    const fakeApp = async (name: string, src: string) => {
      const app = join(work, name, "Osen.app");
      write(join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.0.0</string></dict></plist>`);
      mkdirSync(join(app, "Contents/Resources"), { recursive: true });
      await asar.createPackage(src, join(app, "Contents/Resources/app.asar"));
      return app;
    };
    check("clean packaged app passes", packagedLines(await fakeApp("clean-app", outDir), true).every((l) => l.status === "PASS"));
    const included = packagedLines(await fakeApp("included-app", runtimeDir), true);
    check("packaged app with sprintf-js fails", included.some((l) => l.status === "FAIL" && l.text.includes("app.asar/main/index.js")), JSON.stringify(included));
    check("missing named app fails, missing default app is NOT_VERIFIED", packagedLines(join(work, "missing"), true)[0]!.status === "FAIL" && packagedLines(undefined)[0]!.status === "NOT_VERIFIED");

    // The whole guard runs npm twice, so its child gets a longer watchdog than the 5 s probe
    const whole = (extra: string[]) => supervised([self, "--app", "none", "--logger-dir", loggerDir, "--out-dir", outDir, ...extra], 60_000);
    const clean = await whole([]);
    check("clean fixtures exit 0 with packaged NOT_VERIFIED", clean.code === 0 && clean.stdout.includes("NOT_VERIFIED"), clean.stdout + clean.why);
    for (const [name, extra] of [
      ["dynamic-format fixture exits nonzero", ["--logger-dir", dynamicDir]],
      ["runtime-import fixture exits nonzero", ["--out-dir", runtimeDir]],
      ["missing logger evidence exits nonzero", ["--logger-dir", join(work, "missing")]],
      ["missing build output exits nonzero", ["--out-dir", join(work, "missing")]],
      ["missing named app exits nonzero", ["--app", join(work, "missing")]],
    ] as const) {
      const r = await whole([...extra]);
      check(name, r.code === 1 && r.stdout.includes("RESULT FAIL"), r.stdout + r.why);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(failed ? `self-check FAIL: ${failed}` : "self-check PASS");
  return failed ? 1 : 0;
}

process.exitCode = process.argv.includes("--self-check") ? await selfCheck() : await guard();
