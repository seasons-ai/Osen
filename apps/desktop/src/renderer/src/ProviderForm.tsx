import type { ReactNode } from "react";
import { checkProviderInput, hasErrors } from "../../shared/settings.ts";
import type { ProviderInput } from "../../shared/settings.ts";
import { settings } from "../../shared/messages/settings.ts";
import { Icon } from "./icons.tsx";
import { useMessages } from "./language.tsx";

export const EMPTY_PROVIDER: ProviderInput = { id: null, label: "", baseUrl: "", apiKeyEnv: "" };

const Err = ({ children }: { children: ReactNode }) => (
  <span className="setup__error" data-tone="danger"><Icon name="i-alert" size="sm" /> {children}</span>
);

export function ProviderForm({ input, envPath, saving, error, onChange, onSave, onCancel }: {
  input: ProviderInput;
  envPath: string;
  saving: boolean;
  error: string | null;
  onChange(input: ProviderInput): void;
  onSave(): void;
  onCancel(): void;
}): ReactNode {
  const t = useMessages(settings);
  const errors = checkProviderInput(input);
  const shown = (key: keyof typeof errors) => (input[key].trim() === "" ? null : errors[key]);
  const set = (patch: Partial<ProviderInput>) => onChange({ ...input, ...patch });
  return (
    <article className="card settings-card settings-form">
      <div className="settings-card__head">
        <Icon name="i-cloud" />
        <h3 className="settings-card__name">{input.id === null ? t.formNewTitle : t.formEditTitle}</h3>
        <span className="chip">HTTP</span>
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
      <label className="field">
        <span className="field__label">{t.name}</span>
        <input className="input" value={input.label} placeholder={t.namePlaceholder} onChange={(e) => set({ label: e.target.value })} />
        {shown("label") && <Err>{shown("label")}</Err>}
      </label>
      <label className="field">
        <span className="field__label">{t.address}</span>
        <input className="input" value={input.baseUrl} placeholder="https://example.com/v1" onChange={(e) => set({ baseUrl: e.target.value })} />
        <span className="field__hint">{t.addressHint}</span>
        {shown("baseUrl") && <Err>{shown("baseUrl")}</Err>}
      </label>
      <label className="field">
        <span className="field__label">{t.keyEnvLabel}</span>
        <input className="input" value={input.apiKeyEnv} placeholder={t.keyEnvPlaceholder} onChange={(e) => set({ apiKeyEnv: e.target.value })} />
        <span className="field__hint">{t.keyEnvHintBefore} <span className="mono">{envPath}</span> {t.keyEnvHintAfter}</span>
        {shown("apiKeyEnv") && <Err>{shown("apiKeyEnv")}</Err>}
      </label>
      <div className="settings-actions">
        <button type="button" className="btn btn--primary btn--sm" disabled={saving || hasErrors(errors)} onClick={onSave}>{saving ? t.saving : t.save}</button>
        <button type="button" className="btn btn--sm" disabled={saving} onClick={onCancel}>{t.cancel}</button>
      </div>
    </article>
  );
}
