import type { ThemeId } from "./bridge.ts";

// Shared by main (window arguments) and preload (reads process.argv): no Node or electron imports.
export const THEME_ARG = "--osen-theme=";

const THEMES: readonly ThemeId[] = ["osen", "tuman", "len", "inei", "pergament"];

export function themeFromArgv(argv: readonly string[]): ThemeId {
  const raw = argv.find((a) => a.startsWith(THEME_ARG))?.slice(THEME_ARG.length);
  return THEMES.find((t) => t === raw) ?? "osen";
}
