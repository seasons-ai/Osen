import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import type { ClientActionReply, ClientStatusView, CommandStatusView, ConnectionsView } from "../../shared/connections.ts";
import {
  ConnectionsPanel, createConnectionsActions, dialogKey, initialConnections, reduceConnections,
} from "./ConnectionsTab.tsx";
import type { ConnectionsApi, ConnectionsAction, ConnectionsState } from "./ConnectionsTab.tsx";

const srv = { command: "/Applications/Osen.app/Contents/Resources/bin/osen-mcp", args: [] };
const client = (o: { client: string; [k: string]: unknown }): ClientStatusView =>
  ({ state: "not_connected", file: "/h/.claude.json", entryKey: "mcpServers.osen", entry: null, reason: null, ...o }) as ClientStatusView;
const cmd = (o: CommandStatusView = { state: "not_installed", link: "/h/.local/bin/council" }): CommandStatusView => o;
const mk = (clients: ClientStatusView[], command: CommandStatusView = cmd()): ConnectionsView => ({ clients, command, serverCommand: srv });
const three = (): ConnectionsView => mk([
  client({ client: "claude-code", state: "connected", entry: srv }),
  client({ client: "claude-desktop", file: "/h/Library/claude_desktop_config.json" }),
  client({ client: "codex", state: "not_installed", file: "/h/.codex/config.toml", entryKey: "mcp_servers.osen" }),
]);

const loaded = (view: ConnectionsView): ConnectionsState => reduceConnections(initialConnections(), { type: "view", view });
const html = (s: ConnectionsState) => renderToStaticMarkup(<ConnectionsPanel state={s} on={noop} />);
const noop = { ask() {}, cancel() {}, accept() {}, check() {}, dismiss() {}, copy() {} };
// tags are removed until none is left, so no partial tag survives a single pass
const stripTags = (h: string, sep = ""): string => {
  let prev: string;
  do { prev = h; h = h.replace(/<[^>]*>/g, sep); } while (h !== prev);
  return h;
};
const btns = (h: string) => [...h.matchAll(/<button[^>]*>((?:(?!<\/button>).)*)<\/button>/g)].map((m) => stripTags(m[1]!).trim());
const card = (h: string, name: string) => h.split("<article").find((a) => a.includes(`>${name}<`)) ?? "";

function harness(api: Partial<ConnectionsApi>, view: ConnectionsView | null = three()) {
  let state = view === null ? initialConnections() : loaded(view);
  const dispatch = (a: ConnectionsAction) => { state = reduceConnections(state, a); };
  const actions = createConnectionsActions(() => api as ConnectionsApi, { get: () => state, dispatch });
  return { actions, get: () => state };
}
const reply = (result: ClientActionReply["result"], view: ConnectionsView): ClientActionReply => ({ result, view });
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => setProcessLanguage("ru"));

