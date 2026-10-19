// Screen stand for the five themes (change 148): every screen and its main states of the open development window, in every theme and width.
// Per visible text: contrast against the computed background >= 4.5:1; in light themes no computed color of the autumn theme that is not
// also a value of the current theme.
//   COUNCIL_DEV=1 COUNCIL_HOME=<new folder inside the project> node apps/desktop/scenarios/themes/check.ts --seed-only
//       prepares the data folder (finished sessions of every status, usage fixtures, one running session waiting for the owner) and prints the window command
//   node apps/desktop/scenarios/themes/check.ts --cdp <port> [--themes osen,len] [--screens new,setup,session,result,history,settings,template]
//                                               [--widths 1100,900] [--snapshot <folder>] [--inject-autumn]
//       --snapshot saves <theme>-<screen>-<state>-<width>.png; --inject-autumn adds color:#8E8273 text in the first light theme (the stand must fail)
// The theme is switched with window.council.setAppearance and restored at the end; the width is set by CDP viewport emulation and removed at the end.
// In the autumn theme ("osen") contrast findings are printed as out of scope and do not fail the run. Light themes: any finding gives exit code 1.
// Model calls: 0 (scripted participants).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const argv = process.argv.slice(2);
const arg = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1]! : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PORT = 9341;

// ---------- seed ----------
async function seed(): Promise<void> {
  const { ensureDataDir, readEvents, readSession, sessionsDir } = await import("../../../../packages/core/src/index.ts");
  const { seedFixtures } = await import("../usage/fixture.ts");
  const home = process.env["COUNCIL_HOME"];
  if (process.env["COUNCIL_DEV"] !== "1" || !home) {
    console.error("COUNCIL_DEV=1 and COUNCIL_HOME (a new folder) are required. Usage: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node apps/desktop/scenarios/themes/check.ts --seed-only");
    process.exit(2);
  }
  const dir = resolve(home);
  if (existsSync(dir) && (!statSync(dir).isDirectory() || readdirSync(dir).length > 0)) {
    console.error(`COUNCIL_HOME ${dir} already exists and is not empty: the stand writes only to a new folder.`);
    process.exit(2);
  }
  ensureDataDir(dir);
  const env = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: dir };
  const entry = join(root, "packages/core/src/council.ts");
  const core = (n: string) => `scripted:${join(root, "packages/core/scenarios/consensus", `${n}.json`)}`;
  const attn = (n: string) => `scripted:${join(root, "apps/desktop/scenarios/owner-attention", `${n}.json`)}`;
  const ids = () => new Set(readdirSync(sessionsDir(dir)));
  const events = (id: string) => readEvents(dir, id)!.events as unknown as { type: string }[];
  async function until<T>(what: string, fn: () => T | undefined | false | null, ms = 20000): Promise<T> {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(60)) {
      let r: T | undefined | false | null;
      try { r = fn(); } catch { r = undefined; }
      if (r) return r;
    }
    throw new Error(`timed out waiting for: ${what}`);
  }
  const run = (topic: string, p1: string, p2: string, rounds: number) => {
    const r = spawnSync(process.execPath, [entry, "--topic", topic, "--participant", p1, "--participant", p2, "--max-rounds", String(rounds)], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (r.status !== 0 && r.status !== 3) throw new Error(`council "${topic}" exited with ${r.status}: ${r.stderr}`);
  };
  // A detached council that waits for the owner on the question of the first participant.
  async function waiting(topic: string, seconds: number) {
    const before = ids();
    const child = spawn(process.execPath, [entry, "--topic", topic, "--participant", attn("ask-p1"), "--participant", attn("answer-p2"), "--max-rounds", "3", "--wait-for-owner", "--owner-wait-sec", String(seconds)], { env, detached: true, stdio: "ignore" });
    child.unref();
    const id = await until("session id", () => [...ids()].find((x) => !before.has(x)));
    await until("open owner question", () => events(id).some((e) => e.type === "owner_wait_started"));
    return { id, pid: child.pid! };
  }

  seedFixtures(dir);
  run("THEMES consensus: how to name the cat", core("p1"), core("p2"), 3);
  run("THEMES no consensus: how to name the cat", core("p2"), core("p2"), 1);
  const stopped = await waiting("THEMES stopped: which report to prepare", 600);
  const st = spawnSync(process.execPath, [entry, "stop", stopped.id], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (st.status !== 0) throw new Error(`council stop failed: ${st.stderr}`);
  await until("stopped status", () => readSession(dir, stopped.id)?.status === "stopped");
  const w = await waiting("THEMES waiting: which report to prepare", 86400);
  // Three participants: A proposes, B agrees, C objects; in round 2 A thinks for an hour (the turn timeout is raised to the maximum, ~24.8 days).
  const liveBefore = ids();
  const live = spawn(process.execPath, [entry, "--topic", "THEMES live: which report to prepare", ...["a", "b", "c"].flatMap((n) => ["--participant", `scripted:${join(here, `live-${n}.json`)}`]), "--max-rounds", "3", "--turn-timeout", "2147483"], { env, detached: true, stdio: "ignore" });
  live.unref();
  const liveId = await until("live session id", () => [...ids()].find((x) => !liveBefore.has(x)));
  await until("round 2 turn of A started", () => events(liveId).filter((e) => e.type === "turn_started").length >= 4);

  console.log(`Data folder prepared: ${dir}`);
  console.log(`Sessions: THEMES consensus, THEMES no consensus, THEMES stopped (finished); THEMES waiting ${w.id} (running, open owner question, pid ${w.pid}); usage fixtures usage-a..h (unfinished ones show as running, two journals are broken).`);
  console.log("Not seeded: an interrupted session and a saved lineup.");
  console.log(`Window: cd "${root}" && COUNCIL_DEV=1 COUNCIL_HOME="${dir}" env -u ELECTRON_RUN_AS_NODE npm run desktop -- --remoteDebuggingPort ${PORT} -- --user-data-dir="${dir}/profile"`);
  console.log(`THEMES live ${liveId} (running, pid ${live.pid}): A proposed, B agrees, C objects, A thinks in round 2 for 3600 s (a scripted delay, up to one hour from its start).`);
  console.log(`Stop it: COUNCIL_DEV=1 COUNCIL_HOME="${dir}" node packages/core/src/council.ts stop ${liveId}`);
  console.log(`Check: node apps/desktop/scenarios/themes/check.ts --cdp ${PORT}`);
  console.log(`Stop the waiting session (never kill the process): COUNCIL_DEV=1 COUNCIL_HOME="${dir}" node packages/core/src/council.ts stop ${w.id}`);
}

if (argv.includes("--seed-only")) {
  await seed();
  process.exit(0);
}

// ---------- CDP (as in session-feed/measure.ts) ----------
type Cdp = { send: (method: string, params?: object) => Promise<any>; close: () => void };
async function connect(ws: string): Promise<Cdp> {
  const sock = new WebSocket(ws);
  await new Promise((ok, fail) => { sock.onopen = ok; sock.onerror = fail; });
  let id = 0;
  const wait = new Map<number, (m: any) => void>();
  sock.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (typeof m.id !== "number") return; // events carry no id
    const done = wait.get(m.id);
    wait.delete(m.id);
    if (typeof done === "function") done(m);
  };
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
// Values reach the page as CDP call arguments, never spliced into code.
async function callIn(cdp: Cdp, fn: (...a: any[]) => unknown, ...args: unknown[]): Promise<any> {
  const self = await cdp.send("Runtime.evaluate", { expression: "globalThis" });
  const r = await cdp.send("Runtime.callFunctionOn", { functionDeclaration: fn.toString(), objectId: self.result.objectId, arguments: args.map((value) => ({ value })), awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

// ---------- tokens (as in mockup-tokens/check.ts) ----------
const tokensCss = readFileSync(join(root, "design/mockup-osen/brand/tokens.css"), "utf8");
const hexes = (block: string) => new Map([...block.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
const autumnColors = hexes(/:root\s*\{([\s\S]*?)\n\}/.exec(tokensCss)?.[1] ?? "");
const themeColors = (id: string) => {
  const at = tokensCss.indexOf(`[data-theme="${id}"] {`);
  return hexes(at < 0 ? "" : tokensCss.slice(at, tokensCss.indexOf("\n}", at)));
};
const toRgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
// A dark color that the light theme happens to share is not a leftover.
const leftovers = (theme: string) => {
  const own = new Set(themeColors(theme).values());
  return [...new Set([...autumnColors.values()].filter((v) => !own.has(v)).map(toRgb))];
};

// ---------- the check in the page ----------
type Found = { texts: number; worst: { ratio: number; sel: string } | null; low: string[]; autumn: string[]; images: number };
function inPage(o: { autumn: string[]; osen: boolean }): Found {
  const css = (el: Element) => getComputedStyle(el);
  const parse = (c: string): [number, number, number, number] | null => {
    let m = /^rgba?\(([^)]+)\)$/.exec(c);
    if (m) { const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0]!, p[1]!, p[2]!, p[3] ?? 1]; }
    m = /^color\(srgb ([^)]+)\)$/.exec(c);
    if (m) { const p = m[1]!.split(/[\s/]+/).filter(Boolean).map(Number); return [p[0]! * 255, p[1]! * 255, p[2]! * 255, p[3] ?? 1]; }
    return null;
  };
  const over = (top: [number, number, number, number], under: [number, number, number]): [number, number, number] =>
    [0, 1, 2].map((i) => top[i]! * top[3] + under[i]! * (1 - top[3])) as [number, number, number];
  const lum = (c: number[]) => { const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!); };
  const rgbStr = (c: number[]) => `rgb(${Math.round(c[0]!)}, ${Math.round(c[1]!)}, ${Math.round(c[2]!)})`;
  const path = (el: Element) => {
    const p: string[] = [];
    let e: Element | null = el;
    for (let n = 0; e && e !== document.body && n < 4; e = e.parentElement, n++) {
      const par: Element | null = e.parentElement, tag = e.tagName;
      const same = par ? [...par.children].filter((c) => c.tagName === tag) : [];
      const cls = typeof e.className === "string" ? e.className.trim().split(/\s+/)[0] : "";
      p.unshift(tag.toLowerCase() + (e.id ? `#${e.id}` : "") + (cls ? `.${cls}` : "") + (same.length > 1 ? `:nth-of-type(${same.indexOf(e) + 1})` : ""));
    }
    return p.join(" > ");
  };
  const tok = (name: string) => { const s = document.createElement("span"); s.style.color = css(document.documentElement).getPropertyValue(name).trim(); document.body.append(s); const c = css(s).color; s.remove(); return c; };
  const FAINT = o.osen ? tok("--text-faint") : "", BG3 = o.osen ? tok("--bg-3") : "";
  const rootBg = parse(css(document.documentElement).backgroundColor), bodyBg = parse(css(document.body).backgroundColor);
  const page = ([bodyBg, rootBg].find((c) => c && c[3] > 0.99) ?? [255, 255, 255, 1]) as number[];

  const out: Found = { texts: 0, worst: null, low: [], autumn: [], images: 0 };
  const seen = new Set<string>();
  const TEXT_INPUT = /^(text|search|url|email|password|number|tel)$/;
  const SKIP = new Set(["SCRIPT", "STYLE", "OPTION", "OPTGROUP", "TITLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"]);
  for (const el of document.body.querySelectorAll("*")) {
    if (SKIP.has(el.tagName) || el.getClientRects().length === 0) continue;
    const s = css(el);
    if (s.visibility === "hidden") continue;
    let opacity = 1;
    for (let e: Element | null = el; e; e = e.parentElement) opacity *= Number(css(e).opacity);
    if (opacity <= 0) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    const control = el instanceof HTMLInputElement ? TEXT_INPUT.test(el.type) && el.value !== "" : el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? el.value !== "" : false;
    const ownText = control || [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "");
    const svg = el instanceof SVGElement;

    // autumn colors; the nested theme previews of "Appearance" show other themes on purpose
    if (o.autumn.length && el.closest("[data-theme]") === document.documentElement) {
      const props: [string, string][] = [["background-color", s.backgroundColor]];
      if (ownText || control) props.push(["color", s.color]);
      if (svg) props.push(["fill", s.fill], ["stroke", s.stroke]);
      for (const side of ["top", "right", "bottom", "left"]) {
        if (parseFloat((s as any)[`border-${side}-width`]) > 0 && (s as any)[`border-${side}-style`] !== "none") props.push([`border-${side}-color`, (s as any)[`border-${side}-color`]]);
      }
      if (s.outlineStyle !== "none") props.push(["outline-color", s.outlineColor]);
      for (const [prop, v] of props) {
        const c = parse(v);
        const norm = c && c[3] === 1 ? rgbStr(c) : v;
        if (o.autumn.includes(norm)) { const key = `${path(el)} ${prop} ${norm}`; if (!seen.has(key)) { seen.add(key); out.autumn.push(key); } }
      }
    }

    // contrast
    if (!ownText || el.closest('[aria-hidden="true"]') || el.closest(':disabled,[aria-disabled="true"]')) continue;
    const fg = parse(svg ? s.fill : s.color);
    if (!fg) continue;
    const layers: [number, number, number, number][] = [];
    let image = false;
    for (let e: Element | null = el; e; e = e.parentElement) {
      const cs = css(e);
      const c = parse(cs.backgroundColor);
      if (cs.backgroundImage !== "none") { image = true; break; }
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 0.999) break; }
    }
    if (image) { out.images++; continue; }
    let bg: [number, number, number] = [page[0]!, page[1]!, page[2]!];
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i]!, bg);
    const text = over([fg[0], fg[1], fg[2], fg[3] * opacity], bg);
    if (o.osen && rgbStr(fg) === FAINT && rgbStr(bg) === BG3) continue;
    const hi = Math.max(lum(text), lum(bg)), lo = Math.min(lum(text), lum(bg));
    const ratio = (hi + 0.05) / (lo + 0.05);
    out.texts++;
    const sel = path(el);
    if (!out.worst || ratio < out.worst.ratio) out.worst = { ratio, sel };
    if (ratio < 4.5) {
      const label = control ? (el as HTMLInputElement).value : [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ").trim();
      out.low.push(`contrast ${ratio.toFixed(2)} ${sel} ${rgbStr(text)} on ${rgbStr(bg)} "${label.slice(0, 24)}"`);
    }
  }
  return out;
}

