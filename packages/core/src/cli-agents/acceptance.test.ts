import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "../i18n/process-language.ts";
import { DEFAULT_MODEL } from "./types.ts";
import { writeAcceptanceStub } from "./acceptance-stub.fixture.ts";
import type { CliAgent } from "./types.ts";
import type { VerifiedRecord } from "./verified-record.ts";
import {
  ACCEPTANCE_CALL_BOUND, PROBES, checkMaxCalls, formatPlan, planAcceptance, runAcceptance,
} from "./acceptance.ts";
import type { AcceptancePlan, ProbeId, ProbeOutcome, ProbeRunner } from "./acceptance.ts";

const NOW = new Date("2026-10-20T12:00:00Z");
const RAW = readFileSync(new URL("./fixtures/codex-0.159.2-turn.synthetic.jsonl", import.meta.url), "utf8");
const ENV = { PATH: "/usr/bin:/bin" };
const RECORD_NONE: VerifiedRecord = { entries: [] };
const realRecord = (agent: CliAgent, version: string): VerifiedRecord => ({
  entries: [{ agent, version, level: "real", checkedAt: "2026-10-01", os: "darwin-arm64", osenVersion: "0.1.0", modelCalls: 7 }],
});

let root: string;
let dataDir: string;
beforeEach(() => {
  setProcessLanguage("en");
  root = mkdtempSync(join(tmpdir(), "accept-unit-"));
  dataDir = join(root, "data");
  mkdirSync(dataDir);
});
afterEach(() => {
  setProcessLanguage("en");
  rmSync(root, { recursive: true, force: true });
});

// Installs a fake binary the way `council cli install` records it: a file under cli/<agent>/<version>/ and an entry in pins.json.
function install(agent: CliAgent, version: string, body = "#!/bin/sh\nexit 0\n"): string {
  const vdir = join(dataDir, "cli", agent, version);
  mkdirSync(join(vdir, "config"), { recursive: true });
  const file = join(vdir, agent);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const pinsPath = join(dataDir, "cli", "pins.json");
  const pins = existsSync(pinsPath) ? JSON.parse(readFileSync(pinsPath, "utf8")) : { schemaVersion: 1, agents: {} };
  const cur = pins.agents[agent] ?? { installed: [], active: null, previous: null, activatedAt: null };
  cur.installed.push({ version, path: agent, source: "test", sha256, installedAt: "2026-10-20T10:00:00Z" });
  pins.agents[agent] = cur;
  writeFileSync(pinsPath, JSON.stringify(pins));
  return file;
}

// Everything under a folder as sorted "relative path + content hash" lines.
function treeOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const e of readdirSync(abs).sort()) {
      const p = join(abs, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(`${relative(dir, p)} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(dir);
  return out;
}

async function planFor(record: VerifiedRecord, opts: { candidate?: boolean; model?: string } = {}, version = "0.159.2", agent: CliAgent = "codex") {
  const r = await planAcceptance(dataDir, agent, version, opts, { record });
  if (!r.ok) throw new Error(`plan refused: ${r.text}`);
  return r.plan;
}

function fakeRunner(fail?: ProbeId, calls: Partial<Record<ProbeId, number>> = {}) {
  const seen: ProbeId[] = [];
  const runner: ProbeRunner = async (probe) => {
    seen.push(probe);
    const n = calls[probe] ?? 1;
    if (probe === fail) return { ok: false, reason: `broken ${probe}`, calls: n };
    return { ok: true, calls: n, raw: probe === "valid_turn" ? RAW : undefined };
  };
  return { runner, seen };
}

const realEntries = () => {
  const p = join(dataDir, "cli-verified.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")).entries : [];
};

const runOpts = (extra: Partial<Parameters<typeof runAcceptance>[2]> = {}) => ({
  env: ENV, language: "en" as const, now: () => NOW, osenVersion: "0.9.0", ...extra,
});

describe("Acceptance plan without consent", () => {
  it("prints the plan with the bound 7, writes nothing and does not run the binary", async () => {
    const file = install("codex", "0.159.2", `#!/bin/sh\ntouch "${join(root, "ran")}"\nexit 0\n`);
    const before = treeOf(dataDir);
    const plan = await planFor(realRecord("codex", "0.159.2"));
    const text = formatPlan(plan);
    expect(text).toContain("Upper bound of model calls: 7");
    expect(text).toContain("--max-calls 7");
    expect(text).toContain("CLI default model");
    expect(plan.path).toBe(file);
    expect(plan.model).toBe(DEFAULT_MODEL);
    expect(plan.bound).toBe(7);
    expect(ACCEPTANCE_CALL_BOUND).toBe(PROBES.length);
    for (const p of PROBES) expect(text).toContain(`${PROBES.indexOf(p) + 1}.`);
    expect(treeOf(dataDir)).toEqual(before);
    expect(existsSync(join(root, "ran"))).toBe(false);
  });
});