describe("ConnectionsPanel rendering", () => {
  it("three clients: words, command, path, no change buttons for not installed", () => {
    const h = html(loaded(three()));
    const code = card(h, "Claude Code");
    expect(code).toContain("подключён");
    expect(code).toContain("/Applications/Osen.app/Contents/Resources/bin/osen-mcp");
    expect(code).toContain("/h/.claude.json");
    expect(code).toContain("mcpServers.osen");
    expect(btns(code)).toEqual(["Отключить", "Проверить соединение"]);
    expect(code).toContain("без вызовов моделей");
    expect(card(h, "Claude Desktop")).toContain("не подключён");
    expect(btns(card(h, "Claude Desktop"))).toEqual(["Подключить"]);
    expect(card(h, "Claude Desktop")).toContain("JSON");
    const codex = card(h, "Codex CLI и приложение");
    expect(codex).toContain("не установлен");
    expect(codex).toContain("TOML");
    expect(btns(codex)).toEqual([]);
  });

  it("section intro and the not-installed note follow the mockup", () => {
    const h = html(loaded(three()));
    expect(h).toContain("Osen как MCP-сервер в ваших агентах");
    expect(h.match(/Клиент не найден на этом Mac/g)?.length).toBe(three().clients.filter((c) => c.state === "not_installed").length);
  });

  it("order follows the view; unknown id renders raw", () => {
    const h = html(loaded(mk([client({ client: "zed", state: "not_installed" }), client({ client: "codex", state: "not_installed" })])));
    expect(h.indexOf(">zed<")).toBeGreaterThan(-1);
    expect(h.indexOf(">zed<")).toBeLessThan(h.indexOf("Codex CLI"));
  });

  it("foreign, corrupt, undetermined: reason and no change buttons; undetermined differs from not installed", () => {
    const h = html(loaded(mk([
      client({ client: "claude-code", state: "foreign", entry: { command: "/usr/local/bin/other-mcp", args: ["--serve"] } }),
      client({ client: "claude-desktop", state: "corrupt", reason: { code: "parse", detail: "Unexpected token at 14:3" } }),
      client({ client: "codex", state: "corrupt", reason: { code: "unreadable", detail: "EACCES: permission denied" } }),
    ])));
    const foreign = card(h, "Claude Code");
    expect(foreign).toContain("чужая запись");
    expect(foreign).toContain("Запись в файле:");
    expect(foreign).toContain("/usr/local/bin/other-mcp --serve");
    expect(btns(foreign)).toEqual([]);
    const broken = card(h, "Claude Desktop");
    expect(broken).toContain("конфиг повреждён");
    expect(broken).toContain("Unexpected token at 14:3");
    expect(btns(broken)).toEqual([]);
    const unknown = card(h, "Codex CLI и приложение");
    expect(unknown).toContain("не удалось определить состояние");
    expect(unknown).toContain("EACCES: permission denied");
    expect(unknown).not.toContain("не установлен");
    expect(btns(unknown)).toEqual([]);
  });

  it("exception row is undetermined", () => {
    const h = html(loaded(mk([client({ client: "codex", state: "error", reason: { code: "exception", detail: "boom" } })])));
    expect(h).toContain("не удалось определить состояние");
    expect(h).toContain("boom");
  });

  it("confirmation names the client, the file and the entry; it is not shown without a request", () => {
    const s = loaded(three());
    expect(html(s)).not.toContain('role="dialog"');
    const h = html(reduceConnections(s, { type: "ask", confirm: { kind: "connect", id: "claude-desktop" } }));
    expect(h).toContain('role="dialog"');
    expect(h).toContain('aria-modal="true"');
    expect(h).toContain("Подключить Claude Desktop?");
    expect(h).toContain("/h/Library/claude_desktop_config.json");
    expect(h).toContain("mcpServers.osen");
    expect(h).toContain("Отмена");
    expect(h).toContain("Escape закрывает");
    expect(/aria-labelledby="([^"]+)"/.exec(h)?.[1]).toBeTruthy();
  });

  it("command confirmation names the link path", () => {
    const h = html(reduceConnections(loaded(three()), { type: "ask", confirm: { kind: "install" } }));
    expect(h).toContain("Установить команду council?");
    expect(h).toContain("/h/.local/bin/council");
  });

  it("council card states", () => {
    const row = (c: CommandStatusView) => card(html(loaded(mk([], c))), "Команда council в терминале");
    expect(btns(row(cmd()))).toEqual(["Установить"]);
    expect(btns(row({ state: "found", link: "/l", target: "/t" }))).toEqual(["Удалить"]);
    const shadowed = row({ state: "shadowed", link: "/l", target: "/t", shadowedBy: "/opt/homebrew/bin/council" });
    expect(shadowed).toContain("перекрыта");
    expect(shadowed).toContain("Перекрыта");
    expect(shadowed).toContain("/opt/homebrew/bin/council");
    const stale = row({ state: "stale", link: "/l", target: "/old", expected: "/new" });
    expect(stale).toContain("/old");
    expect(stale).toContain("/new");
    expect(btns(stale)).toEqual(["Обновить", "Удалить"]);
    const np = row({ state: "not_in_path", link: "/l", target: "/t", hint: { file: "~/.zprofile", line: 'export PATH="$HOME/.local/bin:$PATH"' } });
    expect(np).toContain("Добавьте в ~/.zprofile строку:");
    expect(np).toContain("export PATH=&quot;$HOME/.local/bin:$PATH&quot;");
    expect(btns(np)).toContain("Скопировать");
    const foreign = row({ state: "foreign", link: "/l", foreignKind: "file" });
    expect(foreign).toContain("занята чужим");
    expect(btns(foreign)).toEqual([]);
    const failed = row({ state: "check_failed", link: "/l", target: "/t", reason: "shell did not answer" });
    expect(failed).toContain("не удалось определить состояние");
    expect(failed).toContain("shell did not answer");
    expect(btns(failed)).toEqual([]);
  });

  it("copied marker after copy", () => {
    const np: CommandStatusView = { state: "not_in_path", link: "/l", target: "/t", hint: { file: "~/.zprofile", line: "x" } };
    expect(html(reduceConnections(loaded(mk([], np)), { type: "copied" }))).toContain("Скопировано");
  });

  it("en interface has no Cyrillic in the tab", () => {
    setProcessLanguage("en");
    const s = reduceConnections(
      reduceConnections(loaded(mk([
        client({ client: "claude-code", state: "connected", entry: srv }),
        client({ client: "codex", state: "corrupt", reason: { code: "parse", detail: "bad" } }),
      ], { state: "not_in_path", link: "/l", target: "/t", hint: { file: "~/.zprofile", line: "x" } })), { type: "ask", confirm: { kind: "disconnect", id: "claude-code" } }),
      { type: "copied" },
    );
    const text = stripTags(html(s), " ");
    expect(text).toContain("Check connection");
    expect(text).toContain("Disconnect Claude Code?");
    expect(text).not.toMatch(/[А-Яа-яЁё]/);
  });
});

