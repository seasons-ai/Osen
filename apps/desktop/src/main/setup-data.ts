import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DEFAULT_MODEL, OWNER_WAIT_DEFAULT_SEC, OWNER_WAIT_MAX_SEC, listSessions, slotRoster } from "@model-council/core";
import type { ProviderStatus, Registry, TemplateCatalog } from "@model-council/core";
import { SCRIPTED_PROVIDER_ID, scriptedProviderLabel } from "../shared/setup.ts";
import { launch as msg } from "../shared/messages/launch.ts";
import type { ProviderOption, RegistryView, RosterEntry, TemplatesView } from "../shared/setup.ts";

// framing is not passed outward: the frame is substituted by the engine at start
export function templatesView(catalog: TemplateCatalog, builtinIds: ReadonlySet<string>): TemplatesView {
  return {
    templates: catalog.templates.map((t) => ({
      id: t.id, title: t.title, category: t.category, description: t.description, exampleTopic: t.exampleTopic,
      roles: t.roles, maxRounds: t.limits.maxRounds ?? null, source: t.source, modified: t.source === "user" && builtinIds.has(t.id),
    })),
    errors: catalog.errors.map((e) => ({ file: e.file, reason: e.reason })),
  };
}

export function listScenarios(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join("/"))
    .sort();
}

// model comes from the renderer: only a name from the list is accepted, leaving the folder gives null
export function scenarioPath(dir: string | null, model: string): string | null {
  return dir !== null && listScenarios(dir).includes(model) ? join(dir, model) : null;
}

export function registryView(registry: Registry, statuses: readonly ProviderStatus[], scenarios: readonly string[] | null): RegistryView {
  const providers: ProviderOption[] = registry.providers.map((p) => {
    const s = statuses.find((x) => x.id === p.id);
    const base = { id: p.id, label: p.label, available: s?.available ?? false, reason: s ? (s.available ? null : (s.reason ?? msg().providerUnavailableReason)) : msg().providerNotInspected };
    const models = s?.models ?? p.models;
    return p.kind === "cli"
      ? { ...base, kind: "cli", models: [DEFAULT_MODEL, ...models.filter((m) => m !== DEFAULT_MODEL)], defaultModel: DEFAULT_MODEL, billing: "subscription" }
      : { ...base, kind: "openai-http", models, defaultModel: null, billing: s?.keyEnv ? "paid" : "free" };
  });
  if (scenarios !== null) {
    providers.push({
      id: SCRIPTED_PROVIDER_ID, kind: "scripted", label: scriptedProviderLabel(), available: scenarios.length > 0,
      reason: scenarios.length ? null : msg().scenariosNotFound, models: [...scenarios], defaultModel: null, billing: "free",
    });
  }
  const { maxRounds, maxParticipants, materialsChars, maxTotalTokens, participants } = registry.defaults;
  return { providers, defaults: { maxRounds, maxParticipants, materialsChars, maxTotalTokens: maxTotalTokens ?? null, participants: participants.map((p) => ({ providerId: p.providerId, model: p.model })) }, ownerWait: { minSec: 1, maxSec: OWNER_WAIT_MAX_SEC, defaultSec: OWNER_WAIT_DEFAULT_SEC } };
}

// The name and the "default" model of registry providers — for participant names, as in registryView; the scripted one is always present.
export function providerNames(registry: Registry): Pick<ProviderOption, "id" | "label" | "defaultModel">[] {
  return [
    ...registry.providers.map((p) => ({ id: p.id, label: p.label, defaultModel: p.kind === "cli" ? DEFAULT_MODEL : null })),
    { id: SCRIPTED_PROVIDER_ID, label: scriptedProviderLabel(), defaultModel: null },
  ];
}

export function lastRoster(dataDir: string): RosterEntry[] | null {
  const s = listSessions(dataDir).find((x) => x.origin === "desktop");
  return s ? slotRoster(s).map((p) => ({ providerId: p.providerId, model: p.model })) : null;
}
