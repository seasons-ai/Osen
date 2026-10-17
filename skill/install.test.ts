import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import { installMessages, run } from "./install.ts";
import type { Deps } from "./install.ts";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "council-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const readJson = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});

function snapshot(dir: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) if (statSync(join(dir, rel)).isFile()) r[rel] = readFileSync(join(dir, rel), "utf8");
  return r;
}

function setup(over: { codex?: boolean; claude?: boolean } = {}) {
  const home = tmp(), repoRoot = tmp();
  put(join(repoRoot, "skill/osen/SKILL.md"), "# скилл\n");
  put(join(repoRoot, "skill/osen/refs/a.md"), "вложенный\n");
  const main = join(repoRoot, "packages/mcp/src/main.ts");
  const claudeFile = join(home, ".claude.json"), codexFile = join(home, ".codex/fake-state.json");
  const calls: string[] = [];
  const out: string[] = [];
  const mcp = (file: string, key: string) => readJson(file)[key] ?? {};
  const deps: Deps = {
    home, repoRoot, language: "ru", out: (l) => out.push(l),
    hasCommand: (b) => (b === "codex" ? over.codex !== false : over.claude !== false),
    exec: (bin, args) => {
      calls.push(`${bin} ${args.join(" ")}`);
      const ok = (stdout = "") => ({ ok: true, stdout, stderr: "" });
      const [, verb] = args;
      if (bin === "claude") {
        const d = readJson(claudeFile);
        d.mcpServers ??= {};
        if (args[1] === "add") {
          if (d.mcpServers[args[4]!]) return ok("already exists");
          d.mcpServers[args[4]!] = { type: "stdio", command: args[6], args: args.slice(7), env: {} };
        } else delete d.mcpServers[args[4]!];
        put(claudeFile, JSON.stringify(d));
        return ok();
      }
      const d = mcp(codexFile, "servers") as Record<string, unknown>;
      if (verb === "get") {
        const e = d[args[2]!] as { command: string; args: string[] } | undefined;
        return e ? ok(JSON.stringify({ name: args[2], transport: { type: "stdio", ...e } })) : { ok: false, stdout: `Error: No MCP server named '${args[2]}' found.\n`, stderr: "" };
      }
      if (verb === "add") d[args[2]!] = { command: args[4], args: args.slice(5) }; else delete d[args[2]!];
      put(codexFile, JSON.stringify({ servers: d }));
      return ok();
    },
  };
  const mutating = () => calls.filter((c) => / (add|remove)\b/.test(c));
  const seedForeign = () => {
    put(join(home, ".claude/skills/other-skill/SKILL.md"), "чужой claude\n");
    put(join(home, ".codex/skills/other-skill/SKILL.md"), "чужой codex\n");
    put(claudeFile, JSON.stringify({ theme: "dark", mcpServers: { other: { type: "stdio", command: "x", args: ["y"], env: {} } } }));
    put(codexFile, JSON.stringify({ servers: { other: { command: "x", args: ["y"] } } }));
  };
  const text = () => out.join("\n");
  return { home, repoRoot, main, claudeFile, codexFile, calls, out, deps, mutating, seedForeign, text, mcp, claudeServers: () => readJson(claudeFile).mcpServers ?? {}, codexServers: () => mcp(codexFile, "servers") };
}

