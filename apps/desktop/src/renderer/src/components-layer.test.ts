import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const layerPath = "design/mockup-osen/brand/components-osen.css";
const pages = ["index", "setup", "template-editor", "session", "result", "history", "settings", "styleguide"];
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Body of the rule with the exact selector (the last one, if there are several). */
function rule(css: string, selector: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...css.matchAll(new RegExp(`(?:^|[}\\n])\\s*${esc}\\s*\\{([^}]*)\\}`, "g"))];
  return all.at(-1)?.[1] ?? null;
}

describe("Osen components layer", () => {
  it("main.tsx loads the layer right after components.css and before the screen styles", () => {
    const imports = [...read("apps/desktop/src/renderer/src/main.tsx").matchAll(/^import "([^"]+\.css)";$/gm)].map((m) => m[1]!);
    const base = imports.findIndex((p) => p.endsWith("design/mockup/components.css"));
    expect(base).toBeGreaterThan(-1);
    expect(imports[base + 1]).toBe("../../../../../design/mockup-osen/brand/components-osen.css");
    expect(imports.findIndex((p) => p.includes("/screens/"))).toBeGreaterThan(base + 1);
  });

  it.each(pages)("design/mockup/%s.html loads the layer right after components.css", (page) => {
    const links = [...read(`design/mockup/${page}.html`).matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]!);
    expect(links[links.indexOf("components.css") + 1]).toBe("../mockup-osen/brand/components-osen.css");
  });

  it("the layer defines .kv, .pill, the selected .pill, .avatar--sm, .tag and the .eyebrow weight", () => {
    const css = read(layerPath);
    expect(rule(css, ".kv")).toMatch(/grid-template-columns:\s*76px/);
    expect(rule(css, ".kv dt")).toMatch(/color:\s*var\(--text-faint\)/);
    expect(rule(css, ".pill")).toMatch(/border:[^;]*var\(--line-strong\)/);
    const pressed = rule(css, '.pill[aria-pressed="true"]');
    expect(pressed).toMatch(/border-color:\s*var\(--text\)/);
    expect(pressed).toMatch(/(^|;)\s*color:\s*var\(--text\)/);
    expect(rule(css, ".avatar--sm")).toMatch(/var\(--avatar-size-sm\)/);
    expect(rule(css, ".tag")).toMatch(/background:\s*var\(--bg-3\)/);
    expect(rule(css, ".eyebrow")).toMatch(/font-weight:\s*var\(--fw-bold\)/);
  });

  it("keyboard focus in the layer — --leaf outline", () => {
    const css = read(layerPath);
    for (const sel of [":is(a,button,input,select,textarea,[tabindex]):focus-visible", ".disclosure summary:focus-visible"]) {
      expect(rule(css, sel), sel).toMatch(/outline:\s*var\(--focus-w\) solid var\(--leaf\)/);
      expect(rule(css, sel), sel).toMatch(/outline-offset:\s*var\(--focus-w\)/);
    }
  });
});

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

// Measurements run in the styleguide.html page.
function measure() {
  const cs = (sel: string) => { const el = document.querySelector(sel); return el ? getComputedStyle(el) : null; };
  const h = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().height ?? null;
  const w = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().width ?? null;
  const content = cs(".content")!;
  const eyebrow = cs(".eyebrow")!;
  const pressed = cs('.pill[aria-pressed="true"]')!;
  const tag = cs(".tag")!;
  return {
    btn: h(".btn:not(.btn--sm)"), btnSm: h(".btn--sm"), rail: w(".rail"), topbar: h(".topbar"),
    content: [content.paddingTop, content.paddingRight, content.paddingBottom, content.paddingLeft].join(" "),
    eyebrow: [eyebrow.fontSize, eyebrow.fontWeight, eyebrow.textTransform].join(" "),
    kv: cs(".kv")?.gridTemplateColumns.split(" ")[0] ?? null,
    kvDt: cs(".kv dt")?.color ?? null,
    pill: h(".pill"), pillBorder: cs(".pill:not([aria-pressed=\"true\"])")?.borderTopColor ?? null,
    pressed: [pressed.borderTopColor, pressed.color, pressed.fontWeight, pressed.backgroundColor].join(" "),
    avatarSm: [w(".avatar--sm"), h(".avatar--sm")].join("x"),
    tag: [tag.fontSize, tag.backgroundColor, tag.borderTopWidth, tag.fontFamily.includes("Mono")].join(" "),
    shadows: [...document.querySelectorAll("*")].filter((el) => getComputedStyle(el).boxShadow !== "none").map((el) => el.className.toString()),
  };
}

