import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { guardClose, hardenWindow, isAllowedRequest, isExternalLink, rendererFile, revealWindow, windowOptions, APP_URL, DEV_ICON, THEME_ARG } from "./window.ts";
import { themeFromArgv } from "../shared/theme-arg.ts";
import { existsSync } from "node:fs";

const DEV = "http://localhost:5173/";
const FILE = APP_URL;
const ROOT = "/app/out/renderer";

function fakeWindow(appUrl = DEV) {
  const h: { open?: (d: { url: string }) => { action: string }; nav?: (e: { preventDefault(): void }, url: string) => void; req?: (d: { url: string }, cb: (r: { cancel: boolean }) => void) => void } = {};
  const win = {
    webContents: {
      setWindowOpenHandler: (f: typeof h.open) => (h.open = f),
      on: (name: string, f: typeof h.nav) => {
        if (name === "will-navigate") h.nav = f;
      },
      session: { webRequest: { onBeforeRequest: (f: typeof h.req) => (h.req = f) } },
    },
  } as unknown as BrowserWindow;
  const openExternal = vi.fn();
  hardenWindow(win, { appUrl, openExternal });
  return { h, openExternal };
}

describe("windowOptions", () => {
  it("enables isolation", () => {
    const o = windowOptions("/p.cjs", true, "osen");
    expect(o).toMatchObject({ width: 1100, height: 700, minWidth: 900, minHeight: 600, show: false });
    expect(o.webPreferences).toEqual({ preload: "/p.cjs", contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, additionalArguments: ["--osen-theme=osen"] });
    expect(o.backgroundColor).toBe("#17130F");
  });

  it("carries the theme background and argument for a light theme; themeFromArgv round-trips", () => {
    const o = windowOptions("/p.cjs", true, "pergament");
    expect(o.backgroundColor).toBe("#EFE4D0");
    expect(o.webPreferences?.additionalArguments).toEqual([`${THEME_ARG}pergament`]);
    for (const t of ["osen", "tuman", "len", "inei", "pergament"] as const) expect(themeFromArgv(["x", `${THEME_ARG}${t}`])).toBe(t);
    for (const bad of [[], ["--osen-theme="], ["--osen-theme=sakura"], ["--other=len"]]) expect(themeFromArgv(bad)).toBe("osen");
  });
});

describe("window icon", () => {
  it("in development — icon.png from design/mockup-osen/brand/app-icon, the file exists", () => {
    const icon = windowOptions("/p.cjs", false, "osen").icon;
    expect(icon).toBe(DEV_ICON);
    expect(DEV_ICON).toMatch(/design\/mockup-osen\/brand\/app-icon\/icon\.png$/);
    expect(existsSync(DEV_ICON)).toBe(true);
  });

  it("in the built app icon is not set (the package icon is icon.icns)", () => {
    expect(windowOptions("/p.cjs", true, "osen")).not.toHaveProperty("icon");
  });
});

describe("isExternalLink", () => {
  it("only http and https", () => {
    expect(isExternalLink("http://a.b")).toBe(true);
    expect(isExternalLink("https://a.b")).toBe(true);
    expect(isExternalLink("file:///etc/passwd")).toBe(false);
    expect(isExternalLink("javascript:alert(1)")).toBe(false);
    expect(isExternalLink("не адрес")).toBe(false);
  });
});

describe("isAllowedRequest", () => {
  it("lets its own through", () => {
    expect(isAllowedRequest("http://localhost:5173/src/main.tsx", DEV)).toBe(true);
    expect(isAllowedRequest("ws://localhost:5173/", DEV)).toBe(true);
    expect(isAllowedRequest("devtools://devtools/x", DEV)).toBe(true);
    expect(isAllowedRequest("app://osen/a.js", FILE)).toBe(true);
    expect(isAllowedRequest(FILE, FILE)).toBe(true);
    expect(isAllowedRequest("app://osen/assets/x.woff2", FILE)).toBe(true);
  });
  it("cuts off foreign ones", () => {
    expect(isAllowedRequest("https://evil.example/", DEV)).toBe(false);
    expect(isAllowedRequest("http://localhost:9999/", DEV)).toBe(false);
    expect(isAllowedRequest("file:///etc/passwd", DEV)).toBe(false);
    expect(isAllowedRequest("https://evil.example/", FILE)).toBe(false);
  });
  it("any file: and a foreign host of the app protocol are forbidden", () => {
    for (const url of [
      "file:///etc/hosts",
      "file:///Users/x/Library/Application%20Support/osen/.env",
      "file:///app/out/renderer/index.html",
      "file:///app/out/renderer/assets/x.js",
      "app://evil/index.html",
      "app:///index.html",
      "app://osen/%2e%2e%2fsecret",
    ]) expect(isAllowedRequest(url, FILE), url).toBe(false);
  });
});