describe("skill and MCP server installation", () => {
  it("preview changes nothing", async () => {
    const t = setup(); t.seedForeign();
    const before = snapshot(t.home);
    expect(await run(["--dry-run"], t.deps)).toBe(0);
    expect(snapshot(t.home)).toEqual(before);
    expect(t.mutating()).toEqual([]);
    expect(t.text()).toContain("Предпросмотр: изменений не будет");
    expect(t.text()).toContain(`Claude Code · скилл · будет добавлен · ${join(t.home, ".claude/skills/osen")}`);
    expect(t.text()).toContain(`Codex · сервер · будет добавлен · ${join(t.home, ".codex/config.toml")} · node ${t.main}`);
    expect(t.text()).toContain(`Claude Code · сервер · будет добавлен · ${join(t.home, ".claude.json")} · node ${t.main}`);
  });

  it("install next to a foreign entry, repeat with no changes", async () => {
    const t = setup(); t.seedForeign();
    const foreign = snapshot(t.home);
    expect(await run([], t.deps)).toBe(0);
    for (const dir of [".claude", ".codex"]) {
      const s = join(t.home, dir, "skills/osen");
      expect(readFileSync(join(s, "SKILL.md"), "utf8")).toBe("# скилл\n");
      expect(readFileSync(join(s, "refs/a.md"), "utf8")).toBe("вложенный\n");
      expect(readFileSync(join(s, ".osen-install"), "utf8")).toBe(t.repoRoot + "\n");
      expect(readFileSync(join(t.home, dir, "skills/other-skill/SKILL.md"), "utf8")).toBe(foreign[`${dir}/skills/other-skill/SKILL.md`]);
    }
    expect(t.claudeServers()["osen"]).toMatchObject({ command: "node", args: [t.main] });
    expect(t.codexServers()["osen"]).toEqual({ command: "node", args: [t.main] });
    expect(t.claudeServers().other).toBeTruthy();
    expect(t.codexServers().other).toBeTruthy();
    expect(t.text()).toContain("/mcp");

    const before = snapshot(t.home);
    t.calls.length = 0; t.out.length = 0;
    expect(await run([], t.deps)).toBe(0);
    expect(t.text()).toContain("Всё уже установлено.");
    expect(snapshot(t.home)).toEqual(before);
    expect(t.mutating()).toEqual([]);
  });

  for (const agent of ["claude", "codex"] as const) {
    it(`a foreign osen server of ${agent} is not overwritten`, async () => {
      const t = setup();
      const foreign = { command: "node", args: ["/другой/путь/main.ts"] };
      if (agent === "claude") put(t.claudeFile, JSON.stringify({ mcpServers: { "osen": { type: "stdio", ...foreign, env: {} } } }));
      else put(t.codexFile, JSON.stringify({ servers: { "osen": foreign } }));
      expect(await run([], t.deps)).toBe(1);
      const now = agent === "claude" ? t.claudeServers() : t.codexServers();
      expect(now["osen"]).toMatchObject(foreign);
      expect(t.text()).toContain("расхождение");
      expect(t.text()).toContain("/другой/путь/main.ts");
      expect(t.mutating().filter((c) => c.startsWith(agent))).toEqual([]);
      expect(existsSync(join(t.home, `.${agent}/skills/osen/SKILL.md`))).toBe(true);
    });
  }

  it("a foreign skill folder without a marker is left alone", async () => {
    const t = setup();
    put(join(t.home, ".claude/skills/osen/SKILL.md"), "мой собственный\n");
    expect(await run([], t.deps)).toBe(1);
    expect(readFileSync(join(t.home, ".claude/skills/osen/SKILL.md"), "utf8")).toBe("мой собственный\n");
    expect(existsSync(join(t.home, ".claude/skills/osen/.osen-install"))).toBe(false);
    expect(t.text()).toContain("расхождение");
  });

  it("Codex is not installed", async () => {
    const t = setup({ codex: false });
    expect(await run([], t.deps)).toBe(0);
    expect(t.text()).toContain("Codex: не найден, пропущен");
    expect(existsSync(join(t.home, ".codex"))).toBe(false);
    expect(t.claudeServers()["osen"]).toBeTruthy();
    expect(existsSync(join(t.home, ".claude/skills/osen/SKILL.md"))).toBe(true);
  });

  it("no agents: nothing is created", async () => {
    const t = setup({ codex: false, claude: false });
    expect(await run([], t.deps)).toBe(0);
    expect(t.text()).toContain("Ни один агент не найден");
    expect(t.text()).not.toContain("Всё уже установлено.");
    expect(snapshot(t.home)).toEqual({});
  });

  it("unclear codex mcp get answer: the entry is not added", async () => {
    const t = setup();
    const exec = t.deps.exec;
    t.deps.exec = (bin, args) => (bin === "codex" && args[1] === "get" ? { ok: false, stdout: "", stderr: "config.toml: parse error" } : exec(bin, args));
    expect(await run([], t.deps)).toBe(1);
    expect(t.text()).toContain("parse error");
    expect(t.mutating().filter((c) => c.startsWith("codex"))).toEqual([]);
  });

  it("update of a modified copy", async () => {
    const t = setup();
    await run([], t.deps);
    const f = join(t.home, ".claude/skills/osen/SKILL.md");
    writeFileSync(f, "правка\n");
    t.out.length = 0;
    expect(await run([], t.deps)).toBe(0);
    expect(readFileSync(f, "utf8")).toBe("# скилл\n");
    expect(t.text()).toContain("Claude Code · скилл · обновлён");
  });

  it("a broken .claude.json is left alone", async () => {
    const t = setup();
    put(t.claudeFile, "{ сломан");
    expect(await run([], t.deps)).toBe(1);
    expect(readFileSync(t.claudeFile, "utf8")).toBe("{ сломан");
    expect(t.text()).toContain(t.claudeFile);
    expect(t.mutating().filter((c) => c.startsWith("claude"))).toEqual([]);
  });
});

