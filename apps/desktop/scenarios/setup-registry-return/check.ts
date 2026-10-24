// Stand for change 233: session setup rereads the provider registry on returning from "Settings".
//   COUNCIL_DEV=1 COUNCIL_HOME=<new folder inside the project> node apps/desktop/scenarios/setup-registry-return/check.ts --seed-only
//       writes config.json (one HTTP provider "local" on a free port with no server, maxParticipants 3, two default participants "local")
//       and a material file, prints the window command
//   node apps/desktop/scenarios/setup-registry-return/check.ts --cdp <port> [--languages en,ru]
//       drives the open development window, per language:
//       A: custom topic, a file dropped into materials, 3 scripted participants; "Settings" → "Maximum participants" 2 → back:
//          topic, participants and file kept, the limit is 2, "Start" disabled with the limit hint
//       B: the same setup, "Settings" → 5 → back: "Add participant" enabled, "Start" enabled
//       C: participant 1 on "local" from the defaults (unavailable, "Start" disabled); the fake HTTP server starts on the provider port, "Settings" → back:
//          "Start" enabled; the server stops, "Settings" → back: participant 1 is marked unavailable again
//       D: config.json is broken while the setup is open, "Settings" → back: the form and the previous registry stay, the setup shows
//          "Could not read the provider registry"; "Back to templates" and a new setup: no alert; broken again, then config.json is
//          restored, "Settings" → back: the alert is gone
//       On the code before the change the limit stays 3 and "Start" stays disabled in C: the stand exits with code 1.
// Model calls: 0 (scripted participants; the fake HTTP server only answers the model list).
import { createServer } from "node:net";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const argv = process.argv.slice(2);
const arg = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1]! : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PORT = 9353;
const NOTE = "stand-note-233.md";

// ---------- seed ----------
async function seed(): Promise<void> {
  const { ensureDataDir, writeRegistry } = await import("../../../../packages/core/src/index.ts");
  const home = process.env["COUNCIL_HOME"];
  if (process.env["COUNCIL_DEV"] !== "1" || !home) {
    console.error("COUNCIL_DEV=1 and COUNCIL_HOME (a new folder) are required. Usage: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node apps/desktop/scenarios/setup-registry-return/check.ts --seed-only");
    process.exit(2);
  }
  const dir = resolve(home);
  if (existsSync(dir) && (!statSync(dir).isDirectory() || readdirSync(dir).length > 0)) {
    console.error(`COUNCIL_HOME ${dir} already exists and is not empty: the stand writes only to a new folder.`);
    process.exit(2);
  }
  // A free port with nobody listening. With no models in config.json the model list is requested from the server,
// so the provider is unavailable until the CDP run starts the fake server there.
  const port = await new Promise<number>((ok, fail) => {
    const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }).on("error", fail);
  });
  writeRegistry(ensureDataDir(dir), {
    providers: [{ id: "local", kind: "openai-http", label: "Local fake", baseUrl: `http://127.0.0.1:${port}/v1`, models: [] }],
    defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 3, materialsIgnore: [], materialsChars: 60000, participants: [{ providerId: "local", model: "fake-agree" }, { providerId: "local", model: "fake-agree" }] },
  });
  writeFileSync(join(dir, NOTE), "# Stand note\n\nA material that must survive the visit to Settings.\n");
  console.log(`Data folder prepared: ${dir} (provider "local" on 127.0.0.1:${port}, no server; maxParticipants 3; material ${NOTE})`);
  console.log(`Window: cd "${root}" && COUNCIL_DEV=1 COUNCIL_HOME="${dir}" env -u ELECTRON_RUN_AS_NODE -u COUNCIL_LANG npm run desktop -- --remoteDebuggingPort ${PORT} -- --user-data-dir="${dir}/profile"`);
  console.log(`Check: node apps/desktop/scenarios/setup-registry-return/check.ts --cdp ${PORT}`);
}

if (argv.includes("--seed-only")) {
  await seed();
  process.exit(0);
}

