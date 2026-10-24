import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { DEFAULT_LANGUAGE, defineMessages, envFilePath, peekDataDir, resolveLanguage } from "@model-council/core";
import type { Language } from "@model-council/core";
import { connect, desktopApps, disconnect, skillsDir, status } from "@model-council/connect";
import type { ActionResult, Bin, ClientAction, ClientId, ConnectDeps, Reason, ServerCommand } from "@model-council/connect";

export interface Deps {
  home: string;
  repoRoot: string;
  // not set — the process language
  language?: Language;
  hasCommand(bin: Bin): boolean;
  exec(bin: Bin, args: string[]): { ok: boolean; stdout: string; stderr: string };
  out(line: string): void;
  // Claude.app bundle paths; not set — Claude Desktop counts as not installed
  desktopApps?: string[];
  // node for Claude Desktop (an app started from Finder does not see the shell PATH); not set — this process's node
  nodePath?: string;
  // copies the skill source into a temporary folder; not set — cpSync (a seam for tests)
  copy?: (src: string, dst: string) => void;
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
  (no flags)    install the osen skill and MCP server into Claude Code, Codex and Claude Desktop and remove the previous model-council entries of this installation
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
    noSkill: "no skill: support is not confirmed, the rules come from the MCP server instructions",
    staleEntry: (command: string) => `the entry points to a missing file: ${command}`,
    otherProgram: (recorded: string, expected: string) => `the entry runs the same server with another program: ${recorded}, expected ${expected}`,
    serverNotAdded: "server not added: the osen skill folder is foreign",
    unexpectedShape: (file: string) => `${file}: mcpServers is not an object or the file is not a JSON object`,
    unreadable: (file: string, reason: string) => `could not read ${file}: ${reason}`,
    writeFailed: (file: string, reason: string) => `could not write ${file}: ${reason}`,
    needRestart: "restart the client",
    needUnverified: "whether the client needs a restart is not verified: restart it to be sure",
    needConfirm: "confirm the server in the client",
    noAgents: "No agent found: nothing to install into.",
    allInstalled: "Everything is already installed.",
    restart: "Restart the agents and check the server with the /mcp command in Claude Code.",
  },
  ru: {
    help: `Использование: node skill/install.ts [--dry-run] [--uninstall] [--help]

Режимы:
  (без флагов)  установить скилл и MCP-сервер osen в Claude Code, Codex и Claude Desktop и снять прежние записи model-council этой установки
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
    noSkill: "без скилла: поддержка не подтверждена, правила приходят из инструкций MCP-сервера",
    staleEntry: (command: string) => `запись указывает на несуществующий файл: ${command}`,
    otherProgram: (recorded: string, expected: string) => `запись запускает тот же сервер другой программой: ${recorded}, ожидается ${expected}`,
    serverNotAdded: "сервер не добавлен: папка скилла osen чужая",
    unexpectedShape: (file: string) => `${file}: mcpServers не объект или файл не объект JSON`,
    unreadable: (file: string, reason: string) => `не удалось прочитать ${file}: ${reason}`,
    writeFailed: (file: string, reason: string) => `не удалось записать ${file}: ${reason}`,
    needRestart: "перезапусти клиент",
    needUnverified: "нужен ли перезапуск клиента, не проверено: перезапусти его для надёжности",
    needConfirm: "подтверди сервер в клиенте",
    noAgents: "Ни один агент не найден: устанавливать некуда.",
    allInstalled: "Всё уже установлено.",
    restart: "Перезапусти агентов и проверь сервер командой /mcp в Claude Code.",
  },
});
type Messages = ReturnType<typeof installMessages>;

const CLIENTS: { id: ClientId; title: string }[] = [
  { id: "claude-code", title: "Claude Code" },
  { id: "codex", title: "Codex" },
  { id: "claude-desktop", title: "Claude Desktop" },
];

function reasonText(m: Messages, r: Reason, file: string): string {
  switch (r.code) {
    case "parse": return m.parseFailed(file, r.detail);
    case "shape": return m.unexpectedShape(file);
    case "unreadable": return m.unreadable(file, r.detail);
    case "codex_unclear": return m.codexUnclear(r.detail || m.emptyOutput);
    case "cli": return m.cliError(r.detail);
    case "verify": return m.notOursAfterAdd;
    case "write": return m.writeFailed(file, r.detail);
  }
}

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

// Replaces the skill folder atomically: copy and marker go to a dot-prefixed temporary folder, the old folder is kept as a backup until the swap succeeds.
// Returns the failure text, or null; no temporary or backup folder is left.
function swapSkill(src: string, skill: string, skillsRoot: string, marker: string, copy: (src: string, dst: string) => void): string | null {
  const id = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const tmp = join(skillsRoot, `.osen-tmp-${id}`), bak = join(skillsRoot, `.osen-bak-${id}`);
  try {
    mkdirSync(skillsRoot, { recursive: true });
    copy(src, tmp);
    writeFileSync(join(tmp, MARKER), marker);
    if (existsSync(skill)) renameSync(skill, bak);
    renameSync(tmp, skill);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    try { if (existsSync(bak) && !existsSync(skill)) renameSync(bak, skill); } catch { return `${(e as Error).message}; the previous copy is in ${bak}`; }
    return (e as Error).message;
  }
  // the new copy is in place: a failed cleanup of the backup is not a failed install
  try { rmSync(bak, { recursive: true, force: true }); } catch { /* the backup stays */ }
  return null;
}

// COUNCIL_LANG → .env of the data folder → preferences.json → en; only reads, never creates or migrates the data folder (changes 98, 257)
export function installerLanguage(env: NodeJS.ProcessEnv): Language {
  try {
    const dir = peekDataDir(env);
    let lang = env.COUNCIL_LANG;
    if (!lang) {
      try { lang = parseEnv(readFileSync(envFilePath(dir), "utf8")).COUNCIL_LANG; } catch { /* no or broken .env */ }
    }
    return resolveLanguage({ ...env, COUNCIL_LANG: lang }, dir).language;
  } catch { return DEFAULT_LANGUAGE; }
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

  const cdeps: ConnectDeps = { home, hasCommand: deps.hasCommand, exec: deps.exec, desktopApps: deps.desktopApps ?? [] };
  const needText: Record<ClientAction, string> = { none: "", restart_client: m.needRestart, unverified: m.needUnverified, confirm_in_client: m.needConfirm };
  const joined = (e: ServerCommand) => [e.command, ...e.args].join(" ");

  for (const { id, title } of CLIENTS) {
    const desktop = id === "claude-desktop";
    const cmd: ServerCommand = { command: desktop ? deps.nodePath ?? process.execPath : "node", args: [main] };
    const st = await status(id, cmd, cdeps);
    if (st.state === "not_installed") { deps.out(m.notFound(title)); continue; }
    found++;
    const problemsBefore = problems;
    const skillsRoot = skillsDir(id, home);
    const vLine = (act: string) => deps.out(desktop
      ? `${title} · ${m.server} · ${act} · ${st.file} · mcpServers.osen · ${cmd.command} ${main}`
      : `${title} · ${m.server} · ${act} · ${st.file} · node ${main}`);
    const bad = (print: (s: string) => void, what: string) => { problems++; print(m.mismatch(what)); };
    const fail = (print: (s: string) => void, r: Extract<ActionResult, { ok: false }>) => {
      problems++;
      print(r.reason ? reasonText(m, r.reason, r.file) : m.notOursAfterAdd);
    };

    let foreign = "";
    if (skillsRoot === null) deps.out(`${title} · ${m.skill} · ${m.noSkill}`);
    else {
      const skill = join(skillsRoot, NAME);
      const sLine = (act: string) => deps.out(`${title} · ${m.skill} · ${act} · ${skill}`);
      // skill: our own folder has a marker with this copy's path; without a marker, or with another copy's marker, it is foreign
      const owner = existsSync(join(skill, MARKER)) ? readFileSync(join(skill, MARKER), "utf8") : null;
      const own = owner === marker;
      foreign = existsSync(skill) && !own ? (owner === null ? m.foreignFolder : m.otherCopyFolder(owner.replace(/\n$/, ""))) : "";
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
          // the copy is built aside and swapped in, so a failure leaves the previous folder (change 257)
          const failed = dry ? null : swapSkill(src, skill, skillsRoot, marker, deps.copy ?? ((a, b) => cpSync(a, b, { recursive: true })));
          if (failed) { problems++; sLine(m.writeFailed(skill, failed)); }
          else { changed = true; sLine(own ? will(m.willUpdate, m.updated) : will(m.willAdd, m.added)); }
        }
      }
    }

    // server: a stale_path entry is only reported, the app updates it (change 142)
    const mismatch = (print: (s: string) => void, s: typeof st) => {
      if (s.state === "corrupt") bad(print, reasonText(m, s.reason!, s.file));
      else if (s.state !== "stale_path") bad(print, m.pointsTo(joined(s.entry!)));
      else {
        // the same server file with another launcher is not a missing file
        const e = s.entry!, file = e.args.length ? e.args[e.args.length - 1]! : e.command;
        bad(print, existsSync(file) ? m.otherProgram(e.command, cmd.command) : m.staleEntry(joined(e)));
      }
    };
    const done = (r: ActionResult) => {
      if (!r.ok) { fail(vLine, r); return; }
      changed = true;
      vLine(will(un ? m.willRemove : m.willAdd, un ? m.removed : m.added));
      if (!dry && needText[r.need]) deps.out(`${title} · ${needText[r.need]}`);
    };
    if (st.state === "corrupt") { mismatch(vLine, st); continue; }
    if (un) {
      if (st.state === "not_connected") vLine(m.notInstalled);
      else if (st.state === "connected") done(await disconnect(id, cmd, cdeps, { dryRun: dry }));
      else mismatch(vLine, st);
    } else if (st.state === "connected") vLine(m.alreadyInstalled);
    else if (st.state === "not_connected" && foreign) bad(vLine, m.serverNotAdded);
    else if (st.state === "not_connected") done(await connect(id, cmd, cdeps, { dryRun: dry }));
    else mismatch(vLine, st);

    // legacy model-council entries: removed on install only if osen was set up for the agent without mismatches
    if (desktop || (!un && problems > problemsBefore)) continue;
    const legacy = join(skillsRoot!, LEGACY_NAME);
    const lsLine = (act: string) => deps.out(`${title} · ${m.skill} · ${act} · ${legacy}`);
    if (existsSync(legacy)) {
      const text = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
      const ours = text(join(legacy, LEGACY_MARKER)) === marker && /^name: model-council$/m.test(text(join(legacy, "SKILL.md")));
      if (!ours) bad(lsLine, m.notOurFolder);
      else { if (!dry) rmSync(legacy, { recursive: true, force: true }); changed = true; lsLine(will(m.willRemove, m.removed)); }
    }
    const lvLine = (act: string) => deps.out(`${title} · ${m.server} ${LEGACY_NAME} · ${act} · ${st.file} · node ${main}`);
    const lopts = { name: LEGACY_NAME, dryRun: dry };
    const ls = await status(id, cmd, cdeps, lopts);
    if (ls.state === "connected") {
      const r = await disconnect(id, cmd, cdeps, lopts);
      if (r.ok) { changed = true; lvLine(will(m.willRemove, m.removed)); } else fail(lvLine, r);
    } else if (ls.state === "corrupt" || ls.state === "foreign" || ls.state === "stale_path") {
      if (ls.state === "corrupt") bad(lvLine, reasonText(m, ls.reason!, ls.file));
      else bad(lvLine, m.pointsTo(joined(ls.entry!)));
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
    language: installerLanguage(process.env),
    hasCommand: (b) => { try { execFileSync(b, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } },
    exec: (b, args) => {
      try { return { ok: true, stdout: execFileSync(b, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" }; }
      catch (e) { const x = e as { stdout?: string; stderr?: string; message: string }; return { ok: false, stdout: String(x.stdout ?? ""), stderr: String(x.stderr ?? x.message) }; }
    },
    out: (l) => console.log(l),
    desktopApps: desktopApps(homedir()),
  });
  process.exitCode = code;
}
