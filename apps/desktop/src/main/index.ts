import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, join } from "node:path";
import {
  CLI_AGENTS, DataDirError, createLogger, ensureDataDir, ensureRegistry, envFilePath, inspectProviders, loadEnv, locateCli, isValidSessionId, loadTemplates, logRegistryLoaded, readRegistry, readSession,
  applyProcessLanguage, OwnerReleaseRejectedError, OwnerSelectionRejectedError, readUsageSummary, requestOwnerMessage, setPdfExtractorRuntime, requestOwnerRelease, requestStop, selectOwnerVersion, prepareDataDir, userTemplatesDir, builtinTemplateIds, watchSession,
} from "@model-council/core";
import { readFile, writeFile } from "node:fs/promises";
import { app, BrowserWindow, nativeTheme, clipboard, dialog, ipcMain, Notification, protocol, shell } from "electron";
import { CALL_CHANNEL, EVENT_CHANNEL } from "../shared/bridge.ts";
import type { BridgeEvent } from "../shared/bridge.ts";
import { createBridge } from "./bridge.ts";
import { createConnections } from "./connections.ts";
import { headlessBinPath } from "./headless-paths.ts";
import { closeWarningText, createLanguageState } from "./language.ts";
import { createAppearanceState } from "./appearance.ts";
import { shell as shellMessages } from "../shared/messages/shell.ts";
import { launch as launchMessages } from "../shared/messages/launch.ts";
import { exportSession } from "./export.ts";
import { attentionEvent, createAttentionNotifier } from "./attention-notify.ts";
import type { FinishNotifierDeps } from "./finish-notify.ts";
import { createFinishNotifier } from "./finish-notify.ts";
import { historyRead, startHistoryPolling, unreadableJournalLog } from "./history.ts";
import { createLauncher } from "./launcher.ts";
import { sessionDrafts } from "./drafts.ts";
import { createMaterialsDraft } from "./materials.ts";
import { standTransport } from "./url-stand.ts";
import { previewMaterials } from "./materials-preview.ts";
import { prepareRerun } from "./rerun.ts";
import { sessionMarkdown } from "./markdown.ts";
import { resumeScenarioPath, resumeView } from "./resume.ts";
import { onceReporter, readPins, setPinned } from "./pins.ts";
import { createCliTransition } from "./cli-transition.ts";
import { standCandidateDeps } from "./cli-stand.ts";
import { npmReleases, npmSource } from "../../../../packages/core/src/cli-agents/npm-source.ts";
import { createSettings } from "./settings.ts";
import { createTemplateEditor } from "./template-editor.ts";
import { lineupsView, saveLineupInput } from "./lineups.ts";
import { lastRoster, listScenarios, registryView, scenarioPath, templatesView } from "./setup-data.ts";
import { profileDir, resourceDirs } from "./paths.ts";
import { logAppQuit, logMissingClis, logProviders } from "./startup-log.ts";
import { APP_SCHEME, APP_URL, DEV_ICON, guardClose, hardenWindow, rendererFile, revealWindow, windowOptions } from "./window.ts";

// npm runs the script from the package folder; a relative COUNCIL_HOME and .env are taken from the folder where the command was typed
if (process.env["INIT_CWD"]) process.chdir(process.env["INIT_CWD"]);

let win: BrowserWindow | null = null;

// before ready and before the lock: the single-instance lock lives in the profile
const profile = profileDir(app.commandLine.hasSwitch("user-data-dir"), app.isPackaged, app.getPath("appData"));
if (profile) app.setPath("userData", profile);

// before ready: the scheme of the built UI
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json",
};

