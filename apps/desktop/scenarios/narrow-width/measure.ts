// Measurement of the rows of “Session setup” (participant, lineups) and the “Limits” row of the “Template editor” at widths 900–1100.
//   node apps/desktop/scenarios/narrow-width/measure.ts                  the design/mockup mockup in headless Chrome, languages en and ru
//   node apps/desktop/scenarios/narrow-width/measure.ts --cdp <port>     an open development app window (screen and language as in the window)
//   … --save-baseline                                                    record the view at 1100 into baseline-1100.json (before editing styles)
// The width is set by CDP viewport emulation and cleared at the end. A threshold violation or a mismatch with the baseline gives exit code 1.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sessionSetup } from "../../src/shared/messages/session-setup.ts";
import { templateEditor } from "../../src/shared/messages/template-editor.ts";
import { launch } from "../../src/shared/messages/launch.ts";

const here = dirname(fileURLToPath(import.meta.url));
const mockup = resolve(here, "../../../../design/mockup");
const baselineFile = join(here, "baseline-1100.json");
const argv = process.argv.slice(2);
const cdpPort = argv.includes("--cdp") ? Number(argv[argv.indexOf("--cdp") + 1]) : undefined;
const saveBaseline = argv.includes("--save-baseline");
const NARROW = [900, 950, 1000, 1050];
const WIDE = 1100;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

