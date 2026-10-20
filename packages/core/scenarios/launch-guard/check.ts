// Check of the launch guard for pinned CLI installs (change 177): real council processes and the real MCP server over stdio,
// `claude` and `codex` stubs in the stand folder, scripted participants, 0 model calls, no network:
//   COUNCIL_DEV=1 COUNCIL_HOME=<new folder inside the repository> node packages/core/scenarios/launch-guard/check.ts
// Without COUNCIL_HOME the stand creates <repository>/.council-data/launch-guard-*. The folder is deleted on success and kept on failure.
// Pins are created by `council cli install` through the substitute package source of council-test.ts (the production entry has none);
// everything else runs through the production council.ts and the production MCP server. Children get a PATH with the stand bin only,
// so the real `claude` and `codex` are never launched. The stand sets the language of each child itself (COUNCIL_LANG), en and ru.
// Steps 1-7 and 9-11 of the Live Scenario in openspec/changes/177-cli-launch-guard/verification.md; step 8 (the window) is not here.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { checkPinnedLaunch, resetGuardCache } from "../../src/cli-agents/launch-guard.ts";
import type { VerifiedRecord } from "../../src/cli-agents/verified-record.ts";
import { CODEX_HELP, launches, writeStub } from "./stub.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Run: COUNCIL_DEV=1 COUNCIL_HOME=<new folder inside the repository> node packages/core/scenarios/launch-guard/check.ts");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
const entry = join(import.meta.dirname, "council-test.ts");
const council = join(repo, "packages/core/src/council.ts");
const mcpMain = join(repo, "packages/mcp/src/main.ts");
const scenario = join(import.meta.dirname, "scenario.json");
const given = process.env.COUNCIL_HOME ? resolve(process.env.COUNCIL_HOME) : undefined;
if (given && relative(repo, given).startsWith("..")) {
  console.error(`COUNCIL_HOME must be inside the repository (${repo}): ${given}`);
  process.exit(2);
}
const work = given ?? join(repo, ".council-data", `launch-guard-${Date.now()}-${randomBytes(3).toString("hex")}`);
mkdirSync(work, { recursive: true });

