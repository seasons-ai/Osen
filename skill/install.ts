import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_LANGUAGE, defineMessages, peekDataDir, resolveLanguage } from "@model-council/core";
import type { Language } from "@model-council/core";

type Bin = "claude" | "codex";
export interface Deps {
  home: string;
  repoRoot: string;
  // not set — the process language
  language?: Language;
  hasCommand(bin: Bin): boolean;
  exec(bin: Bin, args: string[]): { ok: boolean; stdout: string; stderr: string };
  out(line: string): void;
}

const NAME = "osen";
const MARKER = ".osen-install";
// legacy name: install and uninstall remove the model-council entries created by this installation
const LEGACY_NAME = "model-council";
const LEGACY_MARKER = ".model-council-install";

// Installer output in the active language; paths, commands and agent names are not translated.
export const installMessages = defineMessages({
  en: {
    help: `Usage: node skill/install.ts [--dry-run] [--uninstall] [--help]

Modes:
  (no flags)    install the osen skill and MCP server into Claude Code and Codex and remove the previous model-council entries of this installation
  --dry-run     preview: show what will be done without changing anything
  --uninstall   remove the osen skill and MCP server and the previous model-council entries (only our own; foreign ones are left alone)
  --help        this help`,
    preview: "Preview: nothing will be changed",
    install: "Install",
    uninstall: "Uninstall",
    repo: (path: string) => `Repository: ${path}`,
    notFound: (agent: string) => `${agent}: not found, skipped`,
    skill: "skill",
    server: "server",
    notInstalled: "not installed",
    alreadyInstalled: "already installed",
    willAdd: "will be added",
    added: "added",
    willUpdate: "will be updated",
    updated: "updated",
    willRemove: "will be removed",
    removed: "removed",
    mismatch: (what: string) => `mismatch: ${what}, not changed`,
    foreignFolder: "folder without the install marker (foreign)",
    otherCopyFolder: (path: string) => `folder installed from another copy of the repository: ${path}`,
    notOurFolder: "folder is not from this installation (no marker, another repository in the marker or another name)",
    noSource: (path: string) => `no skill source ${path}`,
    pointsTo: (command: string) => `the entry points to ${command}`,
    parseFailed: (file: string, reason: string) => `could not parse ${file}: ${reason}`,
    codexUnclear: (output: string) => `codex mcp get did not say whether the entry exists: ${output}`,
    emptyOutput: "empty output",
    cliError: (output: string) => `CLI error: ${output}`,
    notOursAfterAdd: "error: after adding, the entry is missing or not ours",
    noAgents: "No agent found: nothing to install into.",
    allInstalled: "Everything is already installed.",
    restart: "Restart the agents and check the server with the /mcp command in Claude Code.",
  },
  ru: {
    help: `Использование: node skill/install.ts [--dry-run] [--uninstall] [--help]

Режимы:
  (без флагов)  установить скилл и MCP-сервер osen в Claude Code и Codex и снять прежние записи model-council этой установки
  --dry-run     предпросмотр: показать, что будет сделано, ничего не меняя
  --uninstall   удалить скилл и MCP-сервер osen и прежние записи model-council (только свои; чужие не трогаются)
  --help        эта справка`,
    preview: "Предпросмотр: изменений не будет",
    install: "Установка",
    uninstall: "Удаление",
    repo: (path: string) => `Репозиторий: ${path}`,
    notFound: (agent: string) => `${agent}: не найден, пропущен`,
    skill: "скилл",
    server: "сервер",
    notInstalled: "не установлен",
    alreadyInstalled: "уже установлено",
    willAdd: "будет добавлен",
    added: "добавлен",
    willUpdate: "будет обновлён",
    updated: "обновлён",
    willRemove: "будет удалён",
    removed: "удалён",
    mismatch: (what: string) => `расхождение: ${what}, не изменено`,
    foreignFolder: "папка без маркера установки (чужая)",
    otherCopyFolder: (path: string) => `папка установлена из другой копии репозитория: ${path}`,
    notOurFolder: "папка не от этой установки (нет маркера, в маркере другой репозиторий или другое имя)",
    noSource: (path: string) => `нет исходника скилла ${path}`,
    pointsTo: (command: string) => `запись указывает на ${command}`,
    parseFailed: (file: string, reason: string) => `не удалось разобрать ${file}: ${reason}`,
    codexUnclear: (output: string) => `codex mcp get не сообщил, есть ли запись: ${output}`,
    emptyOutput: "пустой вывод",
    cliError: (output: string) => `ошибка CLI: ${output}`,
    notOursAfterAdd: "ошибка: после добавления запись не найдена или не наша",
    noAgents: "Ни один агент не найден: устанавливать некуда.",
    allInstalled: "Всё уже установлено.",
    restart: "Перезапусти агентов и проверь сервер командой /mcp в Claude Code.",
  },
});
type Messages = ReturnType<typeof installMessages>;

