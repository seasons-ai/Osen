import type { CliLocation, Logger, ProviderStatus } from "@model-council/core";

export function logProviders(logger: Logger, statuses: ProviderStatus[]): void {
  for (const s of statuses) {
    if (!s.available) {
      logger.error(`Provider ${s.id} unavailable: ${s.reason ?? "no reason given"}${s.searchPath ? `; search locations: ${s.searchPath}` : ""}`);
    } else if (s.kind === "cli") {
      logger.info(`Provider ${s.id}: found ${s.path}, version ${s.version ?? "unknown"}${s.warning ? `; warning: ${s.warning}` : ""}`);
    } else {
      logger.info(`Provider ${s.id}: available, address ${s.baseUrl}`);
    }
  }
}

export function logAppQuit(logger: Logger): void {
  logger.info("App exit");
}

export function logMissingClis(logger: Logger, locations: CliLocation[]): void {
  for (const l of locations) {
    if (!l.found) logger.error(`CLI ${l.agent}: ${l.reason ?? "command not found, no reason given"}; search locations: ${l.searchPath}`);
  }
}
