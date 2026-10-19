import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { shell } from "../../shared/messages/shell.ts";
import type { AppearanceView, Bridge, LightTheme, ThemeId, ThemeMode } from "../../shared/bridge.ts";
import { Icon } from "./icons.tsx";
import { nextOption } from "./LanguagePanel.tsx";
import { useMessages } from "./language.tsx";

type Input = Parameters<Bridge["setAppearance"]>[0];
type T = ReturnType<typeof shell>;

// Options and their strings are data: the order of the mockup, catalog keys per id.
export const MODES = ["dark", "light", "system"] as const satisfies readonly ThemeMode[];
export const LIGHT_THEMES = ["tuman", "len", "inei", "pergament"] as const satisfies readonly LightTheme[];
const MODE_KEYS = { dark: ["appearanceModeDark", "appearanceHintDark"], light: ["appearanceModeLight", "appearanceHintLight"], system: ["appearanceModeSystem", "appearanceHintSystem"] } as const satisfies Record<ThemeMode, readonly (keyof T)[]>;
const THEME_KEYS = {
  osen: ["themeOsen"], tuman: ["themeTuman", "themeTumanDesc"], len: ["themeLen", "themeLenDesc"],
  inei: ["themeInei", "themeIneiDesc"], pergament: ["themePergament", "themePergamentDesc"],
} as const satisfies Record<ThemeId, readonly (keyof T)[]>;
const CHIPS = [["leaf", "previewRunning"], ["rain", "previewAgrees"], ["danger", "previewNo"]] as const;

/** What a click on a light card sends: in the dark mode the card also switches the mode, otherwise the mode stays. */
export const themeChoice = (view: AppearanceView, lightTheme: LightTheme): Input =>
  view.mode === "dark" ? { mode: "light", lightTheme } : { lightTheme };

/** The view comes from the main process (reply and event); the panel never guesses it. */
export function followAppearance(council: Pick<Bridge, "appearance" | "subscribe">, set: (view: AppearanceView) => void): () => void {
  const off = council.subscribe((e) => { if (e.type === "appearance") set(e.view); });
  council.appearance().then(set, () => {});
  return off;
}

const str = (t: T, key: keyof T): string => t[key] as string;

function Preview({ id, t }: { id: LightTheme; t: T }): ReactNode {
  return (
    <span className="theme-prev" data-theme={id} aria-hidden="true">
      <span className="theme-prev__rail"><span className="theme-prev__dot"></span></span>
      <span className="theme-prev__main">
        <span className="theme-prev__title"></span>
        <span className="theme-prev__card">
          {CHIPS.map(([tone, key]) => <span key={tone} className="theme-prev__chip" data-tone={tone}>{str(t, key)}</span>)}
        </span>
        <span className="theme-prev__row"><span className="theme-prev__btn">{t.previewStart}</span><span className="theme-prev__line"></span></span>
      </span>
    </span>
  );
}

export function AppearanceSection({ view, error, onChoose }: { view: AppearanceView; error: string | null; onChoose(input: Input): void }): ReactNode {
  const t = useMessages(shell);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = <K extends string>(options: readonly K[], current: K, e: KeyboardEvent) => {
    const next = nextOption(options, current, e.key);
    if (next === null) return;
    e.preventDefault();
    refs.current[next]?.focus();
  };
  const modeHint = MODE_KEYS[view.mode][1];

  return (
    <section className="card appearance" aria-labelledby="appearance-title">
      <div className="appearance__head">
        <h2 className="appearance__title" id="appearance-title">{t.appearanceHeading}</h2>
        <span className="appearance__now">{t.appearanceNow} <span className="mono">{str(t, THEME_KEYS[view.theme][0])}</span></span>
      </div>
      {error !== null && (
        <div className="alert" data-tone="danger" role="alert">
          <Icon name="i-alert" />
          <div><div className="alert__title">{error}</div></div>
        </div>
      )}
      <div className="appearance__group">
        <span className="appearance__label" id="appearance-mode-label">{t.appearanceModeLabel}</span>
        <div className="appearance__modes" role="radiogroup" aria-labelledby="appearance-mode-label">
          {MODES.map((mode) => {
            const on = mode === view.mode;
            return (
              <button
                key={mode} type="button" role="radio" className="seg" aria-checked={on} tabIndex={on ? 0 : -1}
                ref={(el) => { refs.current[mode] = el; }}
                onClick={() => onChoose({ mode })} onKeyDown={(e) => onKey(MODES, mode, e)}
              >{str(t, MODE_KEYS[mode][0])}</button>
            );
          })}
        </div>
        <span className="appearance__hint">{str(t, modeHint)}</span>
      </div>
      <div className="appearance__group">
        <span className="appearance__label" id="appearance-theme-label">{t.appearanceThemeLabel}</span>
        <div className="theme-grid" role="radiogroup" aria-labelledby="appearance-theme-label">
          {LIGHT_THEMES.map((id) => {
            const on = id === view.lightTheme;
            const [name, desc] = THEME_KEYS[id];
            return (
              <button
                key={id} type="button" role="radio" className="theme-card" aria-checked={on} tabIndex={on ? 0 : -1}
                ref={(el) => { refs.current[id] = el; }}
                onClick={() => onChoose(themeChoice(view, id))} onKeyDown={(e) => onKey(LIGHT_THEMES, id, e)}
              >
                <Preview id={id} t={t} />
                <span className="theme-card__body">
                  <span className="theme-card__head"><span className="theme-card__name">{str(t, name)}</span><span className="theme-card__check">{t.appearanceSelected}</span></span>
                  <span className="theme-card__desc">{str(t, desc)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function AppearancePanel(): ReactNode {
  const [view, setView] = useState<AppearanceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  useEffect(() => followAppearance(window.council, setView), []);
  if (view === null) return null;

  // Marks follow the view returned by the main process, not the click: a refusal leaves them on the previous choice.
  const choose = (input: Input) => {
    if (busy.current) return;
    busy.current = true;
    window.council.setAppearance(input).then(
      (next) => { setView(next); setError(null); },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    ).finally(() => { busy.current = false; });
  };
  return <AppearanceSection view={view} error={error} onChoose={choose} />;
}