const EXIT_USAGE = 2, EXIT_FAILED = 5;
type Lang = "en" | "ru";
// stand binaries: bin (claude and codex stubs the PATH lookup finds), bin9 (an unverified claude for step 9), explicit (a claude at a configured path)
const bin = join(work, "bin"), bin9 = join(work, "bin9"), explicitDir = join(work, "explicit"), marks = join(work, "marks");
for (const d of [bin, bin9, explicitDir, marks]) mkdirSync(d, { recursive: true });
// the login-shell lookup must not run the owner's shell: a stub shell that prints PATH only
const fakeShell = join(bin, "fake-shell");
writeFileSync(fakeShell, `#!/bin/sh\nprintf '\\n__COUNCIL_PATH__%s__COUNCIL_PATH__\\n' "$PATH"\n`);
chmodSync(fakeShell, 0o755);
const pathMark = (agent: string) => join(marks, `path-${agent}`);
writeStub(join(bin, "claude"), { agent: "claude", version: "1.0.0", mark: pathMark("claude"), side: join(marks, "side-path-claude") });
writeStub(join(bin, "codex"), { agent: "codex", version: "3.0.0", mark: pathMark("codex"), side: join(marks, "side-path-codex") });
writeStub(join(bin9, "claude"), { agent: "claude", version: "5.0.0", mark: join(marks, "unverified-claude"), side: join(marks, "side-unverified") });
writeStub(join(explicitDir, "claude"), { agent: "claude", version: "6.0.0", mark: join(marks, "explicit-claude"), side: join(marks, "side-explicit") });
const clearMarks = () => { for (const f of readdirSync(marks)) if (!f.startsWith("side-")) rmSync(join(marks, f)); };

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- a data folder with both CLIs pinned and a local record that marks them real ----
interface Home { dir: string; counters: string; side: string }
function standEnv(h: Pick<Home, "dir" | "counters" | "side">, o: { lang?: Lang; path?: string } = {}): Record<string, string> {
  return {
    PATH: `${o.path ?? bin}:/usr/bin:/bin`, HOME: h.dir, SHELL: fakeShell, COUNCIL_HOME: join(h.dir, "data"), COUNCIL_DEV: "1", COUNCIL_LANG: o.lang ?? "en",
    LAUNCH_GUARD_STAND: JSON.stringify({ counters: h.counters, side: h.side }),
  };
}
interface Result { code: number; out: string; err: string; all: string }
function run(h: Home, script: string, args: string[], o: { lang?: Lang; path?: string } = {}, watch?: () => void): Promise<Result> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [script, ...args], { env: standEnv(h, o), cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const poll = watch ? setInterval(watch, 5) : undefined;
    const timer = setTimeout(() => rej(new Error(`timeout: council ${args.join(" ")}`)), 90_000);
    child.on("close", (code) => { clearTimeout(timer); if (poll) clearInterval(poll); res({ code: code ?? -1, out, err, all: out + err }); });
  });
}
const data = (h: Home) => join(h.dir, "data");
const recordFile = (h: Home) => join(data(h), "cli-verified.json");
const writeRecord = (h: Home, levels: Record<string, "real" | "interface" | null>) => {
  const base = { checkedAt: "2026-10-20", os: "darwin-arm64", osenVersion: "1.0.0" };
  const versions: Record<string, string> = { claude: "1.0.0", codex: "3.0.0" };
  const entries = Object.entries(levels).flatMap(([agent, level]) => level === null ? [] : [{ agent, version: versions[agent]!, level, ...base, ...(level === "real" ? { modelCalls: 2 } : {}) }]);
  writeFileSync(recordFile(h), JSON.stringify({ schemaVersion: 1, entries }, null, 2));
};
const pinMark = (h: Home, agent: string) => join(h.counters, `pin.${agent}`);
const pinPath = (h: Home, agent: "claude" | "codex") => join(data(h), "cli", agent, agent === "claude" ? "1.0.0" : "3.0.0", "node_modules", "pkg", "bin", agent);
const pinSha = (h: Home, agent: "claude" | "codex"): string => {
  const a = (JSON.parse(readFileSync(join(data(h), "cli", "pins.json"), "utf8")) as { agents: Record<string, { installed: { sha256: string }[] }> }).agents[agent]!;
  return a.installed[0]!.sha256;
};
async function fresh(name: string): Promise<Home> {
  const dir = join(work, name);
  const h: Home = { dir, counters: join(dir, "counters"), side: join(dir, "side") };
  for (const d of [data(h), h.counters, h.side]) mkdirSync(d, { recursive: true });
  for (const [agent, version] of [["claude", "1.0.0"], ["codex", "3.0.0"]] as const) {
    const r = await run(h, entry, ["cli", "install", agent, "--version", version]);
    assert.equal(r.code, 0, r.all);
  }
  writeRecord(h, { claude: "real", codex: "real" });
  // the first `providers` run writes config.json with the CLIs it finds: do it while both pins are intact, as on an owner's machine
  const first = await run(h, council, ["providers", "--json"]);
  assert.equal(first.code, 0, first.all);
  for (const f of readdirSync(h.counters)) rmSync(join(h.counters, f)); // installing probed the stubs: start counting from zero
  clearMarks();
  return h;
}
const status = (r: Result, id: string): { available: boolean; reason?: string; warning?: string; path?: string; version?: string } => {
  const find = (v: unknown): Record<string, unknown> | undefined => {
    if (Array.isArray(v)) { for (const x of v) { const f = find(x); if (f) return f; } return undefined; }
    if (v && typeof v === "object") {
      if ((v as { id?: unknown }).id === id) return v as Record<string, unknown>;
      for (const x of Object.values(v)) { const f = find(x); if (f) return f; }
    }
    return undefined;
  };
  const s = find(JSON.parse(r.out) as unknown);
  assert.ok(s, `no ${id} provider in: ${r.out.slice(0, 300)}`);
  return s as never;
};
const providers = async (h: Home, lang: Lang = "en", path?: string) => run(h, council, ["providers", "--json"], { lang, path });
const discuss = (h: Home, participant: string, lang: Lang = "en", watch?: () => void) =>
  run(h, council, ["--topic", "Check the launch guard", "--participant", participant, "--participant", `scripted:${scenario}`, "--max-rounds", "3"], { lang }, watch);

