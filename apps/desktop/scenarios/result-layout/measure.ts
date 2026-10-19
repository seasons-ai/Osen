// Measurement of the «Summary» screen view: the top bar with a long topic, the content width and the last statistics tile.
//   node apps/desktop/scenarios/result-layout/measure.ts                  the design/mockup/result.html mockup in headless Chrome, languages en and ru, short and long topic
//   node apps/desktop/scenarios/result-layout/measure.ts --cdp <port>     an open development app window on the «Summary» screen (topic and language as in the window)
//   … --save-baseline                                                     record the mockup columns at 900 and 1100 into baseline.json (before editing styles)
// The width is set by CDP viewport emulation and cleared at the end. A threshold violation or a mismatch with the baseline gives exit code 1.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { result } from "../../src/shared/messages/result.ts";

const here = dirname(fileURLToPath(import.meta.url));
const mockup = resolve(here, "../../../../design/mockup/result.html");
const baselineFile = join(here, "baseline.json");
const argv = process.argv.slice(2);
const cdpPort = argv.includes("--cdp") ? Number(argv[argv.indexOf("--cdp") + 1]) : undefined;
const saveBaseline = argv.includes("--save-baseline");
const WIDTHS = [900, 1100, 1500, 1710];
const BASELINE_WIDTHS = [900, 1100];
const STATES = ["consensus", "no-consensus", "cap-stopped", "resume"];
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

type Cdp = { send: (method: string, params?: object) => Promise<any>; close: () => void };
async function connect(ws: string): Promise<Cdp> {
  const sock = new WebSocket(ws);
  await new Promise((ok, fail) => { sock.onopen = ok; sock.onerror = fail; });
  let id = 0;
  const wait = new Map<number, (m: any) => void>();
  sock.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    const done = typeof m.id === "number" ? wait.get(m.id) : undefined;
    if (typeof done === "function") { wait.delete(m.id); done(m); }
  };
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

// Runs in the page: text substitution (mockup only) and measurement.
type Subst = { buttons: string[]; long: boolean } | null;
function inPage(subst: Subst) {
  const visible = (el: Element | null): el is HTMLElement => !!el && (el as HTMLElement).getClientRects().length > 0;
  const all = (sel: string) => [...document.querySelectorAll(sel)].filter(visible) as HTMLElement[];
  const topic = all(".topbar__title .session-view__topic")[0];
  const buttons = all(".topbar__actions > .btn");
  if (subst) {
    buttons.forEach((b, i) => { const t = [...b.childNodes].find((n) => n.nodeType === 3 && n.textContent!.trim()); if (t && subst.buttons[i]) t.textContent = subst.buttons[i]; });
    if (subst.long && topic) { const long = document.querySelector('.session-view__topic[data-variant="long-topic"]')!.textContent!; topic.textContent = long; topic.title = long; }
  }
  const lines = (el: Element) => {
    const tops = new Set<number>();
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent!.trim()) continue;
      const r = document.createRange(); r.selectNodeContents(n);
      for (const q of r.getClientRects()) if (q.width > 0) tops.add(Math.round(q.top));
    }
    return tops.size;
  };
  const content = document.querySelector(".content") as HTMLElement;
  const c = content.getBoundingClientRect();
  const rect = (el: Element) => { const r = el.getBoundingClientRect(); return [r.left - c.left, r.top - c.top + content.scrollTop, r.width, r.height].map((v) => +v.toFixed(1)); };
  const rowTops = [...new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top)))];
  const stats = all(".result-stats")[0];
  const tiles = stats ? ([...stats.children].filter(visible) as HTMLElement[]) : [];
  const rights = [...all(".result-cols"), ...all(".result-stats")].map((el) => +(el.getBoundingClientRect().right - c.left).toFixed(1));
  const d = document.documentElement;
  return {
    lang: d.lang || "unknown",
    topicLen: topic?.textContent?.length ?? 0,
    topic: topic ? { lines: lines(topic), truncated: topic.scrollWidth > topic.clientWidth + 0.5, width: topic.clientWidth, ellipsis: getComputedStyle(topic).textOverflow === "ellipsis" } : null,
    buttons: buttons.length,
    rows: rowTops.length,
    wrapped: buttons.filter((b) => lines(b) > 1).map((b) => b.textContent!.trim()),
    barH: +document.querySelector(".topbar")!.getBoundingClientRect().height.toFixed(1),
    btnH: Math.max(...buttons.map((b) => b.getBoundingClientRect().height)),
    contentRight: Math.max(0, ...rights),
    tiles: tiles.map((t) => +t.getBoundingClientRect().width.toFixed(1)),
    grid: stats ? +stats.getBoundingClientRect().width.toFixed(1) : 0,
    rects: Object.fromEntries([".result-hero", ".result-main", ".result-side"].flatMap((s) => all(s).slice(0, 1).map((el) => [s, rect(el)]))),
    hscroll: d.scrollWidth > d.clientWidth || content.scrollWidth > content.clientWidth
  };
}

