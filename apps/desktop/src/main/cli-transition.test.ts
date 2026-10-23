import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderStatus } from "@model-council/core";
import { setProcessLanguage } from "@model-council/core/i18n";
import { installedPath, pinsPath, readPins, versionDir } from "../../../../packages/core/src/cli-agents/pins.ts";
import type { CandidatesReport } from "../../../../packages/core/src/cli-agents/candidates.ts";
import { VERIFIED_FILE } from "../../../../packages/core/src/cli-agents/verified-record.ts";
import { detachExecutable, linkExecutable } from "../../../../packages/core/src/executable.testutil.ts";
import { settings as catalog } from "../shared/messages/settings.ts";
import { REMINDER_FILE, createCliTransition, readReminder, reminderPath } from "./cli-transition.ts";
import type { CliTransitionApi, CliTransitionDeps } from "./cli-transition.ts";
import { guardedPinStatus, installVersions, pinsBytes, record } from "./cli-transition.testutil.ts";
import { SettingsError } from "./settings.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-01T00:00:00Z"); // the moment pins are made

let dir: string;
let ms: number;
let logs: string[];
let running: boolean;
let checked: number;
let listCalls: string[];
let releases: Record<string, string[]>;
let releasesError: Error | null;
let fetchScript: string;
let hook: (() => Promise<void>) | null;
const clock = () => new Date(ms);
const logger = { info: (m: string) => { logs.push(`I ${m}`); }, error: (m: string) => { logs.push(`E ${m}`); } };

function make(over: Partial<CliTransitionDeps> = {}): CliTransitionApi {
  return createCliTransition({
    dataDir: dir, logger, now: clock, monotonic: () => ms, running: () => running, onChecked: () => { checked++; }, resetDiscovery: vi.fn(),
    candidateDeps: () => ({
      releases: {
        async list(agent) {
          listCalls.push(agent);
          if (hook) await hook();
          if (releasesError) throw releasesError;
          return releases[agent] ?? [];
        },
      },
      source: {
        async fetch(agent, version, d) {
          const exe = join(d, "bin", agent);
          mkdirSync(join(d, "bin"), { recursive: true });
          linkExecutable(exe, fetchScript);
          writeFileSync(`${exe}.version`, `${version} (fake)\n`);
          return { executable: exe, source: `fake:${agent}@${version}` };
        },
      },
    }),
    ...over,
  });
}

const status = (over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id: "claude", kind: "cli", label: "Claude Code", available: true, models: [], modelsConfirmed: false,
  source: "pin", verified: { level: "real", checkedAt: "2026-10-07" }, ...over,
});
const reminderRaw = () => readFileSync(reminderPath(dir), "utf8");
const names = () => readdirSync(dir).sort();

/** claude 7.0.0 active since T0; 7.1.0 real and installed; 7.2.0 real, in the record only; 7.3.0 interface only. */
async function seedPins(): Promise<void> {
  record(dir, "claude", "7.0.0", "real", "2026-08-30");
  record(dir, "claude", "7.1.0", "real", "2026-10-07");
  await installVersions(dir, "claude", [{ version: "7.0.0" }, { version: "7.1.0" }], () => new Date(T0));
}

beforeEach(() => {
  setProcessLanguage("en");
  dir = mkdtempSync(join(tmpdir(), "cli-transition-"));
  ms = T0;
  logs = []; running = false; checked = 0; listCalls = []; releases = {}; releasesError = null; hook = null;
  fetchScript = '#!/bin/sh\ncase "$1" in --version) /bin/cat "$0.version";; esac\n';
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); setProcessLanguage("en"); });

