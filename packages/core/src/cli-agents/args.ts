import { DEFAULT_MODEL } from "./types.ts";
import { providerMessages } from "../messages/providers.ts";
import { promptMessages } from "../messages/prompt.ts";
import type { Language } from "../i18n/language.ts";
import type { CliAgent } from "./types.ts";

/** Arguments used to fetch the help text of the required subcommand. */
export const HELP_ARGS: Record<CliAgent, readonly string[]> = { claude: ["--help"], codex: ["exec", "--help"] };

/** System prompt of the participant, in the session language. */
export const participantSystemPrompt = (language: Language): string => promptMessages(language).systemPrompt;

export const CODEX_ISOLATION_FEATURES = ["shell_tool", "unified_exec", "view_image", "sleep_tool", "multi_agent", "apps", "browser_use", "computer_use", "image_generation", "hooks", "plugins", "memories", "skill_search"] as const;

export interface LaunchInput {
  agent: CliAgent;
  flags: ReadonlySet<string>;
  version?: string;
  model: string;
  language: Language; // session language: the participant's system prompt is in it
  schema?: { json: string; file: string };
  features?: ReadonlySet<string>;
  pinned?: boolean; // launched from an Osen pin
}

export type LaunchPlan = { ok: true; args: string[]; structured: boolean } | { ok: false; reason: string };

const REQUIRED: Record<CliAgent, readonly string[]> = {
  claude: ["--print", "--output-format", "--tools", "--strict-mcp-config", "--setting-sources", "--system-prompt", "--no-session-persistence"],
  codex: ["--sandbox", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--json", "--disable"],
};

/** Arguments for an isolated participant run, built from the flags declared by the help text; the request goes through stdin. */
export function planLaunch(input: LaunchInput): LaunchPlan {
  const { agent, flags, version, model, schema, features, language, pinned } = input;
  const m = providerMessages();
  const who = version ? m.whoVersion(agent, version) : m.whoInstalled(agent);
  const missing = REQUIRED[agent].filter((f) => !flags.has(f));
  if (missing.length) return { ok: false, reason: m.missingIsolationFlags(who, missing.join(", ")) };
  if (agent === "codex") {
    // Isolation is confirmed only if the list was read and contains every capability that can be disabled.
    if (!features) return { ok: false, reason: m.isolationFeaturesUnread(who) };
    const absent = CODEX_ISOLATION_FEATURES.filter((f) => !features.has(f));
    if (absent.length) return { ok: false, reason: m.isolationFeaturesMissing(who, absent.join(", ")) };
  }
  // A pinned codex turns self-update off only by --config (decision 174): without it the pin cannot keep its version, so it is not launched.
  if (agent === "codex" && pinned && !flags.has("--config")) return { ok: false, reason: m.pinnedNoConfigFlag(who) };
  const useModel = model !== DEFAULT_MODEL;
  if (useModel && !flags.has("--model")) return { ok: false, reason: m.missingModelFlag(who) };
  const structured = schema !== undefined && flags.has(agent === "claude" ? "--json-schema" : "--output-schema");
  const args: string[] = [];
  if (agent === "claude") {
    args.push("--print", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--system-prompt", participantSystemPrompt(language), "--no-session-persistence");
    if (flags.has("--disable-slash-commands")) args.push("--disable-slash-commands");
    if (useModel) args.push("--model", model);
    if (structured) args.push("--json-schema", schema!.json);
  } else {
    args.push("exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--json");
    for (const f of CODEX_ISOLATION_FEATURES) args.push("--disable", f);
    // Codex has no env switch for self-update and turns ignore config.toml, so a pinned run turns it off by --config.
    if (pinned) args.push("-c", "check_for_update_on_startup=false");
    if (useModel) args.push("--model", model);
    if (structured) args.push("--output-schema", schema!.file);
    args.push("-");
  }
  return { ok: true, args, structured };
}
