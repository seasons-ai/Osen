import { contextBridge, ipcRenderer, webUtils } from "electron";
import { BRIDGE_ACTIONS, CALL_CHANNEL, EVENT_CHANNEL } from "../shared/bridge.ts";
import type { Bridge, BridgeEvent } from "../shared/bridge.ts";
import { themeFromArgv } from "../shared/theme-arg.ts";
import { droppedPaths } from "./dropped.ts";

type Result = { ok: true; value: unknown } | { ok: false; error: string };

const call = async (action: string, args: unknown[]): Promise<unknown> => {
  const r = (await ipcRenderer.invoke(CALL_CHANNEL, action, args)) as Result;
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const bridge = {
  ...Object.fromEntries(BRIDGE_ACTIONS.map((a) => [a, (...args: unknown[]) => call(a, args)])),
  attachDropped: (files: readonly File[]) => call("attachMaterials", [droppedPaths(files, (f) => webUtils.getPathForFile(f))]),
  subscribe(listener: (event: BridgeEvent) => void) {
    const handler = (_: unknown, event: BridgeEvent) => listener(event);
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => void ipcRenderer.removeListener(EVENT_CHANNEL, handler);
  },
} as Bridge;

contextBridge.exposeInMainWorld("council", bridge);
contextBridge.exposeInMainWorld("osenInitial", { theme: themeFromArgv(process.argv) });
