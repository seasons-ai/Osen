import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { basename, isAbsolute, relative, sep } from "node:path";
import { MaterialsError, attachedFolderPrefixes, collectMaterials, collectUrlMaterials, folderStats, isPinnedMaterial, safeSource, safeUrl, scrubPaths, selectMaterials, sha256Of } from "@model-council/core";
import type { CollectedMaterial, FolderFile, Logger, MaterialSource, SkippedMaterial, UrlTransport } from "@model-council/core";
import type { MaterialsView } from "../shared/setup.ts";
import { setupMain } from "../shared/messages/setup-main.ts";

export interface MaterialsDraftDeps {
  limits(): { materialsChars: number; materialsIgnore: readonly string[] }; // read on every action — a limit change in settings is visible without a restart
  collect?: typeof collectMaterials;
  logger?: Pick<Logger, "info">;
  transport?: UrlTransport; // seam for loading links; the core transport by default
  worker?: string; // path of the HTML text extraction worker
  now?: () => Date;
}

export class MaterialsDraftError extends Error {} // the message is shown to the owner

export interface MaterialsDraft {
  view(): MaterialsView;
  attach(paths: readonly string[]): MaterialsView;
  remove(id: string): MaterialsView;
  returnIgnored(id: string): MaterialsView; // include in the set the path of row id of the "Excluded by rules" section
  excludeIgnored(id: string): MaterialsView; // exclude the included path again
  clear(): MaterialsView;
  addUrl(url: string): Promise<MaterialsView>; // loads a link and adds a row; one load at a time; clear/carry during loading discard the result
  carry(materials: readonly CollectedMaterial[], notes: readonly string[], sources?: readonly MaterialSource[]): MaterialsView; // replaces the draft with carried records (without roots); a source is held by the record whose id is in sources
  take(): CollectedMaterial[];
  stamp(): string; // stamp of the draft composition and the selection limits
  refresh(): MaterialsView; // rereads all accepted roots from disk; on refusal throws MaterialsDraftError and changes nothing
  snapshot(): { sources: MaterialSource[]; materials: CollectedMaterial[]; workspace: FolderFile[]; skipped: SkippedMaterial[]; left: { name: string; reason: string }[]; materialsChars: number; stamp: string };
  workspace(): FolderFile[]; // all files of the attached folders for the session snapshot: both those within the limit and those not
}

export const DRAFT_FACTOR = 10; // add boundary = DRAFT_FACTOR × the session limit

const keyOf = (m: CollectedMaterial) => `${m.name}\0${m.sha256}`;
const renumber = (ms: readonly CollectedMaterial[]): CollectedMaterial[] => ms.map((m, i) => ({ ...m, id: `m${i + 1}` }));
const total = (ms: readonly CollectedMaterial[]) => ms.reduce((s, m) => s + m.chars, 0);

