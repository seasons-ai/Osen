// Check of the discussion feed look against the osen mockup (change 89): column grid at 900 and 1100, computed style of cards, questions, alerts,
// the indicator and the cursor of the turn being typed, a static "thinking" under prefers-reduced-motion, absence of the old palette.
//   node apps/desktop/scenarios/session-feed/measure.ts                     mockup design/mockup/session.html, all variants, headless Chrome
//   node apps/desktop/scenarios/session-feed/measure.ts --variants live,wait  only the named mockup variants
//   node apps/desktop/scenarios/session-feed/measure.ts --cdp <port>         an open development app window on the "Discussion" screen
// The width is set by CDP viewport emulation and removed at the end. Any violation gives exit code 1. Model calls: 0.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const mockup = join(root, "design/mockup");
const argv = process.argv.slice(2);
const cdpPort = argv.includes("--cdp") ? Number(argv[argv.indexOf("--cdp") + 1]) : undefined;
const onlyVariants = argv.includes("--variants") ? argv[argv.indexOf("--variants") + 1]!.split(",") : null;
const WIDTHS = [900, 1100];
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OLD_PALETTE = ["#22e3ff", "#3dff9a", "#7aa8ff", "#ff5578", "#ffc53d"];

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
    close: () => sock.close(),
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

