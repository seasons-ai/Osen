import { materialsMessages } from "../messages/materials.ts";
import { MaterialsError, collectSessionMaterials, sha256Of } from "../materials.ts";
import type { CollectOptions, SessionMaterialSet } from "../materials.ts";
import { safeSource, safeUrl } from "../store/material-sources.ts";
import type { MaterialSource } from "../store/material-sources.ts";
import { URL_LIMITS, UrlFetchError, fetchUrl } from "./fetch.ts";
import type { UrlTransport } from "./fetch.ts";
import { UrlTextError, extractUrlText } from "./extract.ts";

export interface UrlMaterial { name: string; text: string; url: URL; fetchedAt: Date }
export interface UrlCollectOptions { transport?: UrlTransport; now?: () => Date; limits?: { ms?: number; redirects?: number; bytes?: number }; worker?: string }

/** Name of a link material: host and path without "/". */
export function urlMaterialName(url: URL): string {
  return (url.host + url.pathname).replace(/\/+$/, "").replaceAll("/", "_");
}

export async function collectUrlMaterials(urls: readonly string[], options: UrlCollectOptions = {}): Promise<UrlMaterial[]> {
  const now = options.now ?? (() => new Date());
  const found: UrlMaterial[] = [];
  const reasons: string[] = [];
  for (const [i, raw] of urls.entries()) {
    try {
      const deadline = Date.now() + (options.limits?.ms ?? URL_LIMITS.ms); // one deadline for the download and the extraction
      const fetched = await fetchUrl(raw, { ...(options.transport && { transport: options.transport }), ...(options.limits && { limits: options.limits }), deadline });
      const fetchedAt = now();
      const text = await extractUrlText(fetched, { deadline, ...(options.worker && { worker: options.worker }) });
      found.push({ name: urlMaterialName(fetched.url), text, url: fetched.url, fetchedAt });
    } catch (e) {
      if (!(e instanceof UrlFetchError || e instanceof UrlTextError)) throw e;
      let safe = materialsMessages().urlNumber(i + 1);
      try { safe = safeUrl(new URL(raw)); } catch { /* not an address — a number */ }
      reasons.push(`«${safe}»: ${e.reason}`);
    }
  }
  if (reasons.length > 0) throw new MaterialsError(reasons);
  return found;
}

export function collectSessionMaterialsWithUrls(
  paths: readonly string[], options: CollectOptions, urls: readonly UrlMaterial[],
): SessionMaterialSet & { sources: MaterialSource[] } {
  const named = urls.map((u) => ({ u, name: u.name }));
  const set = collectSessionMaterials(paths, options, named.map(({ u, name }) => ({ name, text: u.text, chars: u.text.length, sha256: sha256Of(u.text) })));
  // names do not affect the id, size or sum: uniqueness against local names and names already taken by links
  const from = set.materials.length - urls.length;
  const used = new Set(set.materials.slice(0, from).map((m) => m.name));
  const sources = urls.map((u, i) => {
    const m = set.materials[from + i]!;
    const base = m.name;
    for (let k = 2; used.has(m.name); k++) m.name = `${base} (${k})`;
    used.add(m.name);
    return safeSource(u.url, m.id, u.fetchedAt);
  });
  return { ...set, sources };
}
