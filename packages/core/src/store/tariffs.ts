import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TARIFFS_FILE, parseTariffs } from "../protocol/tariffs.ts";
import type { TariffSet } from "../protocol/tariffs.ts";
import { storeMessages } from "../messages/store.ts";

export const tariffsPath = (dataDir: string): string => join(dataDir, TARIFFS_FILE);

/** Reads the tariffs of the data folder. Never throws and writes nothing. */
export function readTariffs(dataDir: string): TariffSet {
  let text: string;
  try {
    text = readFileSync(tariffsPath(dataDir), "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { state: "absent", tariffs: [], warnings: [] };
    // the fs error message contains the data folder path — outward only the code or the class name
    return { state: "unreadable", tariffs: [], warnings: [storeMessages().tariffsUnreadable(TARIFFS_FILE, code ?? (e as Error)?.constructor?.name ?? "Error")] };
  }
  return parseTariffs(text);
}