describe("uninstall", () => {
  it("removes our own, foreign entries stay", async () => {
    const t = setup(); t.seedForeign();
    await run([], t.deps);
    const before = snapshot(t.home);
    expect(await run(["--uninstall", "--dry-run"], t.deps)).toBe(0);
    expect(snapshot(t.home)).toEqual(before);
    expect(await run(["--uninstall"], t.deps)).toBe(0);
    for (const dir of [".claude", ".codex"]) {
      expect(existsSync(join(t.home, dir, "skills/osen"))).toBe(false);
      expect(existsSync(join(t.home, dir, "skills/other-skill/SKILL.md"))).toBe(true);
    }
    expect(t.claudeServers()["osen"]).toBeUndefined();
    expect(t.codexServers()["osen"]).toBeUndefined();
    expect(t.claudeServers().other).toBeTruthy();
    expect(t.codexServers().other).toBeTruthy();
    t.out.length = 0;
    expect(await run(["--uninstall"], t.deps)).toBe(0);
    expect(t.text()).toContain("не установлен");
  });

  it("leaves foreign entries alone", async () => {
    const t = setup();
    const foreign = { command: "node", args: ["/другой/main.ts"] };
    put(t.claudeFile, JSON.stringify({ mcpServers: { "osen": { type: "stdio", ...foreign, env: {} } } }));
    put(t.codexFile, JSON.stringify({ servers: { "osen": foreign } }));
    put(join(t.home, ".claude/skills/osen/SKILL.md"), "мой\n");
    const before = snapshot(t.home);
    expect(await run(["--uninstall"], t.deps)).toBe(1);
    expect(snapshot(t.home)).toEqual(before);
    expect(t.mutating()).toEqual([]);
    expect(t.text()).toContain("расхождение");
  });
});

// Legacy install under the model-council name: a skill folder with a marker and a server on this repository's main.ts.
function seedLegacy(t: ReturnType<typeof setup>, over: { marker?: string | null; name?: string; claudeArgs?: readonly string[]; codexArgs?: readonly string[] } = {}) {
  for (const dir of [".claude", ".codex"]) {
    const s = join(t.home, dir, "skills/model-council");
    put(join(s, "SKILL.md"), `---\nname: ${over.name ?? "model-council"}\n---\n# прежний\n`);
    if (over.marker !== null) put(join(s, ".model-council-install"), over.marker ?? t.repoRoot + "\n");
  }
  const c = readJson(t.claudeFile);
  put(t.claudeFile, JSON.stringify({ ...c, mcpServers: { ...c.mcpServers, "model-council": { type: "stdio", command: "node", args: over.claudeArgs ?? [t.main], env: {} } } }));
  put(t.codexFile, JSON.stringify({ servers: { ...t.codexServers(), "model-council": { command: "node", args: over.codexArgs ?? [t.main] } } }));
}