// Runs in the page. Returns violations and measurements; the column width checks 250–290 / 300–360 are only at 1100.
function inPage(width: number, reduced: boolean) {
  const css = (el: Element) => getComputedStyle(el);
  const visible = (el: Element | null): el is HTMLElement => !!el && (el as HTMLElement).getClientRects().length > 0;
  const all = (sel: string) => [...document.querySelectorAll(sel)].filter(visible);
  const root = css(document.documentElement);
  const tok = (name: string) => { const s = document.createElement("span"); s.style.color = root.getPropertyValue(name).trim(); document.body.append(s); const c = css(s).color; s.remove(); return c; };
  const LEAF = tok("--leaf"), RAIN = tok("--rain"), INSET = tok("--bg-inset"), BG1 = tok("--bg-1"), LINE_STRONG = tok("--line-strong");
  const failures: string[] = [];
  const fail = (sel: string, what: string, el?: Element) => failures.push(`${sel}${el ? `[${[...all(sel)].indexOf(el as HTMLElement)}]` : ""}: ${what}`);
  const mono = (sel: string) => { for (const el of all(sel)) if (!/JetBrains Mono/.test(css(el).fontFamily)) fail(sel, `not mono: ${css(el).fontFamily}`, el); };
  const flat = (sel: string) => { for (const el of all(sel)) { const s = css(el); if (s.boxShadow !== "none") fail(sel, `box-shadow ${s.boxShadow}`, el); if (s.backgroundImage !== "none") fail(sel, `background-image ${s.backgroundImage}`, el); } };
  const inset = (sel: string, bar: string | null) => {
    for (const el of all(sel)) {
      const s = css(el);
      if (s.backgroundColor !== INSET) fail(sel, `background ${s.backgroundColor}, expected --bg-inset ${INSET}`, el);
      if (s.borderLeftWidth !== "2px") fail(sel, `border-left ${s.borderLeftWidth}, expected 2px`, el);
      if (s.borderTopWidth !== "0px" || s.borderRightWidth !== "0px" || s.borderBottomWidth !== "0px") fail(sel, `border other than the left one: ${s.borderTopWidth}/${s.borderRightWidth}/${s.borderBottomWidth}`, el);
      if (bar !== null && s.borderLeftColor !== bar) fail(sel, `bar ${s.borderLeftColor}, expected ${bar}`, el);
      if (s.boxShadow !== "none") fail(sel, `box-shadow ${s.boxShadow}`, el);
    }
  };

  // grid
  const grid = document.querySelector(".session-grid") as HTMLElement | null;
  if (!grid) return { failures: ["no .session-grid: open the \"Discussion\" screen"], widths: [] as number[] };
  const cols = [...grid.children].filter(visible);
  const rects = cols.map((c) => c.getBoundingClientRect());
  const widths = rects.map((r) => Math.round(r.width));
  if (cols.length !== 3) fail(".session-grid", `columns ${cols.length}, expected 3`);
  for (let i = 0; i < rects.length; i++) {
    if (Math.abs(rects[i]!.top - rects[0]!.top) > 0.5) fail(".session-col", `column ${i + 1} is not in the same row: top ${rects[i]!.top} vs ${rects[0]!.top}`);
    if (i > 0 && Math.abs(rects[i]!.left - rects[i - 1]!.right) > 1) fail(".session-col", `gap or overlap between ${i} and ${i + 1}: ${rects[i - 1]!.right} → ${rects[i]!.left}`);
  }
  const d = document.documentElement;
  if (d.scrollWidth > d.clientWidth || grid.scrollWidth > grid.clientWidth + 1) fail(".session-grid", `horizontal scroll: document ${d.scrollWidth}/${d.clientWidth}, grid ${grid.scrollWidth}/${grid.clientWidth}`);
  if (width >= 1100 && widths.length === 3) {
    if (widths[0]! < 250 || widths[0]! > 290) fail(".session-col:first-child", `width ${widths[0]}, expected 250–290`);
    if (widths[2]! < 300 || widths[2]! > 360) fail(".session-col:last-child", `width ${widths[2]}, expected 300–360`);
  }
  for (const h of all(".session-col__head")) {
    if (css(h).borderBottomWidth !== "0px") fail(".session-col__head", `bottom line ${css(h).borderBottomWidth}`, h);
    if (!h.querySelector(".eyebrow")) fail(".session-col__head", "no .eyebrow", h);
  }

  // participants and the indicator
  flat(".session-p"); flat(".session-meter"); flat(".session-turn"); flat(".session-fail"); flat(".session-wait"); flat(".alert");
  for (const p of all(".session-p")) {
    const name = p.querySelector(".participant__name") as HTMLElement | null, tag = p.querySelector(".participant__name .tag"), role = p.querySelector(".participant__meta");
    if (name && tag) { const a = name.getBoundingClientRect(), b = tag.getBoundingClientRect(); if (b.top < a.top - 1 || b.bottom > a.bottom + 1) fail(".session-p", "the model .tag is not in the name line", p); if (!/JetBrains Mono/.test(css(tag).fontFamily)) fail(".session-p .tag", "model is not mono", p); }
    if (name && role && role.getBoundingClientRect().top < name.getBoundingClientRect().bottom - 1) fail(".session-p", "role is not on a separate line", p);
    const s = css(p);
    if (p.classList.contains("participant--off")) {
      if (s.borderTopStyle !== "dashed") fail(".participant--off", `border ${s.borderTopStyle}, expected dashed`, p);
      if (s.backgroundColor !== "rgba(0, 0, 0, 0)") fail(".participant--off", `background ${s.backgroundColor}`, p);
      if (name && !css(name).textDecorationLine.includes("line-through")) fail(".participant--off .participant__name", "name is not struck through", p);
      const badge = p.querySelector(".badge"), reason = p.querySelector(".session-p__reason");
      if (badge && reason && reason.getBoundingClientRect().top < badge.getBoundingClientRect().bottom - 1) fail(".participant--off", "reason is not under the chip", p);
    }
    if (p.classList.contains("participant--active")) {
      if (s.borderTopColor !== LEAF) fail(".participant--active", `border ${s.borderTopColor}, expected leaf ${LEAF}`, p);
      const av = p.querySelector(".avatar"); if (av && css(av).borderTopColor !== LEAF) fail(".participant--active .avatar", `avatar ${css(av).borderTopColor}, expected leaf`, p);
    }
  }
  for (const m of all(".session-meter")) if (css(m).backgroundColor === BG1) fail(".session-meter", "background --bg-1", m);
  for (const meter of all(".session-meter .meter:not(.session-tokens)")) {
    const label = meter.querySelector(".meter__label"), count = meter.querySelector(".session-meter__count"), fill = meter.querySelector(".meter__fill");
    if (!count || !fill || !label) { fail(".session-meter .meter", "no label, count or fill", meter); continue; }
    const c = css(count).color, f = css(fill).backgroundColor;
    if (c !== f) fail(".session-meter__count", `count color ${c} differs from the fill ${f}`, meter);
    if (c !== LEAF && c !== RAIN) fail(".session-meter__count", `color ${c}: neither leaf nor rain`, meter);
    const tone = meter.getAttribute("data-tone");
    if ((tone === "info") !== (c === RAIN)) fail(".session-meter .meter", `tone ${tone} with color ${c}`, meter);
    const [l, r] = [label.firstElementChild, count].map((e) => e!.getBoundingClientRect());
    if (!(l!.right <= r.left)) fail(".session-meter .meter__label", "label is not to the left of the count", meter);
  }
  mono(".session-meter__count"); mono(".session-meter__line .mono"); mono(".session-materials summary .mono");
  for (const line of all(".session-meter__line, .session-materials summary")) if (line.querySelector("svg") && !line.closest(".session-tokens")) {
    const t = line.textContent ?? "";
    if (/открытых вопросов|open questions|материалы|materials/.test(t)) fail(".session-meter__line", `icon on the line «${t.trim()}»`, line);
  }

  // feed
  for (const t of all(".session-turn")) {
    const s = css(t);
    if (s.borderLeftColor !== s.borderTopColor || s.borderLeftWidth !== s.borderTopWidth) fail(".session-turn", `left bar ${s.borderLeftWidth} ${s.borderLeftColor} vs ${s.borderTopWidth} ${s.borderTopColor}`, t);
    if (t.classList.contains("session-turn--live")) {
      if (s.backgroundColor !== "rgba(0, 0, 0, 0)") fail(".session-turn--live", `background ${s.backgroundColor}`, t);
      if (s.borderTopColor !== LEAF) fail(".session-turn--live", `border ${s.borderTopColor}, expected leaf`, t);
      const cur = t.querySelector(".session-cursor");
      if (!cur) fail(".session-turn--live", "no cursor ▍", t);
      else {
        if (css(cur).color !== LEAF) fail(".session-cursor", `color ${css(cur).color}, expected leaf`, t);
        if (css(cur).animationName !== (reduced ? "none" : "blink")) fail(".session-cursor", `animation-name ${css(cur).animationName} with reduced=${reduced}`, t);
        const p = cur.parentElement!; if (p.lastElementChild !== cur) fail(".session-cursor", "not at the end of the text", t);
      }
      const dot = t.querySelector(".dots > i");
      if (dot && css(dot).animationName !== (reduced ? "none" : "blink")) fail(".dots > i", `animation-name ${css(dot).animationName} with reduced=${reduced}`, t);
    }
  }
  mono(".session-turn__head .mono"); mono(".session-turn__head .chip.mono"); mono(".session-turn__read"); mono(".session-round"); mono(".session-question__head .mono"); mono(".session-quote .mono");
  for (const r of all(".session-round")) if (css(r).textTransform !== "none") fail(".session-round", `text-transform ${css(r).textTransform}`, r);
  for (const t of all(".session-turn")) if (t.querySelector(".chip") && /прочитал файлов|files read/.test(t.querySelector("header")?.textContent ?? "")) fail(".session-turn", "chip \"files read\" in the header", t);
  inset(".session-question", LINE_STRONG); inset(".session-answer", LINE_STRONG); inset(".session-fail", null); inset(".session-owner-q", null); inset(".alert", null);
  for (const q of all(".session-question")) {
    const av = q.querySelector(".avatar");
    if (!av || Math.round(av.getBoundingClientRect().width) !== 22) fail(".session-question .avatar", `size ${av ? Math.round(av.getBoundingClientRect().width) : "none"}, expected 22`, q);
    if (!/^(вопрос|question) q\d+ →/.test((q.querySelector(".session-question__head .mono")?.textContent ?? "").trim())) fail(".session-question__head", `header «${q.querySelector(".session-question__head")?.textContent?.trim()}»`, q);
  }
  for (const w of all(".session-wait")) { const s = css(w); if (s.backgroundColor !== INSET || s.borderLeftWidth !== "2px") fail(".session-wait", `background ${s.backgroundColor}, left bar ${s.borderLeftWidth}`, w); }

  // reply field
  for (const box of all(".session-owner-box")) {
    const label = box.querySelector(".field__label"), area = box.querySelector("textarea"), hint = box.querySelector(".session-composer__row .field__hint"), btn = box.querySelector('.session-composer__row button[type="submit"]');
    if (!area) continue;
    if (!label || label.getBoundingClientRect().bottom > area.getBoundingClientRect().top + 1) fail(".session-composer", "label is not above the field", box);
    if (!hint || !btn) { fail(".session-composer__row", "no hint or button", box); continue; }
    const h = hint.getBoundingClientRect(), b = btn.getBoundingClientRect(), row = btn.parentElement!.getBoundingClientRect();
    // hint on the left, button on the right; in a narrow row (answer mode with "Cancel answer") the buttons wrap under the hint but stay on the right
    if (h.top < b.bottom && b.top < h.bottom && h.left >= b.left) fail(".session-composer__row", "hint is not to the left of the button", box);
    if (h.top >= b.bottom - 1) fail(".session-composer__row", "hint is below the button", box);
    if (Math.abs(b.right - (row.right - parseFloat(css(btn.parentElement!).paddingRight))) > 1) fail(".session-composer__row", `"Send" is not pushed to the right: ${b.right} vs ${row.right}`, box);
    if (!btn.classList.contains("btn--primary")) fail(".session-composer__row", "\"Send\" is not primary", box);
    if (Math.round(b.right) > Math.round(box.getBoundingClientRect().right) + 0.5) fail(".session-composer__row", "button goes outside the block", box);
  }
  return { failures, widths };
}