export function createMaterialsDraft(deps: MaterialsDraftDeps): MaterialsDraft {
  const collect = deps.collect ?? collectMaterials;
  let roots: string[] = [];
  let pool: CollectedMaterial[] = []; // everything collected from roots, except deleted and carried; selection under the limit — in select
  let carried: CollectedMaterial[] = []; // carried records: always at the start of the list
  let carriedSrc = new Map<string, MaterialSource>(); // sources of carried links by keyOf
  let links: { material: CollectedMaterial; url: URL; fetchedAt: Date }[] = []; // links: always included, after the materials from roots
  let busy = false; // a link is loading
  let gen = 0; // grows on clear and carry: a load started earlier is discarded
  let skipped: SkippedMaterial[] = []; // as the core returned it: excluded by rules — with excludedPath and rule
  let returned = new Map<string, { name: string; rule: string }>(); // returned absolute paths: after collecting with include the core does not return them in skipped, main remembers the name and rule
  let removed = new Set<string>();
  let error: string | null = null;
  const salt = randomUUID(); // the stamp must not coincide for two drafts
  let version = 0; // counter of composition changes that took place

  // selection under the limit is recomputed on every action: the owner may have changed the limit; carried ones and links are always included
  type Row = { m: CollectedMaterial; src: MaterialSource | null; link: (typeof links)[number] | null };
  const build = (rootList: readonly string[], source: readonly CollectedMaterial[]) => {
    const { taken, left } = selectMaterials(source, rootList, deps.limits().materialsChars - total(carried) - total(links.map((l) => l.material)));
    const used = new Set([...carried, ...taken].map((m) => m.name));
    const linkRows: Row[] = links.map((l) => {
      const base = l.material.name;
      const m = { ...l.material };
      for (let k = 2; used.has(m.name); k++) m.name = `${base} (${k})`;
      used.add(m.name);
      return { m, src: safeSource(l.url, "", l.fetchedAt), link: l };
    });
    const rows: Row[] = [...carried.map((m) => ({ m, src: carriedSrc.get(keyOf(m)) ?? null, link: null })), ...taken.map((m) => ({ m, src: null, link: null })), ...linkRows]
      .map((r, i) => ({ ...r, m: { ...r.m, id: `m${i + 1}` } }));
    return { rows, list: rows.map((r) => r.m), left };
  };
  const select = (rootList: readonly string[], source: readonly CollectedMaterial[]) => build(rootList, source);
  const workspace = (): FolderFile[] => pool.filter((m) => m.name.includes("/")).map((m) => ({ name: m.name, text: m.text }));
  const stampOf = (l: { materialsChars: number; materialsIgnore: readonly string[] }) => sha256Of(`${salt}\0${version}\0${l.materialsChars}\0${JSON.stringify(l.materialsIgnore)}`);
  // rows of the "Excluded by rules" section: excluded and returned in a stable order; ids x1..xN by it; the absolute path does not go into the view
  const ignoredRows = () => {
    const byPath = new Map<string, { abs: string; name: string; rule: string; returned: boolean }>();
    for (const s of skipped) if (s.excludedPath !== undefined) byPath.set(s.excludedPath, { abs: s.excludedPath, name: s.name, rule: s.rule!, returned: false });
    for (const [abs, r] of returned) byPath.set(abs, { abs, ...r, returned: true });
    return [...byPath.values()].sort((a, b) => (a.name !== b.name ? (a.name < b.name ? -1 : 1) : a.abs < b.abs ? -1 : a.abs > b.abs ? 1 : 0));
  };
  const view = (): MaterialsView => {
    const ws = workspace();
    const { rows, list, left } = select(roots, pool);
    const lim = deps.limits();
    const limit = lim.materialsChars;
    const chars = total(list);
    return {
      items: rows.map(({ m, src }) => ({ id: m.id, name: m.name, chars: m.chars, source: src ? { label: src.host + src.pathname, fetchedAt: src.fetchedAt } : null })),
      skipped: skipped.filter((s) => s.excludedPath === undefined).map((s) => ({ name: s.name, reason: s.reason })),
      left,
      ignored: ignoredRows().map((r, i) => ({ id: `x${i + 1}`, name: r.name, rule: r.rule, returned: r.returned })),
      error,
      chars,
      limit,
      over: Math.max(0, chars - limit),
      folder: ws.length > 0 ? folderStats(ws) : null,
      stamp: stampOf(lim),
    };
  };
  const reject = (message: string): MaterialsView => {
    error = message;
    return view();
  };

  // common path of attach and refresh: collecting all roots from disk and the boundary; onFail receives the reason and must not change the state itself
  const rebuild = (next: string[], onFail: (message: string) => MaterialsView, nextReturned = returned, files: string[] = []): MaterialsView => {
    const { materialsChars, materialsIgnore } = deps.limits();
    let set;
    const back = new Set<string>();
    const proc = process as NodeJS.Process & { noAsar?: boolean };
    const prevNoAsar = proc.noAsar;
    proc.noAsar = true; // in the Electron main process fs is patched: openSync of an *.asar file answers ENOENT
    try {
      // ponytail: all accepted roots are collected anew — a root that vanished from disk makes every following add refuse until the owner resets the draft ("To templates"); a separate root removal will be needed if this becomes a nuisance
      const include = [...nextReturned.keys()].filter((p) => next.some((r) => p.startsWith(r + sep)));
      set = collect(next, { materialsChars: Number.MAX_SAFE_INTEGER, materialsIgnore, include });
      // an explicitly named file comes back from the deleted: its material is recognized by content and name (standalone or "<folder>/<path>"); a folder and other actions do not touch the deleted
      const prefixes = attachedFolderPrefixes(next);
      for (const f of files) {
        const sha = collect([f], { materialsChars: Number.MAX_SAFE_INTEGER, materialsIgnore }).materials[0]?.sha256;
        const names = [basename(f), ...[...prefixes].filter(([r]) => f.startsWith(r + sep)).map(([r, pre]) => `${pre}/${relative(r, f).split(sep).join("/")}`)];
        for (const m of set.materials) if (m.sha256 === sha && names.includes(m.name)) back.add(keyOf(m));
      }
    } catch (e) {
      if (!(e instanceof MaterialsError)) throw e;
      return onFail(e.reasons.map((r) => scrubPaths(r, next)).join("\n"));
    } finally {
      proc.noAsar = prevNoAsar;
    }
    const kept = new Set([...removed].filter((k) => !back.has(k)));
    const own = new Set(carried.map(keyOf));
    const fresh = set.materials.filter((m) => !kept.has(keyOf(m)) && !own.has(keyOf(m)));
    // the boundary is counted only over the always-included ones: the size of a large folder does not affect it
    const sum = total(carried) + total(fresh.filter((m) => isPinnedMaterial(m, next)));
    const bound = DRAFT_FACTOR * materialsChars;
    if (sum > bound) return onFail(setupMain().overBound(sum, bound, DRAFT_FACTOR, materialsChars));
    roots = next;
    removed = kept;
    pool = fresh;
    skipped = set.skipped;
    returned = new Map([...nextReturned].filter(([p]) => next.some((r) => p.startsWith(r + sep))));
    error = null;
    version++;
    return view();
  };

  return {
    view,
    attach(paths) {
      const bad = paths.find((p) => typeof p !== "string" || p === "");
      if (bad !== undefined) return reject(setupMain().pathNotString);
      if (paths.some((p) => !isAbsolute(p))) return reject(setupMain().pathNotAbsolute);
      const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
      return rebuild([...new Set([...roots, ...paths])], reject, returned, paths.filter(isFile));
    },
    refresh() {
      if (roots.length === 0) return view();
      return rebuild(roots, (message) => { throw new MaterialsDraftError(message); });
    },
    snapshot() {
      const lim = deps.limits();
      const { rows, list, left } = select(roots, pool);
      const sources = rows.filter((r) => r.src).map((r) => ({ ...r.src!, id: r.m.id }));
      return { sources, materials: list.map((m) => ({ ...m })), workspace: workspace(), skipped: skipped.map((s) => ({ ...s })), left, materialsChars: lim.materialsChars, stamp: stampOf(lim) };
    },
    stamp: () => stampOf(deps.limits()),
    returnIgnored(id) {
      const row = ignoredRows().find((_, i) => `x${i + 1}` === id);
      if (!row || row.returned) return view();
      const res = rebuild(roots, reject, new Map([...returned, [row.abs, { name: row.name, rule: row.rule }]]));
      if (returned.has(row.abs)) deps.logger?.info(`Rule-excluded item returned to the set: ${row.name}`);
      return res;
    },
    excludeIgnored(id) {
      const row = ignoredRows().find((_, i) => `x${i + 1}` === id);
      if (!row || !row.returned) return view();
      const next = new Map(returned);
      next.delete(row.abs);
      return rebuild(roots, reject, next);
    },
    remove(id) {
      const row = select(roots, pool).rows.find((x) => x.m.id === id);
      if (!row) return view();
      if (row.link) {
        version++;
        links = links.filter((l) => l !== row.link);
        error = null;
        return view();
      }
      const m = row.m;
      version++;
      carriedSrc.delete(keyOf(m));
      removed = new Set([...removed, keyOf(m)]);
      carried = carried.filter((x) => keyOf(x) !== keyOf(m));
      pool = pool.filter((x) => keyOf(x) !== keyOf(m));
      error = null;
      return view();
    },
    async addUrl(url) {
      if (typeof url !== "string" || url.trim() === "") return view();
      if (busy) return reject(setupMain().urlBusy);
      busy = true;
      const g = gen;
      try {
        let found;
        try {
          found = (await collectUrlMaterials([url.trim()], { ...(deps.transport && { transport: deps.transport }), ...(deps.worker && { worker: deps.worker }), ...(deps.now && { now: deps.now }) }))[0]!;
        } catch (e) {
          if (!(e instanceof MaterialsError)) throw e;
          if (g !== gen) return view();
          return reject(e.reasons.join("\n"));
        }
        if (g !== gen) return view();
        const material: CollectedMaterial = { id: "", name: found.name, chars: found.text.length, sha256: sha256Of(found.text), text: found.text };
        const exists = [...carried, ...pool, ...links.map((l) => l.material)].some((m) => keyOf(m) === keyOf(material));
        if (!exists) links = [...links, { material, url: found.url, fetchedAt: found.fetchedAt }];
        version++;
        error = null;
        deps.logger?.info(`Link added to the set: ${safeUrl(found.url)}`);
        return view();
      } finally {
        busy = false;
      }
    },
    carry(materials, notes, sources = []) {
      version++;
      gen++;
      const seen = new Set<string>();
      carried = materials.filter((m) => !seen.has(keyOf(m)) && seen.add(keyOf(m)));
      carriedSrc = new Map(carried.flatMap((m) => { const s = sources.find((x) => x.id === m.id); return s ? [[keyOf(m), s] as const] : []; }));
      links = [];
      roots = [];
      pool = [];
      skipped = [];
      returned = new Map();
      removed = new Set();
      error = notes.length > 0 ? notes.join("\n") : null;
      return view();
    },
    clear() {
      version++;
      gen++;
      carried = [];
      carriedSrc = new Map();
      links = [];
      roots = [];
      pool = [];
      skipped = [];
      returned = new Map();
      removed = new Set();
      error = null;
      return view();
    },
    workspace,
    take: () => select(roots, pool).list.map((m) => ({ ...m })),
  };
}
