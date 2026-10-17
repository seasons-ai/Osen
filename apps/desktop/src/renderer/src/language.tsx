import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { getProcessLanguage, setProcessLanguage } from "@model-council/core/i18n";
import type { Language } from "@model-council/core/i18n";
import type { LanguageView } from "../../shared/bridge.ts";
import { shell } from "../../shared/messages/shell.ts";

// null — no provider (tests and stands without one): the language is taken from the process.
const LanguageContext = createContext<LanguageView | null>(null);

export const useLanguageView = (): LanguageView | null => useContext(LanguageContext);

// The effective language for helper functions (nameOf, chars, formatWhen): the same as in useMessages.
export const useLanguage = (): Language => useContext(LanguageContext)?.language ?? getProcessLanguage();

export function useMessages<T>(catalog: (language?: Language) => T): T {
  const view = useContext(LanguageContext);
  return catalog(view?.language ?? getProcessLanguage());
}

// Applying the view outside React: process language, lang and the window title.
export function applyLanguageView(view: LanguageView, doc: { documentElement: { lang: string }; title: string }): void {
  setProcessLanguage(view.language);
  doc.documentElement.lang = view.language;
  doc.title = shell(view.language).appName;
}

export function LanguageProvider({ initial, onError, children }: { initial?: LanguageView; onError?(e: unknown): void; children: ReactNode }): ReactNode {
  const [view, setView] = useState<LanguageView | null>(initial ?? null);
  const [ready, setReady] = useState(initial !== undefined);

  useEffect(() => {
    const set = (next: LanguageView) => { applyLanguageView(next, document); setView(next); };
    const off = window.council.subscribe((event) => { if (event.type === "language") set(event.view); });
    window.council.language().then(set, (e) => onError?.(e)).finally(() => setReady(true));
    return off;
  }, []);

  // Until the bridge replies there are no children: an owner with ru does not see an en flash. If the call fails — the default language.
  return ready ? <LanguageContext.Provider value={view}>{children}</LanguageContext.Provider> : null;
}
