import { useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { LANGUAGES, LANGUAGE_NAMES } from "@model-council/core/i18n";
import type { Language } from "@model-council/core/i18n";
import { shell } from "../../shared/messages/shell.ts";
import { Icon } from "./icons.tsx";
import { useLanguageView, useMessages } from "./language.tsx";

const FORWARD = ["ArrowRight", "ArrowDown"];
const BACK = ["ArrowLeft", "ArrowUp"];

// Next option by an arrow key, cycling; other keys — null.
export function nextLanguage(current: Language, key: string): Language | null {
  const step = FORWARD.includes(key) ? 1 : BACK.includes(key) ? -1 : 0;
  if (step === 0) return null;
  const i = LANGUAGES.indexOf(current);
  return LANGUAGES[(i + step + LANGUAGES.length) % LANGUAGES.length]!;
}

export function LanguagePanel(): ReactNode {
  const view = useLanguageView();
  const t = useMessages(shell);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refs = useRef<Partial<Record<Language, HTMLButtonElement | null>>>({});
  if (view === null) return null;

  const choose = (language: Language) => {
    if (busy || view.locked || language === view.language) return;
    setBusy(true);
    window.council.setLanguage(language).then(
      () => setError(null),
      (e) => setError(e instanceof Error ? e.message : String(e)),
    ).finally(() => setBusy(false));
  };
  const onKey = (language: Language, e: KeyboardEvent) => {
    const next = nextLanguage(language, e.key);
    if (next === null) return;
    e.preventDefault();
    refs.current[next]?.focus();
  };

  return (
    <>
      {error !== null && (
        <div className="settings-banner">
          <div className="alert" data-tone="danger" role="alert">
            <Icon name="i-alert" />
            <div><div className="alert__title">{error}</div></div>
          </div>
        </div>
      )}
      <section className="card settings-lang" aria-labelledby="settings-lang-title">
        <h2 className="card__title" id="settings-lang-title">{t.languageHeading}</h2>
        <div className="settings-lang__group" role="radiogroup" aria-label={t.languageGroupLabel}>
          {LANGUAGES.map((language) => {
            const current = language === view.language;
            return (
              <button
                key={language} type="button" role="radio" className="settings-lang__opt"
                ref={(el) => { refs.current[language] = el; }}
                // options are not disabled during the request: keyboard focus would be left without an element; a repeat is cut off by choose
                aria-checked={current} aria-disabled={view.locked || undefined} disabled={view.locked}
                tabIndex={current ? 0 : -1}
                onClick={() => choose(language)} onKeyDown={(e) => onKey(language, e)}
              >
                <span className="settings-lang__name">{LANGUAGE_NAMES[language]}</span>
                {current && <span className="settings-lang__now"><Icon name="i-check" size="sm" /> {t.languageCurrent}</span>}
              </button>
            );
          })}
        </div>
        {view.locked ? (
          <p className="muted settings-lang__hint settings-lang__env"><Icon name="i-info" size="sm" /> {t.languageLockedHint}</p>
        ) : (
          <p className="muted settings-lang__hint">{t.languageHint}</p>
        )}
      </section>
    </>
  );
}
