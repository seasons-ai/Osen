import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "./server.ts";
import { mcpMessages } from "./messages.ts";
import { setProcessLanguage, saveLineup, configPath, createScriptedDriver, createSession, eventsPath, initialRegistry, listSessions, readEvents, readSession, requestStop, runStoredSession } from "@model-council/core";

const root = join(import.meta.dirname, "../../..");
const main = join(import.meta.dirname, "main.ts");
const baseEnv = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", COUNCIL_LANG: "ru" }; // the child process does not inherit the vitest env: the language is pinned explicitly

const dirs: string[] = [];
const pids: number[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const p of pids.splice(0)) try { process.kill(p, "SIGKILL"); } catch {}
  // council_start sessions live in detached executors: stop them before the folders go
  for (const d of dirs) {
    for (const x of listSessions(d)) {
      const pid = readSession(d, x.id)?.state.pid ?? null;
      if (x.status !== "running" || pid === null) continue;
      requestStop(d, x.id);
      if (!(await waitExit(pid, 5000))) try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = (registry: unknown = initialRegistry([])) => {
  const d = mkdtempSync(join(tmpdir(), "council-"));
  dirs.push(d);
  writeFileSync(configPath(d), JSON.stringify(registry));
  return d;
};

async function connect(dataDir: string, extra: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [main], cwd: root, stderr: "ignore",
    env: { ...baseEnv, COUNCIL_HOME: dataDir, COUNCIL_DEV: "1", ...extra },
  });
  const client = new Client({ name: "test", version: "0" });
  clients.push(client);
  await client.connect(transport);
  pids.push(transport.pid!);
  return { client, pid: transport.pid! };
}

type Res = { isError?: boolean; content: { type: string; text: string }[] };
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as Res;
const json = (r: Res) => JSON.parse(r.content[0]!.text);
const scripted = (...files: string[]) => files.map((model) => ({ providerId: "scripted", model }));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitExit(pid: number, ms = 5000) {
  const t0 = Date.now();
  while (alive(pid) && Date.now() - t0 < ms) await sleep(50);
  return !alive(pid);
}

// session no_consensus (p1 amend, p2 object), scenarios — absolute paths; on resume p2 waits delayMs
async function priorSession(dir: string, ownerWait?: { pauseAfterRound: boolean; timeoutSec: number }, signal?: AbortSignal, resumeDelayMs = 60000) {
  const sc = tmp();
  const step = (stance: string, solution: string | null, delayMs?: number) => ({ response: { stance, reasoning: "r", solution, answers: [], questions: [] }, ...(delayMs ? { delayMs } : {}) });
  const first = [step("amend", "v1"), step("object", null)];
  const models = [[first[0], step("agree", null)], [first[1], step("agree", null, resumeDelayMs)]].map((steps, i) => { const f = join(sc, `p${i + 1}.json`); writeFileSync(f, JSON.stringify({ steps })); return f; });
  const id = "20200101-000000-resume";
  const session = createSession({
    topic: "Имя кота", framing: "", origin: "mcp", ...(ownerWait ? { ownerWait } : {}),
    limits: { maxRounds: ownerWait ? 3 : 1, turnTimeoutSec: 90, contextChars: 20000 },
    participants: models.map((model, i) => ({ name: `N${i + 1}`, providerId: "scripted", model, role: null })),
  }, { maxParticipants: 8, id });
  const drivers = Object.fromEntries(first.map((f, i) => [`p${i + 1}`, createScriptedDriver({ steps: [f as never] }, { COUNCIL_DEV: "1" })]));
  await runStoredSession({ session, drivers, dataDir: dir, ...(signal ? { signal } : {}), waitPollMs: 20 });
  return id;
}
const evCount = (dir: string, id: string, type: string) => readEvents(dir, id)!.events.filter((e) => e.type === type).length;
const poll = async (f: () => boolean, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (f()) return; throw new Error("не дождались"); };

