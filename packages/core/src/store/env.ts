import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { DataDirError, prepareDataDir } from "./data-dir.ts";

type Env = Record<string, string | undefined>;

/** Path of the key file in the data folder. */
export const envFilePath = (dataDir: string): string => join(dataDir, ".env");

const filled = (e: Env): Env => Object.fromEntries(Object.entries(e).filter(([, v]) => v));
const read = (file: string): Env => {
  try {
    return filled(parseEnv(readFileSync(file, "utf8")));
  } catch {
    return {};
  }
};

/** Process environment, extended from the .env of the data folder and the .env of the cwd folder. The input object does not change. */
export function loadEnv(env: Env, cwd: string): Env {
  const local = read(join(cwd, ".env"));
  const own = filled(env);
  let data: Env = {};
  try {
    data = read(envFilePath(prepareDataDir({ ...local, ...own })));
  } catch (e) {
    if (!(e instanceof DataDirError)) throw e; // a migration error reaches the owner from the input; here the file is read without the data folder
  }
  return { ...env, ...local, ...data, ...own };
}
