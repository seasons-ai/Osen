import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import type { CliTransition, SettingsProvider } from "../../shared/settings.ts";
import { createCliTransition } from "../../main/cli-transition.ts";
import { guardedPinStatus } from "../../main/cli-transition.testutil.ts";
import { NO_CLI_CARD } from "./CliTransition.tsx";
import type { CliCardProps } from "./CliTransition.tsx";
import { ProviderCard } from "./ProviderCard.tsx";

const base: SettingsProvider = {
  id: "p", kind: "cli", label: "Claude Code", available: true, reason: null, warning: null, version: "2.1.288", path: "/opt/homebrew/bin/claude",
  baseUrl: null, keyEnv: null, keySet: false, billing: "subscription", models: [], defaultModel: null, modelsSource: "provider", modelsReason: null, modelsAt: null, cli: null,
};
const http = (o: Partial<SettingsProvider> = {}): SettingsProvider => ({
  ...base, kind: "openai-http", label: "OpenRouter", version: null, path: null, baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", keySet: true, billing: "paid", ...o
});
type Over = { cli?: Partial<CliCardProps>; busy?: boolean; deleting?: boolean; canTest?: boolean; models?: ReactNode; test?: ReactNode | null };
const html = (provider: SettingsProvider, o: Over = {}) =>
  renderToStaticMarkup(
    <ProviderCard provider={provider} envPath="/data/.env" busy={o.busy ?? false} deleting={o.deleting ?? false} canTest={o.canTest ?? true}
      models={o.models ?? null} test={o.test ?? null} onTest={() => {}} onRecheck={() => {}} onEdit={() => {}} onAskDelete={() => {}} onDelete={() => {}} onCancelDelete={() => {}} cli={{ ...NO_CLI_CARD, ...o.cli }} />
  );
