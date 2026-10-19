import type { Bridge, ThemeId } from "../../shared/bridge.ts";

type Doc = { documentElement: { dataset: Record<string, string | undefined> } };

// Runs before the first render: the theme the window was created with (from preload).
export function applyInitialTheme(doc: Doc, initial: { theme: ThemeId } | undefined): void {
  doc.documentElement.dataset["theme"] = initial?.theme ?? "osen";
}

// A reload keeps the creation-time argument, so the current theme is asked once; later changes arrive as events.
export function followTheme(doc: Doc, council: Pick<Bridge, "appearance" | "subscribe">): void {
  const set = (theme: ThemeId) => void (doc.documentElement.dataset["theme"] = theme);
  council.appearance().then((v) => set(v.theme)).catch(() => {});
  council.subscribe((e) => {
    if (e.type === "appearance") set(e.view.theme);
  });
}