// ---------- CDP (as in themes/check.ts) ----------
type Cdp = { send: (method: string, params?: object) => Promise<any>; close: () => void };
async function connect(ws: string): Promise<Cdp> {
  const sock = new WebSocket(ws);
  await new Promise((ok, fail) => { sock.onopen = ok; sock.onerror = fail; });
  let id = 0;
  const wait = new Map<number, (m: any) => void>();
  sock.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (typeof m.id !== "number") return;
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

if (!argv.includes("--cdp")) { console.error("Usage: --seed-only (see the file header) or --cdp <port>"); process.exit(2); }
const { sessionSetup } = await import("../../src/shared/messages/session-setup.ts");
const { setup: setupText } = await import("../../src/shared/messages/setup.ts");
const { newDiscussion } = await import("../../src/shared/messages/new-discussion.ts");
const { startFakeServer } = await import("../../../../packages/core/src/http/fake-server.ts");
type Lang = "en" | "ru";
const languages = (arg("--languages")?.split(",") ?? ["en", "ru"]) as Lang[];
const cdp = await connect(await pageTarget(Number(arg("--cdp"))));

// Conditions and actions are fixed code; a value they need is passed as a CDP argument (callIn), never spliced into the code.
const waitFor = async (cond: string, what: string, ms = 15000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(80)) if (await evaluate(cdp, `Boolean(${cond})`).catch(() => false)) return;
  throw new Error(`timed out waiting for ${what}`);
};
const waitIn = async (what: string, fn: (...a: any[]) => unknown, ...args: unknown[]) => {
  for (const t0 = Date.now(); Date.now() - t0 < 8000; await sleep(80)) if (await callIn(cdp, fn, ...args).catch(() => false)) return;
  throw new Error(`timed out waiting for ${what}`);
};
const run = (code: string) => evaluate(cdp, `(async () => { ${code} })()`);
const rail = async (i: number, ready: string) => {
  await callIn(cdp, (n: number) => (document.querySelectorAll(".rail__item")[n] as HTMLElement).click(), i);
  await waitFor(ready, `rail item ${i}`);
};
const setLanguage = (lang: string) => callIn(cdp, (l: string) => (window as any).council.setLanguage(l).then(() => true), lang);
const addHintIs = (t: string) => document.querySelector(".setup__add .muted")?.textContent === t;
// Native value setter: React sees the change as typed input (a select gets a change event).
const setValue = (selector: string, index: number, value: string) => callIn(cdp, (sel: string, i: number, v: string) => {
  const el = document.querySelectorAll(sel)[i] as HTMLInputElement | HTMLSelectElement | undefined;
  if (!el) throw new Error(`no ${sel} #${i}`);
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, v);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}, selector, index, value);

// The first select of a participant row is its provider.
const setProvider = (i: number, id: string) => callIn(cdp, (i: number, v: string) => {
  const el = document.querySelectorAll(".setup-p")[i]?.querySelector("select");
  if (!el) throw new Error(`no participant ${i + 1}`);
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}, i, id);

// What the setup shows: the values the change must keep and the checks it must refresh.
type View = { topic: string; providers: string[]; files: string[]; start: boolean; add: boolean; addHint: string; hint: string; errors: string[] };
const view = (): Promise<View> => callIn(cdp, () => {
  const s = document.querySelector(".setup")!;
  const add = s.querySelector<HTMLButtonElement>(".setup__add .btn");
  return {
    topic: s.querySelector("textarea")!.value,
    providers: [...s.querySelectorAll(".setup-p")].map((p) => p.querySelector("select")!.value),
    files: [...s.querySelectorAll(".setup-material__name")].map((x) => x.textContent!.trim()),
    start: !s.querySelector<HTMLButtonElement>(".setup__side .btn--primary")!.disabled,
    add: Boolean(add && !add.disabled),
    addHint: s.querySelector(".setup__add .muted")?.textContent ?? "",
    hint: [...s.querySelectorAll(".setup__side .field__hint")].map((x) => x.textContent).join(" | "),
    errors: [...s.querySelectorAll(".setup-p .setup__error[data-tone=danger]")].map((x) => x.textContent!.trim()),
  };
});

