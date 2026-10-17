import type { ReactNode } from "react";
import { DEFAULTS_BOUNDS, checkDefaults, hasErrors } from "../../shared/settings.ts";
import type { DefaultsValues, SettingsProvider } from "../../shared/settings.ts";
import { rosterNames } from "../../shared/setup.ts";
import { settings } from "../../shared/messages/settings.ts";
import { Icon } from "./icons.tsx";
import { useMessages } from "./language.tsx";

type NumKey = "maxRounds" | "turnTimeoutSec" | "contextChars" | "materialsChars" | "maxParticipants";

/** Participant model options: "default" (if present) first, then the provider's list. */
export function modelOptions(provider: SettingsProvider | undefined): string[] {
  if (!provider) return [];
  return provider.defaultModel === null ? [...provider.models] : [provider.defaultModel, ...provider.models];
}

/** New participant: the first available provider (none available — the first in the list) and its first model option ("" — no options). No providers — values unchanged. */
export function addParticipant(values: DefaultsValues, providers: readonly SettingsProvider[]): DefaultsValues {
  const provider = providers.find((p) => p.available) ?? providers[0];
  if (!provider) return { ...values, participants: [...values.participants] };
  return { ...values, participants: [...values.participants, { providerId: provider.id, model: modelOptions(provider)[0] ?? "" }] };
}

/** Provider change for a participant: the model resets to the first option of the new provider ("" — no options). */
export function withProvider(values: DefaultsValues, index: number, providerId: string, providers: readonly SettingsProvider[]): DefaultsValues {
  const model = modelOptions(providers.find((p) => p.id === providerId))[0] ?? "";
  return { ...values, participants: values.participants.map((p, i) => (i === index ? { providerId, model } : { ...p })) };
}

const Err = ({ children }: { children: ReactNode }) => (
  <span className="setup__error" data-tone="danger"><Icon name="i-alert" size="sm" /> {children}</span>
);

