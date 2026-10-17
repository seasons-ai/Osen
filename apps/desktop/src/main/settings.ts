import { DEFAULT_MODEL, RegistryError, configPath, getProcessLanguage, createCliDriver, createHttpDriver, envFilePath, inspectProvider, readRegistry, removeProvider, resetDiscoveryCache, writeRegistry } from "@model-council/core";
import type { Logger, ParticipantDriver, Provider, ProviderInspection, ProviderStatus, Registry } from "@model-council/core";
import { checkDefaults, checkProviderInput, hasErrors } from "../shared/settings.ts";
import { settings } from "../shared/messages/settings.ts";
import type { DefaultsValues, ProviderInput, SettingsProvider, SettingsView, TestResult } from "../shared/settings.ts";

export class SettingsError extends Error {} // the message is shown to the owner as is

export interface SettingsDeps {
  dataDir: string;
  env: Record<string, string | undefined>; // the shared environment object of the app; reloadEnv updates it in place
  reloadEnv(): void;
  logger: Logger;
  now?(): Date;
  inspect?: typeof inspectProvider;
  resetDiscovery?(): void;
  driver?(found: ProviderInspection): ParticipantDriver;
}

export interface SettingsApi {
  view(): Promise<SettingsView>;
  recheck(): Promise<SettingsView>;
  saveProvider(input: unknown): Promise<SettingsView>;
  deleteProvider(id: unknown): Promise<SettingsView>;
  saveModels(id: unknown, models: unknown): Promise<SettingsView>;
  refreshModels(id: unknown): Promise<SettingsProvider>;
  testProvider(id: unknown, model: unknown): Promise<TestResult>;
  saveDefaults(values: unknown): Promise<SettingsView>;
}

