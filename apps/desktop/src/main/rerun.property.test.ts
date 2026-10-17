import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import type { Language } from "@model-council/core/i18n";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, createSessionJournal } from "@model-council/core";
import type { Session, SessionEvent, TemplateCatalog } from "@model-council/core";
import { createMaterialsDraft } from "./materials.ts";
import { prepareRerun } from "./rerun.ts";

// Own seeded generator: fast-check is not used.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const created = new Date(2026, 2, 5, 12, 0, 0);
const ts = created.toISOString();
const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
const catalog = () => ({ templates: [], errors: [], neutralFraming: "" }) as unknown as TemplateCatalog;
const NAME = {
  en: { choice: (n: number) => `Owner's choice: version ${n} of the previous session 2026-03-05`, decision: (n: number) => `Solution of the previous session: version ${n}, 2026-03-05` },
  ru: { choice: (n: number) => `Выбор владельца: версия ${n} прошлой сессии 2026-03-05`, decision: (n: number) => `Решение прошлой сессии: версия ${n}, 2026-03-05` },
};

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "council-rerun-prop-"))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); setProcessLanguage("ru"); });

describe("Discuss further from the result: the choice is carried, otherwise the result", () => {
  it("300 seeds: text and name by the owner choice, otherwise by the final version", () => {
    const seen = { choice: 0, decision: 0, missingSel: 0, selBeforeLater: 0, finMissing: 0, finAbsent: 0 };
    for (let seed = 1; seed <= 300; seed++) {
      const r = mulberry32(seed);
      const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
      const lang: Language = seed % 2 ? "en" : "ru";
      const n = int(1, 6);
      const finKind = int(0, 2); // 0 present, 1 absent, 2 number missing
      const fin = finKind === 0 ? int(1, n) : finKind === 2 ? n + int(1, 3) : null;
      const selKind = int(0, 3); // 0 none, 1 present, 2 number missing, 3 present and earlier than a later resume
      const sel = selKind === 1 || selKind === 3 ? int(1, n) : selKind === 2 ? n + int(1, 3) : null;
      const selAfter = selKind === 3 ? int(1, n) : n; // choice after version selAfter, then versions continue

      const id = `s${seed}`;
      const session: Session = { id, createdAt: ts, origin: "desktop", topic: "Т", templateId: null, framing: "Р", participants: [{ id: "p1", name: "n1", providerId: "scripted", model: "m", role: null }, { id: "p2", name: "n2", providerId: "scripted", model: "m", role: null }], limits: { maxRounds: 4, turnTimeoutSec: 60, contextChars: 1000 } };
      createSessionJournal(dir, id);
      const body: unknown[] = [{ type: "session_created", session, pid: deadPid }];
      for (let v = 1; v <= n; v++) {
        body.push({ type: "turn_started", turn: v, round: 1, participantId: "p1" },
          { type: "turn_completed", turn: v, round: 1, participantId: "p1", stance: "amend", normalized: false, reasoning: "ok", solution: `T${seed}-${v}`, version: v, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 1 });
        if (sel !== null && v === selAfter) body.push({ type: "owner_selected_version", version: sel, statusAtSelection: "no_consensus" });
      }
      if (fin !== null) body.push({ type: "session_finished", status: "no_consensus", version: fin, agreed: [], objectors: [] });
      body.forEach((e, i) => appendEvent(dir, id, { ...(e as object), seq: i + 1, ts } as SessionEvent));

      setProcessLanguage(lang);
      const d = createMaterialsDraft({ limits: () => ({ materialsChars: 100_000, materialsIgnore: [] }) });
      const v = prepareRerun({ dataDir: dir, catalog, materials: d }, id, true);
      const name = v.materials.items.at(-1)!.name;
      const text = d.take().at(-1)!.text;

      const selOk = sel !== null && sel <= n;
      const finOk = fin !== null && fin <= n;
      const want = selOk ? sel : finOk ? fin : n;
      const ctx = `seed ${seed} ${lang} n=${n} fin=${fin} sel=${sel}@${selAfter}`;
      expect(text, ctx).toBe(`T${seed}-${want}`);
      expect(name, ctx).toBe(NAME[lang][selOk ? "choice" : "decision"](want));
      selOk ? seen.choice++ : seen.decision++;
      if (selKind === 2) seen.missingSel++;
      if (selKind === 3 && selAfter < n) seen.selBeforeLater++;
      if (finKind === 2) seen.finMissing++;
      if (finKind === 1) seen.finAbsent++;
    }
    for (const [k, c] of Object.entries(seen)) expect(c, k).toBeGreaterThan(0);
  });
});
