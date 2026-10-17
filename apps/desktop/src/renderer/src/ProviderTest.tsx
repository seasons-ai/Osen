import type { ReactNode } from "react";
import type { SettingsProvider, TestResult } from "../../shared/settings.ts";
import { settings } from "../../shared/messages/settings.ts";
import { Icon } from "./icons.tsx";
import { useMessages } from "./language.tsx";

export type TestState =
  | { phase: "idle" }
  | { phase: "confirm"; model: string }
  | { phase: "running"; model: string }
  | { phase: "done"; model: string; result: TestResult };

export type TestAction =
  | { type: "ask" }
  | { type: "model"; model: string }
  | { type: "cancel" }
  | { type: "run" }
  | { type: "result"; result: TestResult };

/** Models of the test call: the provider's list, then the "default" option if there is one. */
export function testModels(provider: SettingsProvider): string[] {
  return [...provider.models, ...(provider.defaultModel !== null ? [provider.defaultModel] : [])];
}

export function canTest(provider: SettingsProvider): boolean {
  return provider.available && testModels(provider).length > 0;
}

export function reduceTest(state: TestState, action: TestAction, provider: SettingsProvider): TestState {
  const models = testModels(provider);
  switch (state.phase) {
    case "idle":
    case "done":
      if (action.type === "ask" && canTest(provider)) return { phase: "confirm", model: models[0]! };
      if (action.type === "cancel" && state.phase === "done") return { phase: "idle" };
      return state;
    case "confirm":
      if (action.type === "model" && models.includes(action.model)) return { phase: "confirm", model: action.model };
      if (action.type === "cancel") return { phase: "idle" };
      if (action.type === "run") return { phase: "running", model: state.model };
      return state;
    case "running":
      return action.type === "result" ? { phase: "done", model: state.model, result: action.result } : state;
  }
}

type TestPanelProps = {
  provider: SettingsProvider;
  state: TestState;
  dispatch(action: TestAction): void;
};

// Thin wrapper: the language hook lives in TestBody, so TestPanel can be called both as a function (tests) and as a component.
export function TestPanel(props: TestPanelProps): ReactNode {
  return <TestBody {...props} />;
}

function TestBody({ provider, state, dispatch }: TestPanelProps): ReactNode {
  const t = useMessages(settings);
  if (state.phase === "idle") return null;
  const titles = { subscription: t.testTitleSubscription, paid: t.testTitlePaid, free: t.testTitleFree } as const;
  const seconds = (ms: number) => t.seconds((ms / 1000).toFixed(1));
  const label = (m: string) => (m === provider.defaultModel ? t.defaultModel : m);
  const model = <span className="tag">{label(state.model)}</span>;
  const close = (
    <div className="alert__actions">
      <button type="button" className="btn btn--sm" onClick={() => dispatch({ type: "cancel" })}>{t.close}</button>
    </div>
  );
  if (state.phase === "confirm") {
    const models = testModels(provider);
    return (
      <div className="alert" data-tone="info" role="alert">
        <Icon name="i-info" />
        <div>
          <div className="alert__title">{titles[provider.billing]}</div>
          <div className="alert__text">
            {t.testConfirmBefore} {model}{t.testConfirmAfter}
            {provider.billing === "free" && ` ${t.testFreeNote}`}
          </div>
          {models.length > 1 && (
            <select className="select" aria-label={t.testModelLabel} value={state.model}
              onChange={(e) => dispatch({ type: "model", model: e.target.value })}>
              {models.map((m) => <option key={m} value={m}>{label(m)}</option>)}
            </select>
          )}
        </div>
        <div className="alert__actions">
          <button type="button" className="btn btn--primary btn--sm" onClick={() => dispatch({ type: "run" })}>{t.runCall}</button>
          <button type="button" className="btn btn--sm" onClick={() => dispatch({ type: "cancel" })}>{t.cancel}</button>
        </div>
      </div>
    );
  }
  if (state.phase === "running") {
    return (
      <div className="alert" data-tone="info">
        <Icon name="i-info" />
        <div>
          <div className="alert__title">{t.testRunningTitle}</div>
          <div className="alert__text">{t.testModelPrefix} {model}{t.testWaiting}</div>
        </div>
      </div>
    );
  }
  const r = state.result;
  return r.ok ? (
    <div className="alert" data-tone="ok">
      <Icon name="i-check" />
      <div>
        <div className="alert__title">{t.testOkTitle}</div>
        <div className="alert__text">{t.testModelPrefix} {model}{t.testResponseTime(seconds(r.ms))}</div>
      </div>
      {close}
    </div>
  ) : (
    <div className="alert" data-tone="danger" role="alert">
      <Icon name="i-alert" />
      <div>
        <div className="alert__title">{t.testFailedTitle}</div>
        <div className="alert__text">{r.reason}</div>
      </div>
      {close}
    </div>
  );
}
