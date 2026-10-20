// Token stand of the osen mockup: the eight pages design/mockup-osen/*.html take colors, fonts and sizes from brand/tokens.css.
//   node apps/desktop/scenarios/mockup-tokens/check.ts                       static check (token literals) + token recoloring + light themes; no snapshots
//   node apps/desktop/scenarios/mockup-tokens/check.ts --snapshot <folder>    PNG snapshots and JSON computed style: <folder>/<net|offline>/<page>-<width>.{png,json}
//   node apps/desktop/scenarios/mockup-tokens/check.ts --compare <folder>     the same snapshots in memory against <folder>; PNG byte by byte, JSON structurally
//   --pages index,setup   narrow the set of pages (in all modes)     --verbose  do not truncate the list of violations
//   --themes len,inei     narrow the set of light themes
// Light themes: every page except themes.html is opened as <page>.html#theme=<id> for tuman, len, inei, pergament; <html> gets
// data-theme=<id>, the body background equals --bg-0 of the theme, and no visible element keeps a color of the dark theme.
// settings.html in «Осень» also checks the nested theme: the «Лён» preview has the background --bg-0 of len.
// themes.html is the comparison sheet: its sections take colors from the variables, the sheet frame stays dark on purpose.
// Snapshot conditions: net — regular Chrome (Google fonts must load), offline — fonts.googleapis.com and fonts.gstatic.com are unavailable.
// Exceptions — allow.json, an array of objects:
//   { "page": "styleguide", "value": "#8E8273", "reason": "…" }          static literal: a hex color or declaration text without spaces around ":",
//                                                                        for example "padding:9px 0" or "font-family:'IBM Plex Sans',sans-serif"; case does not matter
//   { "page": "index", "value": "…", "reason": "…", "selector": ".x" }  the optional selector excludes elements (and their descendants) from recoloring
// page — "index" or "index.html". Any violation gives exit code 1. Model calls: 0.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect, type Cdp } from "./cdp.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const osen = join(root, "design/mockup-osen");
const argv = process.argv.slice(2);
const arg = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1]! : undefined);
const ALL_PAGES = ["index", "setup", "session", "result", "history", "settings", "styleguide", "themes"];
const pages = arg("--pages")?.split(",") ?? ALL_PAGES;
const themes = arg("--themes")?.split(",") ?? ["tuman", "len", "inei", "pergament"];
const verbose = argv.includes("--verbose");
const WIDTHS = [1100, 900];
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RECOLOR = ["--leaf", "--rain", "--text-faint", "--bg-0"];
const OFFLINE_RULES = "MAP fonts.googleapis.com ~NOTFOUND, MAP fonts.gstatic.com ~NOTFOUND";
// Identical for snapshot and compare: no GPU, no subpixel smoothing or hinting, no scrollbars, scale 1.
const CHROME_FLAGS = ["--headless=new", "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--font-render-hinting=none", "--disable-lcd-text", "--disable-font-subpixel-positioning", "--force-color-profile=srgb", "--disable-features=Translate"];

type Allow = { page: string; value: string; reason?: string; selector?: string };
const norm = (p: string) => p.replace(/\.html$/, "");
const allow: Allow[] = (JSON.parse(readFileSync(join(here, "allow.json"), "utf8")) as Allow[]).map((a) => ({ ...a, page: norm(a.page) }));
const normDecl = (s: string) => s.replace(/\s*:\s*/, ":").replace(/\s+/g, " ").trim().toLowerCase();

let fails = 0;
function fail(msg: string) { fails++; console.log(`  FAIL ${msg}`); }
function failList(items: string[], head: string) {
  console.log(`${head}: ${items.length ? `violations ${items.length}` : "✓"}`);
  fails += items.length;
  for (const m of verbose ? items : items.slice(0, 40)) console.log(`  FAIL ${m}`);
  if (!verbose && items.length > 40) console.log(`  … ${items.length - 40} more (--verbose)`);
}