let failures = 0, n = 0;
const check = (ok: boolean, what: string, got?: unknown) => {
  n++;
  if (ok) console.log(`ok ${n}: ${what}`);
  else { failures++; console.log(`✗ ${n}: ${what}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};

const settings = await evaluate(cdp, "window.council.settings()") as { configPath: string; defaults: Record<string, unknown> | null };
const dataDir = dirname(settings.configPath);
const config = JSON.parse(readFileSync(settings.configPath, "utf8")) as { providers: { id: string; baseUrl?: string }[] };
const port = Number(new URL(config.providers.find((p) => p.id === "local")!.baseUrl!).port);
const notePath = join(dataDir, NOTE);
if (!existsSync(notePath)) { console.error(`${notePath} is missing: was the folder prepared with --seed-only?`); process.exit(2); }
const originalLang = (await evaluate(cdp, "window.council.language()") as { language: Lang }).language;
const TOPIC = "Which report to prepare first — SETUP-233";

// Defaults are reset through the bridge between variants: the stand prepares state, the window checks are done through the UI.
const setMax = (max: number) => callIn(cdp, (m: number) => (window as any).council.settings().then((v: any) => (window as any).council.saveDefaults({ ...v.defaults, maxParticipants: m })).then(() => true), max);

async function freshSetup(): Promise<void> {
  await rail(1, `!document.querySelector(".setup")`); // "History" drops the kept setup
  await rail(0, `document.querySelector(".grid-cards button.card--dashed")`);
  await run(`document.querySelector(".grid-cards button.card--dashed").click()`); // "Custom topic"
  await waitFor(`document.querySelector(".setup textarea") && document.querySelectorAll(".setup-p").length === 2`, "session setup with two default participants");
  await setValue(".setup textarea", 0, TOPIC);
  // A file dropped as from Finder: a file input gives File objects with a disk path, then a drop event carries them.
  const doc = await cdp.send("DOM.getDocument");
  await evaluate(cdp, `(() => { const i = document.createElement("input"); i.type = "file"; i.id = "stand-233-file"; i.hidden = true; document.body.append(i); })()`);
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#stand-233-file" });
  await cdp.send("DOM.setFileInputFiles", { nodeId, files: [notePath] });
  await run(`const i = document.getElementById("stand-233-file"); const dt = new DataTransfer(); for (const f of i.files) dt.items.add(f); document.querySelector(".setup-materials").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt })); i.remove();`);
  await waitIn("the dropped file in materials", (name: string) => [...document.querySelectorAll(".setup-material__name")].some((x) => x.textContent!.includes(name)), NOTE);
}

async function scripted(count: number): Promise<void> {
  await setProvider(0, "scripted");
  await setProvider(1, "scripted");
  while ((await evaluate(cdp, `document.querySelectorAll(".setup-p").length`)) < count) {
    await run(`document.querySelector(".setup__add .btn").click()`);
    await sleep(100);
  }
}

// "Settings" → the "Defaults" tab → the "Maximum participants" stepper to `max` → Save → back to "New".
async function viaSettings(max: number | null): Promise<void> {
  await rail(2, `document.querySelector(".settings-tabs")`);
  if (max !== null) {
    await run(`document.querySelectorAll(".settings-tabs .tab")[1].click()`);
    await waitFor(`document.querySelectorAll(".settings-limits .stepper").length >= 2`, "defaults tab");
    for (let i = 0; i < 10; i++) {
      const v = Number(await evaluate(cdp, `[...document.querySelectorAll(".settings-limits .stepper")].at(-1).querySelector(".stepper__value").textContent`));
      if (v === max) break;
      await callIn(cdp, (step: string) => ([...document.querySelectorAll(".settings-limits .stepper")].at(-1)!.querySelector(`[data-step="${step}"]`) as HTMLElement).click(), v > max ? "-1" : "1");
      await sleep(60);
    }
    await run(`[...document.querySelectorAll("main .btn--primary")].filter((b) => b.offsetParent !== null).at(-1).click()`);
    await waitFor(`[...document.querySelectorAll("main .btn--primary")].filter((b) => b.offsetParent !== null).at(-1).disabled`, "defaults saved");
    const saved = await evaluate(cdp, "window.council.settings()") as { defaults: { maxParticipants: number } };
    check(saved.defaults.maxParticipants === max, `"Settings" saved "Maximum participants" = ${max}`, saved.defaults.maxParticipants);
  } else {
    await run(`document.querySelectorAll(".settings-tabs .tab")[0].click()`);
    await sleep(300);
  }
  await rail(0, `document.querySelector(".setup") && document.querySelector(".setup").offsetParent !== null`);
}

// The registry is reread asynchronously: wait for the expected state, then read it once.
async function after(cond: string, what: string): Promise<View> {
  await waitFor(cond, what, 8000).catch(() => {});
  return view();
}

const kept = (v: View, providers: string[], label: string) => {
  check(v.topic === TOPIC, `${label}: topic kept`, v.topic);
  check(JSON.stringify(v.providers) === JSON.stringify(providers), `${label}: participants kept`, v.providers);
  check(v.files.some((f) => f.includes(NOTE)), `${label}: file kept`, v.files);
};

let server: Awaited<ReturnType<typeof startFakeServer>> | null = null;
try {
  for (const lang of languages) {
    console.log(`--- ${lang}`);
    await setLanguage(lang);
    const t = sessionSetup(lang), s = setupText(lang);

    // A: the limit becomes 2 while 3 participants are in the setup.
    await setMax(3);
    await freshSetup();
    await scripted(3);
    let v = await view();
    check(v.start && !v.add && v.addHint === t.limitReached(3), `${lang} A before: 3 scripted participants, "Start" enabled, limit 3`, v);
    await viaSettings(2);
    await waitIn("limit 2 in the setup", addHintIs, t.limitReached(2)).catch(() => {});
    v = await view();
    kept(v, ["scripted", "scripted", "scripted"], `${lang} A`);
    check(v.addHint === t.limitReached(2), `${lang} A: the setup shows limit 2`, v.addHint);
    check(!v.start && v.hint.toLowerCase().includes(s.hintMax(2).toLowerCase()), `${lang} A: "Start" disabled with the limit hint`, { start: v.start, hint: v.hint });

    // B: the limit becomes 5.
    await setMax(3);
    await freshSetup();
    await scripted(3);
    await viaSettings(5);
    await waitIn("limit 5 in the setup", addHintIs, t.atMost(5)).catch(() => {});
    v = await view();
    kept(v, ["scripted", "scripted", "scripted"], `${lang} B`);
    check(v.add && v.addHint === t.atMost(5), `${lang} B: "Add participant" enabled, at most 5`, { add: v.add, addHint: v.addHint });
    check(v.start, `${lang} B: "Start" enabled`, v.hint);

    // C: the provider of participant 1 becomes available, then unavailable again.
    await setMax(3);
    await freshSetup();
    await setProvider(1, "scripted"); // participant 1 stays on "local" with the default model
    v = await view();
    check(!v.start && v.errors.length === 1, `${lang} C before: participant 1 on "local" is unavailable, "Start" disabled`, v);
    server = await startFakeServer({ port });
    await viaSettings(null);
    v = await after(`!document.querySelector(".setup-p .setup__error[data-tone=danger]") && !document.querySelector(".setup__side .btn--primary").disabled`, "provider available");
    kept(v, ["local", "scripted"], `${lang} C`);
    check(v.start && v.errors.length === 0, `${lang} C: the provider is available after "Settings", "Start" enabled`, v);
    await server.close();
    server = null;
    await viaSettings(null);
    v = await after(`document.querySelector(".setup-p .setup__error[data-tone=danger]")`, "provider unavailable again");
    check(!v.start && v.errors.length === 1, `${lang} C: the provider went down, participant 1 is marked, "Start" disabled`, v);

    // D: the registry cannot be read on return.
    await freshSetup();
    await scripted(3);
    const good = readFileSync(settings.configPath, "utf8");
    writeFileSync(settings.configPath, "{ broken");
    try {
      await viaSettings(null);
      const alert = await after(`document.querySelector(".setup [data-registry-error]")`, "registry error in the setup").then(() =>
        evaluate(cdp, `document.querySelector(".setup [data-registry-error] .alert__title")?.textContent ?? null`));
      v = await view();
      check(alert === newDiscussion(lang).registryFailed, `${lang} D: the setup shows "${newDiscussion(lang).registryFailed}"`, alert);
      kept(v, ["scripted", "scripted", "scripted"], `${lang} D`);
      check(v.start && v.addHint === t.limitReached(3), `${lang} D: the previous registry stays (limit 3, "Start" enabled)`, v);
    } finally {
      writeFileSync(settings.configPath, good);
    }
    // "Back to templates" and a new custom setup: the old reread error is not carried over.
    await run(`document.querySelector(".main__setup .topbar__actions .btn").click()`);
    await waitFor(`document.querySelector(".grid-cards button.card--dashed")`, "the gallery after back");
    await run(`document.querySelector(".grid-cards button.card--dashed").click()`);
    await waitFor(`document.querySelector(".setup textarea")`, "a new setup");
    check(!(await evaluate(cdp, `Boolean(document.querySelector(".setup [data-registry-error]"))`)), `${lang} D: a new setup after "Back to templates" has no reread error`);
    await setValue(".setup textarea", 0, TOPIC);
    await scripted(3);
    writeFileSync(settings.configPath, "{ broken");
    try {
      await viaSettings(null);
      await after(`document.querySelector(".setup [data-registry-error]")`, "registry error again");
    } finally {
      writeFileSync(settings.configPath, good);
    }
    await viaSettings(null);
    v = await after(`!document.querySelector(".setup [data-registry-error]")`, "registry error cleared");
    check(!(await evaluate(cdp, `Boolean(document.querySelector(".setup [data-registry-error]"))`)), `${lang} D: after config.json is fixed the alert is gone`);
  }
} catch (e) {
  failures++;
  console.log(`✗ stand error: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await server?.close().catch(() => {});
  await setMax(3).catch(() => {});
  await setLanguage(originalLang).catch(() => {});
  await rail(1, `!document.querySelector(".setup")`).catch(() => {});
  cdp.close();
}
console.log(failures ? `RESULT: ${failures} of ${n} checks failed` : `RESULT: all ${n} checks passed`);
process.exit(failures ? 1 : 0);
