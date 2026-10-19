import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AppearanceView, BridgeEvent } from "../../shared/bridge.ts";
import { applyInitialTheme, followTheme } from "./theme.ts";

const doc = () => ({ documentElement: { dataset: {} as Record<string, string | undefined> } });
const view = (theme: AppearanceView["theme"]): AppearanceView => ({ mode: "light", lightTheme: "len", theme });

describe("theme on <html>", () => {
  it("applyInitialTheme sets the preload theme and falls back to osen", () => {
    const d = doc();
    applyInitialTheme(d, { theme: "pergament" });
    expect(d.documentElement.dataset["theme"]).toBe("pergament");
    applyInitialTheme(d, undefined);
    expect(d.documentElement.dataset["theme"]).toBe("osen");
  });

  it("followTheme: the appearance reply overrides, appearance events update, other events are ignored", async () => {
    const d = doc();
    applyInitialTheme(d, { theme: "osen" });
    let listener: (e: BridgeEvent) => void = () => {};
    followTheme(d, { appearance: () => Promise.resolve(view("len")), subscribe: vi.fn((l) => { listener = l; return () => {}; }) } as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(d.documentElement.dataset["theme"]).toBe("len");
    listener({ type: "appearance", view: view("inei") });
    expect(d.documentElement.dataset["theme"]).toBe("inei");
    listener({ type: "error", message: "x" });
    expect(d.documentElement.dataset["theme"]).toBe("inei");
  });

  it("followTheme survives a failing appearance()", async () => {
    const d = doc();
    applyInitialTheme(d, { theme: "tuman" });
    followTheme(d, { appearance: () => Promise.reject(new Error("x")), subscribe: () => () => {} } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(d.documentElement.dataset["theme"]).toBe("tuman");
  });

  it("main.tsx applies the initial theme before createRoot", () => {
    const src = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    const apply = src.indexOf("applyInitialTheme(document");
    expect(apply).toBeGreaterThan(-1);
    expect(apply).toBeLessThan(src.indexOf("createRoot("));
  });
});
