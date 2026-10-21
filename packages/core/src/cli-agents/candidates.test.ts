import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "../i18n/process-language.ts";
import { CANDIDATES_DIR, CANDIDATE_LIMIT, candidatesJson, checkCandidate, checkCandidates } from "./candidates.ts";
import type { CandidateDeps } from "./candidates.ts";
import { HELP_ARGS } from "./args.ts";
import type { VerifiedEntry } from "./verified-record.ts";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const claudeHelp = fx("claude-2.1.288-help.txt");
const codexHelp = fx("codex-0.159.2-exec-help.txt");
const codexFeatures = fx("codex-0.159.2-features.txt");
const dropLines = (text: string, re: RegExp) => text.split("\n").filter((l) => !re.test(l)).join("\n");

describe("Проверка кандидата по возможностям: pure check", () => {
  it("claude: all declared -> no violations", () => {
    const r = checkCandidate({ agent: "claude", versionOutput: "2.1.288 (Claude Code)", help: claudeHelp, features: undefined });
    expect(r).toEqual({ version: "2.1.288", violations: [] });
  });
  it("codex: all declared -> no violations", () => {
    const r = checkCandidate({ agent: "codex", versionOutput: "codex-cli 0.159.2", help: codexHelp, features: codexFeatures });
    expect(r).toEqual({ version: "0.159.2", violations: [] });
  });
  it("claude: missing --tools is named", () => {
    const r = checkCandidate({ agent: "claude", versionOutput: "2.1.289", help: dropLines(claudeHelp, /^ {2,6}--tools\b/), features: undefined });
    expect(r.violations).toEqual([{ code: "missing_flag", name: "--tools" }]);
  });
  it("codex: missing shell_tool and --config are named", () => {
    const features = dropLines(codexFeatures, /^shell_tool /);
    const help = dropLines(codexHelp, /^ {2}-c, --config/);
    const r = checkCandidate({ agent: "codex", versionOutput: "0.160.0", help, features });
    expect(r.violations).toContainEqual({ code: "missing_feature", name: "shell_tool" });
    expect(r.violations).toContainEqual({ code: "missing_flag", name: "--config" });
  });
  it("codex: features list not read", () => {
    const r = checkCandidate({ agent: "codex", versionOutput: "0.160.0", help: codexHelp, features: undefined });
    expect(r.violations).toEqual([{ code: "features_unread", name: "codex features list" }]);
  });
  it("help not read: named with the help args, no flag checks", () => {
    const r = checkCandidate({ agent: "codex", versionOutput: "0.160.0", help: undefined, features: codexFeatures });
    expect(r.violations).toEqual([{ code: "help_unread", name: "exec --help" }]);
  });
  it("version not parsed", () => {
    expect(checkCandidate({ agent: "claude", versionOutput: "hello", help: claudeHelp, features: undefined }).violations).toEqual([{ code: "version_unparsed", name: "--version" }]);
    expect(checkCandidate({ agent: "claude", versionOutput: undefined, help: claudeHelp, features: undefined }).violations).toEqual([{ code: "version_unparsed", name: "--version" }]);
  });
  it("Другой текст справки: reordered and reworded help with the same flags is ok", () => {
    // Same declared flags, new wording, reversed order, extra prose lines.
    const flags = [...claudeHelp.matchAll(/^ {2,6}(?:-\w, )?(--[\w-]+)/gm)].map((m) => `  ${m[1]} <x>\n      different words`).reverse();
    const help = `Totally new header\n\nOptions:\n${flags.join("\n")}\n`;
    const r = checkCandidate({ agent: "claude", versionOutput: "2.9.9", help, features: undefined });
    expect(r.violations).toEqual([]);
  });
});

// --- orchestration ---

const NOW = new Date("2026-10-20T12:00:00Z");
const base = (agent: "claude" | "codex", version: string): VerifiedEntry => ({ agent, version, level: "real", checkedAt: "2026-01-01", os: "darwin-arm64", osenVersion: "1.0.0", modelCalls: 1 });

