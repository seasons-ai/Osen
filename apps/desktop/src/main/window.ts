import { join } from "node:path";
import type { BrowserWindowConstructorOptions, BrowserWindow } from "electron";

// The development window icon from sources (src/main and out/main at the same depth); the built app takes the package icon.icns.
export const DEV_ICON = join(import.meta.dirname, "../../../../design/mockup-osen/brand/app-icon/icon.png");

export function windowOptions(preloadPath: string, packaged: boolean): BrowserWindowConstructorOptions {
  return {
    ...(!packaged && { icon: DEV_ICON }),
    width: 1100,
    height: 700,
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: { preload: preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
  };
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isExternalLink(url: string): boolean {
  const u = parse(url);
  return u !== null && (u.protocol === "http:" || u.protocol === "https:");
}

// Decoded path segments without empty ones; null — an encoded separator, ".", ".." or a broken encoding.
function segments(url: URL): string[] | null {
  const out: string[] = [];
  for (const raw of url.pathname.split("/")) {
    let s: string;
    try {
      s = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (/[/\\]/.test(s) || s === "." || s === "..") return null;
    if (s) out.push(s);
  }
  return out;
}

// The built UI loads from its own protocol; file: is never let through.
export const APP_SCHEME = "app";
export const APP_URL = `${APP_SCHEME}://osen/index.html`;

function sameApp(url: URL, app: URL): boolean {
  if (app.protocol === `${APP_SCHEME}:`) return url.protocol === app.protocol && url.host.toLowerCase() === app.host.toLowerCase() && segments(url) !== null;
  const wsProtocol = app.protocol === "https:" ? "wss:" : "ws:";
  return (url.protocol === app.protocol || url.protocol === wsProtocol) && url.host === app.host;
}

// App protocol address -> a file inside the UI folder; null — refusal (a 403 response without reading).
export function rendererFile(url: string, root: string): string | null {
  const u = parse(url);
  const app = parse(APP_URL);
  if (!u || !app || !sameApp(u, app)) return null;
  const path = segments(u);
  return path && path.length > 0 ? join(root, ...path) : null;
}

export function isAllowedRequest(url: string, appUrl: string): boolean {
  const u = parse(url);
  const app = parse(appUrl);
  if (!u || !app) return false;
  if (["devtools:", "data:", "blob:"].includes(u.protocol)) return true;
  return sameApp(u, app);
}

export function hardenWindow(win: BrowserWindow, deps: { appUrl: string; openExternal(url: string): void }): void {
  const app = new URL(deps.appUrl);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLink(url)) deps.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const u = parse(url);
    if (u && sameApp(u, app)) return;
    event.preventDefault();
    if (isExternalLink(url)) deps.openExternal(url);
  });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRequest(details.url, deps.appUrl) });
  });
}

export function revealWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

// Closing the window (including Cmd+Q and "Quit") with running sessions requires confirmation.
// The dialog is asynchronous: a synchronous one would stop the main process, where the session engine runs.
export function guardClose(win: BrowserWindow, deps: { running(): number; confirm(running: number): Promise<boolean> }): void {
  let allowed = false;
  let asking = false;
  win.on("close", (event) => {
    if (allowed) return;
    const n = deps.running();
    if (n === 0) return;
    event.preventDefault();
    if (asking) return;
    asking = true;
    deps.confirm(n).catch(() => false).then((close) => {
      asking = false;
      if (!close) return;
      allowed = true;
      win.close();
    });
  });
}