describe("rendererFile", () => {
  it("own addresses give a path inside the UI folder", () => {
    expect(rendererFile(APP_URL, ROOT)).toBe(`${ROOT}/index.html`);
    expect(rendererFile("app://osen/assets/index-abc.js", ROOT)).toBe(`${ROOT}/assets/index-abc.js`);
    expect(rendererFile("app://osen/assets/ibm-plex-sans-latin-400-normal-x.woff2", ROOT)).toBe(`${ROOT}/assets/ibm-plex-sans-latin-400-normal-x.woff2`);
    expect(rendererFile("app://OSEN/index.html", ROOT)).toBe(`${ROOT}/index.html`);
  });
  it("refusal: encoded separators and dots, a foreign and an empty host, an empty path, file:", () => {
    for (const url of [
      "app://osen/assets/%2e%2e%2fsecret",
      "app://osen/%2f%2fetc/hosts",
      "app://osen/a%2fb",
      "app://osen/a%5cb",
      "app://osen/%zz",
      "app://evil/index.html",
      "app:///index.html",
      "app://osen/",
      "app://osen",
      "file:///app/out/renderer/index.html",
      "file:///etc/hosts",
      "не адрес",
    ]) expect(rendererFile(url, ROOT), url).toBeNull();
  });
  it("dots collapse by address parsing and stay inside the folder", () => {
    for (const url of ["app://osen/../etc/hosts", "app://osen/%2e%2e/%2e%2e/etc/hosts", "app://osen/assets/../../a.js"]) {
      const r = rendererFile(url, ROOT);
      expect(r === null || r.startsWith(ROOT + "/"), url).toBe(true);
    }
  });
});

describe("isAllowedRequest: fonts", () => {
  it("woff2 come only from the app address", () => {
    expect(isAllowedRequest("http://localhost:5173/node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-cyrillic-400-normal.woff2", DEV)).toBe(true);
    expect(isAllowedRequest("app://osen/assets/jetbrains-mono-latin-500-normal-Ab12.woff2", FILE)).toBe(true);
    expect(isAllowedRequest("https://fonts.gstatic.com/s/ibmplexsans/v19/x.woff2", DEV)).toBe(false);
    expect(isAllowedRequest("https://fonts.gstatic.com/s/ibmplexsans/v19/x.woff2", FILE)).toBe(false);
    expect(isAllowedRequest("https://fonts.googleapis.com/css2?family=IBM+Plex+Sans", FILE)).toBe(false);
  });
});