// ---------- CDP (client in cdp.ts) ----------
async function evaluate(cdp: Cdp, expression: string): Promise<any> {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function withChrome<T>(extra: string[], run: (cdp: Cdp) => Promise<T>): Promise<T> {
  const profile = mkdtempSync(join(tmpdir(), "mockup-tokens-"));
  const chrome = spawn(CHROME, [...CHROME_FLAGS, ...extra, "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const browserWs = await new Promise<string>((ok, bad) => {
    let buf = "";
    chrome.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) ok(m[1]!); });
    chrome.on("exit", () => bad(new Error(`Chrome did not start: ${buf}`)));
  });
  try {
    const port = new URL(browserWs).port;
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const cdp = await connect(list.find((t) => t.type === "page")!.webSocketDebuggerUrl);
    try { return await run(cdp); } finally { cdp.close(); }
  } finally {
    const browser = await connect(browserWs);
    await browser.send("Browser.close").catch(() => {});
    await new Promise((r) => (chrome.exitCode !== null ? r(null) : chrome.on("exit", r)));
    rmSync(profile, { recursive: true, force: true });
  }
}
const sleep = (cdp: Cdp, ms: number) => evaluate(cdp, `new Promise((r) => setTimeout(r, ${ms}))`);
async function open(cdp: Cdp, page: string, width: number, height = 800, hash = "") {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: "about:blank" });
  await cdp.send("Page.navigate", { url: pathToFileURL(join(osen, `${page}.html`)).href + hash });
  const ready = "Promise.race([new Promise((r) => { const f = () => document.readyState === 'complete' ? document.fonts.ready.then(() => r(true)) : setTimeout(f, 20); f(); }), new Promise((r) => setTimeout(() => r(false), 30000))])";
  if (!(await evaluate(cdp, ready))) throw new Error(`${page}: the page did not load within 30 s`);
}