describe("Connections actions", () => {
  it("Cancel and Escape make no bridge call", () => {
    const api = { connectClient: vi.fn(), checkClient: vi.fn() };
    const h = harness(api);
    h.actions.ask({ kind: "connect", id: "claude-desktop" });
    expect(h.get().confirm).not.toBeNull();
    h.actions.cancel();
    expect(h.get().confirm).toBeNull();
    h.actions.ask({ kind: "connect", id: "claude-desktop" });
    const cancel = vi.fn();
    const e = { key: "Escape", preventDefault: vi.fn() };
    dialogKey(e, cancel);
    expect(cancel).toHaveBeenCalledOnce();
    dialogKey({ key: "Enter", preventDefault: vi.fn() }, cancel);
    expect(cancel).toHaveBeenCalledOnce();
    expect(api.connectClient).not.toHaveBeenCalled();
  });

  it("confirm calls connectClient with the id only and shows the new state", async () => {
    const after = mk([client({ client: "claude-desktop", state: "connected", entry: srv })]);
    const connectClient = vi.fn(async () => reply({ ok: true, client: "claude-desktop", file: "f", changed: true, state: "connected", need: "none" }, after));
    const h = harness({ connectClient }, mk([client({ client: "claude-desktop" })]));
    h.actions.ask({ kind: "connect", id: "claude-desktop" });
    h.actions.accept();
    expect(h.get().busy["claude-desktop"]).toBe(true);
    expect(html(h.get())).toContain("disabled");
    await flush();
    expect(connectClient.mock.calls).toEqual([["claude-desktop"]]);
    expect(h.get().confirm).toBeNull();
    expect(h.get().busy["claude-desktop"]).toBeUndefined();
    expect(html(h.get())).toContain("подключён");
  });

  it("refusal shows the new state and the refusal text", async () => {
    const after = mk([client({ client: "claude-desktop", state: "foreign", entry: { command: "/x", args: [] } })]);
    const connectClient = vi.fn(async () => reply({ ok: false, client: "claude-desktop", file: "f", refusal: "foreign", state: "foreign" }, after));
    const h = harness({ connectClient }, mk([client({ client: "claude-desktop" })]));
    h.actions.ask({ kind: "connect", id: "claude-desktop" });
    h.actions.accept();
    await flush();
    const out = html(h.get());
    expect(out).toContain("чужая запись");
    expect(out).toContain("запись принадлежит не Osen");
    expect(out).toContain('role="alert"');
  });

  it("thrown bridge error is shown in the row", async () => {
    const connectClient = vi.fn(async () => { throw new Error("bridge down"); });
    const h = harness({ connectClient }, mk([client({ client: "claude-desktop" })]));
    h.actions.ask({ kind: "connect", id: "claude-desktop" });
    h.actions.accept();
    await flush();
    expect(html(h.get())).toContain("bridge down");
    expect(h.get().busy["claude-desktop"]).toBeUndefined();
  });

  it("restart note is removed by Got it; note comes from need, not from the client", async () => {
    const after = mk([client({ client: "somebody-new", state: "connected", entry: srv })]);
    const connectClient = vi.fn(async () => reply({ ok: true, client: "somebody-new" as never, file: "f", changed: true, state: "connected", need: "restart_client" }, after));
    const h = harness({ connectClient }, mk([client({ client: "somebody-new" })]));
    h.actions.ask({ kind: "connect", id: "somebody-new" });
    h.actions.accept();
    await flush();
    const out = html(h.get());
    expect(out).toContain("Перезапустите клиент");
    expect(btns(out)).toContain("Понятно");
    h.actions.dismiss("somebody-new");
    expect(html(h.get())).not.toContain("Перезапустите клиент");
  });

  it("disconnect shows no step note even when the module reports one", async () => {
    const after = mk([client({ client: "claude-desktop", state: "not_connected" })]);
    const disconnectClient = async () => reply({ ok: true, client: "claude-desktop", file: "f", changed: true, state: "not_connected", need: "restart_client" }, after);
    const h = harness({ disconnectClient }, mk([client({ client: "claude-desktop", state: "connected", entry: srv })]));
    h.actions.ask({ kind: "disconnect", id: "claude-desktop" });
    h.actions.accept();
    await flush();
    expect(html(h.get())).not.toContain("Перезапустите клиент");
  });

  it("unchanged result has no note; need none shows done", async () => {
    const after = three();
    const base = { ok: true as const, client: "claude-code" as const, file: "f", state: "connected" as const };
    const a = harness({ connectClient: async () => reply({ ...base, changed: false, need: "restart_client" }, after) });
    a.actions.ask({ kind: "connect", id: "claude-code" }); a.actions.accept(); await flush();
    expect(html(a.get())).not.toContain("Перезапустите");
    const b = harness({ connectClient: async () => reply({ ...base, changed: true, need: "none" }, after) });
    b.actions.ask({ kind: "connect", id: "claude-code" }); b.actions.accept(); await flush();
    expect(html(b.get())).toContain("Готово, в клиенте ничего делать не нужно");
  });

  it("check shows the tool count from the result and needs no confirmation", async () => {
    const checkClient = vi.fn(async () => ({ ok: true as const, tools: ["a", "b", "c"], durationMs: 412 }));
    const h = harness({ checkClient });
    h.actions.check("claude-code");
    await flush();
    expect(checkClient.mock.calls).toEqual([["claude-code"]]);
    expect(h.get().confirm).toBeNull();
    expect(html(h.get())).toContain("3 инструмента · 412 мс");
    const f = harness({ checkClient: async () => ({ ok: false as const, reason: "timeout" as const, detail: "5000 ms", durationMs: 5000 }) });
    f.actions.check("claude-code");
    await flush();
    expect(html(f.get())).toContain("таймаут: 5000 ms");
  });

  it("install refusal shows the message; copy calls copyZprofileLine without args", async () => {
    const installCommand = vi.fn(async () => ({
      result: { ok: false as const, code: "foreign" as const, path: "/l", message: "/l is a file; left untouched." },
      view: mk([], cmd({ state: "foreign", link: "/l", foreignKind: "file" })),
    }));
    const h = harness({ installCommand }, mk([], cmd()));
    h.actions.ask({ kind: "install" });
    h.actions.accept();
    await flush();
    expect(installCommand).toHaveBeenCalledWith();
    expect(html(h.get())).toContain("/l is a file; left untouched.");
  });

  it("copy calls copyZprofileLine without args and then shows Copied", async () => {
    const copyZprofileLine = vi.fn(async () => {});
    const np: CommandStatusView = { state: "not_in_path", link: "/l", target: "/t", hint: { file: "~/.zprofile", line: "x" } };
    const h = harness({ copyZprofileLine }, mk([], np));
    h.actions.copy();
    await flush();
    expect(copyZprofileLine.mock.calls).toEqual([[]]);
    expect(html(h.get())).toContain("Скопировано");
  });

  it("load reads the module once and keeps the error out of providers", async () => {
    const connections = vi.fn(async () => three());
    const h = harness({ connections });
    await h.actions.load();
    expect(connections).toHaveBeenCalledOnce();
    const f = harness({ connections: async () => { throw new Error("no module"); } }, null);
    await f.actions.load();
    expect(html(f.get())).toContain("no module");
  });
});