type Entry = { kind: "none" } | { kind: "found"; command: string; args: string[] } | { kind: "error"; message: string };

interface Agent {
  title: string;
  bin: Bin;
  skillsDir(home: string): string;
  settings(home: string): string;
  read(deps: Deps, m: Messages, name: string): Entry;
  add(main: string): string[];
  remove(name: string): string[];
}

const AGENTS: Agent[] = [
  {
    title: "Claude Code", bin: "claude",
    skillsDir: (h) => join(h, ".claude", "skills"),
    settings: (h) => join(h, ".claude.json"),
    read: (d, m, name) => {
      const file = join(d.home, ".claude.json");
      if (!existsSync(file)) return { kind: "none" };
      try {
        const e = JSON.parse(readFileSync(file, "utf8"))?.mcpServers?.[name];
        if (!e) return { kind: "none" };
        return { kind: "found", command: String(e.command ?? ""), args: Array.isArray(e.args) ? e.args.map(String) : [] };
      } catch (err) {
        return { kind: "error", message: m.parseFailed(file, (err as Error).message) };
      }
    },
    add: (main) => ["mcp", "add", "--scope", "user", NAME, "--", "node", main],
    remove: (name) => ["mcp", "remove", "--scope", "user", name],
  },
  {
    title: "Codex", bin: "codex",
    skillsDir: (h) => join(h, ".codex", "skills"),
    settings: (h) => join(h, ".codex", "config.toml"),
    read: (d, m, name) => {
      const r = d.exec("codex", ["mcp", "get", name, "--json"]);
      try {
        const t = JSON.parse(r.stdout)?.transport;
        if (t) return { kind: "found", command: String(t.command ?? ""), args: Array.isArray(t.args) ? t.args.map(String) : [] };
      } catch { /* not JSON: the text is parsed below */ }
      // "no entry" — only on an explicit CLI answer: codex mcp add silently overwrites an existing entry
      const text = `${r.stdout}${r.stderr}`.trim();
      return text.includes("No MCP server named") ? { kind: "none" } : { kind: "error", message: m.codexUnclear(text || m.emptyOutput) };
    },
    add: (main) => ["mcp", "add", NAME, "--", "node", main],
    remove: (name) => ["mcp", "remove", name],
  },
];

function files(dir: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (rel === MARKER || !statSync(join(dir, rel)).isFile()) continue;
    m.set(rel, readFileSync(join(dir, rel), "utf8"));
  }
  return m;
}

function sameFiles(a: string, b: string): boolean {
  const x = files(a), y = files(b);
  return x.size === y.size && [...x].every(([k, v]) => y.get(k) === v);
}