async function startSlow(client: Client) {
  const { sessionId } = json(await call(client, "council_start", { topic: "Имя кота", participants: scripted("slow/p1.json", "slow/p2.json") }));
  for (let i = 0; i < 6; i++) {
    const s = json(await call(client, "council_status", { sessionId, waitSec: 5 }));
    if (s.turns >= 1) return sessionId as string;
  }
  throw new Error("первый ход не завершился");
}

describe("MCP server osen", () => {
  it("publishes exactly seven tools", async () => {
    const { client } = await connect(tmp());
    expect(client.getServerVersion()?.name).toBe("osen");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["council_continue", "council_options", "council_resume", "council_say", "council_start", "council_status", "council_stop"]);
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeTruthy();
    }
    expect(tools.find((t) => t.name === "council_start")!.description).toMatch(/подписк|денег/);
  });

  it("gives the agent the instructions and the extended council_start description", async () => {
    const { client } = await connect(tmp());
    const ins = client.getInstructions();
    expect(typeof ins).toBe("string");
    for (const w of ["council_options", "council_status", "согласи", "верхнюю границу"]) expect(ins).toContain(w);
    const d = (await client.listTools()).tools.find((t) => t.name === "council_start")!.description!;
    expect(d).toContain("Перед вызовом");
    expect(d).toContain("верхнюю границу");
    expect(d).toMatch(/подписк|денег/);
    expect(ins).toContain("ownerSelection");
    expect((await client.listTools()).tools.find((t) => t.name === "council_status")!.description).toContain("ownerSelection");
  });

  it("end-to-end path: options, start, status until consensus", async () => {
    const dir = tmp();
    const { client } = await connect(dir);
    const opts = json(await call(client, "council_options"));
    const sc = JSON.stringify(opts).includes("scripted");
    expect(sc).toBe(true);
    const start = await call(client, "council_start", { topic: "Имя кота", participants: scripted("consensus/p1.json", "consensus/p2.json") });
    expect(start.isError).toBeFalsy();
    const { sessionId } = json(start);
    let s: any;
    for (let i = 0; i < 6; i++) {
      s = json(await call(client, "council_status", { sessionId, waitSec: 5 }));
      if (s.status !== "running") break;
    }
    expect(s.status).toBe("consensus");
    expect(s.solution.text).toBeTruthy();
    expect(s.stats).toBeTruthy();
    expect(listSessions(dir).find((x) => x.id === sessionId)?.origin).toBe("mcp");
  });

  it("tool errors do not bring the server down", async () => {
    const bad = tmp({ ...initialRegistry([]), providers: [{ id: "ghost", label: "Призрак", kind: "cli", agent: "claude", models: [], path: "/nonexistent/ghost-cli" }] });
    const { client } = await connect(bad);
    const one = await call(client, "council_start", { topic: "т", participants: scripted("consensus/p1.json") });
    expect(one.isError).toBe(true);
    expect(one.content[0]!.text).toMatch(/двух|2/);
    const tpl = await call(client, "council_start", { topic: "т", templateId: "no-such-template", participants: scripted("consensus/p1.json", "consensus/p2.json") });
    expect(tpl.isError).toBe(true);
    const prov = await call(client, "council_start", { topic: "т", participants: [{ providerId: "ghost" }, { providerId: "ghost" }] });
    expect(prov.isError).toBe(true);
    expect(prov.content[0]!.text).toMatch(/Призрак|ghost/);
    expect(prov.content[0]!.text).toMatch(/недоступен/);
    const nf = await call(client, "council_status", { sessionId: "20200101-000000-nope" });
    expect(nf.isError).toBe(true);
    expect(nf.content[0]!.text).toMatch(/не найдена/);
    expect((await call(client, "council_options")).isError).toBeFalsy();
    expect(listSessions(bad)).toEqual([]);
  });

  it("a registry error names the field and is logged, then the server recovers", async () => {
    const dir = tmp();
    const good = initialRegistry([]);
    writeFileSync(configPath(dir), JSON.stringify({ ...good, defaults: { ...good.defaults, maxRounds: 0 } }));
    const { client } = await connect(dir);
    const r = await call(client, "council_options");
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("maxRounds");
    writeFileSync(configPath(dir), JSON.stringify(good));
    expect((await call(client, "council_options")).isError).toBeFalsy();
    expect(readFileSync(join(dir, "logs/app.log"), "utf8")).toMatch(/ERROR .*council_options/);
  });

  it("a discussion participant cannot convene a discussion", async () => {
    const dir = tmp();
    const { client } = await connect(dir, { COUNCIL_PARTICIPANT: "1" });
    const r = await call(client, "council_start", { topic: "т", participants: scripted("consensus/p1.json", "consensus/p2.json") });
    expect(r.isError).toBe(true);
    expect(listSessions(dir)).toEqual([]);
  });

  it("the instructions and descriptions contain the rules on waiting and owner messages", async () => {
    const { client } = await connect(tmp());
    const ins = client.getInstructions()!;
    for (const w of ["только по просьбе владельца", "ownerWaitSec", "requestId", "pauseAfterRound", "waitForOwner"]) expect(ins).toContain(w);
    const tools = (await client.listTools()).tools;
    for (const n of ["council_say", "council_continue"]) expect(tools.find((t) => t.name === n)!.description).toContain("только по просьбе владельца");
  });

  it("a discussion participant can neither speak for the owner nor clear the wait", async () => {
    const dir = tmp();
    const { client } = await connect(dir, { COUNCIL_PARTICIPANT: "1" });
    const sessionId = "20200101-000000-nope";
    const say = await call(client, "council_say", { sessionId, text: "т" });
    expect(say.isError).toBe(true);
    expect(say.content[0]!.text).toMatch(/Участник обсуждения/);
    const cont = await call(client, "council_continue", { sessionId, waitId: "w1" });
    expect(cont.isError).toBe(true);
    expect(cont.content[0]!.text).toMatch(/Участник обсуждения/);
    expect(listSessions(dir)).toEqual([]);
  });

  it("the instructions contain rule 9, the council_resume description — subscription spending", async () => {
    const { client } = await connect(tmp());
    const ins = client.getInstructions()!;
    for (const w of ["9. ", "council_resume", "planToken", "stale_plan", "requiresConsent", "согласия"]) expect(ins).toContain(w);
    expect((await client.listTools()).tools.find((t) => t.name === "council_resume")!.description).toContain("расходует подписки или деньги");
  });

  it("the instructions and the council_resume description contain the replacement rules; the list of seven tools is the same", async () => {
    const { client } = await connect(tmp());
    const ins = client.getInstructions()!;
    for (const w of ["replacements", "replacement", "insufficient_active_participants", "все согласия сброшены"]) expect(ins).toContain(w);
    expect(ins).not.toContain("consensus, failed и running не продолжаются");
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(7);
    const d = tools.find((t) => t.name === "council_resume")!;
    expect(d.description).toContain("replacements");
    expect(JSON.stringify(d.inputSchema)).toContain("replacements");
  });

  it("consensus is resumable only with message, in the owner's own words: instr9, resumeDesc and the schema, en and ru", async () => {
    const rules = {
      en: [/consensus is resumed only with message/, /owner's own words/, /only at the owner's request/, /agreementReset/, /stale_plan/],
      ru: [/consensus продолжается только с message/, /словами/, /только по его просьбе/, /agreementReset/, /stale_plan/],
    } as const;
    for (const lang of ["en", "ru"] as const) {
      const m = mcpMessages(lang);
      for (const [name, text] of [["instr9", m.instr9], ["resumeDesc", m.resumeDesc]] as const) {
        for (const re of rules[lang]) expect(text, `${lang} ${name} lacks ${re}`).toMatch(re);
      }
      expect(m.resumeFMessage.length).toBeGreaterThan(20);
    }
    const { client } = await connect(tmp());
    const tool = (await client.listTools()).tools.find((t) => t.name === "council_resume")!;
    const prop = (tool.inputSchema.properties as Record<string, { type?: string; description?: string }>).message;
    expect(prop?.type).toBe("string");
    expect(prop?.description).toBe(mcpMessages("ru").resumeFMessage);
    expect(tool.inputSchema.required ?? []).not.toContain("message");
  });

  it("a discussion participant cannot resume a discussion: neither plan nor launch", async () => {
    const dir = tmp();
    const { client } = await connect(dir, { COUNCIL_PARTICIPANT: "1" });
    const sessionId = "20200101-000000-nope";
    for (const args of [{ sessionId }, { sessionId, execute: true, planToken: "t" }]) {
      const r = await call(client, "council_resume", args);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/Участник обсуждения/);
    }
    expect(listSessions(dir)).toEqual([]);
  });

  // council_resume sessions run in a detached executor too: the server exit does not touch them
  const lockOf = (dir: string, id: string) => join(dir, "sessions", id, "resume.lock");
  for (const [name, stop] of [
    ["закрытие stdin", async (c: Client) => { await c.close(); }],
    ["SIGTERM", async (_c: Client, pid: number) => { process.kill(pid, "SIGTERM"); }],
  ] as const) {
    it(`Завершение сервера: server stop in the middle of a resumed turn (${name}) keeps the resumed session running in its executor`, async () => {
      const dir = tmp();
      const id = await priorSession(dir, undefined, undefined, 4000);
      const { client, pid } = await connect(dir);
      const plan = json(await call(client, "council_resume", { sessionId: id, rounds: 1 }));
      expect(json(await call(client, "council_resume", { sessionId: id, rounds: 1, execute: true, planToken: plan.planToken })).accepted).toBe(true);
      const executor = Number(readFileSync(lockOf(dir, id), "utf8").trim());
      expect(executor).not.toBe(pid);
      await poll(() => evCount(dir, id, "turn_completed") === 3);
      await stop(client, pid);
      expect(await waitExit(pid)).toBe(true);
      expect(alive(executor)).toBe(true);
      expect(readSession(dir, id)!.status).not.toBe("interrupted");
      await poll(() => readSession(dir, id)!.state.finish !== null && evCount(dir, id, "session_finished") === 2, 30000);
      const s = readSession(dir, id)!;
      expect(s.status).toBe("consensus");
      expect(s.state.turns.length).toBeGreaterThan(3);
      expect(evCount(dir, id, "session_resumed")).toBe(1);
      expect(await waitExit(executor, 10000)).toBe(true);
    }, 60000);
  }

  it("Завершение сервера: server stop during a resumed owner wait keeps the wait and the executor; a stop request ends it as stopped", async () => {
    const dir = tmp();
    const ctl = new AbortController();
    const p = priorSession(dir, { pauseAfterRound: true, timeoutSec: 3600 }, ctl.signal);
    const id = "20200101-000000-resume";
    await poll(() => { try { return evCount(dir, id, "owner_wait_started") === 1; } catch { return false; } });
    ctl.abort();
    await p;
    const all = readEvents(dir, id)!.events as any[];
    const keep = all.slice(0, all.findIndex((e) => e.type === "owner_wait_started") + 1);
    keep[0].pid = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(eventsPath(dir, id), keep.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const waiting = readSession(dir, id)!.state.waiting!;
    const turns = readSession(dir, id)!.state.turns.length;
    const { client, pid } = await connect(dir);
    const plan = json(await call(client, "council_resume", { sessionId: id, rounds: 2 }));
    expect(plan.waiting).toMatchObject({ waitId: waiting.waitId, expired: false });
    expect(json(await call(client, "council_resume", { sessionId: id, rounds: 2, execute: true, planToken: plan.planToken })).accepted).toBe(true);
    const executor = Number(readFileSync(lockOf(dir, id), "utf8").trim());
    expect(executor).not.toBe(pid);
    await sleep(300);
    process.kill(pid, "SIGTERM");
    expect(await waitExit(pid)).toBe(true);
    expect(alive(executor)).toBe(true);
    const s = readSession(dir, id)!;
    expect(s.status).not.toBe("interrupted");
    expect(s.state.waiting).toMatchObject({ waitId: waiting.waitId, deadline: waiting.deadline });
    expect(s.state.turns).toHaveLength(turns);
    expect(evCount(dir, id, "session_resumed")).toBe(1);
    requestStop(dir, id);
    expect(await waitExit(executor, 15000)).toBe(true);
    expect(readSession(dir, id)!.status).toBe("stopped");
    expect(existsSync(lockOf(dir, id))).toBe(false);
  }, 60000);

  it("council_stop stops its own session and returns the latest version of the decision", async () => {
    const { client } = await connect(tmp());
    const sessionId = await startSlow(client);
    const r = await call(client, "council_stop", { sessionId });
    expect(r.isError).toBeFalsy();
    const s = json(r);
    expect(s.status).toBe("stopped");
    expect(s.solution.text).toContain("Тигра");
  }, 30000);

  // council_start sessions run in a detached executor: the server exit does not touch them
  const executorOf = (dir: string, id: string) => {
    const lock = join(dir, "sessions", id, "resume.lock");
    return existsSync(lock) ? Number(readFileSync(lock, "utf8").trim()) : readSession(dir, id)!.state.pid!;
  };
  for (const [name, stop] of [
    ["закрытие stdin", async (c: Client) => { await c.close(); }],
    ["SIGTERM", async (_c: Client, pid: number) => { process.kill(pid, "SIGTERM"); }],
  ] as const) {
    it(`Завершение сервера: server shutdown in the middle of a session (${name}) keeps the session running in its executor`, async () => {
      const dir = tmp();
      const { client, pid } = await connect(dir);
      const sessionId = await startSlow(client);
      const executor = executorOf(dir, sessionId);
      expect(executor).not.toBe(pid);
      const t0 = Date.now();
      await stop(client, pid);
      expect(await waitExit(pid)).toBe(true);
      expect(Date.now() - t0).toBeLessThanOrEqual(5500);
      expect(alive(executor)).toBe(true);
      const s = readSession(dir, sessionId)!;
      expect(s.status).toBe("running");
      expect(s.state.finish).toBeNull();
      requestStop(dir, sessionId);
      expect(await waitExit(executor, 15000)).toBe(true);
      const done = readSession(dir, sessionId)!;
      expect(done.status).toBe("stopped");
      expect(existsSync(join(dir, "sessions", sessionId, "resume.lock"))).toBe(false);
    }, 40000);
  }

  it("Завершение сервера: a forced end of the executor leaves the session interrupted, a new server resumes the same session", async () => {
    const dir = tmp();
    const first = await connect(dir);
    const sessionId = await startSlow(first.client);
    const executor = executorOf(dir, sessionId);
    await first.client.close();
    expect(await waitExit(first.pid)).toBe(true);
    process.kill(executor, "SIGKILL");
    expect(await waitExit(executor)).toBe(true);
    expect(readSession(dir, sessionId)!.status).toBe("interrupted");
    const { client } = await connect(dir);
    const plan = json(await call(client, "council_resume", { sessionId }));
    expect(plan.planToken).toBeTruthy();
    expect(json(await call(client, "council_resume", { sessionId, execute: true, planToken: plan.planToken })).accepted).toBe(true);
    await poll(() => evCount(dir, sessionId, "session_resumed") === 1);
    expect(listSessions(dir).filter((x) => x.id === sessionId)).toHaveLength(1);
    expect(readSession(dir, sessionId)!.status).toBe("running");
  }, 40000);

  it("stdout contains only JSON-RPC", async () => {
    const dir = tmp();
    const child = spawn(process.execPath, [main], { cwd: root, env: { ...baseEnv, COUNCIL_HOME: dir, COUNCIL_DEV: "1" }, stdio: ["pipe", "pipe", "ignore"] });
    pids.push(child.pid!);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "council_status", arguments: { sessionId: "20200101-000000-nope" } } });
    const t0 = Date.now();
    const got = () => [1, 2, 3].every((id) => out.split("\n").some((l) => l.includes(`"id":${id},`) || l.includes(`"id":${id}}`)));
    while (!got() && Date.now() - t0 < 10000) await sleep(50);
    child.stdin.end();
    const lines = out.split("\n").filter((l) => l.trim() !== "");
    expect(got()).toBe(true);
    for (const l of lines) expect(JSON.parse(l).jsonrpc).toBe("2.0");
    await new Promise((r) => (child.exitCode !== null ? r(null) : child.once("exit", r)));
  });

  it("the instructions contain rule 6 on the folder snapshot", async () => {
    const { client } = await connect(tmp());
    const ins = client.getInstructions()!;
    for (const w of ["снимка папки", "по запросу", "materials.left.count", "filesRead", "attachments", "абсолютные", "defaults.materialsChars"]) expect(ins).toContain(w);
  });

  it("the instructions and the council_start description contain the attachment rules", async () => {
    const { client } = await connect(tmp());
    const ins = client.getInstructions()!;
    const t = (await client.listTools()).tools.find((x) => x.name === "council_start")!;
    for (const w of ["attachments", "абсолютные", "число материалов и их объём"]) expect(ins).toContain(w);
    for (const w of ["attachments", "абсолютными", "число материалов и их объём", "участники × круги × 3"]) expect(t.description).toContain(w);
    const a = (t.inputSchema.properties as Record<string, any>)["attachments"];
    expect(a.type).toBe("array");
    expect(a.items.type).toBe("string");
  });

  it("attachment refusals: the error names the path, the journal has no paths", async () => {
    const dir = tmp();
    const fx = realpathSync(tmp());
    const { client } = await connect(dir);
    const missing = join(fx, "нет-такого.txt");
    const rel = await call(client, "council_start", { topic: "т", participants: scripted("consensus/p1.json", "consensus/p2.json"), attachments: ["src/секрет.ts"] });
    expect(rel.isError).toBe(true);
    expect(rel.content[0]!.text).toContain("src/секрет.ts");
    const abs = await call(client, "council_start", { topic: "т", participants: scripted("consensus/p1.json", "consensus/p2.json"), attachments: [missing] });
    expect(abs.isError).toBe(true);
    expect(abs.content[0]!.text).toContain("нет-такого.txt");
    expect(abs.content[0]!.text).not.toContain(fx); // the shared collection leaves only the last path segment in the reason
    expect(listSessions(dir)).toEqual([]);
    const log = readFileSync(join(dir, "logs/app.log"), "utf8");
    expect(log).not.toMatch(/секрет\.ts|нет-такого|a\.ts/);
    expect(log).not.toContain(fx);
    expect(log).toMatch(/ERROR .*council_start/);
    expect(log).toMatch(/относительных путей в attachments: 1|Relative paths in attachments rejected: 1/);
    expect(log).toMatch(/Materials not collected: reasons 1/);
  });

  it("token cap: options, start, status until token_cap, refusal on 0", async () => {
    const { client } = await connect(tmp());
    expect(json(await call(client, "council_options")).defaults.maxTotalTokens).toBeNull();
    const started = json(await call(client, "council_start", { topic: "т", participants: scripted("token-cap/p1.json", "token-cap/p2.json"), maxTotalTokens: 1200 }));
    expect(started.maxTotalTokens).toBe(1200);
    let s = json(await call(client, "council_status", { sessionId: started.sessionId, waitSec: 5 }));
    for (let i = 0; i < 10 && s.status === "running"; i++) s = json(await call(client, "council_status", { sessionId: started.sessionId, waitSec: 5 }));
    expect(s).toMatchObject({ status: "stopped", reason: "token_cap", maxTotalTokens: 1200 });
    expect(s.tokens.total).toBe(1500);
    const bad = await call(client, "council_start", { topic: "т", participants: scripted("token-cap/p1.json", "token-cap/p2.json"), maxTotalTokens: 0 });
    expect(bad.isError).toBe(true);
  });
});