type Cdp = { send: (method: string, params?: object) => Promise<any>; close: () => void };
async function connect(ws: string): Promise<Cdp> {
  const sock = new WebSocket(ws);
  await new Promise((ok, fail) => { sock.onopen = ok; sock.onerror = fail; });
  let id = 0;
  const wait = new Map<number, (m: any) => void>();
  sock.onmessage = (e) => { const m = JSON.parse(String(e.data)); wait.get(m.id)?.(m); wait.delete(m.id); };
  return {
    send: (method, params = {}) => new Promise((ok, fail) => {
      const n = ++id;
      wait.set(n, (m) => (m.error ? fail(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
      sock.send(JSON.stringify({ id: n, method, params }));
    }),
    close: () => sock.close()
  };
}
async function pageTarget(port: number): Promise<string> {
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
  const page = list.find((t) => t.type === "page" && !t.url.startsWith("devtools:"));
  if (!page) throw new Error(`no page on port ${port}`);
  return page.webSocketDebuggerUrl;
}
async function evaluate(cdp: Cdp, expression: string): Promise<any> {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

// Runs in the page: text substitution (mockup only) and measurement of visible rows.
type Texts = Record<string, string> | null;
function inPage(texts: Texts) {
  const visible = (el: Element | null): el is HTMLElement => !!el && (el as HTMLElement).getClientRects().length > 0;
  const all = (sel: string) => [...document.querySelectorAll(sel)].filter(visible);
  if (texts) {
    all(".setup-p").slice(0, 2).forEach((row, i) => {
      const [prov, model] = row.querySelectorAll("select");
      prov.options[prov.selectedIndex].text = texts.provider;
      model.options[model.selectedIndex].text = `consensus/p${i + 1}.json`;
      const role = row.querySelector("input")!; role.value = ""; role.placeholder = texts.rolePlaceholder;
    });
    const pick = all(".setup-lineups__pick select")[0] as HTMLSelectElement | undefined;
    if (pick) pick.options[0].text = texts.pickLineup;
    const name = all(".setup-lineups__name input")[0] as HTMLInputElement | undefined;
    if (name) name.placeholder = texts.lineupNamePlaceholder;
    const labels = all(".tpl-limits .field__label");
    ["limitMaxRounds", "limitTurnTimeout", "limitContext"].forEach((k, i) => { if (labels[i]) labels[i].textContent = texts[k]; });
  }
  const ctx = document.createElement("canvas").getContext("2d")!;
  const textW = (el: HTMLElement, text: string) => { const s = getComputedStyle(el); ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`; return ctx.measureText(text).width; };
  const usable = (el: HTMLElement) => { const s = getComputedStyle(el); return el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight); };
  const fit = (name: string, el: HTMLElement, text: string) => ({ name, text, textW: +textW(el, text).toFixed(1), usable: +usable(el).toFixed(1) });
  const clickable = (el: HTMLElement) => { const r = el.getBoundingClientRect(); el.scrollIntoView({ block: "center" }); const r2 = el.getBoundingClientRect(); const hit = document.elementFromPoint(r2.left + r2.width / 2, r2.top + r2.height / 2); return r.width > 0 && !!hit && el.contains(hit); };
  const out: { fits: ReturnType<typeof fit>[]; failures: string[]; rects: Record<string, number[]>; scroll: { doc: number[]; content: number[] } } = { fits: [], failures: [], rects: {}, scroll: { doc: [], content: [] } };
  const rect = (key: string, el: Element) => { const r = el.getBoundingClientRect(); const c = document.querySelector(".content")!.getBoundingClientRect(); out.rects[key] = [r.left - c.left, r.top - c.top + (document.querySelector(".content")!.scrollTop), r.width, r.height].map((v) => +v.toFixed(1)); };
  all(".setup-p").slice(0, 2).forEach((row, i) => {
    const [prov, model] = [...row.querySelectorAll("select")] as HTMLSelectElement[];
    const role = row.querySelector("input")!;
    const p = fit(`participant ${i + 1}: provider`, prov, prov.options[prov.selectedIndex].text);
    const m = model.options[model.selectedIndex].text;
    const mf = fit(`participant ${i + 1}: model (12 chars)`, model, m.slice(0, 12));
    const r = fit(`participant ${i + 1}: role placeholder`, role, role.placeholder);
    out.fits.push(p, mf, r);
    [...row.querySelectorAll("button")].forEach((b, j) => { if (!clickable(b as HTMLElement)) out.failures.push(`participant ${i + 1}: button ${j + 1} is not clickable`); });
    [...row.children].forEach((el, j) => rect(`setup-p${i + 1}.${j}`, el));
  });
  const lineups = all(".setup-lineups")[0];
  if (lineups) {
    const pick = lineups.querySelector(".setup-lineups__pick select") as HTMLSelectElement;
    const name = lineups.querySelector(".setup-lineups__name input") as HTMLInputElement;
    const save = lineups.querySelector(".setup-lineups__save") as HTMLElement;
    out.fits.push(fit("lineups: first item", pick, pick.options[0].text), fit("lineups: name placeholder", name, name.placeholder));
    const a = save.getBoundingClientRect(), b = name.getBoundingClientRect();
    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) out.failures.push("lineups: “Save lineup” overlaps the name field");
    [...lineups.children].forEach((el, j) => rect(`setup-lineups.${j}`, el));
  }
  const limits = all(".tpl-limits")[0];
  if (limits) {
    const inputs = [...limits.querySelectorAll("input")];
    const tops = inputs.map((x) => +x.getBoundingClientRect().top.toFixed(1));
    if (Math.max(...tops) - Math.min(...tops) > 0.5) out.failures.push(`limits: field tops ${tops.join("/")}`);
    limits.querySelectorAll(".field__label").forEach((l) => { if (l.scrollWidth > l.clientWidth + 0.5) out.failures.push(`limits: label “${l.textContent}” is truncated`); });
    [...limits.querySelectorAll(".field > *")].forEach((el, j) => rect(`tpl-limits.${j}`, el));
  }
  const d = document.documentElement, content = document.querySelector(".content") as HTMLElement;
  out.scroll = { doc: [d.scrollWidth, d.clientWidth], content: [content.scrollWidth, content.clientWidth] };
  if (d.scrollWidth > d.clientWidth || content.scrollWidth > content.clientWidth) out.failures.push("horizontal scroll");
  return out;
}

async function setWidth(cdp: Cdp, width: number) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 700, deviceScaleFactor: 0, mobile: false });
  // A timer, not requestAnimationFrame: a background window does not paint frames but recalculates layout when sizes are read.
  await evaluate(cdp, "new Promise((r) => setTimeout(r, 150))");
}

const baseline: Record<string, Record<string, number[]>> = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : {};
let failed = false;
async function check(cdp: Cdp, key: string, texts: Texts, reload: () => Promise<void>) {
  for (const width of [...NARROW, WIDE]) {
    await reload();
    await setWidth(cdp, width);
    const r = await evaluate(cdp, `(${inPage.toString()})(${JSON.stringify(texts)})`);
    if (r.fits.length === 0 && Object.keys(r.rects).length === 0) { console.log(`${key} ${width}: no measurable rows on screen`); failed = true; continue; }
    console.log(`\n${key} width ${width}: document ${r.scroll.doc.join("/")}, .content ${r.scroll.content.join("/")}`);
    for (const f of r.fits) console.log(`  ${f.textW > f.usable + 0.5 ? "✗" : "✓"} ${f.name} «${f.text}»: text ${f.textW} px, usable ${f.usable} px`);
    const fails: string[] = width === WIDE ? [] : [...r.failures, ...r.fits.filter((f: any) => f.textW > f.usable + 0.5).map((f: any) => `${f.name}: does not fit`)];
    if (width === WIDE) {
      if (saveBaseline) baseline[key] = r.rects;
      else if (!baseline[key]) fails.push(`no ${key} entry in baseline-1100.json (run with --save-baseline before editing)`);
      else for (const [k, v] of Object.entries(baseline[key])) {
        const now = r.rects[k] as number[] | undefined;
        if (!now || now.some((x, i) => Math.abs(x - v[i]) > 0.5)) fails.push(`1100: ${k} was ${v.join(",")}, now ${now?.join(",") ?? "none"}`);
      }
    }
    for (const f of fails) console.log(`  ✗ ${f}`);
    if (fails.length) failed = true;
  }
  await cdp.send("Emulation.clearDeviceMetricsOverride");
}

if (cdpPort) {
  const cdp = await connect(await pageTarget(cdpPort));
  const lang = await evaluate(cdp, "document.documentElement.lang || 'unknown'");
  const screen = await evaluate(cdp, "document.querySelector('.tpl-limits') ? 'template-editor' : 'setup'");
  await check(cdp, `app:${screen}:${lang}`, null, async () => {});
  cdp.close();
} else {
  const profile = mkdtempSync(join(tmpdir(), "narrow-width-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const browserWs = await new Promise<string>((ok, fail) => {
    let buf = "";
    chrome.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) ok(m[1]); });
    chrome.on("exit", () => fail(new Error(`Chrome failed to start: ${buf}`)));
  });
  try {
    const cdp = await connect(await pageTarget(Number(new URL(browserWs).port)));
    for (const lang of ["en", "ru"] as const) {
      const s = sessionSetup(lang), te = templateEditor(lang);
      const texts = { provider: launch(lang).scriptedProvider, rolePlaceholder: s.rolePlaceholder, pickLineup: s.pickLineup, lineupNamePlaceholder: s.lineupNamePlaceholder,
        limitMaxRounds: te.limitMaxRounds, limitTurnTimeout: te.limitTurnTimeout, limitContext: te.limitContext };
      for (const [screen, file] of [["setup", "setup.html#custom"], ["template-editor", "template-editor.html#form"]]) {
        const url = pathToFileURL(join(mockup, file.split("#")[0])).href + "#" + file.split("#")[1];
        await check(cdp, `mockup:${screen}:${lang}`, texts, async () => {
          await cdp.send("Page.navigate", { url: "about:blank" });
          await cdp.send("Page.navigate", { url });
          await evaluate(cdp, "new Promise((r) => { const f = () => document.readyState === 'complete' ? document.fonts.ready.then(r) : setTimeout(f, 20); f(); })");
        });
      }
    }
    cdp.close();
    const browser = await connect(browserWs);
    await browser.send("Browser.close").catch(() => {});
  } finally {
    await new Promise((r) => (chrome.exitCode !== null ? r(null) : chrome.on("exit", r)));
    rmSync(profile, { recursive: true, force: true });
  }
}
if (saveBaseline) { writeFileSync(baselineFile, JSON.stringify(baseline, null, 1) + "\n"); console.log(`\nwritten: ${baselineFile}`); }
console.log(failed ? "\nRESULT: violations found" : "\nRESULT: no violations");
process.exit(failed ? 1 : 0);
