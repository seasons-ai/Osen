import { checkLineup, DEFAULT_MODEL, ensureRegistry, envFilePath, inspectProviders, LineupsError, loadTemplates, logRegistryLoaded, readLineups, readRegistry, userTemplatesDir } from "@model-council/core";
import type { LineupCheck } from "@model-council/core";
import { defineTool, listScenarios, resumeScenarioPath, SCRIPTED_PROVIDER_ID, scriptedProviderLabel } from "./context.ts";
import { mcpMessages } from "./messages.ts";
import type { ToolContext } from "./context.ts";

export interface OptionsView {
  templates: { id: string; title: string; category: string; description: string }[];
  providers: {
    id: string; kind: "cli" | "openai-http" | "scripted"; label: string;
    available: boolean; reason: string | null;
    models: string[];
    defaultModel: string | null;
  }[];
  defaults: { maxRounds: number; maxParticipants: number; materialsChars: number; maxTotalTokens: number | null; participants: { providerId: string; model: string }[] };
  lineups: LineupCheck[];
  lineupsError: string | null;
}

/** Check of a scripted lineup position: resumeScenarioPath accepts both a scenario name (MCP) and an absolute path (the council command). */
export const lineupScripted = (ctx: ToolContext): ((model: string) => string | null) | null =>
  ctx.scenariosDir === null ? null : (model) => (resumeScenarioPath(ctx.scenariosDir, model) === null ? mcpMessages().scenarioUnavailable(model) : null);

export const councilOptions = defineTool({
  name: "council_options",
  get description() { return mcpMessages().optionsDesc; },
  inputSchema: {},
  async run(ctx): Promise<OptionsView> {
    const m = mcpMessages();
    await ensureRegistry(ctx.dataDir, { env: ctx.env, deps: ctx.inspectDeps });
    const registry = readRegistry(ctx.dataDir);
    logRegistryLoaded(ctx.logger, ctx.dataDir, registry);
    const found = await inspectProviders(registry, { env: ctx.env, deps: ctx.inspectDeps, keyFile: envFilePath(ctx.dataDir) });
    const statuses = found.map((f) => f.status);
    const catalog = loadTemplates({ builtinDir: ctx.builtinTemplatesDir, userDir: userTemplatesDir(ctx.dataDir) });

    const providers: OptionsView["providers"] = registry.providers.map((p) => {
      const s = statuses.find((x) => x.id === p.id);
      const base = { id: p.id, label: p.label, available: s?.available ?? false, reason: s ? (s.available ? null : (s.reason ?? m.optionsProviderUnavailable)) : m.optionsProviderNotInspected };
      const models = s?.models ?? p.models;
      return p.kind === "cli"
        ? { ...base, kind: "cli", models: [DEFAULT_MODEL, ...models.filter((m) => m !== DEFAULT_MODEL)], defaultModel: DEFAULT_MODEL }
        : { ...base, kind: "openai-http", models: [...models], defaultModel: null };
    });
    if (ctx.scenariosDir !== null) {
      const scenarios = listScenarios(ctx.scenariosDir);
      providers.push({
        id: SCRIPTED_PROVIDER_ID, kind: "scripted", label: scriptedProviderLabel(), available: scenarios.length > 0,
        reason: scenarios.length ? null : m.optionsNoScenarios, models: scenarios, defaultModel: null,
      });
    }
    let lineups: LineupCheck[] = [];
    let lineupsError: string | null = null;
    try {
      lineups = readLineups(ctx.dataDir).map((l) => checkLineup(l, { registry, statuses, scripted: lineupScripted(ctx) }));
    } catch (e) {
      if (!(e instanceof LineupsError)) throw e;
      lineupsError = e.message;
    }
    const { maxRounds, maxParticipants, materialsChars, maxTotalTokens, participants } = registry.defaults;
    return {
      templates: catalog.templates.map((t) => ({ id: t.id, title: t.title, category: t.category, description: t.description })),
      providers,
      defaults: { maxRounds, maxParticipants, materialsChars, maxTotalTokens: maxTotalTokens ?? null, participants: participants.map((p) => ({ providerId: p.providerId, model: p.model })) },
      lineups, lineupsError,
    };
  },
});