// ---------- tokens ----------
const tokensCss = readFileSync(join(osen, "brand/tokens.css"), "utf8");
const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(tokensCss)?.[1] ?? "";
const colorTokens = new Map<string, string>(); // name → #rrggbb
const px = { fs: new Map<number, string[]>(), sp: new Map<number, string[]>(), r: new Map<number, string[]>() };
for (const m of rootBlock.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
  const [name, val] = [m[1]!, m[2]!.trim()];
  if (/^#[0-9a-f]{6}$/i.test(val)) colorTokens.set(name, val.toLowerCase());
  const pm = /^(\d+)px$/.exec(val), kind = /^(fs|sp|r)-/.exec(name)?.[1] as "fs" | "sp" | "r" | undefined;
  if (pm && kind) { const n = Number(pm[1]); px[kind].set(n, [...(px[kind].get(n) ?? []), name]); }
}
// Hex colors of a [data-theme="<id>"] block.
const themeColors = (id: string) => {
  const at = tokensCss.indexOf(`[data-theme="${id}"] {`);
  const block = at < 0 ? "" : tokensCss.slice(at, tokensCss.indexOf("\n}", at));
  return new Map([...block.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
};
const varList = (names: string[]) => names.map((n) => `var(--${n})`).join(" or ");
const hexNames = (hex: string) => [...colorTokens].filter(([, v]) => v === hex.toLowerCase()).map(([n]) => n);

// ---------- static ----------
function staticCheck(page: string): string[] {
  const text = readFileSync(join(osen, `${page}.html`), "utf8");
  const line = (off: number) => text.slice(0, off).split("\n").length;
  const out: string[] = [];
  const allowed = (lit: string) => allow.some((a) => norm(a.page) === page && !a.selector && normDecl(a.value) === normDecl(lit));
  const add = (off: number, lit: string, repl: string) => { if (!allowed(lit)) out.push(`${page}:${line(off)}: ${lit} → ${repl}`); };

  if (!/<link[^>]+rel="stylesheet"[^>]+href="brand\/tokens\.css"|<link[^>]+href="brand\/tokens\.css"[^>]+rel="stylesheet"/.test(text)) out.push(`${page}:1: missing <link rel="stylesheet" href="brand/tokens.css">`);
  if (!/<link[^>]+rel="preconnect"[^>]+href="https:\/\/fonts\.googleapis\.com"|<link[^>]+href="https:\/\/fonts\.googleapis\.com"[^>]+rel="preconnect"/.test(text)) out.push(`${page}:1: missing <link rel="preconnect" href="https://fonts.googleapis.com">`);
  if (!/<link[^>]+href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]*"[^>]*rel="stylesheet"|<link[^>]+rel="stylesheet"[^>]+href="https:\/\/fonts\.googleapis\.com\/css2\?/.test(text)) out.push(`${page}:1: missing a stylesheet link to https://fonts.googleapis.com/css2?…`);
  for (const m of text.matchAll(/\b(?:href|src)\s*=\s*"(https?:\/\/[^"]*)"/g)) {
    if (!/^https:\/\/fonts\.googleapis\.com(\/|$)/.test(m[1]!)) out.push(`${page}:${line(m.index!)}: external address ${m[1]}`);
  }

  const cssAt = (css: string, base: number) => {
    for (const m of css.matchAll(/#[0-9a-f]{6}\b/gi)) {
      const names = hexNames(m[0]);
      if (names.length) add(base + m.index!, m[0], varList(names));
    }
    for (const m of css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/gi)) {
      const prop = m[1]!.toLowerCase(), val = m[2]!.trim(), off = base + m.index!, decl = `${prop}:${val.replace(/\s+/g, " ")}`;
      if ((prop === "font-family" || prop === "font") && !/^var\(/.test(val) && /IBM Plex Sans|JetBrains Mono/.test(val)) add(off, decl, /Mono/.test(val) ? "var(--font-mono)" : "var(--font-ui)");
      let table: Map<number, string[]> | null = null;
      if (prop === "font-size") table = px.fs;
      else if (prop === "font") table = px.fs;
      else if (/^(padding|margin)(-|$)|^(row-|column-)?gap$/.test(prop)) table = px.sp;
      else if (/^border(-[a-z]+-[a-z]+)?-radius$/.test(prop)) table = px.r;
      if (!table) continue;
      const terms = prop === "font" ? [...val.split("/")[0]!.matchAll(/(?<![\d.\-])(\d*\.?\d+)px/g)].slice(-1) : [...val.matchAll(/(?<![\d.\-])(\d*\.?\d+)px/g)];
      const hit = terms.filter((t) => table!.has(Number(t[1]))).map((t) => `${t[0]} → ${varList(table!.get(Number(t[1]))!)}`);
      if (hit.length) add(off, decl, hit.join(", "));
    }
  };
  for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) cssAt(m[1]!, m.index! + m[0].indexOf(">") + 1);
  for (const m of text.matchAll(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/g)) cssAt(m[2]!, m.index! + m[0].indexOf(m[1]!) + 1);
  for (const m of text.matchAll(/\s(?:fill|stroke|stop-color)\s*=\s*"([^"]*)"/g)) {
    for (const h of m[1]!.matchAll(/#[0-9a-f]{6}\b/gi)) { const names = hexNames(h[0]); if (names.length) add(m.index! + h.index!, h[0], varList(names)); }
  }
  return out;
}

// ---------- recoloring ----------
const toRgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
function inRecolor(inject: string, orig: string, token: string, skip: string[], extra: "" | "index" | "setup") {
  const st = document.createElement("style");
  st.textContent = inject;
  document.head.append(st);
  const failures: string[] = [];
  const path = (el: Element) => { const p: string[] = []; for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) { const i = e.parentElement ? [...e.parentElement.children].indexOf(e) + 1 : 1; p.unshift(`${e.localName}${e.id ? "#" + e.id : ""}:nth-child(${i})`); } return p.join(" > ") || "html"; };
  for (const el of document.querySelectorAll("*")) {
    if (skip.some((s) => el.closest(s))) continue;
    const s = getComputedStyle(el);
    const props: [string, string][] = [["color", s.color], ["background-color", s.backgroundColor], ["fill", s.fill], ["stroke", s.stroke]];
    for (const side of ["top", "right", "bottom", "left"]) if (parseFloat((s as any)[`border-${side}-width`]) > 0 && (s as any)[`border-${side}-style`] !== "none") props.push([`border-${side}-color`, (s as any)[`border-${side}-color`]]);
    if (s.outlineStyle !== "none") props.push(["outline-color", s.outlineColor]);
    for (const [p, v] of props) if (v === orig) failures.push(`recoloring ${token}: ${path(el)} ${p} stayed ${orig}`);
  }
  const extras: string[] = [];
  // the active rail item is on index, the primary "Start" button is on setup (index has no primary button)
  if (extra) {
    const a = document.querySelector('.rail-item[aria-current="page"]'), b = document.querySelector(".btn--primary");
    if (!a) extras.push(".rail-item[aria-current=\"page\"] not found"); else if (getComputedStyle(a).color !== "rgb(0, 255, 0)") extras.push(`.rail-item[aria-current="page"] color ${getComputedStyle(a).color}, expected rgb(0, 255, 0)`);
    if (extra === "setup") if (!b) extras.push(".btn--primary not found"); else if (getComputedStyle(b).backgroundColor !== "rgb(0, 255, 0)") extras.push(`.btn--primary background-color ${getComputedStyle(b).backgroundColor}, expected rgb(0, 255, 0)`);
  }
  st.remove();
  return { failures, extras };
}
async function recolorCheck() {
  await withChrome([`--host-resolver-rules=${OFFLINE_RULES}`], async (cdp) => {
    for (const page of pages) {
      const found: string[] = [];
      for (const t of RECOLOR) {
        const hex = colorTokens.get(t.slice(2));
        if (!hex) { found.push(`${t}: not in tokens.css`); continue; }
        await open(cdp, page, 1100);
        const same = hexNames(hex).filter((n) => `--${n}` !== t);
        const inject = `:root,[data-theme]{${t}:#00FF00 !important;${same.map((n) => `--${n}:#00FF01 !important`).join(";")}}`;
        const skip = allow.filter((a) => norm(a.page) === page && a.selector).map((a) => a.selector!);
        const r = await evaluate(cdp, `(${inRecolor.toString()})(${JSON.stringify(inject)}, ${JSON.stringify(toRgb(hex))}, ${JSON.stringify(t)}, ${JSON.stringify(skip)}, ${JSON.stringify(t === "--leaf" && (page === "index" || page === "setup") ? page : "")})`);
        found.push(...r.failures.map((f: string) => `${page}: ${f}`), ...r.extras.map((f: string) => `${page}: ${f}`));
      }
      failList(found, `recoloring ${page}`);
    }
  });
}

// ---------- light themes ----------
function inTheme(theme: string, bg0: string, dark: string[]) {
  const failures: string[] = [];
  const path = (el: Element) => { const p: string[] = []; for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) { const i = e.parentElement ? [...e.parentElement.children].indexOf(e) + 1 : 1; p.unshift(`${e.localName}${e.id ? "#" + e.id : ""}:nth-child(${i})`); } return p.join(" > ") || "html"; };
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr !== theme) failures.push(`<html> data-theme=${attr}, expected ${theme}`);
  const body = getComputedStyle(document.body).backgroundColor;
  if (body !== bg0) failures.push(`body background-color ${body}, expected ${bg0}`);
  for (const el of document.querySelectorAll("body, body *")) {
    const s = getComputedStyle(el);
    if (!el.getClientRects().length || s.visibility !== "visible") continue;
    const props: [string, string][] = [["color", s.color], ["background-color", s.backgroundColor]];
    for (const side of ["top", "right", "bottom", "left"]) if (parseFloat((s as any)[`border-${side}-width`]) > 0 && (s as any)[`border-${side}-style`] !== "none") props.push([`border-${side}-color`, (s as any)[`border-${side}-color`]]);
    for (const [p, v] of props) if (dark.includes(v)) failures.push(`${path(el)} ${p} ${v} is a color of the dark theme`);
  }
  return failures;
}
async function themeCheck() {
  await withChrome([`--host-resolver-rules=${OFFLINE_RULES}`], async (cdp) => {
    for (const page of pages.filter((p) => p !== "themes")) for (const id of themes) {
      const colors = themeColors(id);
      if (!colors.size) { failList([`no [data-theme="${id}"] block in tokens.css`], `theme ${page} ${id}`); continue; }
      // a dark color that the light theme happens to share is not a leftover
      const mine = new Set(colors.values());
      const dark = [...new Set(colorTokens.values())].filter((hex) => !mine.has(hex)).map(toRgb);
      await open(cdp, page, 1100, 800, `#theme=${id}`);
      const found: string[] = await evaluate(cdp, `(${inTheme.toString()})(${JSON.stringify(id)}, ${JSON.stringify(toRgb(colors.get("bg-0")!))}, ${JSON.stringify(dark)})`);
      failList(found.map((f) => `${page} ${id}: ${f}`), `theme ${page} ${id}`);
    }
    if (pages.includes("settings")) {
      const want = toRgb(themeColors("len").get("bg-0")!);
      await open(cdp, "settings", 1100, 800, "#theme=osen");
      const got = await evaluate(cdp, `(() => { const el = document.querySelector('.theme-prev[data-theme="len"]'); return el ? getComputedStyle(el).backgroundColor : "not found"; })()`);
      failList(got === want ? [] : [`settings osen: .theme-prev[data-theme="len"] background-color ${got}, expected ${want}`], "nested theme settings len");
    }
  });
}

