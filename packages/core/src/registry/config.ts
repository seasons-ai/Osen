import { accessSync, constants, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CLI_AGENTS, DEFAULT_MODEL } from "../cli-agents/types.ts";
import type { CliAgent } from "../cli-agents/types.ts";
import { registryMessages } from "../messages/registry.ts";
import { describeIssue, zodMessages } from "../messages/zod.ts";
import { MAX_TURN_TIMEOUT_SEC } from "../protocol/schema.ts";
import type { Logger } from "../store/log.ts";

// Initial values of the limits: the only place where they are written.
const INITIAL_LIMITS = { maxRounds: 5, turnTimeoutSec: 300, contextChars: 24000, maxParticipants: 8 };
export const INITIAL_MATERIALS = { materialsIgnore: ["node_modules", "dist", "build"], materialsChars: 60000 };
const AGENT_LABELS: Record<CliAgent, string> = { claude: "Claude Code", codex: "Codex" };

const nonEmpty = z.string().min(1);
const providerId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .refine((id) => id !== "scripted", { error: () => registryMessages().reservedId });
const base = { id: providerId, label: nonEmpty, models: z.array(nonEmpty) };

const ProviderSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, kind: z.literal("cli"), agent: z.enum(CLI_AGENTS), path: nonEmpty.optional() }),
  z.strictObject({ ...base, kind: z.literal("openai-http"), baseUrl: z.url({ protocol: /^https?$/ }), apiKeyEnv: z.union([z.literal(""), z.string().regex(/^[A-Z_][A-Z0-9_]*$/)]).optional() }),
]);

const ignoreName = z
  .string()
  .refine((n) => n.trim() !== "" && !/[/\\*?]/.test(n), { error: () => registryMessages().ignoreName });
const int = (min: number) => z.number().int().min(min);

export const RegistrySchema = z
  .strictObject({
    providers: z.array(ProviderSchema),
    defaults: z.strictObject({
      maxRounds: int(1),
      turnTimeoutSec: int(1).max(MAX_TURN_TIMEOUT_SEC),
      contextChars: int(1),
      maxParticipants: int(2),
      materialsIgnore: z.array(ignoreName).default(() => [...INITIAL_MATERIALS.materialsIgnore]),
      materialsChars: int(1)
        .refine(Number.isSafeInteger, { error: () => registryMessages().safeInteger })
        .default(INITIAL_MATERIALS.materialsChars),
      maxTotalTokens: int(1).refine(Number.isSafeInteger, { error: () => registryMessages().safeInteger }).optional(),
      participants: z.array(z.strictObject({ providerId: nonEmpty, model: nonEmpty })),
    }),
  })
  .superRefine((r, ctx) => {
    const m = registryMessages();
    const seen = new Set<string>();
    r.providers.forEach((p, i) => {
      if (seen.has(p.id)) ctx.addIssue({ code: "custom", path: ["providers", i, "id"], message: m.duplicateProviderId(p.id) });
      seen.add(p.id);
    });
    r.defaults.participants.forEach((p, i) => {
      if (!seen.has(p.providerId)) {
        ctx.addIssue({ code: "custom", path: ["defaults", "participants", i, "providerId"], message: m.providerNotFound(p.providerId) });
      }
    });
    const { participants, maxParticipants } = r.defaults;
    if (participants.length > maxParticipants) {
      ctx.addIssue({
        code: "custom",
        path: ["defaults", "participants"],
        message: m.tooManyDefaults(participants.length, maxParticipants),
      });
    }
  });

export type Registry = z.infer<typeof RegistrySchema>;
export type Provider = Registry["providers"][number];
export type CliProvider = Extract<Provider, { kind: "cli" }>;
export type HttpProvider = Extract<Provider, { kind: "openai-http" }>;
export type RegistryDefaults = Registry["defaults"];

export class RegistryError extends Error {
  override name = "RegistryError";
}

export const configPath = (dataDir: string): string => join(dataDir, "config.json");

const loggedRegistry = new WeakSet<Logger>();

/** One line about loading the registry per logger instance: only the path and the number of providers. */
export function logRegistryLoaded(logger: Logger, dataDir: string, registry: Registry): void {
  if (loggedRegistry.has(logger)) return;
  loggedRegistry.add(logger);
  logger.info(`Settings loaded: ${configPath(dataDir)}, providers: ${registry.providers.length}`);
}

export function initialRegistry(agents: readonly CliAgent[]): Registry {
  return {
    providers: agents.map((agent) => ({ id: agent, kind: "cli", label: AGENT_LABELS[agent], agent, models: [] })),
    defaults: { ...INITIAL_LIMITS, materialsIgnore: [...INITIAL_MATERIALS.materialsIgnore], materialsChars: INITIAL_MATERIALS.materialsChars, participants: agents.map((a) => ({ providerId: a, model: DEFAULT_MODEL })) },
  };
}

const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createRegistry(dataDir: string, agents: readonly CliAgent[]): "created" | "exists" {
  const file = configPath(dataDir);
  try {
    writeFileSync(file, `${JSON.stringify(initialRegistry(agents), null, 2)}\n`, { flag: "wx" });
    return "created";
  } catch (e) {
    if (errCode(e) === "EEXIST") return "exists";
    throw new RegistryError(registryMessages().createFailed(file, errText(e)));
  }
}

export function describe(i: z.core.$ZodIssue): string {
  return i.code === "invalid_union" ? registryMessages().unionKind : describeIssue(i);
}

export function readRegistry(dataDir: string): Registry {
  const m = registryMessages();
  const file = configPath(dataDir);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (errCode(e) === "ENOENT") throw new RegistryError(m.fileNotFound(file));
    throw new RegistryError(m.readFailed(file, errText(e)));
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new RegistryError(m.notJson(errText(e)));
  }
  return validate(json);
}

function validate(json: unknown): Registry {
  const parsed = RegistrySchema.safeParse(json);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.length ? i.path.join(".") : zodMessages().root}: ${describe(i)}`);
    throw new RegistryError(registryMessages().invalid(lines.join("; ")));
  }
  return parsed.data;
}

/** Writes the registry to config.json. First the check, then the write; on any error the previous file stays byte for byte. */
export function writeRegistry(dataDir: string, registry: unknown): Registry {
  const data = validate(registry);
  const file = configPath(dataDir);
  const tmp = `${file}.tmp`;
  try {
    if (existsSync(file)) accessSync(file, constants.W_OK);
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new RegistryError(registryMessages().writeFailed(file, errText(e)));
  }
  return data;
}

/** A registry with a provider without id: removed from providers and from defaults.participants. The input does not change. An unknown id — a copy without changes. */
export function removeProvider(registry: Registry, id: string): Registry {
  return {
    providers: registry.providers.filter((p) => p.id !== id),
    defaults: { ...registry.defaults, participants: registry.defaults.participants.filter((p) => p.providerId !== id) },
  };
}