describe("MCP server: named lineups", () => {
  it("L14. the instructions contain the lineup rule", async () => {
    const { client } = await connect(tmp());
    const ins = client.getInstructions()!;
    expect(ins).toContain("lineupId");
    expect(ins).toMatch(/назови владельцу участников состава/);
    expect(ins).toMatch(/не заменяй его участников своими/);
  });

  it("L15. council_options returns a lineup; lineupId together with participants — a tool error", async () => {
    const dir = tmp();
    const l = await saveLineup(dir, { name: "Пара", participants: [{ providerId: "scripted", model: "consensus/p1.json", role: null }, { providerId: "scripted", model: "consensus/p2.json", role: "Критик" }] });
    const { client } = await connect(dir);
    const opts = json(await call(client, "council_options"));
    expect(opts.lineupsError).toBeNull();
    expect(opts.lineups).toHaveLength(1);
    expect(opts.lineups[0]).toMatchObject({ id: l.id, available: true });
    const r = await call(client, "council_start", { topic: "Т", lineupId: l.id, participants: scripted("consensus/p1.json", "consensus/p2.json") });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("несовместимы");
    expect(listSessions(dir)).toEqual([]);
  });

  it("the instructions contain the independent drafts rule and the formula with (rounds + 1)", async () => {
    const { client } = await connect(tmp());
    const ins = client.getInstructions()!;
    expect(ins).toContain("11. Независимые черновики");
    expect(ins).toContain("(круги + 1)");
    expect(ins).toContain("не решение и не согласие");
  });
});