// ---- MCP over stdio ----
type Tool = { isError?: boolean; content: { text: string }[] };
async function withMcp<T>(h: Home, lang: Lang, f: (call: (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>) => Promise<T>): Promise<T> {
  const client = new Client({ name: "launch-guard-check", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpMain], cwd: repo, stderr: "ignore", env: standEnv(h, { lang }) }));
  try {
    return await f(async (name, args) => {
      const r = (await client.callTool({ name, arguments: args })) as Tool;
      return { isError: r.isError === true, text: r.content[0]?.text ?? "" };
    });
  } finally { await client.close(); }
}
const sessionIds = (h: Home) => (existsSync(join(data(h), "sessions")) ? readdirSync(join(data(h), "sessions")) : []);
const journal = (h: Home, id: string) => readFileSync(join(data(h), "sessions", id, "events.jsonl"), "utf8");
const events = (h: Home, id: string) => journal(h, id).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

const T = {
  en: { sum: "checksum does not match", real: "real acceptance of this version is not recorded", ver: "reports version", missing: "is missing at" },
  ru: { sum: "контрольная сумма не совпала", real: "реальная приёмка версии не записана", ver: "сообщает версию", missing: "отсутствует по пути" },
} as const;

let n = 0, failed = 0;
async function step(name: string, f: () => Promise<void>): Promise<void> {
  try {
    await f();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL - ${name}\n  ${(e instanceof Error ? (e.stack ?? e.message) : String(e)).slice(0, 1500).replace(/\n/g, "\n  ")}`);
  }
  n++;
}

// 1
await step("1. Pin matches: both pinned CLIs are available, no warning, the record level is real", async () => {
  const h = await fresh("s1");
  const r = await providers(h);
  assert.equal(r.code, 0, r.all);
  for (const id of ["claude", "codex"]) {
    const s = status(r, id);
    assert.equal(s.available, true, JSON.stringify(s));
    assert.equal(s.path, pinPath(h, id as "claude"));
    assert.ok(!s.warning, `${id} warning: ${s.warning}`);
  }
  assert.ok(launches(pinMark(h, "claude")) > 0 && launches(pinMark(h, "codex")) > 0, "inspection reads the version of both pins");
});

// 2
await step("2. Binary replaced after install (en, ru): unavailable with expected and actual checksum, a start is refused before any turn, the tampered binary never ran", async () => {
  const h = await fresh("s2");
  const expected = pinSha(h, "claude");
  appendFileSync(pinPath(h, "claude"), "\n# tampered\n");
  const actual = sha(readFileSync(pinPath(h, "claude")));
  assert.notEqual(actual, expected);
  for (const lang of ["en", "ru"] as const) {
    const r = await providers(h, lang);
    const s = status(r, "claude");
    assert.equal(s.available, false);
    assert.ok(s.reason?.includes(T[lang].sum), s.reason);
    assert.ok(s.reason?.includes(expected) && s.reason.includes(actual), `both checksums in: ${s.reason}`);
    assert.equal(status(r, "codex").available, true, "the other pin is unaffected");
    const text = await run(h, council, ["providers"], { lang });
    assert.ok(text.out.includes(T[lang].sum), text.out);
    const start = await discuss(h, "claude", lang);
    assert.equal(start.code, EXIT_USAGE, start.all);
    assert.ok(start.err.includes(T[lang].sum), start.err);
  }
  assert.equal(sessionIds(h).length, 0, "the refused start created no session");
  assert.equal(launches(pinMark(h, "claude")), 0, "the tampered binary must not run at all, not even for --version");
  assert.equal(launches(pathMark("claude")), 0);
});

// 3
await step("3. Version changed after self-update: unavailable with both versions, a PATH codex of the verified version never ran", async () => {
  const h = await fresh("s3");
  writeFileSync(join(h.side, "codex.ver"), "3.0.1");
  for (const lang of ["en", "ru"] as const) {
    const s = status(await providers(h, lang), "codex");
    assert.equal(s.available, false);
    assert.ok(s.reason?.includes(T[lang].ver) && s.reason.includes("3.0.1") && s.reason.includes("3.0.0"), s.reason);
  }
  assert.equal(launches(pathMark("codex")), 0, "the PATH codex (the verified version) must not run");
  assert.equal(launches(`${pinMark(h, "codex")}.turn`), 0);
  assert.equal(readFileSync(pinMark(h, "codex"), "utf8").split("\n").filter(Boolean).length, 2, "the pinned binary ran only for --version (once per inspection)");
});

// 4
await step("4. Pinned binary deleted while a claude is on PATH: unavailable, the reason names the pin path, the PATH binary never ran", async () => {
  const h = await fresh("s4");
  rmSync(pinPath(h, "claude"));
  for (const lang of ["en", "ru"] as const) {
    const s = status(await providers(h, lang), "claude");
    assert.equal(s.available, false);
    assert.ok(s.reason?.includes(pinPath(h, "claude")) && s.reason.includes(T[lang].missing), s.reason);
  }
  const start = await discuss(h, "claude");
  assert.equal(start.code, EXIT_USAGE, start.all);
  assert.ok(start.err.includes(pinPath(h, "claude")), start.err);
  assert.equal(launches(pathMark("claude")), 0, "the PATH claude must not run in place of the pin");
});

// 5
await step("5. Record level is not real: unavailable (level interface, and no entry at all), the binary is not launched", async () => {
  const h = await fresh("s5");
  for (const [levels, lang] of [[{ claude: "real", codex: "interface" }, "en"], [{ claude: "real", codex: null }, "ru"]] as const) {
    writeRecord(h, levels);
    const s = status(await providers(h, lang), "codex");
    assert.equal(s.available, false);
    assert.ok(s.reason?.includes(T[lang].real), s.reason);
    assert.equal(status(await providers(h, lang), "claude").available, true);
  }
  assert.equal(launches(pinMark(h, "codex")), 0, "the level check comes before the --version launch");
  assert.equal(launches(pathMark("codex")), 0);
});

// 6
await step("6. Swap in the middle of a session (council): the next turn is rejected before the process starts, the participant drops out, no retry, journal prefix unchanged, no usage event for the rejected turn", async () => {
  const h = await fresh("s6");
  writeFileSync(join(h.side, "claude.swap"), ""); // the stub appends a byte to itself on its first turn
  const snapshots: string[] = [];
  const watch = () => {
    for (const id of sessionIds(h)) { try { const t = journal(h, id); if (snapshots.at(-1) !== t) snapshots.push(t); } catch { /* not written yet */ } }
  };
  const r = await discuss(h, "claude", "en", watch);
  assert.equal(r.code, EXIT_FAILED, r.all);
  const [id] = sessionIds(h);
  assert.ok(id);
  assert.equal(launches(`${pinMark(h, "claude")}.turn`), 1, "claude took exactly one turn: the second was rejected before a process started");
  const ev = events(h, id);
  const failedTurns = ev.filter((e) => e.type === "turn_failed");
  assert.equal(failedTurns.length, 1, "no retry of the rejected turn");
  assert.equal(failedTurns[0]!.participantId, "p1");
  assert.ok(String(failedTurns[0]!.message).includes(T.en.sum), String(failedTurns[0]!.message));
  assert.equal(ev.filter((e) => e.type === "participant_dropped" && e.participantId === "p1").length, 1);
  assert.equal(ev.filter((e) => e.type === "turn_completed" && e.participantId === "p1").length, 1, "p1 has exactly one completed turn, so exactly one usage entry");
  const failedAt = ev.findIndex((e) => e.type === "turn_failed");
  assert.deepEqual(ev.slice(failedAt + 1).map((e) => e.type), ["participant_dropped", "session_finished"], "no turn and no usage after the rejection");
  const final = journal(h, id);
  assert.ok(snapshots.length > 1, "the journal was observed while it grew");
  for (const s of snapshots) assert.ok(final.startsWith(s), "an earlier journal state is a prefix of the final journal");
  assert.ok(snapshots.some((s) => s.includes('"turn_completed"') && !s.includes('"turn_failed"')), "a journal state between the swap and the rejection was observed");
  const shown = await run(h, council, ["show", id]);
  assert.equal(shown.code, 0, shown.all);
  assert.ok(shown.out.includes(T.en.sum) && /dropped out/.test(shown.out), shown.out);
  const ru = await run(h, council, ["show", id], { lang: "ru" });
  assert.ok(ru.out.includes("p1"), ru.out);
});

// 6, MCP half of the scenario
await step("6. Swap in the middle of a session (MCP council_start and council_status): the status shows the participant dropped with the reason", async () => {
  const h = await fresh("s6m");
  writeFileSync(join(h.side, "claude.swap"), "");
  await withMcp(h, "en", async (call) => {
    const start = await call("council_start", { topic: "Check the launch guard", participants: [{ providerId: "claude", model: "default" }, { providerId: "scripted", model: "launch-guard/scenario.json" }], maxRounds: 3 });
    assert.equal(start.isError, false, start.text);
    const { sessionId } = JSON.parse(start.text) as { sessionId: string };
    let st: { status: string; participants: { id: string; state: string; dropReason?: string }[] } | undefined;
    for (let i = 0; i < 30; i++) {
      const r = await call("council_status", { sessionId, waitSec: 2 });
      assert.equal(r.isError, false, r.text);
      st = JSON.parse(r.text);
      if (st!.status !== "running") break;
    }
    assert.equal(st?.status, "failed", JSON.stringify(st));
    const p1 = st!.participants.find((p) => p.id === "p1");
    assert.equal(p1?.state, "dropped");
    assert.ok(p1?.dropReason?.includes(T.en.sum), p1?.dropReason);
    assert.equal(launches(`${pinMark(h, "claude")}.turn`), 1);
  });
});

// 7
await step("7. MCP: council_options marks the provider unavailable with the reason, council_start refuses with provider and reason and creates no session (en, ru)", async () => {
  const h = await fresh("s7");
  appendFileSync(pinPath(h, "claude"), "\n# tampered\n");
  for (const lang of ["en", "ru"] as const) {
    await withMcp(h, lang, async (call) => {
      const o = await call("council_options", {});
      assert.equal(o.isError, false, o.text);
      const claude = (JSON.parse(o.text) as { providers: { id: string; available: boolean; reason?: string }[] }).providers.find((p) => p.id === "claude");
      assert.equal(claude?.available, false);
      assert.ok(claude?.reason?.includes(T[lang].sum), claude?.reason);
      const s = await call("council_start", { topic: "x", participants: [{ providerId: "claude", model: "default" }, { providerId: "scripted", model: "launch-guard/scenario.json" }] });
      assert.equal(s.isError, true, s.text);
      assert.ok(s.text.includes("claude") && s.text.includes(T[lang].sum), s.text);
    });
  }
  assert.equal(sessionIds(h).length, 0);
  assert.equal(launches(pinMark(h, "claude")), 0);
});

// 9
await step("9. No pin: a PATH stub of an unverified version, and an explicit provider.path next to a pin, stay available with a warning as before the change", async () => {
  const noPins = join(work, "s9a");
  const a: Home = { dir: noPins, counters: join(noPins, "counters"), side: join(noPins, "side") };
  mkdirSync(data(a), { recursive: true });
  const ra = await providers(a, "en", bin9);
  const sa = status(ra, "claude");
  assert.equal(sa.available, true, JSON.stringify(sa));
  assert.equal(sa.path, join(bin9, "claude"));
  assert.ok(sa.warning, "the old warning about an unverified version is kept");
  assert.equal(existsSync(join(data(a), "cli")), false);
  const h = await fresh("s9b");
  const cfg = JSON.parse(readFileSync(join(data(h), "config.json"), "utf8")) as { providers: { id: string; path?: string }[] };
  cfg.providers.find((p) => p.id === "claude")!.path = join(explicitDir, "claude");
  writeFileSync(join(data(h), "config.json"), JSON.stringify(cfg, null, 2));
  const sb = status(await providers(h), "claude");
  assert.equal(sb.available, true, JSON.stringify(sb));
  assert.equal(sb.path, join(explicitDir, "claude"));
  assert.ok(sb.warning, "an explicit path to an unverified version warns, it is not a pin");
  assert.equal(launches(pinMark(h, "claude")), 0, "the pin is not launched when the explicit path wins");
});

// 10
await step("10. Isolation: the pin matches but the help does not declare --disable: unavailable with the launch-plan reason", async () => {
  const h = await fresh("s10");
  const lines = readFileSync(CODEX_HELP, "utf8").split("\n");
  const at = lines.findIndex((l) => l.includes("--disable <FEATURE>"));
  assert.ok(at >= 0);
  writeFileSync(join(h.side, "codex.help"), lines.filter((_, i) => i !== at && i !== at + 1).join("\n"));
  const s = status(await providers(h), "codex");
  assert.equal(s.available, false);
  assert.ok(s.reason?.includes("--disable"), s.reason);
  assert.ok(!s.reason?.includes(T.en.sum), "the pin itself matched");
  rmSync(join(h.side, "codex.help"));
  assert.equal(status(await providers(h), "codex").available, true, "with the full help the same pin is available");
});

// 11
await step("11. Cost: an unchanged file is hashed once, a changed file (size, then only mtime) is hashed again", async () => {
  const file = join(work, "cost-binary");
  writeFileSync(file, "#!/bin/sh\necho 1.0.0\n");
  chmodSync(file, 0o755);
  const record: VerifiedRecord = { entries: [{ agent: "claude", version: "1.0.0", level: "real", checkedAt: "2026-10-20", os: "darwin-arm64", osenVersion: "1.0.0", modelCalls: 2 }] };
  let hashes = 0;
  const overrides = {
    hash: async (p: string) => { hashes++; return sha(readFileSync(p)); },
    readVersion: async () => "1.0.0 (Claude Code)",
  };
  const check = (expectSha: string) => checkPinnedLaunch({ agent: "claude", pin: { path: file, version: "1.0.0", sha256: expectSha }, launchPath: file, record, env: {} }, overrides);
  resetGuardCache();
  const original = sha(readFileSync(file));
  assert.equal((await check(original)).ok, true);
  assert.equal((await check(original)).ok, true);
  assert.equal(hashes, 1, "two checks of an unchanged file hash it once");
  appendFileSync(file, "# more\n");
  const afterSize = await check(original);
  assert.equal(afterSize.ok, false);
  assert.equal(hashes, 2, "a size change hashes again and the new sum is compared");
  truncateSync(file, readFileSync(file).length - 7); // back to the original bytes, same size as the first hash
  assert.equal(sha(readFileSync(file)), original);
  assert.equal((await check(original)).ok, true);
  assert.equal((await check(original)).ok, true);
  assert.equal(hashes, 3, "restored bytes: hashed once more (size changed back), then cached");
  const t = new Date(Date.now() + 60_000);
  utimesSync(file, t, t);
  assert.equal((await check(original)).ok, true);
  assert.equal(hashes, 4, "only the mtime changed: hashed again");
});

console.log(`\n${n - failed} of ${n} steps passed`);
if (failed === 0) rmSync(work, { recursive: true, force: true });
else console.log(`Stand folder kept: ${work}`);
process.exit(failed ? 1 : 0);
