import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import type { Language } from "@model-council/core";
import { run } from "./install.ts";
import type { Deps } from "./install.ts";

// Own seeded generator: fast-check is not pulled in.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const readJson = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});

// other-copy — an osen folder with another repository copy's marker (change 112)
type SkillState = "none" | "current" | "stale" | "foreign" | "other-copy";
type ServerState = "none" | "ours" | "foreign" | "broken";
// legacy model-council install: the skill folder and the server are ours or foreign
type LegacyState = "none" | "ours" | "foreign";
interface Case {
  claude: boolean; codex: boolean;
  skill: { claude: SkillState; codex: SkillState };
  server: { claude: ServerState; codex: ServerState };
  legacy: { claude: LegacyState; codex: LegacyState };
  argv: string[];
}

function generate(seed: number): Case {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const skills = ["none", "current", "stale", "foreign", "other-copy"] as const;
  const servers = ["none", "ours", "foreign", "broken"] as const;
  return {
    claude: rnd() < 0.8, codex: rnd() < 0.8,
    skill: { claude: pick(skills), codex: pick(skills) },
    server: { claude: pick(servers), codex: pick(servers) },
    legacy: { claude: pick(["none", "ours", "foreign"] as const), codex: pick(["none", "ours", "foreign"] as const) },
    argv: pick([[], ["--dry-run"], ["--uninstall"], ["--uninstall", "--dry-run"]]),
  };
}

// The same initial state in a temp folder; paths are replaced with labels so two runs can be compared.
function world(c: Case, language: Language) {
  const root = mkdtempSync(join(tmpdir(), "council-prop-")); tmps.push(root);
  const home = join(root, "home"), repoRoot = join(root, "repo");
  mkdirSync(home);
  const main = join(repoRoot, "packages/mcp/src/main.ts");
  put(join(repoRoot, "skill/osen/SKILL.md"), "# skill\n");
  put(join(repoRoot, "skill/osen/refs/a.md"), "nested\n");
  const claudeFile = join(home, ".claude.json"), codexFile = join(home, ".codex/fake-state.json");
  for (const agent of ["claude", "codex"] as const) {
    const dir = join(home, `.${agent}/skills/osen`);
    const s = c.skill[agent];
    if (s === "current" || s === "stale") {
      put(join(dir, "SKILL.md"), s === "current" ? "# skill\n" : "old\n");
      put(join(dir, "refs/a.md"), "nested\n");
      put(join(dir, ".osen-install"), repoRoot + "\n");
    } else if (s === "foreign") put(join(dir, "SKILL.md"), "mine\n");
    else if (s === "other-copy") {
      put(join(dir, "SKILL.md"), "other\n");
      put(join(dir, "refs/a.md"), "other nested\n");
      put(join(dir, ".osen-install"), "/other/copy\n");
    }
  }
  const entry = (s: ServerState) => (s === "ours" ? { command: "node", args: [main] } : { command: "node", args: ["/other/main.ts"] });
  const servers = (agent: "claude" | "codex") => ({
    ...(c.server[agent] === "ours" || c.server[agent] === "foreign" ? { osen: entry(c.server[agent]) } : {}),
    ...(c.legacy[agent] !== "none" ? { "model-council": entry(c.legacy[agent] === "ours" ? "ours" : "foreign") } : {}),
  });
  for (const agent of ["claude", "codex"] as const) {
    if (c.legacy[agent] === "none") continue;
    const dir = join(home, `.${agent}/skills/model-council`);
    put(join(dir, "SKILL.md"), "---\nname: model-council\n---\n");
    if (c.legacy[agent] === "ours") put(join(dir, ".model-council-install"), repoRoot + "\n");
  }
  if (c.server.claude === "broken") put(claudeFile, "{ broken");
  else if (Object.keys(servers("claude")).length) put(claudeFile, JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(servers("claude")).map(([k, v]) => [k, { type: "stdio", ...v, env: {} }])) }));
  if (Object.keys(servers("codex")).length) put(codexFile, JSON.stringify({ servers: servers("codex") }));

  const calls: string[] = [], out: string[] = [];
  const deps: Deps = {
    home, repoRoot, language, out: (l) => out.push(...l.split("\n")),
    hasCommand: (b) => (b === "codex" ? c.codex : c.claude),
    exec: (bin, args) => {
      calls.push(`${bin} ${args.join(" ")}`);
      const ok = (stdout = "") => ({ ok: true, stdout, stderr: "" });
      if (bin === "claude") {
        const d = readJson(claudeFile);
        d.mcpServers ??= {};
        if (args[1] === "add") d.mcpServers[args[4]!] = { type: "stdio", command: args[6], args: args.slice(7), env: {} };
        else delete d.mcpServers[args[4]!];
        put(claudeFile, JSON.stringify(d));
        return ok();
      }
      const d = (readJson(codexFile).servers ?? {}) as Record<string, unknown>;
      if (args[1] === "get") {
        if (c.server.codex === "broken") return { ok: false, stdout: "", stderr: "config.toml: parse error" };
        const e = d[args[2]!] as object | undefined;
        return e ? ok(JSON.stringify({ name: args[2], transport: { type: "stdio", ...e } })) : { ok: false, stdout: `Error: No MCP server named '${args[2]}' found.\n`, stderr: "" };
      }
      if (args[1] === "add") d[args[2]!] = { command: args[4], args: args.slice(5) }; else delete d[args[2]!];
      put(codexFile, JSON.stringify({ servers: d }));
      return ok();
    },
  };
  const norm = (s: string) => s.split(root).join("<root>");
  const snapshot = () => {
    const r: Record<string, string> = {};
    for (const rel of readdirSync(home, { recursive: true, encoding: "utf8" })) if (statSync(join(home, rel)).isFile()) r[rel] = norm(readFileSync(join(home, rel), "utf8"));
    return r;
  };
  const legacyLeft = (agent: "claude" | "codex") => existsSync(join(home, `.${agent}/skills/model-council`))
    || !!(agent === "claude" ? readJson(claudeFile).mcpServers : readJson(codexFile).servers)?.["model-council"];
  return { deps, out, snapshot, legacyLeft, mutating: () => calls.filter((x) => / (add|remove)\b/.test(x)).map(norm) };
}

