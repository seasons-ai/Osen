import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedDriver, createSession, draftPath, runStoredSession } from "@model-council/core";
import type { ParticipantDriver } from "@model-council/core";
import { sessionDrafts } from "./drafts.ts";

const env = { COUNCIL_DEV: "1" };
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(realpathSync(tmpdir()), "council-drafts-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const reply = (stance: string, solution: string | null) => ({ response: { stance, reasoning: "r", solution, answers: [], questions: [] } });
async function run(dir: string, id: string, withDrafts: boolean) {
  const session = createSession(
    {
      topic: "Тема", framing: "", origin: "cli", limits: { maxRounds: 3, turnTimeoutSec: 30, contextChars: 20000 },
      ...(withDrafts ? { drafts: { synthesizerId: "p2" } } : {}),
      participants: [1, 2, 3].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })),
    },
    { maxParticipants: 8, id },
  );
  const drivers: Record<string, ParticipantDriver> = Object.fromEntries([1, 2, 3].map((i) => [
    `p${i}`, createScriptedDriver({ steps: [...(withDrafts ? [reply("amend", `Решение №${i}`)] : []), reply("amend", `Версия ${i}`), reply("agree", null), reply("agree", null)] }, env),
  ]));
  await runStoredSession({ session, drivers, dataDir: dir });
}

describe("sessionDrafts", () => {
  it("three drafts in participant order, text from snapshots", async () => {
    const dir = tmp();
    await run(dir, "a", true);
    const v = sessionDrafts(dir, "a");
    expect(v.map((d) => d.draftId)).toEqual(["d1", "d2", "d3"]);
    expect(v.map((d) => d.participantId)).toEqual(["p1", "p2", "p3"]);
    for (const d of v) {
      expect(d.text).toBe(`Решение №${d.draftId.slice(1)}`);
      expect(d.error).toBeNull();
      expect(d.attempts).toBeGreaterThan(0);
      expect(d.chars).toBe(d.text!.length);
      expect(d.reasoning).toBe("r");
    }
    expect(JSON.stringify(v)).not.toContain(dir);
  });

  it("changed snapshot: text null, the rest intact", async () => {
    const dir = tmp();
    await run(dir, "b", true);
    writeFileSync(draftPath(dir, "b", "d1"), "подмена");
    const v = sessionDrafts(dir, "b");
    expect(v[0]).toMatchObject({ text: null });
    expect(v[0]!.error).toContain("изменён");
    expect(v[1]!.text).toBe("Решение №2");
    expect(v[2]!.text).toBe("Решение №3");
    expect(JSON.stringify(v)).not.toContain(dir);
  });

  it("deleted snapshot: text null, \"missing\"", async () => {
    const dir = tmp();
    await run(dir, "c", true);
    unlinkSync(draftPath(dir, "c", "d2"));
    const v = sessionDrafts(dir, "c");
    expect(v[1]!.text).toBeNull();
    expect(v[1]!.error).toContain("отсутствует");
    expect(v[0]!.text).toBe("Решение №1");
    expect(JSON.stringify(v)).not.toContain(dir);
  });

  it("no phase and an unknown identifier give []", async () => {
    const dir = tmp();
    await run(dir, "d", false);
    expect(sessionDrafts(dir, "d")).toEqual([]);
    expect(sessionDrafts(dir, "nope")).toEqual([]);
  });
});