async function setWidth(cdp: Cdp, width: number) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 0, mobile: false });
  // A timer, not requestAnimationFrame: a background window does not paint frames but recalculates layout when sizes are read.
  await evaluate(cdp, "new Promise((r) => setTimeout(r, 150))");
}

const baseline: Record<string, Record<string, number[]>> = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : {};
let failed = false;
async function check(cdp: Cdp, key: string, subst: Subst, reload: () => Promise<void>) {
  for (const width of WIDTHS) {
    await reload();
    await setWidth(cdp, width);
    const r = await evaluate(cdp, `(${inPage.toString()})(${JSON.stringify(subst)})`);
    const long = r.topicLen > 150;
    const fails: string[] = [];
    if (!r.topic || r.buttons === 0) fails.push("no topic or top bar buttons on screen");
    else {
      if (r.wrapped.length) fails.push(`button text wraps: ${r.wrapped.join(", ")}`);
      if (r.rows > 2) fails.push(`${r.rows} rows of actions (max 2)`);
      if (width >= 1500 && r.rows > 1) fails.push(`${r.rows} rows of actions at ${width} (must be 1)`);
      if (r.topic.lines > 1) fails.push(`topic in ${r.topic.lines} lines`);
      if (long && (!r.topic.ellipsis || r.topic.width < 48)) fails.push(`long topic: ellipsis ${r.topic.ellipsis}, visible width ${r.topic.width}`);
      if (long && width >= 1500 && r.barH > 2 * r.btnH + 0.5) fails.push(`top bar ${r.barH} px is higher than two buttons (${r.btnH} px)`);
      if (!long && width >= 1500 && (r.topic.truncated || r.rows > 1)) fails.push(`short topic: truncated ${r.topic.truncated}, rows ${r.rows}`);
    }
    if (r.contentRight > 1200.5) fails.push(`content right edge ${r.contentRight} px (max 1200)`);
    const odd = r.tiles.length % 2 === 1 && r.tiles.length > 1;
    if (odd && Math.abs(r.tiles.at(-1) - r.grid) > 0.5) fails.push(`last of ${r.tiles.length} tiles ${r.tiles.at(-1)} px, grid ${r.grid} px`);
    if (!odd && r.tiles.some((w: number) => Math.abs(w - r.tiles[0]) > 0.5)) fails.push(`tiles of unequal width: ${r.tiles.join("/")}`);
    if (r.hscroll) fails.push("horizontal scroll");
    if (BASELINE_WIDTHS.includes(width) && key.startsWith("mockup:")) {
      const bkey = `${key}:${width}`;
      if (saveBaseline) baseline[bkey] = r.rects;
      else if (!baseline[bkey]) fails.push(`no ${bkey} entry in baseline.json (run with --save-baseline before editing)`);
      else for (const [k, v] of Object.entries(baseline[bkey])) {
        const now = r.rects[k] as number[] | undefined;
        if (!now || now.some((x, i) => Math.abs(x - v[i]) > 0.5)) fails.push(`${k} was ${v.join(",")}, now ${now?.join(",") ?? "none"}`);
      }
    }
    console.log(`${fails.length ? "✗" : "✓"} ${key} ${width}: topic ${r.topicLen} chars${r.topic?.truncated ? " (truncated)" : ""}, ${r.buttons} buttons in ${r.rows} row(s), bar ${r.barH} px, content right ${r.contentRight} px, tiles ${r.tiles.join("/")} of ${r.grid}`);
    for (const f of fails) console.log(`    ✗ ${f}`);
    if (fails.length) failed = true;
  }
  await cdp.send("Emulation.clearDeviceMetricsOverride");
}

if (cdpPort) {
  const cdp = await connect(await pageTarget(cdpPort));
  const r = await evaluate(cdp, `(${inPage.toString()})(null)`);
  await check(cdp, `app:${r.lang}:${r.topicLen > 150 ? "long" : "short"}`, null, async () => {});
  cdp.close();
} else {
  const profile = mkdtempSync(join(tmpdir(), "result-layout-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const browserWs = await new Promise<string>((ok, fail) => {
    let buf = "";
    chrome.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) ok(m[1]); });
    chrome.on("exit", () => fail(new Error(`Chrome failed to start: ${buf}`)));
  });
  try {
    const cdp = await connect(await pageTarget(Number(new URL(browserWs).port)));
    for (const lang of ["en", "ru"] as const) {
      const t = result(lang);
      const buttons = [t.toFeed, t.copy, t.exportMd, t.rerun, t.discussFurther, t.newDiscussion];
      for (const state of STATES) for (const long of [false, true]) {
        const url = pathToFileURL(mockup).href + "#" + state;
        await check(cdp, `mockup:${state}:${lang}:${long ? "long" : "short"}`, { buttons, long }, async () => {
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