// ---------- screens ----------
const widths = (arg("--widths") ?? "1100,900").split(",").map(Number);
const THEMES = ["osen", "tuman", "len", "inei", "pergament"];
const themes = arg("--themes")?.split(",") ?? THEMES;
const ALL_SCREENS = ["new", "setup", "session", "result", "history", "settings", "template"];
const screens = arg("--screens")?.split(",") ?? ALL_SCREENS;
const snapshotDir = arg("--snapshot");
const inject = argv.includes("--inject-autumn");
const bad = [...themes.filter((t) => !THEMES.includes(t)), ...screens.filter((s) => !ALL_SCREENS.includes(s))];
if (bad.length) { console.error(`Unknown --themes/--screens values: ${bad.join(", ")}`); process.exit(2); }
if (argv.includes("--cdp") === false) { console.error("Usage: --seed-only (see the file header) or --cdp <port>"); process.exit(2); }
const port = Number(arg("--cdp"));
const cdp = await connect(await pageTarget(port));

const waitFor = async (cond: string, what: string, ms = 15000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(80)) if (await evaluate(cdp, `Boolean(${cond})`).catch(() => false)) return;
  throw new Error(`timed out waiting for ${what} (${cond})`);
};
const run = (code: string) => evaluate(cdp, `(async () => { ${code} })()`);
// Native value setter: React sees the change as typed input.
const typeInto = (selector: string, value: string) => callIn(cdp, (sel: string, v: string) => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`no ${sel}`);
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, selector, value);
const rail = async (i: number, ready: string) => {
  await run(`document.querySelectorAll(".rail__item")[${i}].click()`);
  await waitFor(ready, `rail item ${i}`);
};
// The History section resets the open session, a kept setup and the editor: every state starts from a known place.
const history = () => rail(1, `document.querySelector(".history-row")`);
const gallery = async () => { await history(); await rail(0, `document.querySelector(".grid-cards .card--dashed")`); };
const card = (i: number) => run(`document.querySelectorAll(".grid-cards")[0].querySelectorAll("button.card--dashed")[${i}].click()`);
const openRow = async (prefix: string) => {
  const found = await callIn(cdp, (p: string) => {
    const b = [...document.querySelectorAll<HTMLElement>(".history-open")].find((x) => x.title.startsWith(p));
    if (b) b.click();
    return Boolean(b);
  }, prefix);
  if (!found) throw new Error(`no history row "${prefix}": was the folder prepared with --seed-only?`);
};

