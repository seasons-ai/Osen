import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const KEYS = ["cli-pin", "cli-due", "cli-confirm", "cli-error", "cli-path"];

// Requirement: "Состояния перехода CLI в макете" / "CLI transition states in the mockup"
describe("CLI transition states in the mockup", () => {
  const html = read("design/mockup/settings.html");
  const list = /data-variants="([^"]*)"/.exec(html)![1]!.split(";").map((s) => s.split(":")[0]);

  it.each(KEYS)("variant %s is in data-variants and used in the markup", (key) => {
    expect(list).toContain(key);
    expect(html).toMatch(new RegExp(`data-variant="[^"]*\\b${key}\\b[^"]*"`));
  });

  it("README states table lists every variant and points to settings.html#cli-due", () => {
    const readme = read("design/mockup/README.md");
    for (const key of KEYS) expect(readme).toContain(`settings.html#${key}`);
  });

  it("settings.css and inline styles have no box-shadow other than none", () => {
    const inline = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).join(";");
    const css = read("design/mockup/screens/settings.css") + inline;
    for (const m of css.matchAll(/box-shadow\s*:\s*([^;}]*)/g)) expect(m[1]!.trim()).toBe("none");
  });

  it("new variants use no literal colors", () => {
    const own = html.split("\n").filter((l) => KEYS.some((k) => l.includes(`data-variant="${k}`)));
    expect(own.length).toBeGreaterThan(0);
    expect(own.join("\n")).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![^<]*<\/)|rgba?\(|hsla?\(/);
  });
});
