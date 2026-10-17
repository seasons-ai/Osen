import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionJournal, writeMaterialSnapshots } from "./journal.ts";
import { encodeSources, formatSource, materialSourcesPath, safeSource, safeUrl, writeMaterialSources } from "./material-sources.ts";
import { loadPreparedMaterials, preparedMaterialsDir, savePreparedMaterials } from "./prepared-materials.ts";
import { sha256Of } from "../materials.ts";

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MARKER = "SECRETq7";
const HOSTS = ["example.com", "example.com:8443", "example.com:443", "192.168.1.10", "[2606:4700::1]", "[2606:4700::1]:8080"];
const SEGMENTS = ["docs", "a%20b", "x%3Fy", "z%23w", "файл", "v1.2", "index.html"];
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(realpathSync(tmpdir()), "council-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function genUrl(r: () => number): URL {
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)]!;
  const n = pick([0, 0, 1, 2, 3]);
  let path = n === 0 ? "" : `/${Array.from({ length: n }, () => pick(SEGMENTS)).join("/")}`;
  if (path && r() < 0.3) path += "/";
  const query = pick([`x=${MARKER}`, `${MARKER}`, `a=/${MARKER}?b=c`, `?${MARKER}=?`, `k=${MARKER}&k2=`, `${MARKER}=`]);
  const frag = `${MARKER}${pick(["", "?x", "/p", "=1"])}`;
  const creds = r() < 0.4 ? `${MARKER}u:${MARKER}p@` : "";
  const form = pick([0, 1, 2]); // 0 — query and fragment, 1 — only query, 2 — fragment before the question mark
  const tail = form === 0 ? `?${query}#${frag}` : form === 1 ? `?${query}` : `#${frag}?x=${MARKER}`;
  return new URL(`${pick(["http", "https"])}://${creds}${pick(HOSTS)}${path}${tail}`);
}

describe("Immutable link snapshot: query and fragment are not saved", () => {
  it("marker gets neither into memory nor onto disk (500 cases)", () => {
    const r = mulberry32(20260101);
    const date = new Date(Date.UTC(2026, 0, 1));
    for (let i = 0; i < 500; i++) {
      const url = genUrl(r);
      const s = safeSource(url, "m1", date);
      const texts = [JSON.stringify(s), safeUrl(url), formatSource(s), encodeSources([s])];
      if (i % 10 === 0) {
        const dir = tmp();
        createSessionJournal(dir, "a");
        writeMaterialSnapshots(dir, "a", [{ id: "m1", text: "t" }]);
        writeMaterialSources(dir, "a", [s]);
        texts.push(readFileSync(materialSourcesPath(dir, "a"), "utf8"));
        const text = "текст";
        const set = savePreparedMaterials(dir, {
          materials: [{ id: "m1", name: "u", chars: text.length, sha256: sha256Of(text), text }],
          workspace: [], skipped: [], left: [], materialsChars: 1000, stamp: "s", sources: [s],
        });
        const setDir = join(preparedMaterialsDir(dir), set.id);
        texts.push(readFileSync(join(setDir, "sources.json"), "utf8"), readFileSync(join(setDir, "set.json"), "utf8"));
        expect(loadPreparedMaterials(dir, set.id).sources).toEqual([s]);
      }
      for (const t of texts) expect(t, url.href).not.toContain(MARKER);
      expect(s.pathname).toBe(url.pathname);
      expect(s.host).toBe(url.host);
    }
  });
});
