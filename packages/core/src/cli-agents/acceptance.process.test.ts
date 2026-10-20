import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceptanceMessages } from "../messages/acceptance.ts";
import { providerMessages } from "../messages/providers.ts";
import { setProcessLanguage } from "../i18n/process-language.ts";
import { declaredFlags, parseCodexFeatures } from "./flags.ts";
import { DEFAULT_MODEL } from "./types.ts";
import type { CliAgent } from "./types.ts";
import { writeAcceptanceStub } from "./acceptance-stub.fixture.ts";
import { PROBES, runAcceptance, runProbe } from "./acceptance.ts";
import type { AcceptancePlan, ProbeContext, ProbeId, ProbeResult } from "./acceptance.ts";

// Real runProbe against a node stub that stands in for the CLI; the stub mode is set through STUB_MODE.
const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const codexFlags = declaredFlags(fx("codex-0.159.2-exec-help.txt"));
const codexFeatures = parseCodexFeatures(fx("codex-0.159.2-features.txt"));
const claudeFlags = declaredFlags(fx("claude-2.1.288-help.txt"));
const m = acceptanceMessages("en");
const LONG_TIMEOUT = 30_000;

let root: string;
let stubPath: string;
let pidFile: string;
beforeEach(() => {
  setProcessLanguage("en");
  root = mkdtempSync(join(tmpdir(), "accept-proc-"));
  stubPath = writeAcceptanceStub(root);
  pidFile = join(root, "child.pid");
});
afterEach(() => {
  // the detached child of the survive stub is not stopped by the product: the test removes it by the pid it saved
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  rmSync(root, { recursive: true, force: true });
});

function ctxFor(agent: CliAgent, mode: string, signal?: AbortSignal): ProbeContext {
  const version = agent === "codex" ? "0.159.2" : "2.1.288";
  const configDir = join(root, agent, "config");
  mkdirSync(configDir, { recursive: true });
  const plan: AcceptancePlan = { agent, version, path: stubPath, sha256: "", configDir, model: DEFAULT_MODEL, probes: PROBES, bound: 7 };
  return {
    plan,
    env: { PATH: "/usr/bin:/bin", STUB_MODE: mode, STUB_PIDFILE: pidFile },
    language: "en",
    flags: agent === "codex" ? codexFlags : claudeFlags,
    ...(agent === "codex" ? { features: codexFeatures } : {}),
    ...(signal ? { signal } : {}),
  };
}

const probe = (id: ProbeId, agent: CliAgent, mode: string): Promise<ProbeResult> => runProbe(id, ctxFor(agent, mode));
// Under a loaded machine the stub may start later than STOP_AFTER_MS: the stub-behaviour cases stop on the first output only,
// so the timer never fires before the stub has done what the case checks.
const stopOnOutput = (mode: string): Promise<ProbeResult> => runProbe("stop", { ...ctxFor("codex", mode), stopAfterMs: 20_000 });

describe("Isolation probes with a well-behaved CLI", () => {
  it("isolation confirmed: the good stub passes every probe on codex", async () => {
    for (const id of ["valid_turn", "outside_file", "tool_call", "mcp_server", "instructions", "resume"] as const) {
      const r = await probe(id, "codex", "good");
      expect(r, id).toMatchObject({ ok: true, calls: 1 });
    }
  }, LONG_TIMEOUT);

  it("isolation confirmed on claude for the valid turn and the stop", async () => {
    expect(await probe("valid_turn", "claude", "good")).toMatchObject({ ok: true, calls: 1 });
    expect(await probe("stop", "claude", "good")).toMatchObject({ ok: true, calls: 1 });
  }, LONG_TIMEOUT);

  it("a probe reports the raw stdout of the valid turn only", async () => {
    const r = await probe("valid_turn", "codex", "good");
    expect(r.raw).toContain("agent_message");
    expect((await probe("outside_file", "codex", "good")).raw).toBeUndefined();
  });
});

describe("Isolation probes with a leaking or misbehaving CLI", () => {
  it("instruction leak: the token of AGENTS.md in the answer fails the probe", async () => {
    const r = await probe("instructions", "codex", "leak");
    expect(r).toMatchObject({ ok: false, calls: 1, reason: m.tokenInstructions });
  }, LONG_TIMEOUT);

  it("outside-file leak: the CLI reads the absolute path from the prompt and prints it", async () => {
    const r = await probe("outside_file", "codex", "read");
    expect(r).toMatchObject({ ok: false, reason: m.tokenOutside });
  });

  it("tool call despite isolation: the event names the kind, the reason is the isolation message", async () => {
    const r = await probe("tool_call", "codex", "tool");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(providerMessages("en").toolDespiteIsolation("codex", "command_execution"));
  });

  it("tool call that ran its command: the marker file fails the probe", async () => {
    const r = await probe("tool_call", "codex", "touch");
    expect(r).toMatchObject({ ok: false, reason: m.markerCreated });
  });

  it("MCP server of the working folder started: the probe fails", async () => {
    const r = await probe("mcp_server", "codex", "mcp");
    expect(r).toMatchObject({ ok: false, reason: m.mcpStarted });
  });

  it("an erroring CLI fails the valid turn with its stderr", async () => {
    const r = await probe("valid_turn", "codex", "err");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("boom");
  });

  it("an erroring CLI fails the turn after the stop, and the good one passes", async () => {
    expect(await probe("resume", "codex", "err")).toMatchObject({ ok: false });
    expect(await probe("resume", "codex", "good")).toMatchObject({ ok: true });
  });
});

