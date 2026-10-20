import { useEffect, useReducer } from "react";
import type { Dispatch, ReactNode } from "react";
import { Icon, IconSprite } from "./icons.tsx";
import type { IconName } from "./icons.tsx";
import { LanguageProvider, useLanguageView } from "./language.tsx";
import type { Language } from "@model-council/core/i18n";
import { shell } from "../../shared/messages/shell.ts";
import { History } from "./History.tsx";
import { NewFlow } from "./NewFlow.tsx";
import { Settings } from "./Settings.tsx";
import { SessionScreen } from "./SessionScreen.tsx";
import { initialUi, pendingFor, reduce } from "./store.ts";
import type { Section, UiAction, UiState } from "./store.ts";
import { OsenMark } from "../../../../../design/mockup-osen/brand/OsenMark.tsx";

const NAV: { key: Section; label: "navNew" | "navHistory" | "navSettings"; icon: IconName }[] = [
  { key: "new", label: "navNew", icon: "i-plus" },
  { key: "history", label: "navHistory", icon: "i-history" },
  { key: "settings", label: "navSettings", icon: "i-settings" },
];

// Session setup stays mounted while alive (setupKept) or open; outside the "New" section it is hidden, form state is kept.
export const setupView = (s: Pick<UiState, "setupKept" | "section">): { mounted: boolean; hidden: boolean } => {
  const mounted = s.setupKept || s.section === "new";
  return { mounted, hidden: mounted && s.section !== "new" };
};

// Shell without hooks (tests call it as a function): the language comes as a prop, without it — the process language.
export function Shell({ state, dispatch, version, language }: { state: UiState; dispatch: Dispatch<UiAction>; version?: string; language?: Language }): ReactNode {
  const { section, openId } = state;
  const t = shell(language);
  const setup = setupView(state);
  return (
    <div className="app">
      <IconSprite />
      <nav className="rail">
        <div className="rail__brand" aria-hidden="true"><OsenMark size={32} /></div>
        {NAV.map((n) => (
          <button
            key={n.key}
            type="button"
            className="rail__item"
            aria-current={n.key === section ? "page" : undefined}
            onClick={() => dispatch({ type: "navigate", section: n.key })}
          >
            <Icon name={n.icon} />
            <span>{t[n.label]}</span>
          </button>
        ))}
        {version && <div className="rail__spacer" />}
        {version && <div className="rail__version" title={t.versionTitle}>v{version}</div>}
      </nav>
      <div className="main">
        {state.errors.length > 0 && (
          <div className="alerts">
            {state.errors.map((e) => (
              <div key={e.id} className="alert" data-tone="danger" role="alert">
                <Icon name="i-alert" />
                <div className="alert__text">{e.message}</div>
                <button type="button" className="alert__close" aria-label={t.close} onClick={() => dispatch({ type: "dismiss", id: e.id })}>
                  <Icon name="i-x" />
                </button>
              </div>
            ))}
          </div>
        )}
        {setup.mounted && (
          <div className="main__setup" hidden={setup.hidden} inert={setup.hidden}>
            <NewFlow key={state.rerun?.sessionId ?? "new"} rerun={state.rerun} active={!setup.hidden} onStarted={(id) => dispatch({ type: "started", id })} />
          </div>
        )}
        {section === "settings" ? (
          <Settings sessionsRunning={state.sessions === null ? undefined : state.sessions.some((s) => s.status === "running")} />
        ) : section === "new" ? null : openId !== null ? (
          <SessionScreen
            key={`${openId}:${state.resultRequest}`} id={openId}
            item={state.sessions?.find((s) => s.id === openId) ?? null}
            state={state.session} live={state.live} expired={state.expiredWaits}
            pending={pendingFor(state, openId)}
            onOwnerSent={(r) => dispatch({ type: "owner-sent", id: openId, ...r })}
            onNew={() => dispatch({ type: "navigate", section: "new" })}
            onError={(message) => dispatch({ type: "error", message })}
            onRerun={(withDecision) => window.council.prepareRerun(openId, withDecision).then(
              (view) => dispatch({ type: "rerun", view }),
              (e) => dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) }),
            )}
          />
        ) : (
          <History
            sessions={state.sessions}
            filter={state.historyFilter}
            onFilter={(filter) => dispatch({ type: "history-filter", filter })}
            usagePeriod={state.usagePeriod}
            onUsagePeriod={(period) => dispatch({ type: "usage-period", period })}
            onError={(message) => dispatch({ type: "error", message })}
            onOpen={(id) => dispatch({ type: "open", id })}
            onNew={() => dispatch({ type: "navigate", section: "new" })}
          />
        )}
      </div>
    </div>
  );
}

function LocalizedShell(props: { state: UiState; dispatch: Dispatch<UiAction>; version?: string }): ReactNode {
  return <Shell {...props} language={useLanguageView()?.language} />;
}

export function App(): ReactNode {
  const [state, dispatch] = useReducer(reduce, undefined, initialUi);
  const fail = (e: unknown) => dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });

  useEffect(() => {
    const off = window.council.subscribe((event) => dispatch({ type: "bridge", event }));
    window.council.listSessions().then((sessions) => dispatch({ type: "sessions", sessions }), fail);
    window.council.notices().then((list) => list.forEach((message) => dispatch({ type: "error", message })), fail);
    return off;
  }, []);

  const { openId } = state;
  useEffect(() => {
    if (openId === null) return;
    window.council.openSession(openId).catch(fail);
    return () => { window.council.closeSession().catch(fail); };
  }, [openId]);

  return (
    <LanguageProvider onError={fail}>
      <LocalizedShell state={state} dispatch={dispatch} version={typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : undefined} />
    </LanguageProvider>
  );
}