describe("removal of legacy model-council entries", () => {
  it("install sets up osen and removes this installation's legacy entries, repeat with no changes", async () => {
    const t = setup(); t.seedForeign(); seedLegacy(t);
    expect(await run([], t.deps)).toBe(0);
    for (const dir of [".claude", ".codex"]) {
      expect(existsSync(join(t.home, dir, "skills/model-council"))).toBe(false);
      expect(existsSync(join(t.home, dir, "skills/osen/.osen-install"))).toBe(true);
      expect(existsSync(join(t.home, dir, "skills/other-skill/SKILL.md"))).toBe(true);
    }
    expect(t.claudeServers()["model-council"]).toBeUndefined();
    expect(t.codexServers()["model-council"]).toBeUndefined();
    expect(t.claudeServers().osen).toMatchObject({ command: "node", args: [t.main] });
    expect(t.codexServers().osen).toEqual({ command: "node", args: [t.main] });
    expect(t.claudeServers().other).toBeTruthy();
    expect(t.codexServers().other).toBeTruthy();
    expect(t.calls).toContain("claude mcp remove --scope user model-council");
    expect(t.calls).toContain("codex mcp remove model-council");
    expect(t.text()).toContain(`Claude Code · скилл · удалён · ${join(t.home, ".claude/skills/model-council")}`);
    expect(t.text()).toContain(`Codex · сервер model-council · удалён`);

    const before = snapshot(t.home);
    t.calls.length = 0; t.out.length = 0;
    expect(await run([], t.deps)).toBe(0);
    expect(t.text()).toContain("Всё уже установлено.");
    expect(snapshot(t.home)).toEqual(before);
    expect(t.mutating()).toEqual([]);
  });

  it("preview names what will be removed and changes nothing", async () => {
    const t = setup(); seedLegacy(t);
    const before = snapshot(t.home);
    expect(await run(["--dry-run"], t.deps)).toBe(0);
    expect(snapshot(t.home)).toEqual(before);
    expect(t.mutating()).toEqual([]);
    for (const a of ["Claude Code", "Codex"]) {
      expect(t.text()).toContain(`${a} · скилл · будет удалён · ${join(t.home, a === "Codex" ? ".codex" : ".claude", "skills/model-council")}`);
      expect(t.text()).toContain(`${a} · сервер model-council · будет удалён`);
    }
  });

  for (const [what, over] of [
    ["сервер на другом пути", { claudeArgs: ["/другой/main.ts"], codexArgs: ["/другой/main.ts"] }],
    ["папка без маркера", { marker: null }],
    ["в маркере другой репозиторий", { marker: "/другой/репозиторий\n" }],
    ["в SKILL.md другое имя", { name: "something-else" }],
  ] as const) {
    it(`a foreign entry under the legacy name is untouched: ${what}`, async () => {
      const t = setup(); seedLegacy(t, over);
      const legacy = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).filter(([k]) => k.includes("skills/model-council")));
      const before = snapshot(t.home);
      expect(await run([], t.deps)).toBe(1);
      if (!("claudeArgs" in over)) expect(legacy(snapshot(t.home))).toEqual(legacy(before));
      expect(t.text()).toContain("расхождение");
      for (const dir of [".claude", ".codex"]) expect(existsSync(join(t.home, dir, "skills/osen/SKILL.md"))).toBe(true);
      expect(t.claudeServers().osen).toBeTruthy();
      expect(t.codexServers().osen).toBeTruthy();
      if ("claudeArgs" in over) {
        expect(t.claudeServers()["model-council"].args).toEqual(["/другой/main.ts"]);
        expect(t.codexServers()["model-council"].args).toEqual(["/другой/main.ts"]);
        expect(t.mutating().filter((c) => c.includes("remove"))).toEqual([]);
      } else for (const dir of [".claude", ".codex"]) expect(existsSync(join(t.home, dir, "skills/model-council/SKILL.md"))).toBe(true);
    });
  }

  it("legacy entries are not removed if osen was not set up for the agent", async () => {
    const t = setup(); seedLegacy(t);
    put(t.codexFile, JSON.stringify({ servers: { ...t.codexServers(), osen: { command: "node", args: ["/чужой/main.ts"] } } }));
    expect(await run([], t.deps)).toBe(1);
    expect(t.codexServers()["model-council"]).toBeTruthy();
    expect(existsSync(join(t.home, ".codex/skills/model-council/SKILL.md"))).toBe(true);
    expect(t.claudeServers()["model-council"]).toBeUndefined();
  });

  it("--uninstall removes both groups, foreign entries stay", async () => {
    const t = setup(); t.seedForeign();
    await run([], t.deps);
    seedLegacy(t);
    expect(await run(["--uninstall"], t.deps)).toBe(0);
    for (const dir of [".claude", ".codex"]) {
      for (const n of ["osen", "model-council"]) expect(existsSync(join(t.home, dir, "skills", n))).toBe(false);
      expect(existsSync(join(t.home, dir, "skills/other-skill/SKILL.md"))).toBe(true);
    }
    for (const servers of [t.claudeServers(), t.codexServers()]) expect(Object.keys(servers)).toEqual(["other"]);
  });
});

