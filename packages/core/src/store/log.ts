import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Logger {
  info(message: string): void;
  error(message: string, cause?: unknown): void;
}

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD/i;

export function createLogger(
  dataDir: string,
  component: string,
  env: Record<string, string | undefined> = process.env,
): Logger {
  const dir = join(dataDir, "logs");
  const file = join(dir, "app.log");
  const secrets = Object.entries(env)
    .filter((e): e is [string, string] => SECRET_NAME.test(e[0]) && (e[1]?.length ?? 0) >= 6)
    .map(([, v]) => v)
    .sort((a, b) => b.length - a.length);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}

  const write = (level: string, text: string): void => {
    try {
      let line = `${new Date().toISOString()} ${level} [${component}] ${text}`.replace(/\r|\n/g, "\\n");
      for (const s of secrets) line = line.split(s).join("[hidden]");
      appendFileSync(file, line + "\n");
    } catch {}
  };

  return {
    info: (message) => write("INFO", message),
    error: (message, cause) => {
      const why = cause === undefined ? "" : ` — reason: ${cause instanceof Error ? cause.message : String(cause)}`;
      write("ERROR", message + why);
    },
  };
}
