import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MaterialSnapshotError, materialsDir } from "./journal.ts";
import { storeMessages } from "../messages/store.ts";

export const MaterialSourceSchema = z.object({
  id: z.string().regex(/^m[1-9]\d*$/),
  scheme: z.enum(["http", "https"]),
  host: z.string().min(1), // as in URL.host: name and non-standard port, without credentials
  pathname: z.string().startsWith("/"),
  fetchedAt: z.string().datetime(), // ISO, UTC
}).strict();
export type MaterialSource = z.infer<typeof MaterialSourceSchema>;

const FileSchema = z.object({ version: z.literal(1), sources: z.array(MaterialSourceSchema) }).strict();

export const SOURCES_FILE = "sources.json";
export const SOURCES_MAX_BYTES = 1024 * 1024;

/** Safe address: scheme, host and path. Query, fragment and credentials are not included. */
export function safeUrl(url: URL): string {
  return `${url.protocol.slice(0, -1)}://${url.host}${url.pathname}`;
}

export function safeSource(url: URL, id: string, fetchedAt: Date): MaterialSource {
  const scheme = url.protocol.slice(0, -1);
  if (scheme !== "http" && scheme !== "https") throw new Error(storeMessages().sourceSchemeUnsupported(scheme));
  return { id, scheme, host: url.host, pathname: url.pathname, fetchedAt: fetchedAt.toISOString() };
}

export function formatSource(s: MaterialSource): string {
  return storeMessages().sourceLine(s.id, `${s.scheme}://${s.host}${s.pathname}`, s.fetchedAt);
}

export function encodeSources(sources: readonly MaterialSource[]): string {
  return `${JSON.stringify({ version: 1, sources }, null, 2)}\n`;
}

export function decodeSources(text: string): MaterialSource[] | undefined {
  try {
    const r = FileSchema.safeParse(JSON.parse(text));
    return r.success ? r.data.sources : undefined;
  } catch {
    return undefined;
  }
}

export function checkSources(sources: readonly MaterialSource[], materialIds: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const s of sources) {
    if (!materialIds.includes(s.id)) return storeMessages().sourceNoMaterial(s.id);
    if (seen.has(s.id)) return storeMessages().sourceDuplicate(s.id);
    seen.add(s.id);
  }
  return undefined;
}

export function materialSourcesPath(dataDir: string, sessionId: string): string {
  return join(materialsDir(dataDir, sessionId), SOURCES_FILE);
}

export function writeMaterialSources(dataDir: string, sessionId: string, sources: readonly MaterialSource[]): void {
  if (sources.length === 0) return;
  try {
    writeFileSync(materialSourcesPath(dataDir, sessionId), encodeSources(sources), { encoding: "utf8", flag: "wx" });
  } catch (e) {
    throw new MaterialSnapshotError(storeMessages().sourcesSaveFailed((e as NodeJS.ErrnoException).code ?? (e as Error).message));
  }
}

export function readMaterialSources(dataDir: string, sessionId: string): MaterialSource[] | null {
  try {
    const path = materialSourcesPath(dataDir, sessionId);
    if (statSync(path).size > SOURCES_MAX_BYTES) return null;
    return decodeSources(readFileSync(path, "utf8")) ?? null;
  } catch (e) {
    const c = (e as NodeJS.ErrnoException).code;
    return c === "ENOENT" || c === "ENOTDIR" ? [] : null; // including an invalid session id — not a path, but null
  }
}