describe("Requirement: Ежесуточная проверка кандидатов без вызовов моделей", () => {
  it("first check writes the file with the time and the outcome, no model calls, one list call", async () => {
    await seedPins();
    ms = T0 + 5 * DAY;
    releases = { claude: ["7.0.0"] };
    await make().maybeCheck();
    expect(JSON.parse(reminderRaw())).toEqual({ schemaVersion: 1, periodDays: 30, lastCheck: { at: "2026-09-06T00:00:00Z", candidates: [], failures: [] } });
    expect(reminderRaw().endsWith("}\n")).toBe(true);
    expect(listCalls).toEqual(["claude"]);
    expect(checked).toBe(1);
    expect(logs.filter((l) => l.startsWith("I CLI candidate check finished"))).toHaveLength(1);
  });

  it("23 hours after the attempt: no check; 25 hours: exactly one", async () => {
    await seedPins();
    const t = make();
    await t.maybeCheck();
    ms += 23 * HOUR;
    await t.maybeCheck();
    expect(listCalls).toHaveLength(1);
    ms += 2 * HOUR;
    await t.maybeCheck();
    await t.maybeCheck();
    expect(listCalls).toHaveLength(2);
    expect(JSON.parse(reminderRaw()).lastCheck.at).toBe("2026-09-02T01:00:00Z");
  });

  const validFile = (at: string) => `${JSON.stringify({ schemaVersion: 1, periodDays: 30, lastCheck: { at, candidates: [], failures: [] } }, null, 2)}\n`;
  const stampOf = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");

  it("the reminder file cannot be written: one check in 23 hourly ticks, the card shows the write failure, the file keeps its bytes; the 24th hour runs it again", async () => {
    await seedPins();
    ms = T0 + 10 * DAY;
    const original = validFile(stampOf(ms - 2 * DAY));
    writeFileSync(reminderPath(dir), original);
    chmodSync(reminderPath(dir), 0o444);
    try {
      const t = make();
      await t.maybeCheck();
      for (let i = 0; i < 23; i++) { ms += HOUR; await t.maybeCheck(); }
      expect(listCalls).toHaveLength(1);
      expect(reminderRaw()).toBe(original);
      expect((await t.forProvider("claude", status())).check).toMatchObject({ at: stampOf(T0 + 10 * DAY), notSaved: { code: "EACCES" } });
      expect(logs.some((l) => l.startsWith("E CLI candidate check result not saved"))).toBe(true);
      ms += HOUR;
      await t.maybeCheck();
      expect(listCalls).toHaveLength(2);
      expect(reminderRaw()).toBe(original);
    } finally {
      chmodSync(reminderPath(dir), 0o644);
    }
  });

  const installFile = (agent: "claude" | "codex", version: string): string => {
    const p = readPins(dir);
    if (p.state !== "loaded") throw new Error("no pins");
    return installedPath(dir, agent, p.pins.agents[agent]!.installed.find((i) => i.version === version)!);
  };

  it("after rollback: no switch to a damaged install (scenario «После отката нет перехода на неисправную установку»)", async () => {
    await seedPins();
    const intact = await make().forProvider("claude", status());
    expect(intact.target).toMatchObject({ version: "7.1.0" });
    expect(intact.broken).toEqual([]);
    detachExecutable(installFile("claude", "7.1.0"));
    appendFileSync(installFile("claude", "7.1.0"), "# changed after installation\n");
    const c = await make().forProvider("claude", status());
    expect(c.target).toBeNull();
    expect(c.install).toBeNull();
    expect(c.broken).toEqual([{ version: "7.1.0", code: "sha256_mismatch" }]);
  });

  it("the install file is missing: the older intact install is the target, the damaged one is listed, no install command (scenario «Файл установки отсутствует»)", async () => {
    record(dir, "claude", "7.0.0", "real", "2026-08-30");
    record(dir, "claude", "7.1.0", "real", "2026-10-07");
    record(dir, "claude", "7.2.0", "real", "2026-10-15");
    await installVersions(dir, "claude", [{ version: "7.0.0" }, { version: "7.1.0" }, { version: "7.2.0" }], () => new Date(T0));
    rmSync(installFile("claude", "7.2.0"));
    const c = await make().forProvider("claude", status());
    expect(c.target).toMatchObject({ version: "7.1.0" });
    expect(c.broken).toEqual([{ version: "7.2.0", code: "missing" }]);
    expect(c.install).toBeNull();
  });

  it("the write failure of the reminder file leaves no absolute path in the view; the path stays in the app log (scenario «Ежесуточная проверка: сбой записи без пути в окне»)", async () => {
    await seedPins();
    ms = T0 + 10 * DAY;
    writeFileSync(reminderPath(dir), validFile(stampOf(ms - 2 * DAY)));
    chmodSync(reminderPath(dir), 0o444);
    try {
      const t = make();
      await t.maybeCheck();
      const c = await t.forProvider("claude", status());
      expect(c.check?.notSaved).toEqual({ code: "EACCES" });
      const json = JSON.stringify(c);
      expect(json).not.toContain(REMINDER_FILE);
      expect(json).not.toContain(dir);
      expect(logs.some((l) => l.startsWith("E ") && l.includes(reminderPath(dir)))).toBe(true);
    } finally {
      chmodSync(reminderPath(dir), 0o644);
    }
  });

  it("a recorded attempt later than now is stale: the next tick runs the check and records the current time", async () => {
    await seedPins();
    ms = T0 + 10 * DAY;
    writeFileSync(reminderPath(dir), validFile(stampOf(ms + 3 * DAY)));
    await make().maybeCheck();
    expect(listCalls).toHaveLength(1);
    expect(JSON.parse(reminderRaw()).lastCheck.at).toBe(stampOf(ms));
    expect(logs.some((l) => l.includes("treated as stale"))).toBe(true);
  });

  it("a wall clock jump forward does not shorten the in-process gate", async () => {
    await seedPins();
    let mono = 0;
    const t = make({ monotonic: () => mono });
    await t.maybeCheck();
    ms += 3 * DAY;
    mono += HOUR;
    await t.maybeCheck();
    expect(listCalls).toHaveLength(1);
    mono += 23 * HOUR;
    await t.maybeCheck();
    expect(listCalls).toHaveLength(2);
  });

  it("no pins: no check and no file", async () => {
    await make().maybeCheck();
    expect(listCalls).toHaveLength(0);
    expect(names()).toEqual([]);
  });

  it("source failure: attempt recorded with the code, logged, no retry before 24 hours", async () => {
    await seedPins();
    releasesError = new Error("registry down");
    const t = make();
    await t.maybeCheck();
    expect(JSON.parse(reminderRaw()).lastCheck).toEqual({ at: "2026-09-01T00:00:00Z", candidates: [], failures: [{ agent: "claude", code: "source_unavailable" }] });
    expect(logs.some((l) => l.startsWith("E CLI candidate check finished with failures: claude=source_unavailable"))).toBe(true);
    ms += 23 * HOUR;
    await t.maybeCheck();
    expect(listCalls).toHaveLength(1);
    expect((await t.forProvider("claude", status())).check).toEqual({ at: "2026-09-01T00:00:00Z", outcome: "source_unavailable" });
  });

  it("a thrown check is stored as check_failed for every checked agent", async () => {
    await seedPins();
    record(dir, "codex", "5.0.0", "real");
    await installVersions(dir, "codex", [{ version: "5.0.0" }], () => new Date(T0));
    await make({ check: async () => { throw new Error("boom"); } }).maybeCheck();
    expect(JSON.parse(reminderRaw()).lastCheck.failures).toEqual([{ agent: "claude", code: "check_failed" }, { agent: "codex", code: "check_failed" }]);
    expect(logs.some((l) => l.startsWith("E CLI candidate check threw"))).toBe(true);
  });

  it("damaged file: not changed, no check, the view names the file", async () => {
    await seedPins();
    writeFileSync(reminderPath(dir), "{not json");
    const t = make();
    await t.maybeCheck();
    expect(reminderRaw()).toBe("{not json");
    expect(listCalls).toHaveLength(0);
    const v = t.settingsView();
    expect(v.periodDays).toBe(30);
    expect(v.fileError).toContain(reminderPath(dir));
    expect(v.fileError).toContain("not valid JSON");
  });

  it("a file that fails the schema is also damaged and left alone", async () => {
    await seedPins();
    const bad = JSON.stringify({ schemaVersion: 1, periodDays: 400, lastCheck: null });
    writeFileSync(reminderPath(dir), bad);
    await make().maybeCheck();
    expect(reminderRaw()).toBe(bad);
    expect(readReminder(dir).state).toBe("broken");
  });

  it("the file breaks while the check runs: the result is not written over it", async () => {
    await seedPins();
    hook = async () => { writeFileSync(reminderPath(dir), "oops"); };
    await make().maybeCheck();
    expect(reminderRaw()).toBe("oops");
    expect(checked).toBe(0);
  });

  it("two overlapping calls run one check", async () => {
    await seedPins();
    let release!: () => void;
    hook = () => new Promise<void>((r) => { release = r; });
    const t = make();
    const a = t.maybeCheck();
    await vi.waitFor(() => expect(listCalls).toHaveLength(1));
    await t.maybeCheck();
    release();
    await a;
    expect(listCalls).toHaveLength(1);
  });

  it("a newer candidate found: pins.json bytes are the same; a violating one leaves the record alone too", async () => {
    await seedPins();
    releases = { claude: ["7.0.0", "7.5.0"] };
    const pinsBefore = pinsBytes(dir);
    const recBefore = readFileSync(join(dir, VERIFIED_FILE), "utf8");
    await make().maybeCheck(); // the stub prints only --version: help unread → violates
    const last = JSON.parse(reminderRaw()).lastCheck;
    expect(last.candidates).toHaveLength(1);
    expect(last.candidates[0]).toMatchObject({ agent: "claude", version: "7.5.0", status: "violates" });
    expect(pinsBytes(dir)).toBe(pinsBefore);
    expect(readFileSync(join(dir, VERIFIED_FILE), "utf8")).toBe(recBefore);
  });

  it("a candidate that passes only adds an interface record entry; pins.json stays", async () => {
    await seedPins();
    releases = { claude: ["7.5.0"] };
    const help = readFileSync(new URL("../../../../packages/core/src/cli-agents/fixtures/claude-2.1.288-help.txt", import.meta.url), "utf8");
    const helpFile = join(dir, "help.txt");
    writeFileSync(helpFile, help);
    fetchScript = `#!/bin/sh\ncase "$1" in --version) /bin/cat "$0.version";; --help) /bin/cat '${helpFile}';; esac\n`;
    const pinsBefore = pinsBytes(dir);
    await make().maybeCheck();
    expect(JSON.parse(reminderRaw()).lastCheck.candidates[0]).toMatchObject({ version: "7.5.0", status: "ok", recorded: true });
    expect(pinsBytes(dir)).toBe(pinsBefore);
    expect(readPins(dir)).toMatchObject({ state: "loaded" });
  });
});

