export const CLI_AGENTS = ["claude", "codex"] as const;
export type CliAgent = (typeof CLI_AGENTS)[number];

/** Value of Participant.model meaning "the CLI's default model": the model flag is not passed. */
export const DEFAULT_MODEL = "default";

/** Everything needed to run a CLI participant turn: gathered when the provider is inspected, consumed by the driver. */
export interface CliRuntime {
  agent: CliAgent;
  path: string;                                 // executable file of the CLI
  env: Record<string, string | undefined>;      // environment of the child process, PATH already prepared
  flags: ReadonlySet<string>;                   // flags declared by the help of the installed version
  features?: ReadonlySet<string>;               // codex: capabilities from `codex features list`
  version?: string;
  pinned?: boolean;                             // launched from an Osen pin: self-update off, own config dir
  pinDataDir?: string;                          // data folder of the Osen pin; the driver re-checks the pin before every turn
}