describe("arguments", () => {
  it("unknown flag and --help", async () => {
    const t = setup();
    expect(await run(["--nope"], t.deps)).toBe(2);
    t.out.length = 0;
    expect(await run(["--help"], t.deps)).toBe(0);
    expect(t.text()).toBe(installMessages("ru").help);
    for (const f of ["--dry-run", "--uninstall", "без флагов"]) expect(t.text()).toContain(f);
  });
});

describe("English output", () => {
  const en = (over: { codex?: boolean; claude?: boolean } = {}) => { const t = setup(over); t.deps.language = "en"; return t; };

  it("preview changes nothing", async () => {
    const t = en(); t.seedForeign();
    const before = snapshot(t.home);
    expect(await run(["--dry-run"], t.deps)).toBe(0);
    expect(snapshot(t.home)).toEqual(before);
    expect(t.mutating()).toEqual([]);
    expect(t.out[0]).toBe(`Preview: nothing will be changed\nRepository: ${t.repoRoot}`);
    expect(t.text()).toContain(`Claude Code · skill · will be added · ${join(t.home, ".claude/skills/osen")}`);
    expect(t.text()).toContain(`Codex · server · will be added · ${join(t.home, ".codex/config.toml")} · node ${t.main}`);
    expect(t.text()).not.toMatch(/[а-яё]/i);
  });

  it("install, repeat with no changes, uninstall", async () => {
    const t = en(); t.seedForeign();
    expect(await run([], t.deps)).toBe(0);
    expect(t.text()).toContain("Claude Code · skill · added");
    expect(t.text()).toContain("Restart the agents and check the server with the /mcp command in Claude Code.");
    t.out.length = 0;
    expect(await run([], t.deps)).toBe(0);
    expect(t.text()).toContain("Codex · skill · already installed");
    expect(t.text()).toContain("Everything is already installed.");
    t.out.length = 0;
    expect(await run(["--uninstall"], t.deps)).toBe(0);
    expect(t.out[0]).toBe(`Uninstall\nRepository: ${t.repoRoot}`);
    expect(t.text()).toContain("Codex · server · removed");
    expect(t.text()).not.toMatch(/[а-яё]/i);
  });

  it("foreign server and foreign folder: mismatch, code 1, nothing changed", async () => {
    const t = en();
    put(t.codexFile, JSON.stringify({ servers: { "osen": { command: "node", args: ["/other/main.ts"] } } }));
    put(join(t.home, ".claude/skills/osen/SKILL.md"), "mine\n");
    const before = snapshot(t.home);
    expect(await run([], t.deps)).toBe(1);
    expect(t.text()).toContain("Claude Code · skill · mismatch: folder without the install marker (foreign), not changed");
    expect(t.text()).toContain("Codex · server · mismatch: the entry points to node /other/main.ts, not changed");
    expect(snapshot(t.home)[".claude/skills/osen/SKILL.md"]).toBe(before[".claude/skills/osen/SKILL.md"]);
    expect(t.mutating().filter((c) => c.startsWith("codex"))).toEqual([]);
  });

  // change 112: an osen folder with another repository copy's marker is foreign
  const otherCopy = (t: ReturnType<typeof setup>, marker = "/other/copy\n") => {
    for (const agent of ["claude", "codex"]) {
      put(join(t.home, `.${agent}/skills/osen/SKILL.md`), "from another copy\n");
      put(join(t.home, `.${agent}/skills/osen/refs/a.md`), "other nested\n");
      put(join(t.home, `.${agent}/skills/osen/.osen-install`), marker);
    }
    const other = { command: "node", args: ["/other/copy/packages/mcp/src/main.ts"] };
    put(t.claudeFile, JSON.stringify({ mcpServers: { osen: { type: "stdio", ...other, env: {} } } }));
    put(t.codexFile, JSON.stringify({ servers: { osen: other } }));
  };
  const skillMismatch = (t: ReturnType<typeof setup>) => ["Claude Code", "Codex"].every((a) =>
    t.text().includes(`${a} · skill · mismatch: folder installed from another copy of the repository: /other/copy, not changed`));

  it("another copy's folder: install, uninstall and preview change nothing, code 1", async () => {
    for (const argv of [[], ["--uninstall"], ["--dry-run"], ["--uninstall", "--dry-run"]]) {
      const t = en(); otherCopy(t);
      const before = snapshot(t.home);
      expect(await run(argv, t.deps), argv.join(" ")).toBe(1);
      expect(snapshot(t.home), argv.join(" ")).toEqual(before);
      expect(skillMismatch(t), `${argv.join(" ")}\n${t.text()}`).toBe(true);
      expect(t.text()).not.toContain("Restart the agents");
      expect(t.mutating(), argv.join(" ")).toEqual([]);
    }
  });

  it("another copy's folder: legacy model-council entries are not removed; the same reason in Russian", async () => {
    const t = setup(); otherCopy(t);
    put(join(t.home, ".claude/skills/model-council/SKILL.md"), "---\nname: model-council\n---\n");
    put(join(t.home, ".claude/skills/model-council/.model-council-install"), t.repoRoot + "\n");
    const before = snapshot(t.home);
    expect(await run([], t.deps)).toBe(1);
    expect(snapshot(t.home)).toEqual(before);
    expect(t.text()).toContain("Claude Code · скилл · расхождение: папка установлена из другой копии репозитория: /other/copy, не изменено");
  });

  it("control: a marker with this copy's path — update and uninstall work as before", async () => {
    const t = en(); otherCopy(t, "");
    for (const agent of ["claude", "codex"]) put(join(t.home, `.${agent}/skills/osen/.osen-install`), t.repoRoot + "\n");
    put(t.claudeFile, "{}"); put(t.codexFile, "{}");
    expect(await run([], t.deps)).toBe(0);
    expect(t.text()).toContain("Claude Code · skill · updated");
    expect(readFileSync(join(t.home, ".codex/skills/osen/SKILL.md"), "utf8")).toBe("# скилл\n");
    expect(await run(["--uninstall"], t.deps)).toBe(0);
    expect(existsSync(join(t.home, ".claude/skills/osen"))).toBe(false);
  });

  it("Codex is not installed, no agents, broken .claude.json", async () => {
    let t = en({ codex: false });
    expect(await run([], t.deps)).toBe(0);
    expect(t.text()).toContain("Codex: not found, skipped");
    t = en({ codex: false, claude: false });
    expect(await run([], t.deps)).toBe(0);
    expect(t.text()).toContain("No agent found: nothing to install into.");
    t = en();
    put(t.claudeFile, "{ broken");
    expect(await run([], t.deps)).toBe(1);
    expect(t.text()).toContain(`mismatch: could not parse ${t.claudeFile}:`);
  });

  it("help and unknown flag", async () => {
    const t = en();
    expect(await run(["--help"], t.deps)).toBe(0);
    expect(t.text()).toBe(installMessages("en").help);
    for (const f of ["--dry-run", "--uninstall", "(no flags)"]) expect(t.text()).toContain(f);
    t.out.length = 0;
    expect(await run(["--nope"], t.deps)).toBe(2);
    expect(t.text()).toContain("Usage: node skill/install.ts");
  });
});

describe("language choice when run from a terminal", () => {
  const script = join(import.meta.dirname, "install.ts");
  const help = (env: Record<string, string>) => {
    const { COUNCIL_LANG: _, ...rest } = process.env;
    return execFileSync(process.execPath, [script, "--help"], { encoding: "utf8", env: { ...rest, ...env }, stdio: ["ignore", "pipe", "pipe"] }).trim();
  };

  it("without COUNCIL_LANG and preferences.json — English, the data folder is not created", () => {
    const home = join(tmp(), "data");
    expect(help({ COUNCIL_HOME: home })).toBe(installMessages("en").help);
    expect(existsSync(home)).toBe(false);
  });

  it("preferences.json of the data folder; COUNCIL_LANG takes precedence over the file", () => {
    const home = tmp();
    put(join(home, "preferences.json"), JSON.stringify({ language: "ru" }));
    expect(help({ COUNCIL_HOME: home })).toBe(installMessages("ru").help);
    expect(help({ COUNCIL_HOME: home, COUNCIL_LANG: "en" })).toBe(installMessages("en").help);
    put(join(home, "preferences.json"), "{ broken");
    expect(help({ COUNCIL_HOME: home })).toBe(installMessages("en").help);
  });
});