describe("Consent for another bound", () => {
  it("refuses 6 and 8 naming 7, accepts 7 and nothing else", async () => {
    install("codex", "0.159.2");
    const plan = await planFor(realRecord("codex", "0.159.2"));
    expect(checkMaxCalls(plan, 6)).toContain("7");
    expect(checkMaxCalls(plan, 8)).toContain("7");
    expect(checkMaxCalls(plan, 7)).toBeUndefined();
  });
});

describe("Version not installed", () => {
  it("refuses with the install hint and writes nothing", async () => {
    install("codex", "0.159.2");
    const before = treeOf(dataDir);
    const r = await planAcceptance(dataDir, "codex", "9.9.8", {}, { record: realRecord("codex", "9.9.8") });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe(2);
    expect(r.text).toContain("not installed");
    expect(r.text).toContain("council cli install codex --version 9.9.8");
    expect(treeOf(dataDir)).toEqual(before);
  });
});

describe("Installed file changed", () => {
  it("refuses with the expected and the actual sha256, code 2", async () => {
    const file = install("codex", "0.159.2");
    writeFileSync(file, "#!/bin/sh\necho changed\n");
    const r = await planAcceptance(dataDir, "codex", "0.159.2", {}, { record: realRecord("codex", "0.159.2") });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe(2);
    expect(r.text).toMatch(/expected sha256 [0-9a-f]{64}, found [0-9a-f]{64}/);
  });
});

