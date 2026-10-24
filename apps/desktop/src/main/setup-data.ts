import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DEFAULT_MODEL, OWNER_WAIT_DEFAULT_SEC, OWNER_WAIT_MAX_SEC, SessionEventSchema, eventsPath, isValidSessionId, readSession, sessionsDir, slotRoster } from "@model-council/core";
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

const FIRST_LINE_BLOCK_BYTES = 4096;
const FIRST_LINE_MAX_BYTES = 1024 * 1024; // a longer first line skips the journal

// The first line of the journal (the session_created event) without reading the rest of the file; null = unreadable or too long.
function readFirstLine(file: string): string | null {
  const fd = openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.alloc(FIRST_LINE_BLOCK_BYTES);
      const n = readSync(fd, buf, 0, FIRST_LINE_BLOCK_BYTES, null);
      if (n === 0) return null;
      const nl = buf.subarray(0, n).indexOf(0x0a);
      const end = nl === -1 ? n : nl;
      total += end;
      if (total > FIRST_LINE_MAX_BYTES) return null;
      chunks.push(buf.subarray(0, end));
      if (nl !== -1) return Buffer.concat(chunks).toString("utf8");
    }
  } finally {
    closeSync(fd);
  }
}

// The newest desktop session by the first journal line; only the chosen journal is read and folded in full.
export function lastRoster(dataDir: string): RosterEntry[] | null {
  let entries;
  try {
    entries = readdirSync(sessionsDir(dataDir), { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const candidates: { id: string; at: number }[] = [];
  for (const d of entries) {
    if (!d.isDirectory() || !isValidSessionId(d.name)) continue;
    try {
      const line = readFirstLine(eventsPath(dataDir, d.name));
      if (line === null) continue;
      const e = SessionEventSchema.safeParse(JSON.parse(line));
      if (e.success && e.data.type === "session_created" && e.data.session.origin === "desktop") candidates.push({ id: d.name, at: Date.parse(e.data.session.createdAt) });
    } catch { /* an unreadable or malformed journal is skipped */ }
  }
  candidates.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  for (const c of candidates) {
    try {
      const s = readSession(dataDir, c.id);
      if (s !== null) return slotRoster(s.state.session!).map((p) => ({ providerId: p.providerId, model: p.model }));
    } catch { /* the next candidate */ }
  }
  return null;
}