async function setWidth(cdp: Cdp, width: number) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 700, deviceScaleFactor: 0, mobile: false });
  await evaluate(cdp, "new Promise((r) => setTimeout(r, 150))");
}
const ready = "new Promise((r) => { const f = () => document.readyState === 'complete' ? document.fonts.ready.then(r) : setTimeout(f, 20); f(); })";

let failed = false;
async function check(cdp: Cdp, key: string, reload: () => Promise<void>) {
  for (const width of WIDTHS) {
    await reload();
    await setWidth(cdp, width);
    const r = await evaluate(cdp, `(${inPage.toString()})(${width}, false)`);
    const fails: string[] = [...r.failures];
    if (width === WIDTHS[WIDTHS.length - 1] && fails.length === 0) {
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await evaluate(cdp, "new Promise((r) => setTimeout(r, 100))");
      const rr = await evaluate(cdp, `(${inPage.toString()})(${width}, true)`);
      fails.push(...rr.failures.map((f: string) => `reduced-motion: ${f}`));
      await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    }
    console.log(`${key} width ${width}: columns ${r.widths.join(" / ")}${fails.length ? "" : " ✓"}`);
    for (const f of fails) console.log(`  ✗ ${f}`);
    if (fails.length) failed = true;
  }
  await cdp.send("Emulation.clearDeviceMetricsOverride");
}