describe("hardenWindow", () => {
  it("new windows are always forbidden, only http(s) goes outward", () => {
    const { h, openExternal } = fakeWindow();
    expect(h.open!({ url: "https://a.b" })).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenCalledWith("https://a.b");
    openExternal.mockClear();
    expect(h.open!({ url: "file:///x" })).toEqual({ action: "deny" });
    expect(openExternal).not.toHaveBeenCalled();
  });
  it("navigation outward is cancelled", () => {
    const { h, openExternal } = fakeWindow();
    const preventDefault = vi.fn();
    h.nav!({ preventDefault }, "https://a.b");
    expect(preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("https://a.b");
  });
  it("navigation inside the app is not cancelled", () => {
    const { h, openExternal } = fakeWindow();
    const preventDefault = vi.fn();
    h.nav!({ preventDefault }, "http://localhost:5173/x");
    expect(preventDefault).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });
  it("navigation and a request to any file: are cancelled, its own address passes", () => {
    const { h, openExternal } = fakeWindow(FILE);
    const preventDefault = vi.fn();
    h.nav!({ preventDefault }, "file:///etc/hosts");
    expect(preventDefault).toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    preventDefault.mockClear();
    h.nav!({ preventDefault }, FILE);
    expect(preventDefault).not.toHaveBeenCalled();
    const cb = vi.fn();
    h.req!({ url: "file:///Users/x/Library/Application%20Support/osen/.env" }, cb);
    expect(cb).toHaveBeenLastCalledWith({ cancel: true });
    h.req!({ url: "file:///app/out/renderer/assets/index.js" }, cb);
    expect(cb).toHaveBeenLastCalledWith({ cancel: true });
    h.nav!({ preventDefault }, "file:///app/out/renderer/index.html");
    expect(preventDefault).toHaveBeenCalled();
    h.req!({ url: "app://osen/assets/index.js" }, cb);
    expect(cb).toHaveBeenLastCalledWith({ cancel: false });
  });
  it("a request to a foreign address is cancelled", () => {
    const { h } = fakeWindow();
    const cb = vi.fn();
    h.req!({ url: "https://evil.example/" }, cb);
    expect(cb).toHaveBeenCalledWith({ cancel: true });
    h.req!({ url: "http://localhost:5173/a" }, cb);
    expect(cb).toHaveBeenLastCalledWith({ cancel: false });
  });
});

describe("guardClose", () => {
  function setup(running: number, answers: Array<boolean | "reject" | "pending">) {
    let onClose!: (e: { preventDefault(): void }) => void;
    const win = { on: (_: string, f: typeof onClose) => (onClose = f), close: vi.fn() } as unknown as BrowserWindow;
    const resolvers: Array<(v: boolean) => void> = [];
    const confirm = vi.fn(() => {
      const a = answers.shift();
      if (a === "reject") return Promise.reject(new Error("x"));
      if (a === "pending") return new Promise<boolean>((r) => resolvers.push(r));
      return Promise.resolve(a ?? false);
    });
    guardClose(win, { running: () => running, confirm });
    const attempt = () => {
      const preventDefault = vi.fn();
      onClose({ preventDefault });
      return preventDefault;
    };
    return { win, confirm, attempt, resolvers };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("without running sessions the window closes without a question", () => {
    const { confirm, attempt } = setup(0, []);
    expect(attempt()).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });
  it("the owner stayed: the window does not close, the next attempt asks again", async () => {
    const { win, confirm, attempt } = setup(1, [false, false]);
    expect(attempt()).toHaveBeenCalled();
    await flush();
    expect(confirm).toHaveBeenCalledWith(1);
    expect(win.close).not.toHaveBeenCalled();
    expect(attempt()).toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(2);
  });
  it("the owner confirmed: win.close is called, a repeated close passes without a question", async () => {
    const { win, confirm, attempt } = setup(1, [true]);
    expect(attempt()).toHaveBeenCalled();
    await flush();
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(attempt()).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
  });
  it("while the question is open, a second attempt does not open a second dialog", async () => {
    const { confirm, attempt, resolvers } = setup(1, ["pending"]);
    expect(attempt()).toHaveBeenCalled();
    expect(attempt()).toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
    resolvers[0]!(false);
    await flush();
  });
  it("confirm declined: the window stays, the next attempt asks again", async () => {
    const { win, confirm, attempt } = setup(1, ["reject", false]);
    expect(attempt()).toHaveBeenCalled();
    await flush();
    expect(win.close).not.toHaveBeenCalled();
    expect(attempt()).toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

describe("revealWindow", () => {
  const make = (minimized: boolean) => {
    const calls: string[] = [];
    const win = {
      isMinimized: () => minimized,
      restore: vi.fn(() => calls.push("restore")),
      show: vi.fn(() => calls.push("show")),
      focus: vi.fn(() => calls.push("focus")),
    } as unknown as BrowserWindow;
    return { win, calls };
  };

  it("minimized window: restore, show, focus in order", () => {
    const { win, calls } = make(true);
    revealWindow(win);
    expect(calls).toEqual(["restore", "show", "focus"]);
  });

  it("non-minimized window: restore is not called", () => {
    const { win, calls } = make(false);
    revealWindow(win);
    expect(calls).toEqual(["show", "focus"]);
  });
});