// readFile, not net.fetch(file:): file: is closed in the window, and a main request would pass the same onBeforeRequest
function serveRenderer(root: string) {
  return async (req: Request): Promise<Response> => {
    const file = rendererFile(req.url, root);
    if (!file) return new Response(null, { status: 403 });
    try {
      return new Response(new Uint8Array(await readFile(file)), { headers: { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream" } });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) revealWindow(win);
  });
  app.on("window-all-closed", () => app.quit());
  void app.whenReady().then(start).catch((e: unknown) => {
    dialog.showErrorBox(shellMessages().appName, e instanceof Error ? e.message : String(e));
    app.quit();
  });
}

async function start(): Promise<void> {
  // Electron as Node runs PDF text extraction; the script lies unpacked next to the asar
  const htmlWorker = join(import.meta.dirname, "html-worker.mjs").replace("app.asar", "app.asar.unpacked");
  setPdfExtractorRuntime({ script: join(import.meta.dirname, "pdf-extract.mjs").replace("app.asar", "app.asar.unpacked"), env: { ELECTRON_RUN_AS_NODE: "1" } });
  const env = loadEnv(process.env, process.cwd());
  applyProcessLanguage(env); // the data folder may not exist yet: language from the variable, the file or the default
  let dataDir: string;
  try {
    dataDir = ensureDataDir(prepareDataDir(env));
  } catch (e) {
    if (!(e instanceof DataDirError)) throw e;
    dialog.showErrorBox(shellMessages().appName, e.message);
    app.quit();
    return;
  }
  const logger = createLogger(dataDir, "desktop", env);
  const language = createLanguageState({ env, dataDir, send: (event) => send(event), logger });
  // main follows its own appearance events: the native theme source and the window background change in one place
  const appearance = createAppearanceState({
    dataDir,
    systemDark: () => nativeTheme.shouldUseDarkColors,
    applyMode: (mode) => void (nativeTheme.themeSource = mode),
    send: (event) => {
      if (win && !win.isDestroyed()) win.setBackgroundColor(appearance.background());
      send(event);
    },
    logger,
  });
  nativeTheme.on("updated", () => appearance.systemChanged());
  const loggedUsageSkips = new Set<string>();
  const loggedTariffWarnings = new Set<string>();
  // its own handler disables the Electron error window, so we show the window ourselves; the app is not closed — a session may be running in it
  process.on("uncaughtException", (e) => {
    logger.error("Unhandled error in the main process", e);
    dialog.showErrorBox(shellMessages().appName, e instanceof Error ? e.message : String(e));
  });
  process.on("unhandledRejection", (e) => logger.error("Unhandled rejection in the main process", e));
  logger.info(`App start ${app.getVersion()} (${app.isPackaged ? "build" : "development"}), data folder: ${dataDir}`);

  const notices: string[] = [];
  try {
    await ensureRegistry(dataDir, { env });
    const found = readRegistry(dataDir);
    logRegistryLoaded(logger, dataDir, found);
    void inspectProviders(found, { env, keyFile: envFilePath(dataDir), withModels: false, dataDir }).then(
      (r) => logProviders(logger, r.map((f) => f.status)),
      (e: unknown) => logger.error("Provider inspection at startup failed", e),
    );
    const inRegistry = new Set(found.providers.flatMap((p) => (p.kind === "cli" ? [p.agent] : [])));
    void Promise.all(CLI_AGENTS.filter((a) => !inRegistry.has(a)).map((a) => locateCli(a, { env, dataDir }))).then(
      (l) => logMissingClis(logger, l),
      (e: unknown) => logger.error("Provider inspection at startup failed", e),
    );
  } catch (e) {
    notices.push(e instanceof Error ? e.message : String(e));
    logger.error("Registry error", e);
  }

  const { builtinDir, scenariosDir } = resourceDirs({
    packaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, dev: env["COUNCIL_DEV"] === "1",
  });
  const catalog = () => loadTemplates({ builtinDir, userDir: userTemplatesDir(dataDir) });
  const templateTitles = new Map<string, string>();
  const fillTitles = (c: ReturnType<typeof catalog>) => {
    templateTitles.clear();
    for (const t of c.templates) templateTitles.set(t.id, t.title);
  };
  try {
    fillTitles(catalog());
  } catch (e) {
    logger.error("Templates not loaded", e);
  }

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!devUrl) protocol.handle(APP_SCHEME, serveRenderer(join(import.meta.dirname, "../renderer")));
  const appUrl = devUrl ?? APP_URL;
  if (!app.isPackaged) app.dock?.setIcon(DEV_ICON);
  const window = (win = new BrowserWindow(windowOptions(join(import.meta.dirname, "../preload/index.cjs"), app.isPackaged, appearance.view().theme)));

  window.webContents.on("render-process-gone", (_e, details) => logger.error(`Window process gone: ${details.reason}`));

  const send = (event: BridgeEvent) => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(EVENT_CHANNEL, event);
  };
  const urlStand = env["COUNCIL_DEV"] === "1" ? env["COUNCIL_URL_STAND"] : undefined;
  if (urlStand) logger.info("Material links go through the stand transport (COUNCIL_DEV)");
  const materials = createMaterialsDraft({
    logger,
    ...(urlStand && { transport: standTransport(urlStand) }),
    worker: htmlWorker,
    limits: () => {
      const { materialsChars, materialsIgnore } = readRegistry(dataDir).defaults;
      return { materialsChars, materialsIgnore };
    },
  });
  const launcher = createLauncher({ dataDir, env, logger, materials, registry: () => readRegistry(dataDir), catalog, scenarioPath: (model) => scenarioPath(scenariosDir, model),
    onChunk: (id, c) => bridge.chunk(id, c), onEnded: (id) => bridge.ended(id),
  });
  const reloadEnv = () => {
    const next = loadEnv(process.env, process.cwd());
    for (const k of Object.keys(env)) delete env[k];
    Object.assign(env, next);
  };
  const reportPinsError = onceReporter((message) => {
    logger.error(message);
    send({ type: "error", message });
  });
  // a notice about a corrupted preferences.json goes the same way as for pins: an error event once and notices() for a late renderer
  const reportLanguageNotice = onceReporter((message) => {
    logger.error(message);
    send({ type: "error", message });
  });
  const logUnreadable = unreadableJournalLog(logger);
  const readHistory = () => {
    const pins = readPins(dataDir);
    reportPinsError(pins.error);
    reportLanguageNotice(language.invalidNotice());
    try {
      fillTitles(catalog()); // titles from the catalog of the current language: the language may have changed in "Settings"
    } catch {
      // the catalog cannot be read — the previous titles remain
    }
    return historyRead(dataDir, templateTitles, new Set(pins.ids), logUnreadable);
  };
  const history = () => readHistory().items;
  const cliStand = env["COUNCIL_DEV"] === "1" ? env["COUNCIL_CLI_STAND"] : undefined;
  if (cliStand) logger.info("CLI candidate checks go through the stand seam (COUNCIL_DEV)");
  const transition = createCliTransition({
    dataDir, logger, env, osenVersion: app.getVersion(),
    running: () => history().some((s) => s.status === "running"),
    onChecked: () => send({ type: "cli-transition" }),
    candidateDeps: () => (cliStand ? standCandidateDeps(cliStand) : { releases: npmReleases(env), source: npmSource(env) }),
  });
  const settings = createSettings({ dataDir, env, reloadEnv, logger, transition });
  const templateDirs = () => ({ builtinDir, userDir: userTemplatesDir(dataDir) });
  const inspected = async () => {
    const reg = readRegistry(dataDir);
    const found = await inspectProviders(reg, { env, keyFile: envFilePath(dataDir), dataDir });
    return { reg, statuses: found.map((f) => f.status) };
  };
  // Packaged: the wrappers inside Osen.app, null when missing. Development: the server from the repo with an absolute node
  // (a client may have no node in its PATH); the council link exists only when the dev stand provides a fake wrapper.
  const packagedBin = (name: "osen-mcp" | "council") => headlessBinPath(name, { packaged: true, resourcesPath: process.resourcesPath });
  const absoluteNode = (): string => {
    for (const d of (env["PATH"] ?? "").split(delimiter)) {
      try { accessSync(join(d, "node"), constants.X_OK); return join(d, "node"); } catch { /* next */ }
    }
    return "node";
  };
  const serverBin = app.isPackaged ? packagedBin("osen-mcp") : null;
  const connections = createConnections({
    home: homedir(),
    env,
    logger,
    language: () => language.view().language,
    serverCommand: app.isPackaged
      ? (serverBin ? { command: serverBin, args: [] } : null)
      : { command: absoluteNode(), args: [join(app.getAppPath(), "../../packages/mcp/src/main.ts")] },
    councilWrapper: app.isPackaged ? packagedBin("council") : env["COUNCIL_DEV"] === "1" ? env["COUNCIL_COMMAND_WRAPPER"] ?? null : null,
  });
  const bridge = createBridge({
    language,
    appearance,
    connections,
    settings,
    templates: createTemplateEditor({ dirs: templateDirs, logger, sessionFraming: (id) => (isValidSessionId(id) ? readSession(dataDir, id)?.state.session?.framing ?? null : null) }),
    materials,
    pickMaterials: async (kind) => {
      const d = await dialog.showOpenDialog(window, { properties: kind === "files" ? ["openFile", "multiSelections"] : ["openDirectory"] });
      return d.canceled ? null : d.filePaths;
    },
    listSessions: history,
    previewMaterials: (refresh) => previewMaterials({ dataDir, logger, materials }, refresh),
    prepareRerun: (id, withDecision) => prepareRerun({ dataDir, catalog, materials }, id, withDecision),
    sessionExists: (id) => readSession(dataDir, id) !== null,
    sessionDrafts: (id) => {
      const views = sessionDrafts(dataDir, id);
      for (const v of views) if (v.text === null) logger.info(`Draft ${v.draftId} of session ${id} not shown: ${v.error ?? "no reason given"}`);
      return views;
    },
    usageSummary: (from, to) => {
      const summary = readUsageSummary(dataDir, from, to, (skip) => {
        const key = `${skip.id}:${skip.kind}`;
        if (loggedUsageSkips.has(key)) return;
        loggedUsageSkips.add(key);
        logger.info(skip.kind === "unreadable"
          ? `Usage summary: journal of session ${skip.id} not read and not counted: ${skip.reason}`
          : `Usage summary: journal of session ${skip.id} read partially, the beginning counted: ${skip.reason}`);
      });
      for (const w of summary.tariffs.warnings) {
        if (loggedTariffWarnings.has(w)) continue;
        loggedTariffWarnings.add(w);
        logger.info(`Usage summary: tariffs: ${w}`);
      }
      return summary;
    },
    watchSession: (id, onEvent) => watchSession(dataDir, id, (event) => onEvent(event), {}),
    // a pin read error at startup goes out as an event before the renderer subscribed, so it is here too
    notices: () => {
      const extra = [readPins(dataDir).error, language.invalidNotice()].filter((x): x is string => x !== null);
      return [...notices, ...extra];
    },
    listTemplates: () => {
      const c = catalog();
      fillTitles(c);
      return templatesView(c, builtinTemplateIds(templateDirs()));
    },
    registry: async () => {
      const { reg, statuses } = await inspected();
      return registryView(reg, statuses, scenariosDir === null ? null : listScenarios(scenariosDir));
    },
    lineups: async () => {
      const { reg, statuses } = await inspected();
      return lineupsView(dataDir, reg, statuses, scenariosDir === null ? null : (model) => (scenarioPath(scenariosDir, model) === null ? launchMessages().scenarioUnavailable(model) : null));
    },
    saveLineup: (input) => saveLineupInput(dataDir, input),
    startSession: async (input) => {
      const started = await launcher.start(input);
      notifier.markRunning(started.id);
      polling.refresh();
      return started;
    },
    lastParticipants: () => lastRoster(dataDir),
    resumeOptions: async (id, replacements, message) => {
      const reg = readRegistry(dataDir);
      const found = await inspectProviders(reg, { env, keyFile: envFilePath(dataDir), dataDir });
      const view = registryView(reg, found.map((f) => f.status), scenariosDir === null ? null : listScenarios(scenariosDir));
      return resumeView(dataDir, id, view, resumeScenarioPath((model) => scenarioPath(scenariosDir, model)), replacements, message);
    },
    resumeSession: async (id, rounds, cap, replacements, message) => {
      const resumed = await launcher.resume(id, rounds, cap, replacements, message);
      notifier.markRunning(id);
      polling.refresh();
      return resumed;
    },
    stopSession: (id) => {
      logger.info(`Stop requested for session ${id}`);
      requestStop(dataDir, id);
    },
    acceptVersion: (id, version, note) => {
      try {
        const selected = selectOwnerVersion(dataDir, id, { version, note });
        logger.info(`Owner selection: session ${id}, version ${version}`);
        return selected;
      } catch (e) {
        if (e instanceof OwnerSelectionRejectedError) logger.info(`Owner selection rejected: session ${id}, version ${version}, reason ${e.reason}`);
        throw e;
      }
    },
    sendOwnerMessage: (id, text, answerTo) => requestOwnerMessage(dataDir, id, text, answerTo === undefined ? {} : { questionId: answerTo }),
    continueWait: (id, waitId) => {
      try {
        const { requestId } = requestOwnerRelease(dataDir, id, { waitId });
        logger.info(`Wait release request: session ${id}, wait ${waitId}`);
        return { requestId };
      } catch (e) {
        if (e instanceof OwnerReleaseRejectedError) logger.info(`Wait release request rejected: session ${id}, wait ${waitId}, reason ${e.reason}`);
        throw e;
      }
    },
    copyText: (text) => clipboard.writeText(text),
    exportSession: async (id) => {
      const r = await exportSession(id, {
        read: (i) => readSession(dataDir, i),
        render: (s, i) => sessionMarkdown(s.state, s.status, undefined, s.partial, sessionDrafts(dataDir, i)),
        pickPath: async (name) => {
          const d = await dialog.showSaveDialog(window, { defaultPath: name, filters: [{ name: "Markdown", extensions: ["md"] }] });
          return d.canceled || !d.filePath ? null : d.filePath;
        },
        write: (p, t) => writeFile(p, t, "utf8"),
      });
      if (r) logger.info(`Session ${id} exported: ${r.path}`);
      return r;
    },
    setPinned: (id, pinned) => {
      setPinned(dataDir, id, pinned);
      logger.info(`Pinning of session ${id}: ${pinned ? "pinned" : "unpinned"}`);
      polling.refresh();
    },
    send,
    logger,
  });
  ipcMain.handle(CALL_CHANNEL, (event, action: unknown, args: unknown) => {
    if (event.sender !== window.webContents) {
      logger.error(`Bridge call from a foreign sender rejected: ${event.senderFrame?.url ?? "?"}`);
      return { ok: false, error: shellMessages().callRejected };
    }
    return bridge.call(action, args);
  });
  // ponytail: references are held until the click — one object per finished session per launch; prune on close if a click from the notification center works without a reference
  const shown = new Set<Notification>();
  const showSystem: FinishNotifierDeps["show"] = (text, on) => {
    const n = new Notification({ title: text.title, body: text.body });
    shown.add(n);
    n.on("show", () => on.shown());
    n.on("click", () => {
      shown.delete(n);
      on.click();
    });
    n.on("failed", (_e, error) => {
      shown.delete(n);
      on.failed(error);
    });
    n.show();
  };
  const notifier = createFinishNotifier({
    isSupported: () => Notification.isSupported(),
    show: showSystem,
    focused: () => !window.isDestroyed() && window.isFocused(),
    openId: () => bridge.openId(),
    activate: (id) => {
      if (window.isDestroyed()) return;
      revealWindow(window);
      send({ type: "open-result", id });
    },
    logger,
  });
  const attention = createAttentionNotifier({
    isSupported: () => Notification.isSupported(),
    show: showSystem,
    focused: () => !window.isDestroyed() && window.isFocused(),
    openId: () => bridge.openId(),
    activate: (id) => {
      if (window.isDestroyed()) return;
      revealWindow(window);
      send(attentionEvent(id, readSession(dataDir, id)?.status));
    },
    logger,
  });
  const polling = startHistoryPolling({
    read: () => {
      const { items, attention: snapshots } = readHistory();
      notifier.observe(items);
      attention.observe(snapshots);
      return items;
    },
    emit: (sessions) => send({ type: "sessions", sessions }),
    onError: (e) => {
      logger.error("History poll failed", e);
      send({ type: "error", message: e instanceof Error ? e.message : String(e) });
    },
  });
  window.on("focus", polling.refresh);
  guardClose(window, {
    running: () => launcher.running().length,
    confirm: async (n) => {
      const text = closeWarningText(n);
      logger.info(`Window close during a running session: warning shown, sessions: ${n}`);
      const { response } = await dialog.showMessageBox(window, { type: "warning", buttons: text.buttons, defaultId: 0, cancelId: 0, message: text.message, detail: text.detail });
      const close = response === 1;
      logger.info(close ? `Window close during a running session: confirmed, sessions interrupted: ${n}` : "Window close during a running session: the owner stayed");
      return close;
    },
  });
  void transition.maybeCheck();
  const transitionTimer = setInterval(() => void transition.maybeCheck(), 3_600_000);
  // will-quit (windows already closed, quit is certain) is deferred once so a running candidate check can stop and remove its install prefix (at most 5 s).
  let transitionStopped = false;
  app.on("will-quit", (event) => {
    if (transitionStopped) return;
    event.preventDefault();
    void transition.stop().finally(() => {
      transitionStopped = true;
      setImmediate(() => app.quit()); // after the cancelled will-quit has fully returned: a quit inside it is ignored
    });
  });
  app.on("will-quit", () => {
    if (!transitionStopped) return; // the deferred pass: cleanup runs on the repeated quit
    clearInterval(transitionTimer);
    polling.stop();
    bridge.dispose();
    logAppQuit(logger);
  });

  hardenWindow(window, { appUrl, openExternal: (url) => void shell.openExternal(url) });
  window.once("ready-to-show", () => window.show());
  void window.loadURL(appUrl);
}