describe("Stop probe", () => {
  it("stop pass: a slowly streaming CLI is stopped in time and leaves nothing behind", async () => {
    const started = Date.now();
    const r = await probe("stop", "codex", "good");
    expect(r).toMatchObject({ ok: true, calls: 1 });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, LONG_TIMEOUT);

  it("the process survived the stop: its detached child is reported, the test removes it", async () => {
    const r = await stopOnOutput("survive");
    const childPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(r).toMatchObject({ ok: false, reason: m.survived(String(childPid)) });
  }, LONG_TIMEOUT);

  it("the CLI wrote session history before the stop: the probe fails naming the file", async () => {
    const r = await stopOnOutput("history");
    expect(r).toMatchObject({ ok: false, reason: m.historyWritten("sessions/x.jsonl") });
  }, LONG_TIMEOUT);

  it("the turn finished before the stop: the probe fails", async () => {
    const r = await stopOnOutput("quick");
    expect(r).toMatchObject({ ok: false, reason: m.finishedBeforeStop });
  }, LONG_TIMEOUT);

  it("an interruption of the command is not the stop probe's failure", async () => {
    // Abort once the stub reports its start (STUB_LOG), not after a fixed delay: a fixed 500 ms raced the stop itself,
    // which finished first wherever the stub starts fast (Linux CI). The claude stub stays silent for 60 s and the stop
    // timer is 20 s, so nothing but the abort can end this probe.
    const controller = new AbortController();
    const log = join(root, "launches.log");
    let abortedAt = 0;
    const poll = setInterval(() => {
      if (existsSync(log) && readFileSync(log, "utf8").trim()) { clearInterval(poll); abortedAt = Date.now(); controller.abort(); }
    }, 10);
    const ctx = ctxFor("claude", "good", controller.signal);
    const r = await runProbe("stop", { ...ctx, env: { ...ctx.env, STUB_LOG: log }, stopAfterMs: 20_000 }).finally(() => clearInterval(poll));
    expect(r).toMatchObject({ ok: false, calls: 1, reason: m.interrupted });
    // the abort itself ends the command: well before the 20 s stop timer could
    expect(Date.now() - abortedAt).toBeLessThan(10_000);
  }, LONG_TIMEOUT);
});

describe("Full acceptance with the real probes", () => {
  const dataDir = () => join(root, "data");
  const inspect = async () => ({ flags: codexFlags, features: codexFeatures });
  const planFor = (mode: string): AcceptancePlan => ({ ...ctxFor("codex", mode).plan, sha256: "a".repeat(64) });

  it("the good CLI passes all seven probes and writes real with 7 calls", async () => {
    mkdirSync(dataDir(), { recursive: true });
    const out = await runAcceptance(dataDir(), planFor("good"), { env: { PATH: "/usr/bin:/bin", STUB_MODE: "good", STUB_PIDFILE: pidFile }, language: "en" }, { inspect });
    expect(out).toMatchObject({ code: 0, recorded: true, calls: 7 });
    expect(out.outcomes.every((o) => o.ok)).toBe(true);
    const record = JSON.parse(readFileSync(join(dataDir(), "cli-verified.json"), "utf8"));
    expect(record.entries[0]).toMatchObject({ agent: "codex", version: "0.159.2", level: "real", modelCalls: 7 });
  }, LONG_TIMEOUT);

  it("a leaking CLI fails the instructions probe: the later probes are not run, nothing is recorded", async () => {
    mkdirSync(dataDir(), { recursive: true });
    const out = await runAcceptance(dataDir(), planFor("leak"), { env: { PATH: "/usr/bin:/bin", STUB_MODE: "leak", STUB_PIDFILE: pidFile }, language: "en" }, { inspect });
    expect(out.code).toBe(5);
    expect(out.outcomes.map((o) => o.probe)).toEqual(["valid_turn", "outside_file", "tool_call", "mcp_server", "instructions"]);
    expect(out.text).toContain(m.tokenInstructions);
    expect(existsSync(join(dataDir(), "cli-verified.json"))).toBe(false);
  }, LONG_TIMEOUT);
});

describe("Launch of a probe", () => {
  it("runs the pinned binary with the isolation args, the pinned env and COUNCIL_PARTICIPANT=1 in a new empty folder that is removed afterwards", async () => {
    const proto = join(root, "proto");
    const sh = join(root, "codex-proto");
    writeFileSync(sh, `#!/bin/sh
cat > /dev/null
{ echo "CODEX_HOME=$CODEX_HOME"; echo "COUNCIL_PARTICIPANT=$COUNCIL_PARTICIPANT"; echo "PWD=$(pwd)"; echo "LS=$(ls -A)"; echo "ARGS=$*"; } > "${proto}"
echo '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`);
    chmodSync(sh, 0o755);
    const ctx = ctxFor("codex", "good");
    const r = await runProbe("valid_turn", { ...ctx, plan: { ...ctx.plan, path: sh } });
    expect(r).toMatchObject({ ok: true, calls: 1 });
    const lines = Object.fromEntries(readFileSync(proto, "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    expect(lines.CODEX_HOME).toBe(ctx.plan.configDir);
    expect(lines.COUNCIL_PARTICIPANT).toBe("1");
    expect(lines.LS).toBe("");
    expect(lines.ARGS).toContain("exec --sandbox read-only --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules --json");
    expect(lines.ARGS).toContain("-c check_for_update_on_startup=false");
    expect(existsSync(lines.PWD!)).toBe(false);
  });
});