describe("Requirement: Выход из приложения посреди проверки", () => {
  const prefixes = () => (existsSync(join(dir, "cli-candidates")) ? readdirSync(join(dir, "cli-candidates")) : []);

  it("quit mid-check aborts the install and removes its prefix; the partial result is not written", async () => {
    await seedPins();
    releases = { claude: ["7.5.0"] };
    let aborted = false;
    const t = make({
      candidateDeps: () => ({
        releases: { list: async () => ["7.5.0"] },
        source: {
          fetch: (_agent, _version, _dir, signal) => new Promise((_, reject) => {
            signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
          }),
        },
      }),
    });
    const run = t.maybeCheck();
    await vi.waitFor(() => expect(prefixes()).toHaveLength(1));
    await t.stop();
    expect(aborted).toBe(true);
    expect(existsSync(join(dir, "cli-candidates"))).toBe(false);
    await run;
    expect(existsSync(reminderPath(dir))).toBe(false);
    expect(checked).toBe(0);
    expect(logs).toContain("I CLI candidate check stopped at quit");
    await t.maybeCheck(); // no new check after stop
    expect(prefixes()).toEqual([]);
  });

  it("a check that ignores the signal holds quit for 5 s at most; its prefix stays", async () => {
    await seedPins();
    vi.useFakeTimers();
    try {
      const t = make({
        check: async (data) => {
          mkdirSync(join(data, "cli-candidates", "claude-7.5.0-x"), { recursive: true });
          return new Promise<CandidatesReport>(() => {});
        },
      });
      void t.maybeCheck();
      await vi.waitFor(() => expect(prefixes()).toHaveLength(1));
      let done = false;
      void t.stop().then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      expect(prefixes()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop with no check running resolves at once", async () => {
    await make().stop();
  });
});

describe("Requirement: Срок планового перехода", () => {
  it("default 30 without creating the file", async () => {
    const t = make();
    expect(t.settingsView()).toMatchObject({ periodDays: 30, fileError: null, running: false });
    await t.forProvider("claude", status());
    expect(names()).toEqual([]);
  });

  it("saving 14 writes the exact file and keeps the previous check; no check is started", async () => {
    await seedPins();
    const t = make();
    await t.maybeCheck();
    const before = JSON.parse(reminderRaw());
    t.setPeriod(14);
    expect(JSON.parse(reminderRaw())).toEqual({ ...before, periodDays: 14 });
    expect(reminderRaw()).toBe(`${JSON.stringify({ ...before, periodDays: 14 }, null, 2)}\n`);
    expect(t.settingsView().periodDays).toBe(14);
    expect(listCalls).toHaveLength(1);
    expect(names().some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it.each([0, 400, 7.5, "30", null, Number.NaN, -1])("%s is refused with the bounds, the file is untouched", (bad) => {
    const t = make();
    expect(() => t.setPeriod(bad)).toThrow(SettingsError);
    expect(() => t.setPeriod(bad)).toThrow(catalog().intRange(1, 365));
    expect(names()).toEqual([]);
    t.setPeriod(20);
    const kept = reminderRaw();
    expect(() => t.setPeriod(bad)).toThrow(SettingsError);
    expect(reminderRaw()).toBe(kept);
  });

  it("a write error keeps the old bytes and leaves no temp file", () => {
    const t = make();
    t.setPeriod(20);
    const kept = reminderRaw();
    chmodSync(reminderPath(dir), 0o444);
    try {
      expect(() => t.setPeriod(10)).toThrow(/EACCES/);
      expect(reminderRaw()).toBe(kept);
      expect(names()).toEqual([REMINDER_FILE]);
      expect(t.settingsView().periodDays).toBe(20);
    } finally {
      chmodSync(reminderPath(dir), 0o644);
    }
  });

  it("the settings view carries no absolute path outside fileError (healthy and damaged file)", () => {
    const check = () => {
      const view = make().settingsView();
      const { fileError, ...rest } = view;
      expect(Object.keys(view).sort()).toEqual(["fileError", "periodDays", "running"]);
      const walk = (x: unknown): void => {
        if (typeof x === "string") expect(x.startsWith("/")).toBe(false);
        else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) { expect(k).not.toBe("file"); walk(v); }
      };
      walk(rest);
      return fileError;
    };
    expect(check()).toBeNull();
    writeFileSync(reminderPath(dir), "garbage");
    expect(check()).toContain(reminderPath(dir));
  });

  it("a damaged file is replaced only by the explicit save", () => {
    writeFileSync(reminderPath(dir), "garbage");
    const t = make();
    expect(t.settingsView().fileError).not.toBeNull();
    t.setPeriod(7);
    expect(JSON.parse(reminderRaw())).toEqual({ schemaVersion: 1, periodDays: 7, lastCheck: null });
    expect(t.settingsView().fileError).toBeNull();
  });

  it("the file is the same bytes after saving on en and on ru, and after a check", async () => {
    const out: string[] = [];
    for (const lang of ["en", "ru"] as const) {
      setProcessLanguage(lang);
      dir = mkdtempSync(join(tmpdir(), "cli-transition-lang-"));
      await seedPins();
      releasesError = new Error("registry down");
      const t = make();
      await t.maybeCheck();
      t.setPeriod(14);
      out.push(reminderRaw());
      rmSync(dir, { recursive: true, force: true });
    }
    expect(out[0]).toBe(out[1]);
    expect(out[0]).not.toMatch(/[А-Яа-яЁё]/);
    dir = mkdtempSync(join(tmpdir(), "cli-transition-")); // for afterEach
  }, 60_000);
});

describe("Requirement: Переход и откат из карточки", () => {
  it("card transition and rollback: pin failed the pre-launch check still gives source pin and previous", async () => {
    const unavailable = await guardedPinStatus(dir, new Date(T0));
    const c = await make().forProvider("claude", unavailable);
    expect(c.source).toBe("pin");
    expect(c.pin).toMatchObject({ version: "2.1.288", previous: "2.1.280" });
  });
});

describe("Requirement: Напоминание о плановом переходе и о кандидате", () => {
  it("term over, installed real version: due and the switch target; nothing changes in pins", async () => {
    await seedPins();
    ms = T0 + 40 * DAY;
    const before = pinsBytes(dir);
    const c = await make().forProvider("claude", status());
    expect(c.pin).toEqual({ version: "7.0.0", activatedAt: "2026-09-01T00:00:00Z", ageDays: 40, previous: null });
    expect(c.due).toEqual({ from: "7.0.0", to: "7.1.0", ageDays: 40, acceptedAt: "2026-10-07" });
    expect(c.target).toEqual({ version: "7.1.0", acceptedAt: "2026-10-07" });
    expect(c.install).toBeNull();
    expect(pinsBytes(dir)).toBe(before);
  });

  it("term not over: no reminder, the switch target is still there", async () => {
    await seedPins();
    ms = T0 + 10 * DAY;
    const c = await make().forProvider("claude", status());
    expect(c.due).toBeNull();
    expect(c.target).toEqual({ version: "7.1.0", acceptedAt: "2026-10-07" });
  });

  it("term over but only an interface candidate is newer: no reminder, a candidate line, no button", async () => {
    record(dir, "claude", "7.0.0", "real");
    record(dir, "claude", "7.3.0", "interface");
    await installVersions(dir, "claude", [{ version: "7.0.0" }], () => new Date(T0));
    ms = T0 + 40 * DAY;
    const c = await make().forProvider("claude", status());
    expect(c).toMatchObject({ due: null, target: null, install: null, candidates: [{ version: "7.3.0" }] });
  });

  it("real version in the record but not installed: the install command instead of a button", async () => {
    await seedPins();
    record(dir, "claude", "7.2.0", "real", "2026-10-15");
    ms = T0 + 40 * DAY;
    const c = await make().forProvider("claude", status());
    expect(c.due).toMatchObject({ to: "7.2.0", acceptedAt: "2026-10-15" });
    expect(c.target).toMatchObject({ version: "7.1.0" });
    expect(c.install).toEqual({ version: "7.2.0", command: "council cli install claude --version 7.2.0" });
  });

  it("only an uninstalled real version: no target, install command", async () => {
    record(dir, "claude", "7.0.0", "real");
    record(dir, "claude", "7.2.0", "real");
    await installVersions(dir, "claude", [{ version: "7.0.0" }], () => new Date(T0));
    const c = await make().forProvider("claude", status());
    expect(c.target).toBeNull();
    expect(c.install?.command).toBe("council cli install claude --version 7.2.0");
  });

  it("the period changes without a new check", async () => {
    await seedPins();
    ms = T0 + 20 * DAY;
    const t = make();
    expect((await t.forProvider("claude", status())).due).toBeNull();
    t.setPeriod(14);
    expect((await t.forProvider("claude", status())).due).toMatchObject({ ageDays: 20 });
    expect(listCalls).toHaveLength(0);
  });

  it("no activation date: age unknown, no reminder, the target stays", async () => {
    await seedPins();
    const pins = JSON.parse(pinsBytes(dir));
    pins.agents.claude.activatedAt = null;
    writeFileSync(pinsPath(dir), `${JSON.stringify(pins, null, 2)}\n`);
    ms = T0 + 400 * DAY;
    const c = await make().forProvider("claude", status());
    expect(c.pin).toEqual({ version: "7.0.0", activatedAt: null, ageDays: null, previous: null });
    expect(c.due).toBeNull();
    expect(c.target).toMatchObject({ version: "7.1.0" });
  });

  it("PATH and explicit path: no reminder or target; the pin is shown for explicit only", async () => {
    await seedPins();
    ms = T0 + 40 * DAY;
    const t = make();
    const explicit = await t.forProvider("claude", status({ source: "explicit" }));
    expect(explicit).toMatchObject({ source: "explicit", due: null, target: null, install: null, candidates: [], violations: [], check: null });
    expect(explicit.pin?.version).toBe("7.0.0");
    const path = await t.forProvider("codex", status({ id: "codex", source: "path", verified: { level: "none", checkedAt: null } }));
    expect(path).toMatchObject({ agent: "codex", source: "path", level: "none", checkedAt: null, pin: null, due: null });
    expect((await t.forProvider("claude", status({ source: undefined }))).source).toBeNull();
  });

  it("a candidate that violates the contract is shown with the missing names, no buttons", async () => {
    await seedPins();
    const report: CandidatesReport = {
      bases: { claude: "7.0.0" }, interrupted: false, code: 0, failures: [],
      candidates: [{ agent: "claude", version: "7.9.0", status: "violates", recorded: false, violations: [{ code: "missing_flag", name: "--tools" }] }],
    };
    const t = make({ check: async () => report });
    await t.maybeCheck();
    const c = await t.forProvider("claude", status());
    expect(c.violations).toEqual([{ version: "7.9.0", names: ["--tools"] }]);
    expect(c.check).toEqual({ at: "2026-09-01T00:00:00Z", outcome: "ok" });
    expect(c.target).toMatchObject({ version: "7.1.0" });
  });
});

describe("Requirement: Переход и откат из карточки", () => {
  const sessionTree = () => {
    mkdirSync(join(dir, "sessions", "s1"), { recursive: true });
    writeFileSync(join(dir, "sessions", "s1", "journal.jsonl"), '{"seq":1}\n');
  };
  const journal = () => readFileSync(join(dir, "sessions", "s1", "journal.jsonl"), "utf8");

  it("switch: 7.1.0 active, 7.0.0 previous, activatedAt from the clock, journals untouched", async () => {
    await seedPins();
    sessionTree();
    ms = T0 + 3 * DAY; // out of term
    const reset = vi.fn();
    make({ resetDiscovery: reset }).switchCli("claude", "7.1.0");
    expect(JSON.parse(pinsBytes(dir)).agents.claude).toMatchObject({ active: "7.1.0", previous: "7.0.0", activatedAt: "2026-09-04T00:00:00Z" });
    expect(reset).toHaveBeenCalledOnce();
    expect(journal()).toBe('{"seq":1}\n');
    expect(logs.some((l) => l.startsWith("I CLI switch to 7.1.0 claude"))).toBe(true);
  });

  it("rollback restores the previous one; then there is nothing to roll back and pins stay", async () => {
    await seedPins();
    const t = make();
    t.switchCli("claude", "7.1.0");
    t.rollbackCli("claude");
    expect(JSON.parse(pinsBytes(dir)).agents.claude).toMatchObject({ active: "7.0.0", previous: null });
    const kept = pinsBytes(dir);
    expect(() => t.rollbackCli("claude")).toThrow(SettingsError);
    expect(pinsBytes(dir)).toBe(kept);
  });

  it("switch and rollback: file changed while the confirmation is open", async () => {
    await seedPins();
    const file = (version: string) => {
      const r = readPins(dir);
      if (r.state !== "loaded") throw new Error("no pins");
      return installedPath(dir, "claude", r.pins.agents.claude!.installed.find((i) => i.version === version)!);
    };
    detachExecutable(file("7.1.0"));
    appendFileSync(file("7.1.0"), "# changed after installation\n");
    const t = make();
    let kept = pinsBytes(dir);
    expect(() => t.switchCli("claude", "7.1.0")).toThrow(SettingsError);
    expect(() => t.switchCli("claude", "7.1.0")).toThrow(/does not match/);
    expect(pinsBytes(dir)).toBe(kept);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await seedPins();
    const t2 = make();
    t2.switchCli("claude", "7.1.0");
    detachExecutable(file("7.0.0"));
    appendFileSync(file("7.0.0"), "# changed after installation\n");
    kept = pinsBytes(dir);
    expect(() => t2.rollbackCli("claude")).toThrow(SettingsError);
    expect(() => t2.rollbackCli("claude")).toThrow(/does not match/);
    expect(pinsBytes(dir)).toBe(kept);
    expect(JSON.parse(kept).agents.claude).toMatchObject({ active: "7.1.0", previous: "7.0.0" });
  });

  it("switch and rollback: file without the execute bit is refused with the text without the path (scenario «Файл без бита исполнения»)", async () => {
    await seedPins();
    const file = (version: string) => {
      const r = readPins(dir);
      if (r.state !== "loaded") throw new Error("no pins");
      return installedPath(dir, "claude", r.pins.agents.claude!.installed.find((i) => i.version === version)!);
    };
    const t = make();
    detachExecutable(file("7.1.0"));
    detachExecutable(file("7.0.0"));
    chmodSync(file("7.1.0"), 0o644);
    let kept = pinsBytes(dir);
    expect(() => t.switchCli("claude", "7.1.0")).toThrow("The file of claude 7.1.0 is not executable; the pin is unchanged");
    expect(pinsBytes(dir)).toBe(kept);
    chmodSync(file("7.1.0"), 0o755);
    t.switchCli("claude", "7.1.0");
    chmodSync(file("7.0.0"), 0o644);
    kept = pinsBytes(dir);
    expect(() => t.rollbackCli("claude")).toThrow("The file of claude 7.0.0 is not executable; the pin is unchanged");
    expect(pinsBytes(dir)).toBe(kept);
    expect(JSON.parse(kept).agents.claude).toMatchObject({ active: "7.1.0", previous: "7.0.0" });
  });

  it("a running session refuses both actions; pins stay byte for byte", async () => {
    await seedPins();
    const t = make();
    t.switchCli("claude", "7.1.0");
    const kept = pinsBytes(dir);
    running = true;
    expect(t.settingsView().running).toBe(true);
    expect(() => t.switchCli("claude", "7.1.0")).toThrow(catalog().cliSessionRunning);
    expect(() => t.rollbackCli("claude")).toThrow(catalog().cliSessionRunning);
    expect(pinsBytes(dir)).toBe(kept);
  });

  it("176 refuses a non-real and a not installed version with its own text; pins stay", async () => {
    record(dir, "claude", "7.0.0", "real");
    record(dir, "claude", "7.3.0", "interface");
    record(dir, "claude", "7.4.0", "real");
    await installVersions(dir, "claude", [{ version: "7.0.0" }, { version: "7.3.0", candidate: true }], () => new Date(T0));
    const kept = pinsBytes(dir);
    const t = make();
    expect(() => t.switchCli("claude", "7.3.0")).toThrow(/7\.3\.0/);
    expect(() => t.switchCli("claude", "7.4.0")).toThrow(/7\.4\.0/);
    expect(pinsBytes(dir)).toBe(kept);
    expect(logs.filter((l) => l.startsWith("E CLI switch"))).toHaveLength(2);
  });

  it("a 176 refusal on ru: the owner sees the Russian text, the log line does not depend on the language", async () => {
    record(dir, "claude", "7.0.0", "real");
    record(dir, "claude", "7.3.0", "interface");
    await installVersions(dir, "claude", [{ version: "7.0.0" }, { version: "7.3.0", candidate: true }], () => new Date(T0));
    const t = make();
    setProcessLanguage("ru");
    expect(() => t.switchCli("claude", "7.3.0")).toThrow(/[А-Яа-яЁё]/);
    const line = logs.filter((l) => l.startsWith("E CLI switch"));
    expect(line).toHaveLength(1);
    expect(line[0]).not.toMatch(/[А-Яа-яЁё]/);
  });

  it("the refusal text is in the language at the time of the action", async () => {
    await seedPins();
    const t = make();
    running = true;
    setProcessLanguage("ru");
    expect(() => t.switchCli("claude", "7.1.0")).toThrow(catalog().cliSessionRunning);
    expect(catalog().cliSessionRunning).toMatch(/[А-Яа-яЁё]/);
  });

  it("malformed input and an agent without a pin are refused; pins stay", async () => {
    await seedPins();
    const kept = pinsBytes(dir);
    const t = make();
    expect(() => t.switchCli(5, "7.1.0")).toThrow(catalog().badRequest(catalog().reqAgent));
    expect(() => t.switchCli("gemini", "7.1.0")).toThrow(catalog().badRequest(catalog().reqAgent));
    expect(() => t.switchCli("claude", "x")).toThrow(catalog().badRequest(catalog().reqVersion));
    expect(() => t.switchCli("claude", 7)).toThrow(catalog().badRequest(catalog().reqVersion));
    expect(() => t.rollbackCli({})).toThrow(catalog().badRequest(catalog().reqAgent));
    expect(() => t.switchCli("codex", "5.0.0")).toThrow(catalog().cliNoPin("codex"));
    expect(() => t.rollbackCli("codex")).toThrow(catalog().cliNoPin("codex"));
    expect(pinsBytes(dir)).toBe(kept);
  });
});

describe("Requirement: Файл напоминаний о переходе CLI", () => {
  it("no pins: opening the settings data, a periodic check and a recheck create nothing", async () => {
    const t = make();
    t.settingsView();
    await t.forProvider("claude", status({ source: "path" }));
    await t.maybeCheck();
    expect(names()).toEqual([]);
  });
});

describe("Requirement: Срок планового перехода (texts without paths)", () => {
  const SOURCE_DIR = () => [dir, dir.normalize("NFD")];
  const noRoot = (text: string) => { for (const r of SOURCE_DIR()) expect(text).not.toContain(r); expect(text).not.toContain(REMINDER_FILE); };

  it("a period write error shows the code without the path, en and ru; the path goes to the log; the file keeps its bytes", () => {
    const t = make();
    t.setPeriod(20);
    const kept = reminderRaw();
    chmodSync(reminderPath(dir), 0o444);
    try {
      for (const lang of ["en", "ru"] as const) {
        setProcessLanguage(lang);
        let msg = "";
        try { t.setPeriod(10); } catch (e) { msg = (e as Error).message; }
        expect(msg).toContain("EACCES");
        noRoot(msg);
        expect(msg).toBe(catalog().reminderSaveFailed("EACCES"));
        if (lang === "ru") expect(msg).toMatch(/[А-Яа-яЁё]/);
        expect(reminderRaw()).toBe(kept);
      }
      expect(logs.some((l) => l.startsWith("E ") && l.includes(reminderPath(dir)) && l.includes("EACCES"))).toBe(true);
    } finally {
      chmodSync(reminderPath(dir), 0o644);
    }
  });

  it("the write-failure line of the daily check goes away after a successful setPeriod, which keeps the check result", async () => {
    await seedPins();
    ms = T0 + 10 * DAY;
    const original = `${JSON.stringify({ schemaVersion: 1, periodDays: 30, lastCheck: { at: "2026-09-09T00:00:00Z", candidates: [], failures: [] } }, null, 2)}\n`;
    writeFileSync(reminderPath(dir), original);
    chmodSync(reminderPath(dir), 0o444);
    const t = make();
    try {
      await t.maybeCheck();
      expect((await t.forProvider("claude", status())).check?.notSaved).toEqual({ code: "EACCES" });
      expect(() => t.setPeriod(14)).toThrow(/EACCES/);
      expect((await t.forProvider("claude", status())).check?.notSaved).toEqual({ code: "EACCES" }); // a failed save leaves it
    } finally {
      chmodSync(reminderPath(dir), 0o644);
    }
    const runs = listCalls.length;
    t.setPeriod(14);
    const c = (await t.forProvider("claude", status())).check;
    expect(c).toBeTruthy();
    expect(c).not.toHaveProperty("notSaved");
    const file = JSON.parse(reminderRaw());
    expect(file.periodDays).toBe(14);
    expect(file.lastCheck.at).toBe("2026-09-11T00:00:00Z");
    expect(file.lastCheck).toMatchObject({ candidates: [], failures: [] });
    expect(listCalls).toHaveLength(runs);
  });
});

describe("Requirement: Переход и откат из карточки (texts without paths)", () => {
  const noRoot = (text: string) => { for (const r of [dir, dir.normalize("NFD")]) expect(text).not.toContain(r); };
  const msgOf = (f: () => void): string => { try { f(); } catch (e) { return (e as Error).message; } throw new Error("expected a refusal"); };
  const view = async (t: CliTransitionApi) => JSON.stringify([t.settingsView(), await t.forProvider("claude", status())]);

  it("after a normal rollback previous is null in pins.json and in the view", async () => {
    await seedPins();
    const t = make();
    t.switchCli("claude", "7.1.0");
    t.rollbackCli("claude");
    expect(JSON.parse(pinsBytes(dir)).agents.claude.previous).toBeNull();
    expect((await t.forProvider("claude", status())).pin?.previous ?? null).toBeNull();
  });

  it("rollback to an install whose file was deleted, and switch to a version whose file is missing: no data folder path, pins stay", async () => {
    await seedPins();
    const t = make();
    t.switchCli("claude", "7.1.0");
    rmSync(versionDir(dir, "claude", "7.0.0"), { recursive: true });
    let kept = pinsBytes(dir);
    for (const lang of ["en", "ru"] as const) {
      setProcessLanguage(lang);
      const msg = msgOf(() => t.rollbackCli("claude"));
      noRoot(msg);
      expect(msg).toContain("7.0.0");
    }
    expect(pinsBytes(dir)).toBe(kept);
    setProcessLanguage("en");
    expect(msgOf(() => t.switchCli("claude", "7.0.0"))).toBe("The file of claude 7.0.0 is missing");
    noRoot(await view(t));
    expect(pinsBytes(dir)).toBe(kept);
    kept = pinsBytes(dir);
    expect(logs.every((l) => !l.startsWith("E ") || l.includes("refused by the pin store"))).toBe(true);
  });

  it("a damaged pins.json: switch and rollback show the neutral text, the path is in the log, the file is unchanged", async () => {
    await seedPins();
    writeFileSync(pinsPath(dir), "{ not json");
    const t = make();
    for (const lang of ["en", "ru"] as const) {
      setProcessLanguage(lang);
      for (const act of [() => t.switchCli("claude", "7.1.0"), () => t.rollbackCli("claude")]) {
        const msg = msgOf(act);
        expect(msg).toBe(catalog().cliPinsUnavailable);
        noRoot(msg);
      }
    }
    expect(readFileSync(pinsPath(dir), "utf8")).toBe("{ not json");
    expect(logs.some((l) => l.startsWith("E ") && l.includes(pinsPath(dir)))).toBe(true);
  });
});