// The old palette in the styles and markup of the screen is checked by files, without a browser.
for (const file of ["design/mockup/screens/session.css", "design/mockup/components.css", "design/mockup-osen/brand/components-osen.css", "design/mockup-osen/brand/tokens.css", "design/mockup/session.html", "apps/desktop/src/renderer/src/app.css", "apps/desktop/src/renderer/src/session-view.css"]) {
  const text = readFileSync(join(root, file), "utf8").toLowerCase();
  for (const hex of OLD_PALETTE) if (text.includes(hex)) { console.log(`✗ ${file}: old palette ${hex}`); failed = true; }
}

if (cdpPort) {
  const cdp = await connect(await pageTarget(cdpPort));
  const lang = await evaluate(cdp, "document.documentElement.lang || 'unknown'");
  await check(cdp, `app:session:${lang}`, async () => {});
  cdp.close();
} else {
  const html = readFileSync(join(mockup, "session.html"), "utf8");
  const variants = (/data-variants="([^"]+)"/.exec(html)?.[1] ?? "").split(";").map((v) => v.split(":")[0]!).filter((v) => !onlyVariants || onlyVariants.includes(v));
  const profile = mkdtempSync(join(tmpdir(), "session-feed-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const browserWs = await new Promise<string>((ok, fail) => {
    let buf = "";
    chrome.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) ok(m[1]!); });
    chrome.on("exit", () => fail(new Error(`Chrome did not start: ${buf}`)));
  });
  try {
    const cdp = await connect(await pageTarget(Number(new URL(browserWs).port)));
    for (const v of variants) {
      const url = pathToFileURL(join(mockup, "session.html")).href + "#" + v;
      await check(cdp, `mockup:session#${v}`, async () => {
        await cdp.send("Page.navigate", { url: "about:blank" });
        await cdp.send("Page.navigate", { url });
        await evaluate(cdp, ready);
      });
    }
    cdp.close();
    const browser = await connect(browserWs);
    await browser.send("Browser.close").catch(() => {});
  } finally {
    await new Promise((r) => (chrome.exitCode !== null ? r(null) : chrome.on("exit", r)));
    rmSync(profile, { recursive: true, force: true });
  }
}
console.log(failed ? "\nRESULT: violations found" : "\nRESULT: no violations");
process.exit(failed ? 1 : 0);
