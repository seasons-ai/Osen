import { existsSync } from "node:fs";
import { HELP_ARGS, planLaunch } from "../cli-agents/args.ts";
import { locateCli, pinnedEnv } from "../cli-agents/discovery.ts";
import { declaredFlags, parseCodexFeatures } from "../cli-agents/flags.ts";
import { listModels } from "../cli-agents/models.ts";
import { readOutput } from "../cli-agents/process.ts";
import { CLI_AGENTS, DEFAULT_MODEL } from "../cli-agents/types.ts";
import type { CliRuntime } from "../cli-agents/types.ts";
import { listHttpModels } from "../http/models.ts";
import type { HttpRuntime } from "../http/types.ts";
import { registryMessages } from "../messages/registry.ts";
import { getProcessLanguage } from "../i18n/process-language.ts";
import { cliEnv } from "../store/env.ts";
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
  verified?: { level: "real" | "interface" | "none"; checkedAt: string | null }; // only for a found cli
  source?: "explicit" | "pin" | "path"; // only for cli, when the search got that far: where the executable came from (the same search as a turn launch)
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
  readFeatures(path: string, args: readonly string[], env: Env): Promise<string>;
  listModels: typeof listModels;
  listHttpModels: typeof listHttpModels;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
// Own process group: the 10 s limit or more than 4 MiB of output ends the whole group (SIGTERM, then SIGKILL).
const exec = (path: string, args: readonly string[], env: Env) => readOutput(path, args, env);

const realDeps: InspectDeps = {
  locate: locateCli,
  readHelp: exec,
  readFeatures: exec,
  listModels,
  listHttpModels,
};

// provider.models holds only the models the owner added; the requested list comes first.
const withOwnerModels = (found: string[], owner: string[]): string[] => [...found, ...owner.filter((m) => !found.includes(m))];

interface Options { env: Env; withModels?: boolean; deps?: Partial<InspectDeps>; keyFile?: string; dataDir?: string }

async function inspectCli(provider: CliProvider, { env: rawEnv, withModels = true, deps, dataDir }: Options): Promise<ProviderInspection> {
  const env = cliEnv(rawEnv, { dataDir });
  const d = { ...realDeps, ...deps };
  const { agent } = provider;
  const status: ProviderStatus = { id: provider.id, kind: "cli", label: provider.label, available: false, models: provider.models, modelsConfirmed: false };
  const loc = await d.locate(agent, { explicitPath: provider.path, env, dataDir });
  if (!loc.found || !loc.path) {
    return { status: { ...status, reason: loc.reason ?? registryMessages().cliNotFound(agent), searchPath: loc.searchPath, ...(loc.source ? { source: loc.source } : {}), ...(loc.version ? { version: loc.version } : {}) } };
  }
  const path = loc.path;
  status.path = path;
  if (loc.version) status.version = loc.version;
  if (loc.verified) status.verified = loc.verified;
  if (loc.warning) status.warning = loc.warning;
  if (loc.source) status.source = loc.source;

  const updateOff = loc.pin && agent === "codex" ? ["-c", "check_for_update_on_startup=false"] : []; // same as turns (planLaunch)
  const childEnv = { ...env, PATH: loc.searchPath, ...(loc.pin ? pinnedEnv(agent, loc.pin.configDir) : {}) };
  let help: string;
  try {
    help = await d.readHelp(path, [...HELP_ARGS[agent], ...updateOff], childEnv);
  } catch (e) {
    return { status: { ...status, reason: registryMessages().helpFailed(agent, errText(e)) } };
  }
  const flags = declaredFlags(help);
  let features: Set<string> | undefined;
  if (agent === "codex") features = await d.readFeatures(path, ["features", "list", ...updateOff], childEnv).then(parseCodexFeatures, () => undefined);

  const plan = planLaunch({ agent, flags, version: loc.version, model: DEFAULT_MODEL, language: getProcessLanguage(), features, pinned: !!loc.pin });
  let runtime: CliRuntime | undefined;
  if (plan.ok) {
    status.available = true;
    runtime = { agent, path, env: childEnv, flags };
    if (features) runtime.features = features;
    if (loc.version) runtime.version = loc.version;
    if (loc.pin) { runtime.pinned = true; if (dataDir !== undefined) runtime.pinDataDir = dataDir; }
  } else status.reason = plan.reason;

  if (withModels) {
    const found = await d.listModels(agent, { path, env: childEnv, help });
    status.models = withOwnerModels(found.models, provider.models);
    status.modelsConfirmed = found.confirmed;
    if (found.reason) status.modelsReason = found.reason;
  }
  return runtime ? { status, runtime } : { status };
}

// One backward scan instead of /\/+$/, which retries at every slash of a long run (CodeQL js/polynomial-redos).
function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
  return url.slice(0, end);
}

async function inspectHttp(provider: HttpProvider, { env, withModels = true, deps, keyFile = registryMessages().keyFileDefault }: Options): Promise<ProviderInspection> {
  const d = { ...realDeps, ...deps };
  const parsed = URL.parse(provider.baseUrl);
  if (parsed && (parsed.username || parsed.password)) { // the address is never echoed: it holds a password
    return { status: { id: provider.id, kind: "openai-http", label: provider.label, available: false, reason: registryMessages().baseUrlUserinfo(provider.id), models: provider.models, modelsConfirmed: false } };
  }
  const baseUrl = trimTrailingSlashes(provider.baseUrl);
  const apiKeyEnv = provider.apiKeyEnv || undefined;
  const apiKey = apiKeyEnv ? env[apiKeyEnv] || undefined : undefined;
  const status: ProviderStatus = { id: provider.id, kind: "openai-http", label: provider.label, available: false, models: provider.models, modelsConfirmed: false, baseUrl };
  if (apiKeyEnv) { status.keyEnv = apiKeyEnv; status.keySet = apiKey !== undefined; }
  if (apiKeyEnv && !apiKey) return { status: { ...status, reason: registryMessages().keyNotSet(apiKeyEnv, keyFile) } };
  const http: HttpRuntime = { baseUrl, keyFile, ...(apiKeyEnv ? { apiKeyEnv, apiKey } : {}) };
  status.available = true;
  if (withModels) {
    const found = await d.listHttpModels(http);
    if (found.unavailable && provider.models.length === 0) return { status: { ...status, available: false, ...(found.reason ? { reason: found.reason } : {}) } };
    // With the owner's models the provider stays usable even if the endpoint has no list.
    if (!found.unavailable) status.models = withOwnerModels(found.models, provider.models);
    status.modelsConfirmed = !found.unavailable && found.confirmed;
    if (found.reason) status.modelsReason = found.reason;
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
  const locs = await Promise.all(CLI_AGENTS.map((a) => locate(a, { env: options.env, dataDir })));
  return createRegistry(dataDir, locs.filter((l) => l.found || l.source === "pin").map((l) => l.agent));
}