interface Harness { dir: string; calls: string[][]; fetched: string[]; deps: CandidateDeps }
let dir: string;
beforeEach(() => {
  setProcessLanguage("en");
  dir = mkdtempSync(join(tmpdir(), "cand-"));
});
afterEach(() => {
  try { chmodSync(join(dir, "cli-verified.json"), 0o644); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function harness(over: { versions?: Partial<Record<"claude" | "codex", string[] | Error>>; builtin?: VerifiedEntry[]; badHelp?: (agent: string, version: string) => string | undefined; signal?: AbortSignal; fetchError?: Error; onFetch?: () => void } = {}): Harness {
  const calls: string[][] = [];
  const fetched: string[] = [];
  const versions = over.versions ?? { claude: ["2.1.289"], codex: ["0.160.0"] };
  const deps: CandidateDeps = {
    releases: {
      async list(agent) {
        const v = versions[agent] ?? [];
        if (v instanceof Error) throw v;
        return v;
      },
    },
    source: {
      async fetch(agent, version, d) {
        fetched.push(`${agent}@${version}`);
        over.onFetch?.();
        if (over.fetchError) throw over.fetchError;
        const exe = join(d, "bin", agent);
        mkdirSync(join(d, "bin"), { recursive: true });
        writeFileSync(exe, `binary ${agent} ${version}`);
        chmodSync(exe, 0o755);
        return { executable: exe, source: `fake:${agent}@${version}` };
      },
    },
    builtin: over.builtin ?? [base("claude", "2.1.288"), base("codex", "0.159.2")],
    async run(path, args) {
      calls.push([...args]);
      const agent = path.includes("/codex") ? "codex" : "claude";
      const version = /-(\d+\.\d+\.\d+)-/.exec(path)?.[1] ?? "0.0.0";
      if (args[0] === "--version") return `${version}\n`;
      if (args[0] === "features") return codexFeatures;
      const help = over.badHelp?.(agent, version);
      if (help !== undefined) return help;
      return agent === "claude" ? claudeHelp : codexHelp;
    },
    now: () => NOW,
    os: "darwin-arm64",
    osenVersion: "9.9.9",
    env: {},
    signal: over.signal,
  };
  return { dir, calls, fetched, deps };
}
const leftovers = () => [existsSync(join(dir, CANDIDATES_DIR)), existsSync(join(dir, "cli"))];
const recordFile = () => join(dir, "cli-verified.json");
const entries = () => (JSON.parse(readFileSync(recordFile(), "utf8")) as { entries: VerifiedEntry[] }).entries;

describe("Команда cli candidates / Новый кандидат", () => {
  it("records an interface entry with sha256 and no modelCalls; no pins.json, no leftovers", async () => {
    const h = harness();
    const r = await checkCandidates(dir, ["claude", "codex"], h.deps);
    expect(r.code).toBe(0);
    expect(r.candidates).toEqual([
      { agent: "claude", version: "2.1.289", status: "ok", violations: [], recorded: true },
      { agent: "codex", version: "0.160.0", status: "ok", violations: [], recorded: true },
    ]);
    const e = entries();
    expect(e).toHaveLength(2);
    expect(e[0]).toMatchObject({ agent: "claude", version: "2.1.289", level: "interface", checkedAt: "2026-10-20", os: "darwin-arm64", osenVersion: "9.9.9" });
    expect(e[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(e[0]).not.toHaveProperty("modelCalls");
    expect(existsSync(join(dir, "cli", "pins.json"))).toBe(false);
    expect(leftovers()).toEqual([false, false]);
  });
  it("candidatesJson has no human text", async () => {
    const h = harness({ versions: { claude: new Error("boom"), codex: [] } });
    const r = await checkCandidates(dir, ["claude", "codex"], h.deps);
    expect(candidatesJson(r)).toEqual({ schemaVersion: 1, candidates: [], failures: [{ agent: "claude", code: "source_unavailable" }] });
  });
  it("violation: not recorded, named, code 0", async () => {
    const h = harness({ badHelp: (a) => (a === "claude" ? dropLines(claudeHelp, /^ {2,6}--tools\b/) : undefined) });
    const r = await checkCandidates(dir, ["claude"], h.deps);
    expect(r.code).toBe(0);
    expect(r.candidates[0]).toMatchObject({ status: "violates", recorded: false, violations: [{ code: "missing_flag", name: "--tools" }] });
    expect(existsSync(recordFile())).toBe(false);
    expect(leftovers()).toEqual([false, false]);
  });
});

describe("Команда cli candidates / Нет версий новее", () => {
  it("nothing installed or written, code 0", async () => {
    const h = harness({ versions: { claude: ["2.1.288", "2.0.0"], codex: [] } });
    const r = await checkCandidates(dir, ["claude", "codex"], h.deps);
    expect(r).toMatchObject({ candidates: [], failures: [], code: 0 });
    expect(h.fetched).toEqual([]);
    expect(existsSync(recordFile())).toBe(false);
    expect(leftovers()).toEqual([false, false]);
  });
});

describe("Команда cli candidates / Источник релизов недоступен", () => {
  it("other agent is still checked, code 1, reason has the error text", async () => {
    const h = harness({ versions: { claude: new Error("offline"), codex: ["0.160.0"] } });
    const r = await checkCandidates(dir, ["claude", "codex"], h.deps);
    expect(r.code).toBe(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ agent: "claude", code: "source_unavailable" });
    expect(r.failures[0]!.reason).toContain("offline");
    expect(r.candidates.map((c) => c.agent)).toEqual(["codex"]);
  });
  it("unparsable answer is a source failure", async () => {
    const h = harness();
    h.deps.releases = { list: async () => ({ not: "a list" }) as unknown as string[] };
    const r = await checkCandidates(dir, ["claude"], h.deps);
    expect(r.failures[0]!.code).toBe("source_unavailable");
    expect(h.fetched).toEqual([]);
  });
});

describe("Команда cli candidates / Нет базовой версии", () => {
  it("no builtin: both agents no_base, code 2, nothing installed", async () => {
    const h = harness({ builtin: [] });
    const r = await checkCandidates(dir, ["claude", "codex"], h.deps);
    expect(r.code).toBe(2);
    expect(r.failures.map((f) => f.code)).toEqual(["no_base", "no_base"]);
    expect(r.failures[0]!.reason).toContain("claude");
    expect(h.fetched).toEqual([]);
    expect(leftovers()).toEqual([false, false]);
  });
  it("one agent without base: the other is checked, code 2", async () => {
    const h = harness({ builtin: [base("codex", "0.159.2")] });
    const r = await checkCandidates(dir, ["claude", "codex"], h.deps);
    expect(r.code).toBe(2);
    expect(r.candidates.map((c) => c.agent)).toEqual(["codex"]);
  });
});

describe("Команда cli candidates / Повреждённый pins.json", () => {
  it("unparsable pins.json: no_base with the file path for each agent, nothing fetched or written, code 2", async () => {
    mkdirSync(join(dir, "cli"));
    const pinsFile = join(dir, "cli", "pins.json");
    writeFileSync(pinsFile, "{bad");
    const h = harness({ versions: { claude: ["2.1.290"], codex: ["0.160.0"] } });
    const r = await checkCandidates(dir, ["claude", "codex"], h.deps);
    expect(r.code).toBe(2);
    expect(r.failures.map((f) => [f.agent, f.code])).toEqual([["claude", "no_base"], ["codex", "no_base"]]);
    expect(r.failures[0]!.reason).toContain(pinsFile);
    expect(r.failures[0]!.reason).toContain("claude");
    expect(h.fetched).toEqual([]);
    expect(r.candidates).toEqual([]);
    expect(existsSync(recordFile())).toBe(false);
    expect(readFileSync(pinsFile, "utf8")).toBe("{bad");
    expect(existsSync(join(dir, CANDIDATES_DIR))).toBe(false);
  });
  it("unreadable pins.json (chmod 000) is also no_base", async () => {
    mkdirSync(join(dir, "cli"));
    const pinsFile = join(dir, "cli", "pins.json");
    writeFileSync(pinsFile, "{}");
    chmodSync(pinsFile, 0o000);
    try {
      const h = harness();
      const r = await checkCandidates(dir, ["claude"], h.deps);
      expect(r.failures.map((f) => f.code)).toEqual(["no_base"]);
      expect(r.failures[0]!.reason).toContain(pinsFile);
      expect(h.fetched).toEqual([]);
    } finally {
      chmodSync(pinsFile, 0o644);
    }
  });
  it("pins.json failing the schema is also no_base", async () => {
    mkdirSync(join(dir, "cli"));
    writeFileSync(join(dir, "cli", "pins.json"), JSON.stringify({ schemaVersion: 1, agents: { claude: { active: 5 } } }));
    const h = harness();
    const r = await checkCandidates(dir, ["claude"], h.deps);
    expect(r.failures.map((f) => f.code)).toEqual(["no_base"]);
    expect(h.fetched).toEqual([]);
  });
});

describe("Команда cli candidates / Ошибка файловой системы", () => {
  it("a file where the cli-candidates folder goes: install_failed per candidate, no throw, file untouched, code 1", async () => {
    const blocker = join(dir, CANDIDATES_DIR);
    writeFileSync(blocker, "keep");
    const h = harness();
    const r = await checkCandidates(dir, ["claude", "codex"], h.deps);
    expect(r.code).toBe(1);
    expect(r.failures.map((f) => [f.agent, f.code])).toEqual([["claude", "install_failed"], ["codex", "install_failed"]]);
    expect(r.failures[0]!.reason).toContain("2.1.289");
    expect(r.candidates).toEqual([]);
    expect(h.fetched).toEqual([]);
    expect(readFileSync(blocker, "utf8")).toBe("keep");
    expect(existsSync(recordFile())).toBe(false);
  });
  it("hash read failure: install_failed, prefix removed, other agent still checked", async () => {
    const h = harness();
    const run = h.deps.run!;
    h.deps.run = async (path, args, env, signal) => {
      const out = await run(path, args, env, signal);
      if (path.includes("/claude") && args[0] !== "--version") rmSync(path);
      return out;
    };
    const r = await checkCandidates(dir, ["claude", "codex"], h.deps);
    expect(r.code).toBe(1);
    expect(r.failures.map((f) => [f.agent, f.code])).toEqual([["claude", "install_failed"]]);
    expect(r.candidates.map((c) => [c.agent, c.status])).toEqual([["codex", "ok"]]);
    expect(leftovers()).toEqual([false, false]);
  });
});

describe("Вывод и запись результата проверки кандидата / Сбой записи", () => {
  it("read-only record: recorded false, record_failed, code 1, prefix removed", async () => {
    writeFileSync(recordFile(), `${JSON.stringify({ schemaVersion: 1, entries: [{ agent: "claude", version: "1.0.0", level: "interface", checkedAt: "2026-01-01", os: "x", osenVersion: "1" }] })}\n`);
    chmodSync(recordFile(), 0o444);
    const before = readFileSync(recordFile(), "utf8");
    const h = harness();
    const r = await checkCandidates(dir, ["claude"], h.deps);
    expect(r.code).toBe(1);
    expect(r.candidates[0]).toMatchObject({ status: "ok", recorded: false });
    expect(r.failures[0]).toMatchObject({ code: "record_failed" });
    expect(readFileSync(recordFile(), "utf8")).toBe(before);
    expect(leftovers()).toEqual([false, false]);
  });
});

describe("Вывод и запись результата проверки кандидата / Повреждённый файл записи", () => {
  it("invalid file is untouched, nothing installed, reason has the full path", async () => {
    writeFileSync(recordFile(), "{ not json");
    const h = harness();
    const r = await checkCandidates(dir, ["claude", "codex"], h.deps);
    expect(r.code).toBe(1);
    expect(r.failures.map((f) => f.code)).toEqual(["record_failed", "record_failed"]);
    expect(r.failures[0]!.reason).toContain(recordFile());
    expect(readFileSync(recordFile(), "utf8")).toBe("{ not json");
    expect(h.fetched).toEqual([]);
    expect(r.candidates).toEqual([]);
  });
});

describe("Временные установки кандидатов / Папка не остаётся", () => {
  it("after an install error", async () => {
    const h = harness({ fetchError: new Error("npm exploded") });
    const r = await checkCandidates(dir, ["claude"], h.deps);
    expect(r.code).toBe(1);
    expect(r.failures[0]).toMatchObject({ code: "install_failed" });
    expect(r.failures[0]!.reason).toContain("npm exploded");
    expect(r.candidates).toEqual([]);
    expect(leftovers()).toEqual([false, false]);
  });
  it("version mismatch is install_failed without a result", async () => {
    const h = harness();
    h.deps.run = async (_p, args) => (args[0] === "--version" ? "9.9.9" : claudeHelp);
    const r = await checkCandidates(dir, ["claude"], h.deps);
    expect(r.failures[0]).toMatchObject({ code: "install_failed" });
    expect(r.candidates).toEqual([]);
    expect(existsSync(recordFile())).toBe(false);
    expect(leftovers()).toEqual([false, false]);
  });
  it("executable outside the prefix is install_failed", async () => {
    const h = harness();
    h.deps.source = { fetch: async () => ({ executable: join(dir, "elsewhere"), source: "x" }) };
    const r = await checkCandidates(dir, ["claude"], h.deps);
    expect(r.failures[0]).toMatchObject({ code: "install_failed" });
    expect(leftovers()).toEqual([false, false]);
  });
});

describe("Команда cli candidates / Прерывание", () => {
  it("abort during fetch: interrupted, no record, prefix removed, other agent not started", async () => {
    const ac = new AbortController();
    const h = harness({ signal: ac.signal, onFetch: () => ac.abort() });
    const r = await checkCandidates(dir, ["claude", "codex"], h.deps);
    expect(r.interrupted).toBe(true);
    expect(r.code).toBe(1);
    expect(r.failures).toEqual([]);
    expect(h.fetched).toEqual(["claude@2.1.289"]);
    expect(existsSync(recordFile())).toBe(false);
    expect(leftovers()).toEqual([false, false]);
  });
  it("a rejection while aborted is an interruption, not a failure", async () => {
    const ac = new AbortController();
    const h = harness({ signal: ac.signal });
    h.deps.source = { fetch: async () => { ac.abort(); throw new Error("aborted"); } };
    const r = await checkCandidates(dir, ["claude"], h.deps);
    expect(r.interrupted).toBe(true);
    expect(r.failures).toEqual([]);
    expect(leftovers()).toEqual([false, false]);
  });
});

describe("Нет вызовов моделей и автоматического перехода / Подставной CLI считает вызовы", () => {
  it("runs only --version, the help args and features list", async () => {
    const h = harness();
    await checkCandidates(dir, ["claude", "codex"], h.deps);
    expect(h.calls).toEqual([["--version"], [...HELP_ARGS.claude], ["--version"], [...HELP_ARGS.codex], ["features", "list"]]);
  });
  it("active pin and pins.json bytes are unchanged; base comes from the pin", async () => {
    const pins = { schemaVersion: 1, agents: { claude: { installed: [{ version: "2.1.280", path: "bin/claude", source: "t", sha256: "a".repeat(64), installedAt: "2026-10-01T00:00:00Z" }], active: "2.1.280", previous: null, activatedAt: "2026-10-01T00:00:00Z" } } };
    mkdirSync(join(dir, "cli"));
    const text = JSON.stringify(pins, null, 2);
    writeFileSync(join(dir, "cli", "pins.json"), text);
    const h = harness({ versions: { claude: ["2.1.270", "2.1.281", "2.1.288", "2.1.289"] } });
    const r = await checkCandidates(dir, ["claude"], h.deps);
    expect(r.bases.claude).toBe("2.1.280");
    expect(h.fetched).toEqual(["claude@2.1.281", "claude@2.1.289"]);
    expect(r.candidates.map((c) => [c.version, c.status])).toEqual([["2.1.281", "ok"], ["2.1.288", "already_recorded"], ["2.1.289", "ok"]]);
    expect(readFileSync(join(dir, "cli", "pins.json"), "utf8")).toBe(text);
    expect(readdirSync(join(dir, "cli"))).toEqual(["pins.json"]);
  });
});

describe("Команда cli candidates / Ограничение и повтор", () => {
  it("limit: 8 newer versions -> the 5 newest, ascending", async () => {
    const v = Array.from({ length: 8 }, (_, i) => `2.2.${i + 1}`);
    const h = harness({ versions: { claude: [...v].reverse() } });
    const r = await checkCandidates(dir, ["claude"], h.deps);
    expect(CANDIDATE_LIMIT).toBe(5);
    expect(r.candidates.map((c) => c.version)).toEqual(["2.2.4", "2.2.5", "2.2.6", "2.2.7", "2.2.8"]);
  });
  it("numeric, not lexical, version order; non-release versions ignored", async () => {
    const h = harness({ builtin: [base("claude", "2.1.5")], versions: { claude: ["2.1.9", "2.1.10", "2.2.0-beta.1", "latest", "2.1.10"] } });
    const r = await checkCandidates(dir, ["claude"], h.deps);
    expect(r.candidates.map((c) => c.version)).toEqual(["2.1.9", "2.1.10"]);
  });
  it("second run with a pin base: already_recorded, nothing fetched, no second entry", async () => {
    mkdirSync(join(dir, "cli"));
    const pins = { schemaVersion: 1, agents: { claude: { installed: [{ version: "2.1.280", path: "bin/claude", source: "t", sha256: "a".repeat(64), installedAt: "2026-10-01T00:00:00Z" }], active: "2.1.280", previous: null, activatedAt: "2026-10-01T00:00:00Z" } } };
    writeFileSync(join(dir, "cli", "pins.json"), JSON.stringify(pins));
    const h = harness({ versions: { claude: ["2.1.289"] } });
    await checkCandidates(dir, ["claude"], h.deps);
    const h2 = harness({ versions: { claude: ["2.1.289"] } });
    const r = await checkCandidates(dir, ["claude"], h2.deps);
    expect(r.candidates).toEqual([{ agent: "claude", version: "2.1.289", status: "already_recorded", violations: [], recorded: false }]);
    expect(h2.fetched).toEqual([]);
    expect(entries()).toHaveLength(1);
  });
  it("no pin: own interface entries do not move the base; a repeat run skips recorded, rechecks violating", async () => {
    const badHelp = (_a: string, v: string) => (v === "2.1.291" ? dropLines(claudeHelp, /^ {2,6}--tools\b/) : undefined);
    const first = harness({ versions: { claude: ["2.1.290", "2.1.291"] }, badHelp });
    const r1 = await checkCandidates(dir, ["claude"], first.deps);
    expect(r1.candidates.map((c) => [c.version, c.status])).toEqual([["2.1.290", "ok"], ["2.1.291", "violates"]]);
    const bytes = readFileSync(recordFile(), "utf8");
    const second = harness({ versions: { claude: ["2.1.290", "2.1.291"] }, badHelp });
    const r2 = await checkCandidates(dir, ["claude"], second.deps);
    expect(r2.bases.claude).toBe("2.1.288");
    expect(r2.candidates.map((c) => [c.version, c.status])).toEqual([["2.1.290", "already_recorded"], ["2.1.291", "violates"]]);
    expect(second.fetched).toEqual(["claude@2.1.291"]);
    expect(readFileSync(recordFile(), "utf8")).toBe(bytes);
  });
  it("a local real entry above the builtin moves the base", async () => {
    writeFileSync(recordFile(), `${JSON.stringify({ schemaVersion: 1, entries: [{ ...base("claude", "2.1.290") }] })}\n`);
    const h = harness({ versions: { claude: ["2.1.289", "2.1.290", "2.1.291"] } });
    const r = await checkCandidates(dir, ["claude"], h.deps);
    expect(r.bases.claude).toBe("2.1.290");
    expect(r.candidates.map((c) => c.version)).toEqual(["2.1.291"]);
  });
});