// Async panels (settings tabs, usage) fill in after the click: wait until the page text stops changing.
const settle = async () => {
  let last = -1, same = 0;
  for (const t0 = Date.now(); same < 4 && Date.now() - t0 < 10000; await sleep(150)) {
    const n = (await evaluate(cdp, "document.body.innerText.length")) as number;
    same = n === last ? same + 1 : 0;
    last = n;
  }
};

type State = { name: string; go: () => Promise<void>; reached?: [string, string][] };
const SCREENS: Record<string, State[]> = {
  new: [{ name: "gallery", go: gallery }],
  setup: [{
    name: "two-participants",
    go: async () => {
      await gallery();
      await card(0);
      await waitFor(`document.querySelector(".setup")`, "session setup");
      await typeInto(".setup textarea", "THEMES setup: what to check first");
      await run(`for (let i = 0; i < 3 && document.querySelectorAll(".setup-p").length < 2; i++) { const b = document.querySelector(".setup__add .btn"); if (!b || b.disabled) break; b.click(); await new Promise((r) => setTimeout(r, 150)); }`);
    },
  }],
  template: [{
    name: "editor",
    go: async () => {
      await gallery();
      await card(1);
      await waitFor(`!document.querySelector(".grid-cards") && document.querySelector("main.content input, main.content textarea")`, "template editor");
    },
  }],
  history: [
    { name: "list", go: history },
    { name: "search", go: async () => { await history(); await typeInto(".history-search", "THEMES"); }, reached: [["the usage panel", `section.usage`], ["a filtered list", `.history-row`]] },
  ],
  session: [
    {
      name: "live",
      go: async () => { await history(); await openRow("THEMES live"); await waitFor(`!document.querySelector(".history-row") && document.querySelector(".session-col")`, "discussion screen"); },
      reached: [
        ["a thinking turn in the feed", `.session-turn--live`],
        ["a participant in the thinking state", `.session-p__state .badge[data-tone="accent"]`],
        ["an agreed participant", `.session-p__state .badge[data-tone="info"]`],
        ["an objecting participant", `.session-p__state .badge[data-tone="danger"]`],
        ["an agree chip in the feed", `.session-turn .badge[data-tone="info"]`],
        ["an objection chip in the feed", `.session-turn .badge[data-tone="danger"]`],
        ["the solution panel with a proposed version", `.session-col .session-panel`],
      ],
    },
    {
      name: "waiting",
      go: async () => { await history(); await openRow("THEMES waiting"); await waitFor(`!document.querySelector(".history-row") && document.querySelector(".session-col")`, "discussion screen"); },
      reached: [["the owner wait panel", `section.session-wait`], ["the solution panel", `.session-col .session-panel`]],
    },
  ],
  result: ["consensus", "no consensus", "stopped"].map((s) => ({
    name: s.replace(" ", "-"),
    go: async () => { await history(); await openRow(`THEMES ${s}`); await waitFor(`!document.querySelector(".history-row")`, "result screen"); },
  })),
  settings: [
    { name: "providers", go: () => rail(2, `document.querySelector(".settings-tabs") && document.querySelector(".appearance")`) },
    { name: "appearance", go: async () => { await rail(2, `document.querySelector(".appearance")`); await run(`document.querySelector(".appearance").scrollIntoView()`); } },
    { name: "defaults", go: async () => { await rail(2, `document.querySelector(".settings-tabs")`); await run(`document.querySelectorAll(".settings-tabs .tab")[1].click()`); } },
    { name: "connections", go: async () => { await rail(2, `document.querySelector(".settings-tabs")`); await run(`document.querySelectorAll(".settings-tabs .tab")[2].click()`); } },
  ],
};

