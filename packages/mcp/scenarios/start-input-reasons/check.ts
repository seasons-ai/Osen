// Live check of council_start refusal reasons (change 113): a real MCP server as a child process over stdio,
// with and without COUNCIL_DEV=1, on en and ru. Participants are scripted only, 0 model calls, no sessions are created.
//   COUNCIL_DEV=1 COUNCIL_HOME=.council-data/start-reasons-<label> node packages/mcp/scenarios/start-input-reasons/check.ts
// Writes only to COUNCIL_HOME (and the neighbouring folder <COUNCIL_HOME>-empty for step 5) and does not delete them.
import "../../../core/scenarios/language-ru.ts";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { configPath, initialRegistry } from "@model-council/core";

if (process.env.COUNCIL_DEV !== "1" || !process.env.COUNCIL_HOME?.trim()) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME are required. Run: COUNCIL_DEV=1 COUNCIL_HOME=.council-data/start-reasons-<label> node packages/mcp/scenarios/start-input-reasons/check.ts");
  process.exit(2);
}
const home = resolve(process.env.COUNCIL_HOME);
const emptyHome = `${home}-empty`;
mkdirSync(home, { recursive: true });
mkdirSync(emptyHome, { recursive: true });
// 1. A registry with providers regardless of the machine; providers are not called. For step 5 — a registry without providers.
writeFileSync(configPath(home), JSON.stringify(initialRegistry(["claude", "codex"]), null, 2));
writeFileSync(configPath(emptyHome), JSON.stringify(initialRegistry([]), null, 2));

const root = join(import.meta.dirname, "../../../..");
const mainTs = join(root, "packages/mcp/src/main.ts");
const sessions = (dir: string) => (existsSync(join(dir, "sessions")) ? readdirSync(join(dir, "sessions")) : []);

type Res = { isError?: boolean; content: { type: string; text: string }[] };
async function server(dataDir: string, lang: "en" | "ru", dev: boolean) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: lang, COUNCIL_HOME: dataDir };
  if (dev) env.COUNCIL_DEV = "1"; // without the mode there is no variable in the child's environment at all
  const transport = new StdioClientTransport({ command: process.execPath, args: [mainTs], cwd: root, stderr: "ignore", env });
  const client = new Client({ name: "start-input-reasons-check", version: "0" });
  await client.connect(transport);
  return {
    start: async (args: Record<string, unknown>) => {
      const r = (await client.callTool({ name: "council_start", arguments: { topic: "т", ...args } })) as Res;
      if (!r.isError) throw new Error(`expected a refusal, got: ${r.content[0]?.text}`);
      return r.content[0]?.text ?? "";
    },
    close: () => client.close(),
  };
}

const sc = (m: string) => ({ providerId: "scripted", model: m });
const two = [sc("consensus/p1.json"), sc("consensus/p2.json")];
const T = {
  en: { got0: "At least 2 participants are required, got 0.", got1: "At least 2 participants are required, got 1.", unknown: "Scenario “нет.json” is unavailable.", dev: "Scripted participants are available only with COUNCIL_DEV=1.", none: /^There are no participants to take: the registry has no providers/ },
  ru: { got0: "Нужно не меньше 2 участников, получено 0.", got1: "Нужно не меньше 2 участников, получено 1.", unknown: "Сценарий «нет.json» недоступен.", dev: "Сценарные участники доступны только при COUNCIL_DEV=1.", none: /^Участников взять неоткуда: в реестре нет провайдеров/ },
} as const;

let failed = 0;
function check(name: string, ok: boolean, got: string) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${ok ? "" : ` — got: ${got}`}`);
  if (!ok) failed++;
}

for (const lang of ["en", "ru"] as const) {
  const t = T[lang];
  const dev = await server(home, lang, true);
  try {
    let got = await dev.start({ participants: [] });
    check(`${lang} 2. participants: [] with providers in the registry — got 0`, got === t.got0 && !/registry has no providers|нет провайдеров/.test(got), got);
    got = await dev.start({ participants: [sc("consensus/p1.json")] });
    check(`${lang} 2. one participant — got 1`, got === t.got1, got);
    got = await dev.start({ participants: [sc("consensus/p1.json"), sc("нет.json")] });
    check(`${lang} 3. unknown scenario with COUNCIL_DEV=1 — the same text as before`, got === t.unknown, got);
  } finally { await dev.close(); }

  const prod = await server(home, lang, false);
  try {
    const got = await prod.start({ participants: two });
    check(`${lang} 4. scripted participants without COUNCIL_DEV — the text names COUNCIL_DEV`, got === t.dev, got);
  } finally { await prod.close(); }
  check(`${lang} 2–4. no sessions in the data folder`, sessions(home).length === 0, sessions(home).join(", "));

  const empty = await server(emptyHome, lang, true);
  try {
    let got = await empty.start({});
    check(`${lang} 5. the registry is empty, participants not set — nothing to take from`, t.none.test(got), got);
    got = await empty.start({ participants: [] });
    check(`${lang} 5. the registry is empty, participants: [] — got 0`, got === t.got0, got);
  } finally { await empty.close(); }
  check(`${lang} 5. no sessions in the empty folder`, sessions(emptyHome).length === 0, sessions(emptyHome).join(", "));
}

console.log(failed === 0 ? "RESULT: all checks passed" : `RESULT: failed ${failed}`);
process.exit(failed === 0 ? 0 : 1);
