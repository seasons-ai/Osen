import { describe, expect, it } from "vitest";
import type { ActionResult, ClientStatusView, CommandStatusView } from "../../shared/connections.ts";
import { settings } from "../../shared/messages/settings.ts";
import { clientRow, commandRow, stepNote } from "./connections-model.ts";

const base = { client: "codex" as const, file: "/h/.codex/config.toml", entryKey: "mcp_servers.osen", entry: null };
const client = (state: ClientStatusView["state"], code?: string): ClientStatusView =>
  state === "error"
    ? { ...base, state, reason: { code: "exception", detail: "boom" } }
    : ({ ...base, state, reason: code ? { code, detail: "d" } : null } as ClientStatusView);

describe("clientRow", () => {
  it.each([
    ["not_installed", "not_installed", []],
    ["not_connected", "not_connected", ["connect"]],
    ["connected", "connected", ["disconnect", "check"]],
    ["stale_path", "stale_path", ["update", "disconnect", "check"]],
    ["foreign", "foreign", []],
  ] as const)("%s", (state, kind, buttons) => {
    expect(clientRow(client(state))).toEqual({ kind, buttons });
  });

  it("corrupt with parse or shape stays corrupt, no buttons", () => {
    for (const code of ["parse", "shape"]) expect(clientRow(client("corrupt", code))).toEqual({ kind: "corrupt", buttons: [] });
  });

  it("corrupt with unreadable, cli, codex_unclear or no reason is undetermined", () => {
    for (const code of ["unreadable", "cli", "codex_unclear", undefined]) {
      expect(clientRow(client("corrupt", code))).toEqual({ kind: "undetermined", buttons: [] });
    }
  });

  it("module exception is undetermined", () => {
    expect(clientRow(client("error"))).toEqual({ kind: "undetermined", buttons: [] });
  });
});

describe("commandRow", () => {
  const c = (state: string): CommandStatusView => ({ state, link: "/l", target: "/t" }) as unknown as CommandStatusView;
  it.each([
    ["not_installed", "not_installed", ["install"]],
    ["found", "found", ["remove"]],
    ["not_in_path", "not_in_path", ["remove", "copy"]],
    ["shadowed", "shadowed", ["remove"]],
    ["stale", "stale", ["update", "remove"]],
    ["foreign", "foreign", []],
    ["check_failed", "undetermined", []],
    ["error", "undetermined", []],
  ])("%s", (state, kind, buttons) => {
    expect(commandRow(c(state))).toEqual({ kind, buttons });
  });
});

describe("stepNote", () => {
  const ok = (client: string, need: string, changed = true) => ({ ok: true, client, file: "f", changed, state: "connected", need }) as unknown as ActionResult;
  it("takes the note from need only", () => {
    expect(stepNote(ok("some-future-client", "restart_client"))).toBe("restart_client");
    expect(stepNote(ok("claude-desktop", "none"))).toBe("done");
    expect(stepNote(ok("codex", "confirm_in_client"))).toBe("confirm_in_client");
    expect(stepNote(ok("codex", "unverified"))).toBe("unverified");
  });
  it("no note when nothing changed or on refusal", () => {
    expect(stepNote(ok("codex", "restart_client", false))).toBeNull();
    expect(stepNote({ ok: false, client: "codex", file: "f", refusal: "foreign", state: "foreign" })).toBeNull();
  });
});

describe("connections catalog texts", () => {
  const en = settings("en");
  const ru = settings("ru");
  const keys = Object.keys(en).filter((k) => k.startsWith("conn") || k === "tabConnections");

  it("new keys exist in both languages (key parity itself is enforced by defineMessages types)", () => {
    expect(keys.length).toBeGreaterThan(40);
    for (const k of keys) expect(k in ru).toBe(true);
  });

  it("en texts contain no Cyrillic", () => {
    for (const k of keys) {
      const v = (en as Record<string, unknown>)[k];
      const text = typeof v === "function" ? (v as (...a: unknown[]) => string)("x", "y", "z", 7, 412) : String(v);
      expect(text, k).not.toMatch(/[Ѐ-ӿ]/);
    }
  });

  it("client names fall back to the raw id", () => {
    expect(en.connClientName("codex")).toBe("Codex CLI and app");
    expect(ru.connClientName("codex")).toBe("Codex CLI и приложение");
    expect(en.connClientName("future")).toBe("future");
  });

  it("check result uses Russian plural", () => {
    expect(ru.connCheckOk(7, 412)).toBe("7 инструментов · 412 мс");
    expect(ru.connCheckOk(1, 5)).toBe("1 инструмент · 5 мс");
    expect(ru.connCheckOk(2, 5)).toBe("2 инструмента · 5 мс");
  });

  it("check failure and refusal texts cover every code", () => {
    for (const code of ["no_entry", "spawn_failed", "timeout", "missing_tools", "stray_stdout"]) {
      expect(en.connCheckFailed(code, "d")).toContain("d");
      expect(en.connCheckFailed(code, "d")).not.toBe(en.connCheckFailed("zzz", "d"));
    }
    for (const r of ["not_installed", "not_connected", "foreign", "stale_path", "corrupt", "failed", "no_server_command"]) {
      expect(en.connRefusal(r)).not.toBe(en.connRefusal("zzz"));
    }
    expect(ru.connCheckFailed("timeout", "d")).toBe("таймаут: d");
  });
});