// ---------- snapshots ----------
const PROPS = ["color", "background-color", ...["top", "right", "bottom", "left"].flatMap((s) => [`border-${s}-color`, `border-${s}-width`, `border-${s}-style`]), "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius", "padding-top", "padding-right", "padding-bottom", "padding-left", "margin-top", "margin-right", "margin-bottom", "margin-left", "gap", "row-gap", "column-gap", "font-size", "font-weight", "line-height", "letter-spacing", "fill", "stroke", "outline-color", "opacity", "box-shadow"];
function inDump(props: string[]) {
  const st = document.createElement("style");
  st.textContent = "*,*::before,*::after{animation:none !important;transition:none !important;caret-color:transparent !important}";
  document.head.append(st);
  window.scrollTo(0, 0);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  // <head> elements are not rendered: linking tokens.css must not change their number
  return [...document.querySelectorAll("html, body, body *")].map((el) => {
    const b = el.getBoundingClientRect(), s = getComputedStyle(el), c: Record<string, string> = {};
    for (const p of props) c[p] = s.getPropertyValue(p);
    return { t: el.localName, r: [r2(b.x), r2(b.y), r2(b.width), r2(b.height)], c };
  });
}
type Dump = { t: string; r: number[]; c: Record<string, string> }[];
async function takeAll(outDir: string) {
  for (const cond of ["net", "offline"]) {
    mkdirSync(join(outDir, cond), { recursive: true });
    await withChrome(cond === "offline" ? [`--host-resolver-rules=${OFFLINE_RULES}`] : [], async (cdp) => {
      for (const page of pages) for (const width of WIDTHS) {
        await open(cdp, page, width);
        if (cond === "net") {
          const ok = await evaluate(cdp, `document.fonts.check('14px "IBM Plex Sans"') && document.fonts.check('14px "JetBrains Mono"') && ["IBM Plex Sans","JetBrains Mono"].every((f) => [...document.fonts].some((x) => x.family.replace(/["']/g, "") === f && x.status === "loaded"))`);
          if (!ok) { fail(`fonts did not load (${page}, ${width})`); continue; }
        }
        const dump: Dump = await evaluate(cdp, `(${inDump.toString()})(${JSON.stringify(PROPS)})`);
        await sleep(cdp, 100);
        const [w, h] = await evaluate(cdp, "[document.documentElement.scrollWidth, document.documentElement.scrollHeight]");
        const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
        const base = join(outDir, cond, `${page}-${width}`);
        writeFileSync(`${base}.png`, Buffer.from(shot.data, "base64"));
        writeFileSync(`${base}.json`, JSON.stringify(dump));
      }
    });
  }
}
function diffDump(a: Dump, b: Dump): string[] {
  const out: string[] = [];
  if (a.length !== b.length) out.push(`number of elements ${a.length} → ${b.length}`);
  for (let i = 0; i < Math.min(a.length, b.length) && out.length < 5; i++) {
    const [x, y] = [a[i]!, b[i]!];
    if (x.t !== y.t) { out.push(`#${i} tag ${x.t} → ${y.t}`); continue; }
    if (x.r.join() !== y.r.join()) out.push(`#${i} <${x.t}> rect [${x.r}] → [${y.r}]`);
    for (const p of PROPS) if (out.length < 5 && x.c[p] !== y.c[p]) out.push(`#${i} <${x.t}> ${p}: ${x.c[p]} → ${y.c[p]}`);
  }
  return out.slice(0, 5);
}
function compareAll(base: string, fresh: string) {
  for (const cond of ["net", "offline"]) for (const page of pages) for (const width of WIDTHS) {
    const name = `${page}-${width}`, key = `${cond}/${name}`;
    const [oldPng, newPng] = [join(base, cond, `${name}.png`), join(fresh, cond, `${name}.png`)];
    if (!existsSync(newPng)) continue; // no snapshot taken — the reason is already in a FAIL
    if (!existsSync(oldPng)) { fail(`${key}: no reference in ${base}`); continue; }
    if (!readFileSync(oldPng).equals(readFileSync(newPng))) {
      writeFileSync(join(base, cond, `${name}.after.png`), readFileSync(newPng));
      fail(`${key}: PNG differs (the new one is ${name}.after.png)`);
    }
    const d = diffDump(JSON.parse(readFileSync(join(base, cond, `${name}.json`), "utf8")), JSON.parse(readFileSync(join(fresh, cond, `${name}.json`), "utf8")));
    for (const m of d) fail(`${key}: ${m}`);
    if (!d.length && readFileSync(oldPng).equals(readFileSync(newPng))) console.log(`${key}: ✓`);
  }
}

// ---------- run ----------
if (arg("--snapshot")) {
  const dir = resolve(arg("--snapshot")!);
  await takeAll(dir);
  console.log(`snapshots written to ${dir}`);
} else if (arg("--compare")) {
  const base = resolve(arg("--compare")!);
  const tmp = mkdtempSync(join(tmpdir(), "mockup-tokens-cmp-"));
  try { await takeAll(tmp); compareAll(base, tmp); } finally { rmSync(tmp, { recursive: true, force: true }); }
} else {
  for (const page of pages) failList(staticCheck(page), `static ${page}`);
  await recolorCheck();
  await themeCheck();
}
console.log(fails ? `\nRESULT: FAIL (${fails})` : "\nRESULT: OK");
process.exit(fails ? 1 : 0);
