import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mcpMessages } from "./messages.ts";

// Reference of all ru values of the catalog, taken from the code before the texts changed (change 65): a string — as is,
// a function — an array of results on the argument sets from VARIANTS. A new function without a set is a test error.
const GOLDEN = join(import.meta.dirname, "__golden__/ru-messages.json");

const VARIANTS: Record<string, unknown[][]> = {
  scenarioUnavailable: [["S1"]],
  sessionNotFound: [["ID1"]],
  statusText: [["consensus"], ["no_consensus"], ["stopped"], ["failed"], ["interrupted"], ["running"]],
  statusDrafting: [[2, 3]],
  journalUndefined: [["NOTE"]],
  reasonSynthesizer: [["p2"], [""]],
  statusFWaitSec: [[50]],
  stopFinished: [["ST"]],
  stopNotDone: [["ST"]],
  startFMaxRounds: [[1, 20]],
  startFOwnerWaitSec: [[86400, 300]],
  startFAttachments: [[20000000]],
  startRoundsBounds: [[1, 20]],
  startOwnerWaitRange: [[86400]],
  startRelativePaths: [[["a/b", "c"]]],
  startLineupNotFound: [["L1"]],
  startLineupUnavailable: [["LN"]],
  startLineupNote: [[2, "prov", "mod", "NOTE"]],
  startProviderNotFound: [["zzz", ["claude", "codex"]], ["zzz", []]],
  startProviderNeedsModel: [["pid"]],
  startProviderUnavailable: [["LBL", "RSN"], ["LBL", null], ["LBL", undefined]],
  startNext: [[false, false], [true, false], [false, true], [true, true]],
  startNextDrafts: [["p2", "NAME", true, 12], ["p2", "NAME", false, 12]],
  startNextOwnerWait: [[300]],
  resumeFRounds: [[1, 20]],
  resumeBadRounds: [[1, 20]],
  resumeStaleWithReason: [["DETAIL"]],
  resumeJournalChanged: [["ID1"]],
  resumeReplacementUnavailable: [["RSN"], [undefined]],
  resumeReplacementDropped: [["RSN"], [null], [undefined]],
  resumeNextPlan: [[2, 12, 0, false], [2, 12, 5, false], [2, 12, 0, true], [2, 12, 5, true]],
  resumeNextAccepted: [["SID", 0], ["SID", 2]],
};

export function render(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mcpMessages("ru"))) {
    if (typeof value === "string") { out[key] = value; continue; }
    const variants = VARIANTS[key];
    if (!variants) throw new Error(`Для функции каталога ${key} нет набора аргументов в VARIANTS`);
    out[key] = variants.map((args) => (value as (...a: unknown[]) => string)(...args));
  }
  return out;
}

describe("mcpMessages catalog: ru values equal the reference", () => {
  it("the key set and every ru value equal the reference", () => {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, unknown>;
    const got = render();
    expect(Object.keys(got).sort()).toEqual(Object.keys(golden).sort());
    for (const key of Object.keys(golden)) expect(got[key], key).toEqual(golden[key]);
  });

  it("argument sets are defined only for catalog functions", () => {
    const fns = Object.entries(mcpMessages("ru")).filter(([, v]) => typeof v === "function").map(([k]) => k).sort();
    expect(Object.keys(VARIANTS).sort()).toEqual(fns);
  });
});

// change 104: the cap counts all model calls of the session (96), not only completed turns.
describe("The maxTotalTokens description names the core's sum rule", () => {
  const cases = {
    en: { must: [/model calls/, /failed attempts/, /file requests/, /drafts/], mustNot: /completed turns/ },
    ru: { must: [/вызов\S* моделей/, /неудачные попытки/, /запросы файлов/, /черновики/], mustNot: /завершённым ходам/ },
  } as const;
  for (const [lang, c] of Object.entries(cases)) {
    it(lang, () => {
      const d = mcpMessages(lang as "en" | "ru").startFMaxTotalTokens;
      for (const re of c.must) expect(d).toMatch(re);
      expect(d).not.toMatch(c.mustNot);
    });
  }
});