describe.skipIf(!existsSync(CHROME))("слой компонентов в headless Chrome (styleguide.html)", () => {
  it("frame, button, capsule, avatar, label and focus sizes match SPEC", async () => {
    const profile = mkdtempSync(join(tmpdir(), "components-layer-"));
    const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const browserWs = await new Promise<string>((ok, fail) => {
      let buf = "";
      chrome.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) ok(m[1]!); });
      chrome.on("exit", () => fail(new Error(`Chrome не запустился: ${buf}`)));
    });
    try {
      const port = Number(new URL(browserWs).port);
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      const cdp = await connect(list.find((t) => t.type === "page")!.webSocketDebuggerUrl);
      const evaluate = async (expression: string) => {
        const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      };
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
      await cdp.send("Page.navigate", { url: pathToFileURL(join(root, "design/mockup/styleguide.html")).href });
      await evaluate("new Promise((r) => { const f = () => document.readyState === 'complete' ? document.fonts.ready.then(r) : setTimeout(f, 20); f(); })");
      const m = await evaluate(`(${measure.toString()})()`);
      expect(m).toEqual({
        btn: 36, btnSm: 30, rail: 84, topbar: 56,
        content: "24px 32px 24px 32px",
        eyebrow: "11px 600 uppercase",
        kv: "76px",
        kvDt: "rgb(142, 130, 115)",
        pill: 30, pillBorder: "rgb(58, 48, 40)",
        pressed: "rgb(237, 228, 216) rgb(237, 228, 216) 400 rgba(0, 0, 0, 0)",
        avatarSm: "22x22",
        tag: "12px rgb(42, 34, 27) 0px true",
        shadows: [],
      });
      // Keyboard focus: Tab to the first focusable element.
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      const focus = await evaluate("(() => { const s = getComputedStyle(document.activeElement); return [document.activeElement.tagName, s.outlineWidth, s.outlineOffset, s.outlineColor].join(' '); })()");
      expect(focus).toMatch(/^(A|BUTTON|INPUT|SELECT|TEXTAREA) 2px 2px rgb\(238, 154, 98\)$/);
      expect(await evaluate("(() => { const s = getComputedStyle(document.querySelector('.eyebrow')); const t = getComputedStyle(document.querySelector('.tag')); return [s.letterSpacing, t.borderTopLeftRadius].join(' '); })()")).toBe("0.88px 3px");
      // «Discussion» on .content--flush: the layer sets .content margins, but must not return them to a screen without margins.
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
      await cdp.send("Page.navigate", { url: pathToFileURL(join(root, "design/mockup/session.html")).href + "#agreed" });
      await evaluate("new Promise((r) => { const f = () => document.readyState === 'complete' ? document.fonts.ready.then(r) : setTimeout(f, 20); f(); })");
      expect(await evaluate("getComputedStyle(document.querySelector('.content--flush')).padding")).toBe("0px");
      expect(await evaluate("[...document.querySelectorAll('.alert__actions .btn')].filter((b) => b.getClientRects().length).every((b) => b.getBoundingClientRect().right <= b.parentElement.getBoundingClientRect().right + 0.5)")).toBe(true);
      cdp.close();
    } finally {
      await (await connect(browserWs)).send("Browser.close").catch(() => {});
      await new Promise((r) => (chrome.exitCode !== null ? r(null) : chrome.on("exit", r)));
      rmSync(profile, { recursive: true, force: true });
    }
  }, 60_000);
});