export function DefaultsPanel({ values, providers, configPath, dirty, saving, error, onChange, onSave }: {
  values: DefaultsValues;
  providers: SettingsProvider[];
  configPath: string;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onChange(values: DefaultsValues): void;
  onSave(): void;
}): ReactNode {
  const t = useMessages(settings);
  const errors = checkDefaults(values, providers.map((p) => p.id));
  const names = rosterNames(values.participants, providers);
  const set = (key: NumKey, value: number) => onChange({ ...values, [key]: value });

  const stepper = (key: NumKey, label: string, hint: string) => {
    const { min, max } = DEFAULTS_BOUNDS[key];
    return (
      <div className="field">
        <span className="field__label">{label}</span>
        <div className="stepper" data-min={min} data-max={max}>
          <button type="button" data-step="-1" aria-label={t.less} disabled={values[key] <= min} onClick={() => set(key, values[key] - 1)}>−</button>
          <span className="stepper__value">{values[key]}</span>
          <button type="button" data-step="1" aria-label={t.more} disabled={values[key] >= max} onClick={() => set(key, values[key] + 1)}>+</button>
        </div>
        <span className="field__hint">{hint}</span>
        {errors[key] && <Err>{errors[key]}</Err>}
      </div>
    );
  };

  const input = (key: NumKey, label: string, hint: string) => (
    <label className="field">
      <span className="field__label">{label}</span>
      <input className="input" inputMode="numeric" value={values[key] === 0 ? "" : String(values[key])}
        onChange={(e) => set(key, Number(e.target.value.replace(/\D/g, "")))} />
      <span className="field__hint">{hint}</span>
      {errors[key] && <Err>{errors[key]}</Err>}
    </label>
  );

  return (
    <>
      <div className="settings-head">
        <h2 className="section-title">{t.defaultsTitle}</h2>
        <span className="muted">{t.defaultsNote}</span>
      </div>
      <div className="card">
        <h3 className="card__title">{t.limits}</h3>
        <div className="settings-limits">
          {stepper("maxRounds", t.maxRounds, t.maxRoundsHint)}
          {input("turnTimeoutSec", t.turnTimeout, t.turnTimeoutHint)}
          {input("contextChars", t.contextChars, t.contextCharsHint)}
          {input("materialsChars", t.materialsChars, t.materialsCharsHint)}
          <label className="field">
            <span className="field__label">{t.tokenCap}</span>
            <input className="input" inputMode="numeric" placeholder={t.tokenCapPlaceholder} value={values.maxTotalTokens === null ? "" : String(values.maxTotalTokens)}
              onChange={(e) => { const d = e.target.value.replace(/\D/g, ""); onChange({ ...values, maxTotalTokens: d === "" ? null : Number(d) }); }} />
            <span className="field__hint">{t.tokenCapHint}</span>
            {errors.maxTotalTokens && <Err>{errors.maxTotalTokens}</Err>}
          </label>
          {stepper("maxParticipants", t.maxParticipants, t.maxParticipantsHint)}
        </div>
      </div>
      <div className="card settings-section">
        <h3 className="card__title">{t.defaultParticipants}</h3>
        <div className="settings-people">
          {values.participants.map((p, i) => {
            const provider = providers.find((x) => x.id === p.providerId);
            const options = modelOptions(provider);
            const label = (m: string) => (m === provider?.defaultModel ? t.defaultModel : m);
            return (
              <div key={i} className="participant settings-p" data-p={i + 1}>
                <div className="avatar" data-p={i + 1}>{i + 1}</div>
                <div>
                  <div className="participant__name">{names[i]}</div>
                  <div className="participant__meta">{p.providerId}{p.model !== "" && <> · <span className="tag">{label(p.model)}</span></>}</div>
                </div>
                <select className="select" aria-label={t.provider} value={p.providerId} onChange={(e) => onChange(withProvider(values, i, e.target.value, providers))}>
                  {providers.map((x) => <option key={x.id} value={x.id}>{x.available ? x.label : t.optionUnavailable(x.label)}</option>)}
                  {!provider && <option value={p.providerId}>{p.providerId}</option>}
                </select>
                <select className="select" aria-label={t.model} value={p.model}
                  onChange={(e) => onChange({ ...values, participants: values.participants.map((q, j) => (j === i ? { ...q, model: e.target.value } : q)) })}>
                  {options.map((m) => <option key={m} value={m}>{label(m)}</option>)}
                  {p.model !== "" && !options.includes(p.model) && <option value={p.model}>{p.model}</option>}
                  {options.length === 0 && p.model === "" && <option value="">{t.noModels}</option>}
                </select>
                <button type="button" className="btn btn--ghost btn--sm" aria-label={t.remove}
                  onClick={() => onChange({ ...values, participants: values.participants.filter((_, j) => j !== i) })}><Icon name="i-trash" size="sm" /></button>
              </div>
            );
          })}
        </div>
        <div className="row">
          <button type="button" className="btn btn--sm" disabled={values.participants.length >= values.maxParticipants || providers.length === 0}
            onClick={() => onChange(addParticipant(values, providers))}><Icon name="i-plus" size="sm" /> {t.add}</button>
          {errors.participants ? <Err>{errors.participants}</Err> : <span className="muted">{t.atLeastTwo}</span>}
        </div>
      </div>
      {error && (
        <div className="alert" data-tone="danger" role="alert">
          <Icon name="i-alert" />
          <div>
            <div className="alert__title">{t.saveFailedTitle}</div>
            <div className="alert__text">{error}</div>
          </div>
        </div>
      )}
      <div className="settings-foot">
        <button type="button" className="btn btn--primary" disabled={saving || !dirty || hasErrors(errors)} onClick={onSave}>{saving ? t.saving : t.save}</button>
        <span className="muted">{t.settingsFile} <span className="mono">{configPath}</span></span>
      </div>
    </>
  );
}