// ---------- run ----------
const original = await evaluate(cdp, `Promise.resolve(window.council.appearance())`) as { mode: string; lightTheme: string; theme: string };
const height = await evaluate(cdp, "window.innerHeight") as number;
let violations = 0;
const outOfScope: string[] = [];
const cap = (items: string[], head: string) => {
  for (const m of items.slice(0, 25)) console.log(`  ✗ ${head}${m}`);
  if (items.length > 25) console.log(`  … ${items.length - 25} more ${head.trim()}`);
};
async function setTheme(id: string) {
  const input = id === "osen" ? { mode: "dark" } : { mode: "light", lightTheme: id };
  await evaluate(cdp, `Promise.resolve(window.council.setAppearance(${JSON.stringify(input)})).then(() => true)`);
  await waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(id)}`, `theme ${id}`);
  await sleep(350);
}
let probed = false;
try {
  if (snapshotDir) mkdirSync(snapshotDir, { recursive: true });
  for (const width of widths) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    for (const theme of themes) {
      await setTheme(theme);
      const light = theme !== "osen";
      const autumn = light ? leftovers(theme) : [];
      for (const screen of screens) {
        for (const state of SCREENS[screen]!) {
          const label = `${width} ${theme} ${screen}${SCREENS[screen]!.length > 1 || state.name !== "gallery" ? `:${state.name}` : ""}`;
          try {
            await state.go();
            await settle();
            const missing: string[] = [];
            for (const [what, sel] of state.reached ?? []) if (!(await evaluate(cdp, `Boolean(document.querySelector(${JSON.stringify(sel)}))`))) missing.push(what);
            if (missing.length) { violations += missing.length; for (const what of missing) console.log(`  ✗ state not reached: ${what}`); }
            const probe = inject && light && !probed;
            if (probe) await evaluate(cdp, `(() => { const s = document.createElement("span"); s.id = "stand-probe"; s.style.color = "#8E8273"; s.textContent = "probe"; (document.querySelector(".main") ?? document.body).append(s); })()`);
            const f = (await evaluate(cdp, `(${inPage.toString()})(${JSON.stringify({ autumn, osen: !light })})`)) as Found;
            if (probe) { probed = true; await evaluate(cdp, `document.getElementById("stand-probe")?.remove()`); }
            const w = f.worst ? `${f.worst.ratio.toFixed(2)} at ${f.worst.sel}` : "none";
            console.log(`${label}: texts ${f.texts}, worst contrast ${w}${f.images ? `, background image, contrast not computed: ${f.images}` : ""}`);
            if (light) {
              violations += f.low.length + f.autumn.length;
              cap(f.low, "");
              cap(f.autumn.map((a) => `autumn color: ${a}`), "");
            } else {
              outOfScope.push(...f.low.map((m) => `${label}: ${m}`));
            }
            if (snapshotDir) {
              const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
              writeFileSync(join(snapshotDir, `${theme}-${screen}-${state.name}-${width}.png`), Buffer.from(shot.data, "base64"));
            }
          } catch (e) {
            violations++;
            console.log(`${label}: ✗ stand error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
  }
} finally {
  await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await evaluate(cdp, `Promise.resolve(window.council.setAppearance(${JSON.stringify({ mode: original.mode, lightTheme: original.lightTheme })})).then(() => true)`).catch(() => {});
  await history().catch(() => {});
  cdp.close();
}
if (outOfScope.length) {
  console.log(`out of scope (osen): ${outOfScope.length} contrast findings`);
  for (const m of outOfScope.slice(0, 25)) console.log(`  ${m}`);
}
if (inject && !probed) { console.log("✗ --inject-autumn: no light theme was checked, the probe was not placed"); violations++; }
console.log(violations ? `RESULT: violations found (${violations})` : "RESULT: no violations");
process.exit(violations ? 1 : 0);