describe("Version without a real record", () => {
  it("refuses without --candidate naming the level, accepts with --candidate", async () => {
    install("codex", "0.160.0");
    const refused = await planAcceptance(dataDir, "codex", "0.160.0", {}, { record: RECORD_NONE });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe(2);
      expect(refused.text).toContain("--candidate");
      expect(refused.text).toContain("not recorded");
    }
    const accepted = await planAcceptance(dataDir, "codex", "0.160.0", { candidate: true }, { record: RECORD_NONE });
    expect(accepted.ok).toBe(true);
  });

  it("refuses an agent that is not claude or codex with code 2", async () => {
    const r = await planAcceptance(dataDir, "gemini", "1.0.0", {}, { record: RECORD_NONE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(2);
  });

  it("an unreadable pins file is refused with code 1", async () => {
    mkdirSync(join(dataDir, "cli"), { recursive: true });
    writeFileSync(join(dataDir, "cli", "pins.json"), "{ not json");
    const r = await planAcceptance(dataDir, "codex", "0.159.2", {}, { record: RECORD_NONE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(1);
  });
});

describe("Plan and refusals in both languages", () => {
  it("en and ru texts differ and carry the same numbers", async () => {
    install("codex", "0.159.2");
    const plan = await planFor(realRecord("codex", "0.159.2"));
    expect(formatPlan(plan)).toContain("Upper bound of model calls: 7");
    setProcessLanguage("ru");
    expect(formatPlan(plan)).toContain("Верхняя граница вызовов модели: 7");
    expect(formatPlan(plan)).toContain("--max-calls 7");
    expect(checkMaxCalls(plan, 6)).toContain("7");
    expect(checkMaxCalls(plan, 6)).toMatch(/[а-я]/);
    const refusal = await planAcceptance(dataDir, "codex", "9.9.8", {}, { record: RECORD_NONE });
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect(refusal.text).toContain("не установлена");
  });
});

describe("runAcceptance with injected probes", () => {
  it("all probes passed: one real entry with every field, calls not above the bound", async () => {
    install("codex", "0.159.2");
    const plan = await planFor(realRecord("codex", "0.159.2"));
    const { runner, seen } = fakeRunner();
    const out = await runAcceptance(dataDir, plan, runOpts(), { runProbe: runner, inspect: async () => ({ flags: new Set(), features: new Set() }) });
    expect(out.code).toBe(0);
    expect(out.recorded).toBe(true);
    expect(out.calls).toBeLessThanOrEqual(7);
    expect(seen).toEqual([...PROBES]);
    const [e] = realEntries();
    expect(e).toEqual({
      agent: "codex", version: "0.159.2", level: "real", checkedAt: "2026-10-20",
      os: `${process.platform}-${process.arch}`, osenVersion: "0.9.0", sha256: plan.sha256, modelCalls: 7,
    });
    expect(out.text).toContain("0.159.2");
  });

  it("a failed probe: code 5, later probes not called, no entry", async () => {
    install("codex", "0.159.2");
    const plan = await planFor(realRecord("codex", "0.159.2"));
    const { runner, seen } = fakeRunner("tool_call");
    const out = await runAcceptance(dataDir, plan, runOpts(), { runProbe: runner, inspect: async () => ({ flags: new Set(), features: new Set() }) });
    expect(out.code).toBe(5);
    expect(out.recorded).toBe(false);
    expect(seen).toEqual(["valid_turn", "outside_file", "tool_call"]);
    expect(out.text).toContain("tool call");
    expect(out.text).toContain("broken tool_call");
    expect(realEntries()).toEqual([]);
  });

  it("an interrupted command: code 1, interrupted, no entry", async () => {
    install("codex", "0.159.2");
    const plan = await planFor(realRecord("codex", "0.159.2"));
    const controller = new AbortController();
    controller.abort();
    const { runner, seen } = fakeRunner();
    const out = await runAcceptance(dataDir, plan, runOpts({ signal: controller.signal }), { runProbe: runner });
    expect(out).toMatchObject({ code: 1, interrupted: true, recorded: false });
    expect(seen).toEqual([]);
    expect(out.text).toContain("interrupted");
    expect(realEntries()).toEqual([]);
  });

  it("an interruption during a probe is not a probe failure", async () => {
    install("codex", "0.159.2");
    const plan = await planFor(realRecord("codex", "0.159.2"));
    const controller = new AbortController();
    const runner: ProbeRunner = async () => {
      controller.abort();
      return { ok: true, calls: 1 };
    };
    const out = await runAcceptance(dataDir, plan, runOpts({ signal: controller.signal }), { runProbe: runner });
    expect(out).toMatchObject({ code: 1, interrupted: true, recorded: false });
    expect(realEntries()).toEqual([]);
  });

  it("the data folder keeps its sessions unchanged after every outcome", async () => {
    install("codex", "0.159.2");
    const sessions = join(dataDir, "sessions");
    mkdirSync(join(sessions, "2026"), { recursive: true });
    writeFileSync(join(sessions, "2026", "old.jsonl"), '{"session":"kept"}\n');
    const sessionsBefore = treeOf(sessions);
    const plan = await planFor(realRecord("codex", "0.159.2"));
    const before = treeOf(dataDir);
    for (const fail of [undefined, "stop" as const]) {
      const { runner } = fakeRunner(fail);
      await runAcceptance(dataDir, plan, runOpts(), { runProbe: runner, inspect: async () => ({ flags: new Set(), features: new Set() }) });
      expect(treeOf(sessions)).toEqual(sessionsBefore);
    }
    const after = treeOf(dataDir);
    const path = (line: string) => line.split(" ")[0]!;
    // nothing that existed may vanish or change, except the log that grows
    const touched = before.filter((l) => !after.includes(l)).map(path).filter((p) => !p.startsWith("logs/"));
    expect(touched).toEqual([]);
    // what is new may only be the local record and the log
    const added = after.filter((l) => !before.includes(l)).map(path);
    for (const p of added) expect(p === "cli-verified.json" || p.startsWith("logs/")).toBe(true);
  });

  it("an inspection failure fails the first probe with its reason and calls nothing", async () => {
    install("codex", "0.159.2");
    const plan = await planFor(realRecord("codex", "0.159.2"));
    const { runner, seen } = fakeRunner();
    const out = await runAcceptance(dataDir, plan, runOpts(), {
      runProbe: runner,
      inspect: async () => { throw new Error("help is unreadable"); },
    });
    expect(out.code).toBe(5);
    expect(seen).toEqual([]);
    expect(out.calls).toBe(0);
    expect(out.outcomes).toEqual([{ probe: "valid_turn", ok: false, reason: expect.stringContaining("help is unreadable") }]);
  });

  it("a runner that throws is a failed probe with the message", async () => {
    install("codex", "0.159.2");
    const plan = await planFor(realRecord("codex", "0.159.2"));
    const runner: ProbeRunner = async (probe) => {
      if (probe === "outside_file") throw new Error("spawn exploded");
      return { ok: true, calls: 1 };
    };
    const out = await runAcceptance(dataDir, plan, runOpts(), { runProbe: runner, inspect: async () => ({ flags: new Set() }) });
    expect(out.code).toBe(5);
    expect(out.text).toContain("spawn exploded");
  });

  it("onProbe is called once per probe in order", async () => {
    install("codex", "0.159.2");
    const plan = await planFor(realRecord("codex", "0.159.2"));
    const seen: ProbeOutcome[] = [];
    const { runner } = fakeRunner("instructions");
    await runAcceptance(dataDir, plan, runOpts({ onProbe: (o) => seen.push(o) }), { runProbe: runner, inspect: async () => ({ flags: new Set() }) });
    expect(seen.map((o) => [o.probe, o.ok])).toEqual([["valid_turn", true], ["outside_file", true], ["tool_call", true], ["mcp_server", true], ["instructions", false]]);
  });

  it("re-acceptance: two runs with different dates and call counts leave one entry with the second run's data", async () => {
    install("codex", "0.159.2");
    const plan = await planFor(realRecord("codex", "0.159.2"));
    const inspect = async () => ({ flags: new Set<string>() });
    const first = fakeRunner(undefined, { stop: 0, resume: 0 });
    expect((await runAcceptance(dataDir, plan, runOpts({ osenVersion: "0.8.0", now: () => new Date("2026-10-10T00:00:00Z") }), { runProbe: first.runner, inspect })).code).toBe(0);
    expect(realEntries()).toMatchObject([{ checkedAt: "2026-10-10", modelCalls: 5, osenVersion: "0.8.0" }]);
    const second = fakeRunner();
    expect((await runAcceptance(dataDir, plan, runOpts(), { runProbe: second.runner, inspect })).code).toBe(0);
    expect(realEntries()).toMatchObject([{ agent: "codex", version: "0.159.2", level: "real", checkedAt: "2026-10-20", modelCalls: 7, osenVersion: "0.9.0" }]);
    expect(realEntries()).toHaveLength(1);
  });

  it("a record write failure is code 1 with its reason", async () => {
    install("codex", "0.159.2");
    const plan = await planFor(realRecord("codex", "0.159.2"));
    mkdirSync(join(dataDir, "cli-verified.json"));
    const { runner } = fakeRunner();
    const out = await runAcceptance(dataDir, plan, runOpts(), { runProbe: runner, inspect: async () => ({ flags: new Set() }) });
    expect(out.code).toBe(1);
    expect(out.recorded).toBe(false);
    expect(out.text).toContain("cli-verified.json");
  });
});

describe("Turn fixture from the valid turn", () => {
  it("is saved as <agent>-<version>-turn.jsonl when the valid turn passes", async () => {
    install("codex", "0.159.2");
    const plan = await planFor(realRecord("codex", "0.159.2"));
    const folder = join(root, "fx");
    const { runner } = fakeRunner();
    const out = await runAcceptance(dataDir, plan, runOpts({ saveFixture: folder }), { runProbe: runner, inspect: async () => ({ flags: new Set() }) });
    expect(out.code).toBe(0);
    expect(out.fixture).toBe(join(folder, "codex-0.159.2-turn.jsonl"));
    expect(readdirSync(folder)).toEqual(["codex-0.159.2-turn.jsonl"]);
    expect(readFileSync(out.fixture!, "utf8")).not.toMatch(/\/Users\//);
  });

  it("is not saved when the valid turn fails", async () => {
    install("codex", "0.159.2");
    const plan = await planFor(realRecord("codex", "0.159.2"));
    const folder = join(root, "fx");
    const { runner } = fakeRunner("valid_turn");
    const out = await runAcceptance(dataDir, plan, runOpts({ saveFixture: folder }), { runProbe: runner, inspect: async () => ({ flags: new Set() }) });
    expect(out.code).toBe(5);
    expect(out.fixture).toBeUndefined();
    expect(existsSync(folder)).toBe(false);
  });

  it("is kept when a later probe fails, with code 5 and no entry", async () => {
    install("codex", "0.159.2");
    const plan = await planFor(realRecord("codex", "0.159.2"));
    const folder = join(root, "fx");
    const { runner } = fakeRunner("outside_file");
    const out = await runAcceptance(dataDir, plan, runOpts({ saveFixture: folder }), { runProbe: runner, inspect: async () => ({ flags: new Set() }) });
    expect(out.code).toBe(5);
    expect(existsSync(out.fixture!)).toBe(true);
    expect(realEntries()).toEqual([]);
  });

  it("is not written without the flag", async () => {
    install("codex", "0.159.2");
    const plan = await planFor(realRecord("codex", "0.159.2"));
    const folder = join(root, "fx");
    const { runner } = fakeRunner();
    const out = await runAcceptance(dataDir, plan, runOpts(), { runProbe: runner, inspect: async () => ({ flags: new Set() }) });
    expect(out.code).toBe(0);
    expect(out.fixture).toBeUndefined();
    expect(out.fixtureError).toBeUndefined();
    expect(existsSync(folder)).toBe(false);
  });

  it("an anonymization error is reported and changes neither the probes nor the code", async () => {
    install("codex", "0.159.2");
    const plan = await planFor(realRecord("codex", "0.159.2"));
    const folder = join(root, "fx");
    const runner: ProbeRunner = async (probe) => ({ ok: true, calls: 1, raw: probe === "valid_turn" ? "not a json turn" : undefined });
    const out = await runAcceptance(dataDir, plan, runOpts({ saveFixture: folder }), { runProbe: runner, inspect: async () => ({ flags: new Set() }) });
    expect(out.code).toBe(0);
    expect(out.recorded).toBe(true);
    expect(out.fixture).toBeUndefined();
    expect(out.fixtureError).toContain("JSON");
    expect(existsSync(folder)).toBe(false);
  });
});

describe("Порядок поиска и окружение закреплённого CLI: Справка и список возможностей Codex в проверке кандидата и в приёмке", () => {
  const UPDATE_OFF = "-c check_for_update_on_startup=false";
  for (const agent of ["claude", "codex"] as const) {
    it(`accept ${agent}: the real inspectPinned reads help${agent === "codex" ? " and features list with" : " without"} ${UPDATE_OFF}, no --version read`, async () => {
      const stub = writeAcceptanceStub(root, { help: "  --model <m>\n", features: "shell_tool stable true\n" });
      const configDir = join(root, "config");
      mkdirSync(configDir, { recursive: true });
      const plan: AcceptancePlan = { agent, version: "9.9.9", path: stub, sha256: "a".repeat(64), configDir, model: DEFAULT_MODEL, probes: PROBES, bound: 7 };
      const argvLog = join(root, "argv.log");
      const runner: ProbeRunner = async () => ({ ok: true, calls: 1 });
      await runAcceptance(dataDir, plan, runOpts({ env: { ...ENV, STUB_ARGV_LOG: argvLog } }), { runProbe: runner });
      const lines = readFileSync(argvLog, "utf8").split("\n").filter(Boolean);
      expect(lines).toEqual(agent === "claude" ? ["--help"] : [`exec --help ${UPDATE_OFF}`, `features list ${UPDATE_OFF}`]);
    });
  }
});