const bad = (what: string) => new SettingsError(settings().badRequest(what));
const str = (v: unknown): v is string => typeof v === "string";
const rec = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw bad(settings().reqObject(what));
  return v as Record<string, unknown>;
};
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createSettings(deps: SettingsDeps): SettingsApi {
  const { dataDir, env, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const inspect = deps.inspect ?? inspectProvider;
  const keyFile = envFilePath(dataDir);

  function toProvider(provider: Provider, status: ProviderStatus): SettingsProvider {
    const cli = provider.kind === "cli";
    const models = status.models.filter((m) => m !== DEFAULT_MODEL);
    const modelsSource: SettingsProvider["modelsSource"] =
      provider.models.length > 0 ? "owner" : status.modelsConfirmed ? "provider" : models.length > 0 ? "unconfirmed" : "unavailable";
    const noKey = !cli && provider.apiKeyEnv && !status.keySet;
    const modelsReason =
      modelsSource === "unconfirmed" ? (status.modelsReason ?? null)
      : modelsSource === "unavailable" ? (noKey ? settings().modelsNoKey : (status.modelsReason ?? null))
      : null;
    return {
      id: provider.id, kind: provider.kind, label: provider.label, available: status.available,
      reason: status.available ? null : (status.reason ?? settings().providerUnavailable),
      warning: status.warning ?? null, version: status.version ?? null, path: status.path ?? null,
      baseUrl: status.baseUrl ?? null, keyEnv: status.keyEnv ?? null, keySet: status.keySet ?? false,
      billing: cli ? "subscription" : status.keyEnv ? "paid" : "free",
      models, defaultModel: cli ? DEFAULT_MODEL : null,
      modelsSource, modelsReason, modelsAt: modelsSource === "provider" ? now().toISOString() : null,
    };
  }

  const look = async (provider: Provider, withModels: boolean) => inspect(provider, { env, withModels, keyFile });

  async function view(): Promise<SettingsView> {
    const base = { configPath: configPath(dataDir), envPath: keyFile };
    let registry: Registry;
    try {
      registry = readRegistry(dataDir);
    } catch (e) {
      if (!(e instanceof RegistryError)) throw e;
      return { ...base, registryError: e.message, providers: [], defaults: null };
    }
    const found = await Promise.all(registry.providers.map((p) => look(p, true)));
    const { maxRounds, turnTimeoutSec, contextChars, materialsChars, maxTotalTokens, maxParticipants, participants } = registry.defaults;
    return {
      ...base, registryError: null,
      providers: registry.providers.map((p, i) => toProvider(p, found[i]!.status)),
      defaults: { maxRounds, turnTimeoutSec, contextChars, materialsChars, maxTotalTokens: maxTotalTokens ?? null, maxParticipants, participants: participants.map((x) => ({ providerId: x.providerId, model: x.model })) },
    };
  }

  const find = (registry: Registry, id: unknown): Provider => {
    if (!str(id)) throw bad(settings().reqIdString);
    const p = registry.providers.find((x) => x.id === id);
    if (!p) throw new SettingsError(settings().providerNotFound(id));
    return p;
  };

  function freeId(registry: Registry, baseUrl: string): string {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "http";
    const taken = (id: string) => id === "scripted" || registry.providers.some((p) => p.id === id);
    let id = host;
    for (let n = 2; taken(id); n++) id = `${host}-${n}`;
    return id;
  }

  return {
    view,

    async recheck() {
      deps.reloadEnv();
      (deps.resetDiscovery ?? resetDiscoveryCache)();
      logger.info("Environment re-check: .env re-read, CLI search reset");
      return view();
    },

    async saveProvider(raw) {
      const r = rec(raw, settings().reqProvider);
      if (r["id"] !== null && !str(r["id"])) throw bad(settings().reqIdStringOrNull);
      if (!str(r["label"]) || !str(r["baseUrl"]) || !str(r["apiKeyEnv"])) throw bad(settings().reqProviderFields);
      const input: ProviderInput = { id: r["id"], label: r["label"].trim(), baseUrl: r["baseUrl"].trim(), apiKeyEnv: r["apiKeyEnv"].trim() };
      const errors = checkProviderInput(input);
      if (hasErrors(errors)) throw new SettingsError(Object.values(errors).find((v) => v !== null)!);
      const registry = readRegistry(dataDir);
      const { label, baseUrl, apiKeyEnv } = input;
      let id: string;
      let providers: Provider[];
      if (input.id === null) {
        id = freeId(registry, baseUrl);
        providers = [...registry.providers, { id, kind: "openai-http", label, models: [], baseUrl, ...(apiKeyEnv ? { apiKeyEnv } : {}) }];
      } else {
        id = input.id;
        const old = find(registry, id);
        if (old.kind !== "openai-http") throw new SettingsError(settings().editHttpOnly);
        const { apiKeyEnv: _drop, ...rest } = old;
        providers = registry.providers.map((p) => (p.id === id ? { ...rest, label, baseUrl, ...(apiKeyEnv ? { apiKeyEnv } : {}) } : p));
      }
      writeRegistry(dataDir, { ...registry, providers });
      logger.info(`Provider saved: ${id}`);
      return view();
    },

    async deleteProvider(id) {
      const registry = readRegistry(dataDir);
      if (find(registry, id).kind !== "openai-http") throw new SettingsError(settings().deleteHttpOnly);
      writeRegistry(dataDir, removeProvider(registry, id as string));
      logger.info(`Provider removed: ${id as string}`);
      return view();
    },

    async saveModels(id, models) {
      if (!Array.isArray(models) || !models.every(str)) throw bad(settings().reqModelsArray);
      const registry = readRegistry(dataDir);
      const provider = find(registry, id);
      const list = [...new Set((models as string[]).map((m) => m.trim()).filter((m) => m !== "" && m !== DEFAULT_MODEL))];
      writeRegistry(dataDir, { ...registry, providers: registry.providers.map((p) => (p === provider ? { ...p, models: list } : p)) });
      logger.info(`Model list saved: ${provider.id}, models ${list.length}`);
      return view();
    },

    async refreshModels(id) {
      const provider = find(readRegistry(dataDir), id);
      const found = await look(provider, true);
      logger.info(`Model list refreshed: ${provider.id}`);
      return toProvider(provider, found.status);
    },

    async testProvider(id, model) {
      const registry = readRegistry(dataDir);
      const provider = find(registry, id);
      if (!str(model) || model.trim() === "") throw bad(settings().reqModelNonEmpty);
      logger.info(`Test call: ${provider.id}, model ${model}`);
      const found = await look(provider, false);
      if (!found.runtime && !found.http) {
        const reason = found.status.reason ?? settings().providerUnavailable;
        logger.info(`Test call ${provider.id}: refused: ${reason}`);
        return { ok: false, reason };
      }
      const { turnTimeoutSec } = registry.defaults;
      const start = Date.now();
      try {
        const driver = deps.driver ? deps.driver(found) : found.runtime ? createCliDriver(found.runtime) : createHttpDriver(found.http!);
        await driver.call({
          participant: { id: "p1", name: provider.label, providerId: provider.id, model, role: null },
          prompt: settings().testPrompt, language: getProcessLanguage(),
          timeoutSec: turnTimeoutSec, signal: AbortSignal.timeout(turnTimeoutSec * 1000), onChunk: () => {},
        });
        const ms = Date.now() - start;
        logger.info(`Test call ${provider.id}: success in ${ms} ms`);
        return { ok: true, ms };
      } catch (e) {
        const reason = errText(e);
        logger.info(`Test call ${provider.id}: refused: ${reason}`);
        return { ok: false, reason };
      }
    },

    async saveDefaults(raw) {
      const r = rec(raw, settings().reqDefaults);
      const nums = ["maxRounds", "turnTimeoutSec", "contextChars", "materialsChars", "maxParticipants"] as const;
      if (!nums.every((k) => typeof r[k] === "number")) throw bad(settings().reqDefaultsNumbers);
      const cap = r["maxTotalTokens"];
      if (cap !== null && typeof cap !== "number") throw bad(settings().reqCapNumberOrNull);
      const list = r["participants"];
      if (!Array.isArray(list)) throw bad(settings().reqParticipantsArray);
      const participants = list.map((p: unknown) => {
        const o = typeof p === "object" && p !== null ? (p as Record<string, unknown>) : null;
        if (!o || !str(o["providerId"]) || !str(o["model"])) throw bad(settings().reqParticipantFields);
        return { providerId: o["providerId"], model: o["model"] };
      });
      const values: DefaultsValues = { maxRounds: r["maxRounds"] as number, turnTimeoutSec: r["turnTimeoutSec"] as number, contextChars: r["contextChars"] as number, materialsChars: r["materialsChars"] as number, maxTotalTokens: cap, maxParticipants: r["maxParticipants"] as number, participants };
      const registry = readRegistry(dataDir);
      const errors = checkDefaults(values, registry.providers.map((p) => p.id));
      if (hasErrors(errors)) throw new SettingsError(Object.values(errors).find((v) => v !== null)!);
      const { maxTotalTokens: _cap, ...rest } = values;
      const { maxTotalTokens: _old, ...kept } = registry.defaults;
      writeRegistry(dataDir, { ...registry, defaults: { ...kept, ...rest, ...(values.maxTotalTokens !== null ? { maxTotalTokens: values.maxTotalTokens } : {}) } });
      logger.info("Defaults saved");
      return view();
    },
  };
}