// Server text language (change 65): the server is created in this process, the language is taken from the process at the moment of creation
describe("server text language", () => {
  afterEach(() => setProcessLanguage("ru"));
  const CYR = /[А-Яа-яЁё]/;
  const noop = () => {};
  async function inMemory() {
    const server = createServer({ dataDir: "/nonexistent", env: {}, logger: { info: noop, warn: noop, error: noop, debug: noop } as never, builtinTemplatesDir: "", scenariosDir: null, shutdown: new AbortController().signal, councilLaunch: { command: process.execPath, args: [], env: {} } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "lang", version: "0" });
    clients.push(client);
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    return { instructions: client.getInstructions()!, tools };
  }
  const noDescriptions = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(noDescriptions)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "description").map(([k, x]) => [k, noDescriptions(x)]))
      : v;

  it("ru: instructions, descriptions and schemas are byte-for-byte equal to the reference taken before the change", async () => {
    const golden = JSON.parse(readFileSync(join(import.meta.dirname, "__golden__/ru-server.json"), "utf8"));
    const got = await inMemory();
    expect(got.instructions).toBe(golden.instructions);
    expect(JSON.parse(JSON.stringify(got.tools))).toEqual(golden.tools);
  });

  it("en: instructions — 11 numbered rules, a line about the owner's language, no Cyrillic", async () => {
    setProcessLanguage("en");
    const { instructions } = await inMemory();
    expect(instructions).not.toMatch(CYR);
    const lines = instructions.split("\n");
    expect(lines.filter((l) => /^\d+\. /.test(l)).map((l) => l.split(".")[0])).toEqual(Array.from({ length: 11 }, (_, i) => String(i + 1)));
    expect(lines.at(-1)).toMatch(/^Reply to the owner in the owner's language/);
    for (const w of ["council_options", "council_start", "council_status", "council_resume", "planToken", "stale_plan", "replacements", "lineupId"]) expect(instructions).toContain(w);
  });

  it("en: descriptions and fields of all tools without Cyrillic; spending warning in council_start and council_resume", async () => {
    setProcessLanguage("en");
    const { tools } = await inMemory();
    expect(tools).toHaveLength(7);
    for (const t of tools) {
      expect(t.description, t.name).not.toMatch(CYR);
      expect(JSON.stringify(t.inputSchema), t.name).not.toMatch(CYR);
    }
    for (const n of ["council_start", "council_resume"]) expect(tools.find((t) => t.name === n)!.description).toMatch(/subscription|money/);
  });

  it("tool lists and schemas on en and ru match by names and field types", async () => {
    const ru = await inMemory();
    setProcessLanguage("en");
    const en = await inMemory();
    expect(en.tools.map((t) => t.name)).toEqual(ru.tools.map((t) => t.name));
    expect(noDescriptions(en.tools.map((t) => t.inputSchema))).toEqual(noDescriptions(ru.tools.map((t) => t.inputSchema)));
  });
});
