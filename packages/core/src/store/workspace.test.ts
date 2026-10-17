import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSession } from "../engine.ts";
import { collectMaterials } from "../materials.ts";
import { createScriptedDriver, readScenario } from "../participants/scripted.ts";
import type { ParticipantDriver, TurnRequest } from "../participants/driver.ts";
import { folderStats } from "../protocol/folder.ts";
import type { FolderFile } from "../protocol/folder.ts";
import type { Session } from "../protocol/schema.ts";
import { createSessionJournal, eventsPath, MaterialSnapshotError, readEvents, readWorkspaceSnapshot, workspaceDir, writeWorkspaceSnapshot } from "./journal.ts";
import { planResume, ResumeRejectedError, runResumedSession } from "./resume.ts";
import { runStoredSession } from "./run.ts";

const scenarios = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scenarios");
const env = { COUNCIL_DEV: "1" };
let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "council-ws-"))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const FILES: FolderFile[] = [
  { name: "проект/src/б.ts", text: "бэ" },
  { name: "проект/README.md", text: "Привет 😀" },
  { name: "проект/src/а.ts", text: "а" },
];

const mk = (id: string, workspace: readonly FolderFile[] | undefined, maxRounds = 3): Session =>
  createSession(
    {
      topic: "Тема", framing: "", origin: "cli", limits: { maxRounds, turnTimeoutSec: 30, contextChars: 20000 },
      participants: [1, 2].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })),
      ...(workspace ? { workspace } : {}),
    },
    { maxParticipants: 8, id },
  );
const scripted = (...responses: object[]) =>
  createScriptedDriver({ steps: responses.map((response) => ({ response })) } as never, env);
const body = (stance: string, solution: string | null, files: string[] = []) =>
  ({ stance, reasoning: "r", solution, answers: [], questions: [], files });

describe("folder snapshot: write and read", () => {
  it("11. nested folders, Cyrillic, order by name", () => {
    createSessionJournal(dir, "a");
    writeWorkspaceSnapshot(dir, "a", FILES);
    const got = readWorkspaceSnapshot(dir, "a");
    expect(got.map((f) => f.name)).toEqual(["проект/README.md", "проект/src/а.ts", "проект/src/б.ts"]);
    for (const f of got) expect(f.text).toBe(FILES.find((x) => x.name === f.name)!.text);
  });

  it("12. name outside snapshot: error and no writes", () => {
    for (const bad of ["../x.txt", "/etc/x.txt", ""]) {
      createSessionJournal(dir, `b${bad.length}`);
      const id = `b${bad.length}`;
      expect(() => writeWorkspaceSnapshot(dir, id, [{ name: "ok/a.txt", text: "1" }, { name: bad, text: "2" }])).toThrow(MaterialSnapshotError);
      expect(existsSync(workspaceDir(dir, id))).toBe(false);
    }
  });

  it("13. empty list, no folder, link skipped", () => {
    createSessionJournal(dir, "c");
    writeWorkspaceSnapshot(dir, "c", []);
    expect(existsSync(workspaceDir(dir, "c"))).toBe(false);
    expect(readWorkspaceSnapshot(dir, "c")).toEqual([]);
    writeWorkspaceSnapshot(dir, "c", [{ name: "d/a.txt", text: "1" }]);
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "чужой");
    symlinkSync(outside, join(workspaceDir(dir, "c"), "d", "link.txt"));
    symlinkSync(dir, join(workspaceDir(dir, "c"), "dirlink"));
    expect(readWorkspaceSnapshot(dir, "c")).toEqual([{ name: "d/a.txt", text: "1" }]);
  });
});

describe("runStoredSession with folder", () => {
  it("14. files on disk by session_created, no names in journal", async () => {
    const session = mk("r", FILES);
    let atCreated: FolderFile[] | null = null;
    const run = await runStoredSession({
      session, workspace: FILES, dataDir: dir,
      drivers: { p1: scripted(body("amend", "R")), p2: scripted(body("agree", null)) },
      onEvent: (e) => { if (e.type === "session_created") atCreated = readWorkspaceSnapshot(dir, "r"); },
    });
    expect(atCreated).toHaveLength(3);
    const created = readEvents(dir, "r")!.events[0]!;
    expect(created.type === "session_created" && created.session.workspace).toEqual(folderStats(FILES));
    expect(run.state.finish?.status).toBe("consensus");
    const journal = readFileSync(eventsPath(dir, "r"), "utf8");
    for (const f of FILES) expect(journal).not.toContain(f.name);
  });
});

describe("continuation with folder", () => {
  const prior = async (id: string, workspace: FolderFile[] | undefined) => {
    await runStoredSession({
      session: mk(id, workspace, 1), dataDir: dir, ...(workspace ? { workspace } : {}),
      drivers: { p1: scripted(body("amend", "v1")), p2: scripted(body("object", null)) },
    });
  };

  it("15. file request served from disk; file loss — refusal; without folder as before", async () => {
    await prior("s", FILES);
    const plan = planResume(dir, "s", { rounds: 1, isAlive: () => false });
    expect(plan.workspace).toHaveLength(3);
    const prompts: string[] = [];
    let n = 0;
    const p1b: ParticipantDriver = {
      call: (req: TurnRequest) => {
        prompts.push(req.prompt);
        return scripted(n++ === 0 ? body("object", null, ["проект/src/а.ts"]) : body("agree", null)).call(req);
      },
    };
    const run = await runResumedSession({ dataDir: dir, plan, drivers: { p1: p1b, p2: scripted(body("agree", null)) }, isAlive: () => false });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("# Запрошенные файлы");
    expect(run.events.find((e) => e.type === "turn_completed")).toBeTruthy();

    await prior("lost", FILES);
    rmSync(join(workspaceDir(dir, "lost"), "проект", "README.md"));
    let err: unknown;
    try { planResume(dir, "lost", { rounds: 1, isAlive: () => false }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ResumeRejectedError);
    expect((err as ResumeRejectedError).reason).toBe("material");
    expect((err as Error).message).toContain("Снимок папки не совпадает");

    await prior("plain", undefined);
    expect(planResume(dir, "plain", { rounds: 1, isAlive: () => false })).not.toHaveProperty("workspace");
  });
});

describe("folder end-to-end scenario", () => {
  it("16. p1 reads a file, p2 agrees", async () => {
    const sample = realpathSync(join(scenarios, "folder", "sample"));
    const set = collectMaterials([sample], { materialsChars: Number.MAX_SAFE_INTEGER, materialsIgnore: [] });
    const files: FolderFile[] = set.materials.map((m) => ({ name: m.name, text: m.text }));
    expect(files.map((f) => f.name)).toContain("sample/src/engine.ts");
    const drivers = {
      p1: createScriptedDriver(await readScenario(join(scenarios, "folder", "p1.json")), env),
      p2: createScriptedDriver(await readScenario(join(scenarios, "folder", "p2.json")), env),
    };
    const run = await runStoredSession({ session: mk("e2e", files), workspace: files, drivers, dataDir: dir });
    expect(run.state.finish?.status).toBe("consensus");
    const turns = run.events.filter((e) => e.type === "turn_completed");
    expect(turns[0]).toMatchObject({ attempts: 2 });
    expect((turns[0] as { filesRead: { name: string }[] }).filesRead[0]!.name).toBe("sample/src/engine.ts");
    expect(run.events.filter((e) => e.type === "turn_failed")).toHaveLength(0);
  });
});
