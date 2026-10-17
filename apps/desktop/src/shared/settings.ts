import { ROUNDS_BOUNDS } from "./setup.ts";
import type { Billing, RosterEntry } from "./setup.ts";
import { settings } from "./messages/settings.ts";

// "Settings" screen data: the contract between main and renderer. Key values are not included — only the variable name and a flag.

export type ModelsSource = "provider" | "owner" | "unconfirmed" | "unavailable";

export interface SettingsProvider {
  id: string;
  kind: "cli" | "openai-http";
  label: string;
  available: boolean;
  reason: string | null;        // reason for unavailability
  warning: string | null;       // cli: version newer than the verified range
  version: string | null;       // cli
  path: string | null;          // cli: executable file
  baseUrl: string | null;       // openai-http
  keyEnv: string | null;        // openai-http: key variable name; null — no key required
  keySet: boolean;              // meaningful when keyEnv !== null
  billing: Billing;
  models: string[];             // the shown list, without defaultModel
  defaultModel: string | null;  // the "default model" value; null — no such option
  modelsSource: ModelsSource;   // provider — received from the provider, owner — set by the owner in config.json
  modelsReason: string | null;  // explanation for unconfirmed and unavailable
  modelsAt: string | null;      // ISO time the list was received; only when modelsSource === "provider"
}

export interface DefaultsValues {
  maxRounds: number;
  turnTimeoutSec: number;
  contextChars: number;
  materialsChars: number;
  maxTotalTokens: number | null; // default session token cap; null — none
  maxParticipants: number;
  participants: RosterEntry[];
}

export interface SettingsView {
  configPath: string;
  envPath: string;
  registryError: string | null; // not null — the registry was not read: providers is empty, defaults === null
  providers: SettingsProvider[];
  defaults: DefaultsValues | null;
}

export interface ProviderInput { id: string | null; label: string; baseUrl: string; apiKeyEnv: string } // id null — a new provider; apiKeyEnv "" — no key required

export type TestResult = { ok: true; ms: number } | { ok: false; reason: string };

export const DEFAULTS_BOUNDS = {
  maxRounds: ROUNDS_BOUNDS,
  turnTimeoutSec: { min: 10, max: 3600 },
  contextChars: { min: 1000, max: 1_000_000 },
  materialsChars: { min: 1000, max: 1_000_000 },
  maxParticipants: { min: 2, max: 8 },
} as const;

export interface ProviderInputErrors { label: string | null; baseUrl: string | null; apiKeyEnv: string | null }

export function checkProviderInput(input: ProviderInput): ProviderInputErrors {
  const url = input.baseUrl.trim();
  const env = input.apiKeyEnv.trim();
  const m = settings();
  return {
    label: input.label.trim() === "" ? m.labelRequired : null,
    baseUrl: URL.canParse(url) && ["http:", "https:"].includes(new URL(url).protocol) ? null : m.baseUrlInvalid,
    apiKeyEnv: env === "" || /^[A-Z_][A-Z0-9_]*$/.test(env) ? null : m.keyEnvInvalid,
  };
}

export interface DefaultsErrors { maxRounds: string | null; turnTimeoutSec: string | null; contextChars: string | null; materialsChars: string | null; maxTotalTokens: string | null; maxParticipants: string | null; participants: string | null }

export function checkDefaults(values: DefaultsValues, providerIds: readonly string[]): DefaultsErrors {
  const m = settings();
  const num = (key: keyof typeof DEFAULTS_BOUNDS) => {
    const { min, max } = DEFAULTS_BOUNDS[key];
    const v = values[key];
    return Number.isInteger(v) && v >= min && v <= max ? null : m.intRange(min, max);
  };
  const list = values.participants;
  const unknown = list.find((p) => !providerIds.includes(p.providerId));
  const participants =
    list.length < 2 ? m.participantsMin
    : list.length > values.maxParticipants ? m.participantsOverMax(list.length, values.maxParticipants)
    : unknown ? m.providerUnknown(unknown.providerId)
    : list.some((p) => p.model.trim() === "") ? m.participantNoModel
    : null;
  return {
    maxRounds: num("maxRounds"),
    turnTimeoutSec: num("turnTimeoutSec"),
    contextChars: num("contextChars"),
    materialsChars: num("materialsChars"),
    maxTotalTokens: values.maxTotalTokens === null || (Number.isSafeInteger(values.maxTotalTokens) && values.maxTotalTokens >= 1) ? null : m.capInvalid,
    maxParticipants: num("maxParticipants"),
    participants,
  };
}

export const hasErrors = (errors: object): boolean => Object.values(errors).some((v) => v !== null);