describe("Installer output in the chosen language: exit code, actions and snapshot do not depend on the language", () => {
  it("200 random initial states and flags", async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const c = generate(seed);
      const r = {} as Record<Language, { code: number; lines: number; calls: string[]; before: Record<string, string>; after: Record<string, string> }>;
      for (const language of ["en", "ru"] as const) {
        const w = world(c, language);
        const before = w.snapshot();
        const code = await run(c.argv, w.deps);
        r[language] = { code, lines: w.out.length, calls: w.mutating(), before, after: w.snapshot() };
        for (const agent of ["claude", "codex"] as const) {
          const present = c[agent], dry = c.argv.includes("--dry-run"), un = c.argv.includes("--uninstall");
          const legacyFiles = (snap: Record<string, string>) => Object.entries(snap).filter(([k]) => k.startsWith(`.${agent}/skills/model-council/`));
          // a foreign legacy folder is never changed
          if (c.legacy[agent] === "foreign") expect(legacyFiles(r[language].after), `seed ${seed}`).toEqual(legacyFiles(before));
          // another copy's folder is never changed; agent present — code 1
          const skillFiles = (snap: Record<string, string>) => Object.entries(snap).filter(([k]) => k.startsWith(`.${agent}/skills/osen/`));
          if (c.skill[agent] === "other-copy") expect(skillFiles(r[language].after), `seed ${seed}: ${agent}`).toEqual(skillFiles(before));
          if (c.skill[agent] === "other-copy" && present) expect(code, `seed ${seed}: ${agent}`).toBe(1);
          // a foreign or other-copy skill folder and no osen server: install never adds the server (change 257)
          if ((c.skill[agent] === "foreign" || c.skill[agent] === "other-copy") && c.server[agent] === "none" && present && !un) {
            const entries = agent === "claude" ? readJson(join(w.deps.home, ".claude.json")).mcpServers : readJson(join(w.deps.home, ".codex/fake-state.json")).servers;
            expect(entries?.osen, `seed ${seed}: ${agent}`).toBeUndefined();
          }
          // our own legacy entry is removed if the agent is present, it is not a preview and osen has no mismatches for the agent (or it is an uninstall)
          const clean = c.server[agent] !== "broken" && (un || (c.skill[agent] !== "foreign" && c.skill[agent] !== "other-copy" && c.server[agent] !== "foreign"));
          if (c.legacy[agent] === "ours" && present && !dry && clean) expect(w.legacyLeft(agent), `seed ${seed}: ${agent}`).toBe(false);
        }
      }
      const why = `seed ${seed}: ${JSON.stringify(c)}`;
      expect(r.en.code, why).toBe(r.ru.code);
      expect(r.en.lines, why).toBe(r.ru.lines);
      expect(r.en.calls, why).toEqual(r.ru.calls);
      expect(r.en.after, why).toEqual(r.ru.after);
      if (c.argv.includes("--dry-run")) {
        expect(r.en.after, why).toEqual(r.en.before);
        expect(r.en.calls, why).toEqual([]);
      }
    }
  }, 60_000);
});
