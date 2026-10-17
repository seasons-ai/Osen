import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { HELP_ARGS, planLaunch } from "../cli-agents/args.ts";
import { locateCli } from "../cli-agents/discovery.ts";
import { declaredFlags, parseCodexFeatures } from "../cli-agents/flags.ts";
import { listModels } from "../cli-agents/models.ts";
import { CLI_AGENTS, DEFAULT_MODEL } from "../cli-agents/types.ts";
import type { CliRuntime } from "../cli-agents/types.ts";
import { listHttpModels } from "../http/models.ts";
import type { HttpRuntime } from "../http/types.ts";
import { registryMessages } from "../messages/registry.ts";
import { getProcessLanguage } from "../i18n/process-language.ts";
import { configPath, createRegistry } from "./config.ts";
import type { CliProvider, HttpProvider, Provider, Registry } from "./config.ts";

type Env = Record<string, string | undefined>;

export interface ProviderStatus {
  id: string;
  kind: Provider["kind"];
  label: string;
  available: boolean;
  reason?: string;
  searchPath?: string; // only for cli, when the command is not found: where it was looked for (the process PATH and the login shell)
  warning?: string;
  path?: string;
  version?: string;
  models: string[];           // without DEFAULT_MODEL; the "default" variant is added by the displaying code
  modelsConfirmed: boolean;
  modelsReason?: string;
  baseUrl?: string;    // only openai-http
  keyEnv?: string;     // only openai-http with a key: the name of the variable
  keySet?: boolean;    // only openai-http with a key: flag "key is set"
}

export interface ProviderInspection { status: ProviderStatus; runtime?: CliRuntime; http?: HttpRuntime }

export interface InspectDeps {
  locate: typeof locateCli;
  readHelp(path: string, args: readonly string[], env: Env): Promise<string>;
  readFeatures(path: string, env: Env): Promise<string>;
  listModels: typeof listModels;
  listHttpModels: typeof listHttpModels;
}

const run = promisify(execFile);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const exec = async (path: string, args: readonly string[], env: Env) =>
  (await run(path, [...args], { env, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })).stdout;

const realDeps: InspectDeps = {
  locate: locateCli,
  readHelp: exec,
  readFeatures: (path, env) => exec(path, ["features", "list"], env),
  listModels,
  listHttpModels,
};

interface Options { env: Env; withModels?: boolean; deps?: Partial<InspectDeps>; keyFile?: string }

async function inspectCli(provider: CliProvider, { env, withModels = true, deps }: Options): Promise<ProviderInspection> {
  const d = { ...realDeps, ...deps };
  const { agent } = provider;
  const status: ProviderStatus = { id: provider.id, kind: "cli", label: provider.label, available: false, models: provider.models, modelsConfirmed: false };
  const loc = await d.locate(agent, { explicitPath: provider.path, env });
  if (!loc.found || !loc.path) return { status: { ...status, reason: loc.reason ?? registryMessages().cliNotFound(agent), searchPath: loc.searchPath } };
  const path = loc.path;
  status.path = path;
  if (loc.version) status.version = loc.version;
  if (loc.warning) status.warning = loc.warning;

  const childEnv = { ...env, PATH: loc.searchPath };
  let help: string;
  try {
    help = await d.readHelp(path, HELP_ARGS[agent], childEnv);
  } catch (e) {
    return { status: { ...status, reason: registryMessages().helpFailed(agent, errText(e)) } };
  }
  const flags = declaredFlags(help);
  let features: Set<string> | undefined;
  if (agent === "codex") features = await d.readFeatures(path, childEnv).then(parseCodexFeatures, () => undefined);

  const plan = planLaunch({ agent, flags, version: loc.version, model: DEFAULT_MODEL, language: getProcessLanguage(), features });
  let runtime: CliRuntime | undefined;
  if (plan.ok) {
    status.available = true;
    runtime = { agent, path, env: childEnv, flags };
    if (features) runtime.features = features;
    if (loc.version) runtime.version = loc.version;
  } else status.reason = plan.reason;

  if (withModels) {
    if (provider.models.length) {
      status.modelsReason = registryMessages().modelsByOwner;
    } else {
      const found = await d.listModels(agent, { path, env: childEnv, help });
      status.models = found.models;
      status.modelsConfirmed = found.confirmed;
      if (found.reason) status.modelsReason = found.reason;
    }
  }
  return runtime ? { status, runtime } : { status };
}

async function inspectHttp(provider: HttpProvider, { env, withModels = true, deps, keyFile = registryMessages().keyFileDefault }: Options): Promise<ProviderInspection> {
  const d = { ...realDeps, ...deps };
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");
  const apiKeyEnv = provider.apiKeyEnv || undefined;
  const apiKey = apiKeyEnv ? env[apiKeyEnv] || undefined : undefined;
  const status: ProviderStatus = { id: provider.id, kind: "openai-http", label: provider.label, available: false, models: provider.models, modelsConfirmed: false, baseUrl };
  if (apiKeyEnv) { status.keyEnv = apiKeyEnv; status.keySet = apiKey !== undefined; }
  if (apiKeyEnv && !apiKey) return { status: { ...status, reason: registryMessages().keyNotSet(apiKeyEnv, keyFile) } };
  const http: HttpRuntime = { baseUrl, keyFile, ...(apiKeyEnv ? { apiKeyEnv, apiKey } : {}) };
  status.available = true;
  if (withModels) {
    if (provider.models.length) {
      status.modelsReason = registryMessages().modelsByOwner;
    } else {
      const found = await d.listHttpModels(http);
      if (found.unavailable) return { status: { ...status, available: false, ...(found.reason ? { reason: found.reason } : {}) } };
      status.models = found.models;
      status.modelsConfirmed = found.confirmed;
      if (found.reason) status.modelsReason = found.reason;
    }
  }
  return { status, http };
}

export async function inspectProvider(provider: Provider, options: Options): Promise<ProviderInspection> {
  try {
    return provider.kind === "openai-http" ? await inspectHttp(provider, options) : await inspectCli(provider, options);
  } catch (e) {
    const name = provider.kind === "openai-http" ? provider.id : provider.agent;
    return { status: { id: provider.id, kind: provider.kind, label: provider.label, available: false, reason: registryMessages().inspectFailed(name, errText(e)), models: provider.models, modelsConfirmed: false } };
  }
}

export const inspectProviders = (registry: Registry, options: Options): Promise<ProviderInspection[]> =>
  Promise.all(registry.providers.map((p) => inspectProvider(p, options)));

export async function ensureRegistry(dataDir: string, options: { env: Env; deps?: Partial<InspectDeps> }): Promise<"created" | "exists"> {
  if (existsSync(configPath(dataDir))) return "exists";
  const locate = options.deps?.locate ?? locateCli;
  const locs = await Promise.all(CLI_AGENTS.map((a) => locate(a, { env: options.env })));
  return createRegistry(dataDir, locs.filter((l) => l.found).map((l) => l.agent));
}