export async function run(argv: string[], deps: Deps): Promise<number> {
  const m = installMessages(deps.language);
  let values;
  try {
    values = parseArgs({ args: argv, options: { "dry-run": { type: "boolean" }, uninstall: { type: "boolean" }, help: { type: "boolean" } }, strict: true }).values;
  } catch (e) {
    deps.out(`${(e as Error).message}\n${m.help}`);
    return 2;
  }
  if (values.help) { deps.out(m.help); return 0; }
  const dry = !!values["dry-run"], un = !!values.uninstall;
  const { home, repoRoot } = deps;
  const src = join(repoRoot, "skill", NAME);
  const main = join(repoRoot, "packages", "mcp", "src", "main.ts");
  const marker = repoRoot + "\n";
  const will = (future: string, past: string) => (dry ? future : past);
  let changed = false, problems = 0, found = 0;

  deps.out(`${dry ? m.preview : un ? m.uninstall : m.install}\n${m.repo(repoRoot)}`);

  for (const a of AGENTS) {
    if (!deps.hasCommand(a.bin)) { deps.out(m.notFound(a.title)); continue; }
    found++;
    const problemsBefore = problems;
    const skill = join(a.skillsDir(home), NAME);
    const sLine = (act: string) => deps.out(`${a.title} · ${m.skill} · ${act} · ${skill}`);
    const vLine = (act: string) => deps.out(`${a.title} · ${m.server} · ${act} · ${a.settings(home)} · node ${main}`);
    const bad = (print: (s: string) => void, what: string) => { problems++; print(m.mismatch(what)); };
    const fail = (print: (s: string) => void, r: { stderr: string; stdout: string }) => { problems++; print(m.cliError((r.stderr || r.stdout).trim())); };

    // skill: our own folder has a marker with this copy's path; without a marker, or with another copy's marker, it is foreign
    const owner = existsSync(join(skill, MARKER)) ? readFileSync(join(skill, MARKER), "utf8") : null;
    const own = owner === marker;
    const foreign = existsSync(skill) && !own ? (owner === null ? m.foreignFolder : m.otherCopyFolder(owner.replace(/\n$/, ""))) : "";
    if (un) {
      if (foreign) bad(sLine, foreign);
      else if (!own) sLine(m.notInstalled);
      else { if (!dry) rmSync(skill, { recursive: true, force: true }); changed = true; sLine(will(m.willRemove, m.removed)); }
    } else if (foreign) bad(sLine, foreign);
    else if (!existsSync(src)) bad(sLine, m.noSource(src));
    else {
      const upToDate = own && sameFiles(src, skill);
      if (upToDate) sLine(m.alreadyInstalled);
      else {
        if (!dry) {
          rmSync(skill, { recursive: true, force: true });
          mkdirSync(a.skillsDir(home), { recursive: true });
          cpSync(src, skill, { recursive: true });
          writeFileSync(join(skill, MARKER), marker);
        }
        changed = true;
        sLine(own ? will(m.willUpdate, m.updated) : will(m.willAdd, m.added));
      }
    }

    // server
    const isOurs = (e: Entry) => e.kind === "found" && e.command === "node" && e.args.length === 1 && e.args[0] === main;
    const e = a.read(deps, m, NAME);
    if (e.kind === "error") { bad(vLine, e.message); continue; }
    const other = e.kind === "found" && !isOurs(e) ? m.pointsTo([e.command, ...e.args].join(" ")) : "";
    if (un) {
      if (e.kind === "none") vLine(m.notInstalled);
      else if (other) bad(vLine, other);
      else if (dry) { changed = true; vLine(m.willRemove); }
      else {
        const r = deps.exec(a.bin, a.remove(NAME));
        if (!r.ok) fail(vLine, r); else { changed = true; vLine(m.removed); }
      }
    } else if (e.kind === "found") {
      if (other) bad(vLine, other); else vLine(m.alreadyInstalled);
    } else if (dry) { changed = true; vLine(m.willAdd); }
    else {
      const r = deps.exec(a.bin, a.add(main));
      if (!r.ok) fail(vLine, r);
      else if (!isOurs(a.read(deps, m, NAME))) { problems++; vLine(m.notOursAfterAdd); }
      else { changed = true; vLine(m.added); }
    }

    // legacy model-council entries: removed on install only if osen was set up for the agent without mismatches
    if (!un && problems > problemsBefore) continue;
    const legacy = join(a.skillsDir(home), LEGACY_NAME);
    const lsLine = (act: string) => deps.out(`${a.title} · ${m.skill} · ${act} · ${legacy}`);
    if (existsSync(legacy)) {
      const text = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
      const ours = text(join(legacy, LEGACY_MARKER)) === marker && /^name: model-council$/m.test(text(join(legacy, "SKILL.md")));
      if (!ours) bad(lsLine, m.notOurFolder);
      else { if (!dry) rmSync(legacy, { recursive: true, force: true }); changed = true; lsLine(will(m.willRemove, m.removed)); }
    }
    const lvLine = (act: string) => deps.out(`${a.title} · ${m.server} ${LEGACY_NAME} · ${act} · ${a.settings(home)} · node ${main}`);
    const le = a.read(deps, m, LEGACY_NAME);
    if (le.kind === "error") bad(lvLine, le.message);
    else if (le.kind === "found" && !isOurs(le)) bad(lvLine, m.pointsTo([le.command, ...le.args].join(" ")));
    else if (le.kind === "found" && dry) { changed = true; lvLine(m.willRemove); }
    else if (le.kind === "found") {
      const r = deps.exec(a.bin, a.remove(LEGACY_NAME));
      if (!r.ok) fail(lvLine, r); else { changed = true; lvLine(m.removed); }
    }
  }

  if (found === 0) deps.out(m.noAgents);
  else if (!un && !dry && !changed && !problems) deps.out(m.allInstalled);
  else if (!un && !dry && changed) deps.out(m.restart);
  return problems ? 1 : 0;
}

if (import.meta.main) {
  const code = await run(process.argv.slice(2), {
    home: homedir(),
    repoRoot: resolve(import.meta.dirname, ".."),
    // COUNCIL_LANG → preferences.json of the data folder → en; only reads the data folder, never migrates it (change 98)
    language: (() => { try { return resolveLanguage(process.env, peekDataDir(process.env)).language; } catch { return DEFAULT_LANGUAGE; } })(),
    hasCommand: (b) => { try { execFileSync(b, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } },
    exec: (b, args) => {
      try { return { ok: true, stdout: execFileSync(b, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" }; }
      catch (e) { const x = e as { stdout?: string; stderr?: string; message: string }; return { ok: false, stdout: String(x.stdout ?? ""), stderr: String(x.stderr ?? x.message) }; }
    },
    out: (l) => console.log(l),
  });
  process.exitCode = code;
}