const btn = (h: string, text: string) => h.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${text}</button>`))?.[0] ?? "";

describe("ProviderCard", () => {
  it("CLI found", () => {
    const h = html(base);
    expect(h).toContain('<span class="badge" data-tone="ok">');
    expect(h).toContain("доступен");
    expect(h).toContain('<dt>Версия</dt><dd><span class="mono">2.1.288</span></dd>');
    expect(h).toContain('<dt>Команда</dt><dd><span class="mono">/opt/homebrew/bin/claude</span></dd>');
    expect(h).toContain('<dd><span class="chip">расходует подписку</span></dd>');
    expect(btn(h, "Проверить")).not.toBe("");
    expect(h).toContain('<div class="settings-card__head"><h3 class="settings-card__name">Claude Code</h3><span class="chip mono">CLI</span>');
    expect(h).toContain('<dl class="kv settings-info">');
    expect(h).not.toContain("Изменить");
    expect(h).not.toContain("Удалить");
  });

  it("CLI not found", () => {
    const h = html({ ...base, available: false, reason: "Команда codex не найдена", version: null, path: null });
    expect(h).toContain('<span class="badge" data-tone="danger">');
    expect(h).toContain("недоступен");
    expect(h).toContain('data-tone="danger" role="alert"');
    expect(h).toContain("Команда codex не найдена");
    expect(btn(h, "Проверить заново")).not.toBe("");
    expect(h).not.toContain("<dt>Версия</dt>");
    expect(h).not.toContain("<dt>Команда</dt>");
    expect(h).toContain("<dt>Расход</dt>");
  });

  it("version newer than the verified one", () => {
    const h = html({ ...base, warning: "Проверено на 2.0–2.1, найдена 2.5" });
    expect(h).toContain('<div class="alert" data-tone="warn">');
    expect(h).toContain("Версия новее проверенной");
    expect(h).toContain("Проверено на 2.0–2.1, найдена 2.5");
    expect(h).toContain('data-tone="ok"');
  });

  it("HTTP with a key", () => {
    const h = html(http());
    expect(h).toContain('<dt>Адрес</dt><dd><span class="mono">https://openrouter.ai/api/v1</span></dd>');
    expect(h).toContain('<dd><span class="mono">OPENROUTER_API_KEY</span><span class="badge" data-tone="ok">');
    expect(h).toContain('<span class="chip mono">HTTP</span>');
    expect(h).toContain("ключ задан");
    expect(h).toContain("оплачивается");
    expect(btn(h, "Проверить")).not.toBe("");
    expect(btn(h, "Изменить")).not.toBe("");
    expect(btn(h, "Удалить")).not.toBe("");
  });

  it("HTTP without a key", () => {
    const h = html(http({ available: false, keySet: false, reason: "нет ключа" }));
    expect(h.match(/data-tone="warn"><svg[^>]*><use href="#i-alert"><\/use><\/svg> ключ не задан/g)).toHaveLength(2);
    expect(h).toContain('<div class="alert__title">Ключ не задан</div>');
    expect(h).toContain('<span class="mono">OPENROUTER_API_KEY</span> в файл <span class="mono">/data/.env</span>');
    expect(btn(h, "Проверить заново")).not.toBe("");
  });

  it("HTTP without a key variable", () => {
    const h = html(http({ keyEnv: null, billing: "free" }));
    expect(h).toContain('<span class="muted">не требуется</span>');
    expect(h).not.toContain("<dt>Расход</dt>");
  });

  it("HTTP unavailable for another reason", () => {
    const h = html(http({ available: false, reason: "Эндпоинт не отвечает" }));
    expect(h).toContain('<span class="badge" data-tone="danger">');
    expect(h).toContain("Эндпоинт не отвечает");
    expect(h).toContain("Провайдер недоступен");
  });

  it("delete confirmation", () => {
    const h = html(http(), { deleting: true });
    expect(h).toContain("Удалить провайдера «OpenRouter»?");
    expect(btn(h, "Удалить")).toContain("btn--danger");
    expect(btn(h, "Отмена")).not.toBe("");
    expect(h).not.toContain("settings-actions");
  });

  it("check panel", () => {
    const h = html(base, { test: <div id="panel">ПАНЕЛЬ</div> });
    expect(h).toContain('<div id="panel">ПАНЕЛЬ</div>');
    expect(h).not.toContain("settings-actions");
  });

  it("busy and canTest", () => {
    const h = html(http(), { busy: true });
    for (const t of ["Проверить", "Изменить", "Удалить"]) expect(btn(h, t)).toContain("disabled");
    expect(btn(html(http(), { canTest: false }), "Проверить")).toContain("disabled");
    expect(btn(html(http()), "Проверить")).not.toContain("disabled");
  });

  it("models node", () => {
    expect(html(base, { models: <div id="m">МОДЕЛИ</div> })).toContain('<div id="m">МОДЕЛИ</div>');
  });

  it("no input fields, the name is escaped", () => {
    const h = html({ ...base, label: "<b>x</b>" });
    expect(h).not.toContain("<input");
    expect(h).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(h).not.toContain("<b>");
  });
});

describe("ProviderCard: en", () => {
  afterEach(() => setProcessLanguage("ru"));
  const en = (p: SettingsProvider, o: Over = {}) => { setProcessLanguage("en"); return html(p, o); };

  it("CLI available", () => {
    const h = en(base);
    for (const t of ["available", "Version", "Command", "Billing", "uses subscription", "Test"]) expect(h).toContain(t);
  });
  it("HTTP with a key", () => {
    const h = en(http());
    for (const t of ["Address", "Key", "key set", "paid", "Edit", "Delete"]) expect(h).toContain(t);
  });
  it("key not set: a phrase with the variable name and path", () => {
    const h = en(http({ available: false, keySet: false }));
    expect(h).toContain("key not set");
    expect(h).toContain('Put the value of the variable <span class="mono">OPENROUTER_API_KEY</span> into the file <span class="mono">/data/.env</span> and press “Check again”.');
    expect(h).toContain("Check again");
  });
  it("unavailable: reason as is", () => {
    const h = en(base_down());
    expect(h).toContain("Provider unavailable");
    expect(h).toContain("Не найден");
  });
  it("version warning", () => {
    expect(en({ ...base, warning: "w" })).toContain("Version newer than tested");
  });
  it("must not be caught by hard-coded ru", () => {
    const miss = en(http({ available: false, keySet: false }));
    expect(miss).toMatch(/<span class="badge" data-tone="warn">.*key not set<\/span><\/div>/);
    expect(miss).toContain("<div class=\"alert__title\">Key not set</div>");
    expect(en(http({ keyEnv: null }))).toContain("not required");
    const d = en(http(), { deleting: true });
    expect(d).toContain("It will be removed from the registry and from the default participants. Past sessions with it stay in history.");
    expect(btn(d, "Delete")).toContain("btn--danger");
  });
  it("delete confirmation", () => {
    const h = en(http(), { deleting: true });
    expect(h).toContain("Delete provider “OpenRouter”?");
    expect(h).toContain("Cancel");
  });
});
const base_down = (): SettingsProvider => ({ ...base, available: false, reason: "Не найден" });

// Requirements: "Источник, версия и уровень проверки CLI в карточке", "Переход и откат из карточки", "Тексты перехода CLI на выбранном языке"
describe("CLI transition in the card", () => {
  afterEach(() => setProcessLanguage("ru"));
  const tr = (o: Partial<CliTransition> = {}): CliTransition => ({
    agent: "claude", source: "pin", level: "real", checkedAt: "2026-10-07",
    pin: { version: "2.1.288", activatedAt: "2026-09-10T08:30:00Z", ageDays: 40, previous: "2.1.270" },
    due: null, target: null, install: null, candidates: [], violations: [], check: null, ...o,
  });
  const day = (d: string, lang: string) => new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
  const card = (cli: CliTransition | null, o: Over = {}, lang: "en" | "ru" = "en") => { setProcessLanguage(lang); return html({ ...base, cli }, o); };
  const due = { from: "2.1.288", to: "2.1.300", ageDays: 40, acceptedAt: "2026-10-15" };
  const noCyrillic = (h: string) => expect(h).not.toMatch(/[А-Яа-яЁё]/);

  it("pin: source, real acceptance with date, activation date, previous pin", () => {
    const h = card(tr());
    expect(h).toContain("<dt>Source</dt><dd>Osen pin</dd>");
    expect(h).toContain("real acceptance");
    expect(h).toContain(`<span class="muted">${day("2026-10-07", "en")}</span>`);
    expect(h).toContain(`<dt>Active since</dt><dd>${day("2026-09-10", "en")}</dd>`);
    expect(h).toContain("<dt>Previous pin</dt><dd><span class=\"mono\">2.1.270</span></dd>");
    expect(h.indexOf("<dt>Source</dt>")).toBeLessThan(h.indexOf("<dt>Version</dt>"));
    noCyrillic(h);
  });

  it("PATH: no buttons, a note that Osen does not pin the version", () => {
    const h = card(tr({ source: "path", level: "interface", pin: null, target: { version: "2.1.300", acceptedAt: "2026-10-15" } }));
    expect(h).toContain("<dt>Source</dt><dd>PATH</dd>");
    expect(h).toContain("interface only");
    expect(h).toContain("Osen does not pin this version.");
    expect(btn(h, "Switch to")).toBe("");
    expect(btn(h, "Roll back")).toBe("");
    expect(h).not.toContain("Active since");
  });

  it("explicit path beats the pin: note, no buttons", () => {
    const h = card(tr({ source: "explicit", level: "none", checkedAt: null, target: { version: "2.1.300", acceptedAt: "2026-10-15" } }));
    expect(h).toContain("explicit path");
    expect(h).toContain("Pin 2.1.288 not used: an explicit path is set.");
    expect(btn(h, "Switch to")).toBe("");
    expect(btn(h, "Roll back")).toBe("");
  });

  it("version without a record: «no record» and no date", () => {
    const h = card(tr({ level: "none", checkedAt: null }));
    expect(h).toContain("no record");
    expect(h).not.toMatch(/<span class="muted">[A-Z][a-z]{2} \d/);
  });

  it("unknown activation date: the phrase, no due line", () => {
    const h = card(tr({ pin: { version: "2.1.288", activatedAt: null, ageDays: null, previous: null } }));
    expect(h).toContain("activation date unknown");
    expect(h).not.toContain("Time for the planned transition");
  });

  it("nothing to roll back: «Roll back» is shown unavailable with the reason (en, ru)", () => {
    const pin = { version: "2.1.288", activatedAt: "2026-09-10T08:30:00Z", ageDays: 40, previous: null };
    const h = card(tr({ pin }));
    expect(btn(h, "Roll back")).toMatch(/disabled=""/);
    expect(h).toContain("no previous version");
    const r = card(tr({ pin }), {}, "ru");
    expect(btn(r, "Откатить")).toMatch(/disabled=""/);
    expect(r).toContain("нет предыдущей версии");
  });

  it("due: reminder line with versions, age and acceptance date, and the Switch button", () => {
    const h = card(tr({ due, target: { version: "2.1.300", acceptedAt: "2026-10-15" } }));
    expect(h).toContain("Time for the planned transition");
    expect(h).toContain(`2.1.288 → 2.1.300: pinned for 40 days. Real acceptance of 2.1.300: ${day("2026-10-15", "en")}`);
    expect(btn(h, "Switch to 2.1.300")).not.toBe("");
    expect(btn(h, "Roll back to 2.1.270")).not.toBe("");
    noCyrillic(h);
  });

  it("due on ru: the date already ends with «г.», no doubled period after it", () => {
    const h = card(tr({ due, target: { version: "2.1.300", acceptedAt: "2026-10-15" } }), {}, "ru");
    expect(h).toContain(`Реальная приёмка 2.1.300: ${day("2026-10-15", "ru")}`);
    expect(h).not.toMatch(/г\.\./);
  });

  it("interface candidate: a line without a button; violation: missing names, no buttons", () => {
    const h = card(tr({ candidates: [{ version: "2.1.301" }], violations: [{ version: "2.1.302", names: ["--tools", "mcp_config"] }] }));
    expect(h).toContain("Candidate found 2.1.301");
    expect(h).toContain("switch after council cli accept");
    expect(h).toContain("Candidate 2.1.302 violates the contract");
    expect(h).toContain("Missing: --tools, mcp_config.");
    expect(btn(h, "Switch to")).toBe("");
  });

  it("real version not installed: install command and Copy; copy state", () => {
    const install = { version: "2.1.310", command: "council cli install claude --version 2.1.310" };
    const h = card(tr({ install }));
    expect(h).toContain("Version 2.1.310 is not installed");
    expect(h).toContain('<code class="mono conn-line__text">council cli install claude --version 2.1.310</code>');
    expect(btn(h, "Copy")).not.toBe("");
    expect(h).not.toContain("Copied");
    expect(card(tr({ install }), { cli: { copied: true } })).toContain("Copied");
    expect(btn(h, "Switch to")).toBe("");
  });

  it("last check failure: reason by code and the attempt time", () => {
    const h = card(tr({ check: { at: "2026-10-20T14:32:00Z", outcome: "source_unavailable" } }));
    expect(h).toContain("Candidate check failed");
    expect(h).toContain("the release source is unavailable");
    expect(h).toContain("Last attempt:");
    expect(card(tr({ check: { at: "2026-10-20T14:32:00Z", outcome: "ok" } }))).not.toContain("Candidate check failed");
    expect(card(tr({ check: { at: "2026-10-20T14:32:00Z", outcome: "no_base" } }))).toContain("no active pin");
  });

  it("running session: both buttons disabled with a visible reason", () => {
    const h = card(tr({ target: { version: "2.1.300", acceptedAt: "2026-10-15" } }), { cli: { running: true } });
    expect(btn(h, "Switch to 2.1.300")).toContain("disabled");
    expect(btn(h, "Roll back to 2.1.270")).toContain("disabled");
    expect(h).toContain("a session is running");
    expect(card(tr({ target: { version: "2.1.300", acceptedAt: "2026-10-15" } }))).not.toContain("a session is running");
  });

  it("confirmation: CLI, versions, consequences, Switch and Cancel; the action buttons are hidden", () => {
    const confirm = { agent: "claude", kind: "switch" as const, from: "2.1.288", to: "2.1.300" };
    const h = card(tr({ target: { version: "2.1.300", acceptedAt: "2026-10-15" } }), { cli: { confirm } });
    expect(h).toContain("Switch Claude Code from 2.1.288 to 2.1.300?");
    expect(h).toContain("New launches will use 2.1.300; past sessions and journals do not change. No model calls.");
    expect(btn(h, "Switch")).not.toBe("");
    expect(btn(h, "Cancel")).not.toBe("");
    expect(btn(h, "Switch to")).toBe("");
    const rb = card(tr(), { cli: { confirm: { agent: "claude", kind: "rollback", from: "2.1.288", to: "2.1.270" } } });
    expect(rb).toContain("Roll Claude Code back from 2.1.288 to 2.1.270?");
    expect(btn(rb, "Roll back")).not.toBe("");
  });

  it("card transition and rollback: pin failed the pre-launch check shows the pin rows and an enabled rollback", async () => {
    setProcessLanguage("en");
    const dir = mkdtempSync(join(tmpdir(), "card-pin-guard-"));
    try {
      const status = await guardedPinStatus(dir, new Date("2026-09-01T00:00:00Z"));
      const reason = status.reason ?? "";
      const logger = { info() {}, error() {} };
      const cli = createCliTransition({ dataDir: dir, logger, running: () => false, onChecked() {}, candidateDeps: () => { throw new Error("no check"); } }).forProvider("claude", status);
      const down = html({ ...base, available: false, reason, version: null, path: null, cli }, {});
      expect(down).toContain(reason);
      expect(down).toContain("<dt>Source</dt><dd>Osen pin</dd>");
      expect(btn(down, "Roll back to 2.1.280")).not.toBe("");
      expect(btn(down, "Roll back to 2.1.280")).not.toContain("disabled");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("card transition and rollback: pin failed the pre-launch check also offers the switch to a newer real version", async () => {
    setProcessLanguage("en");
    const dir = mkdtempSync(join(tmpdir(), "card-pin-guard-"));
    try {
      const status = await guardedPinStatus(dir, new Date("2026-09-01T00:00:00Z"), "2.1.300");
      const logger = { info() {}, error() {} };
      const cli = createCliTransition({ dataDir: dir, logger, running: () => false, onChecked() {}, candidateDeps: () => { throw new Error("no check"); } }).forProvider("claude", status);
      const down = html({ ...base, available: false, reason: status.reason ?? "", version: null, path: null, cli }, {});
      expect(btn(down, "Switch to 2.1.300")).not.toBe("");
      expect(btn(down, "Switch to 2.1.300")).not.toContain("disabled");
      expect(btn(down, "Roll back to 2.1.280")).not.toBe("");
      expect(btn(down, "Roll back to 2.1.280")).not.toContain("disabled");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refusal is shown next to the buttons", () => {
    const h = card(tr({ target: { version: "2.1.300", acceptedAt: "2026-10-15" } }), { cli: { refusal: "Version 2.1.300 is not installed" } });
    expect(h).toContain('<span class="settings-cli__refusal" role="alert">');
    expect(h).toContain("Version 2.1.300 is not installed");
  });

  it("ru: labels", () => {
    const h = card(tr({ due, target: { version: "2.1.300", acceptedAt: "2026-10-15" } }), { cli: { running: true } }, "ru");
    for (const w of ["закрепление Osen", "реальная приёмка", "Перейти на 2.1.300", "Откатить на 2.1.270", "идёт сессия"]) expect(h).toContain(w);
    expect(card(tr({ source: "explicit", level: "interface" }), {}, "ru")).toContain("явный путь");
    expect(card(tr({ source: "explicit", level: "interface" }), {}, "ru")).toContain("только интерфейс");
    expect(card(tr({ level: "none", checkedAt: null }), {}, "ru")).toContain("нет записи");
    expect(card(tr({ pin: { version: "2.1.288", activatedAt: null, ageDays: null, previous: null } }), {}, "ru")).toContain("дата активации неизвестна");
    expect(card(tr({ check: { at: "2026-10-20T14:32:00Z", outcome: "check_failed" } }), {}, "ru")).toContain("Проверка кандидатов не удалась");
  });

  it("day plural forms on en and ru", () => {
    const line = (n: number, lang: "en" | "ru") => card(tr({ due: { ...due, ageDays: n }, target: null }), {}, lang);
    expect(line(1, "en")).toContain("pinned for 1 day.");
    expect(line(2, "en")).toContain("pinned for 2 days.");
    expect(line(5, "en")).toContain("pinned for 5 days.");
    expect(line(1, "ru")).toContain("закреплению 1 день.");
    expect(line(2, "ru")).toContain("закреплению 2 дня.");
    expect(line(5, "ru")).toContain("закреплению 5 дней.");
  });

  it("an HTTP provider and a CLI without data render no transition rows", () => {
    const h = card(null);
    expect(h).not.toContain("Source");
    expect(h).not.toContain("Osen pin");
  });
});
