import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { findCyrillicLiterals, ROOT, walk } from "./ast-scan.testutil.ts";

// Files fully excluded from the check (paths from packages/core/src).
const SKIP_FILES: Record<string, string> = {
  "i18n/language.ts": "названия языков не переводятся",
  "pdf/fixture.ts": "тестовые данные",
  "http/fake-server.ts": "имитация ответов модели",
  "store/log.ts": "строки логов",
};
// Folders excluded from the check.
const SKIP_DIRS: Record<string, string> = {
  "messages/": "каталоги сообщений: значения ru",
  "pdf/testdata/": "тестовые данные",
};
describe("Core messages in the selected language: completeness", () => {
  it("the search finds a literal in code and does not find it in comments and logs", () => {
    const sample = `
      // комментарий по-русски
      const a = 1; // хвостовой комментарий
      /* блочный комментарий */
      logger.info("запись лога");
      log.error("запись лога", a);
      x.logger?.warn(\`лог \${a}\`);
      const bad = "Сообщение";
      const bad2 = \`Шаблон \${a}\`;
    `;
    const hits = findCyrillicLiterals("cli-agents/args.ts", sample);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toContain(":8:");
    expect(hits[1]).toContain(":9:");
  });

  it("no Cyrillic literals in packages/core/src outside the exclusion list", () => {
    const base = join(ROOT, "packages/core/src");
    const hits: string[] = [];
    for (const file of walk(base)) {
      const rel = relative(base, file);
      if (rel in SKIP_FILES || Object.keys(SKIP_DIRS).some((d) => rel.startsWith(d))) continue;
      hits.push(...findCyrillicLiterals(rel, readFileSync(file, "utf8")));
    }
    expect(hits).toEqual([]);
  });
});

// App 'Settings' screen files (change 57): labels come from apps/desktop/src/shared/messages/settings.ts.
const SETTINGS_SCREEN = [
  "renderer/src/Settings.tsx", "renderer/src/ProviderCard.tsx", "renderer/src/ProviderForm.tsx",
  "renderer/src/ProviderModels.tsx", "renderer/src/ProviderTest.tsx", "renderer/src/DefaultsPanel.tsx",
  "main/settings.ts", "shared/settings.ts",
];

describe("'Settings' screen in the selected language: no Russian labels", () => {
  it("no Cyrillic literals in screen files outside logger calls", () => {
    const base = join(ROOT, "apps/desktop/src");
    expect(SETTINGS_SCREEN.flatMap((rel) => findCyrillicLiterals(rel, readFileSync(join(base, rel), "utf8")))).toEqual([]);
  });
});

// Files of the 'Discussion' screen, shared session elements and notifications (change 58): labels come from
// apps/desktop/src/shared/messages/session*.ts and notify.ts. Scenario 'Default language'.
const SESSION_SCREEN = [
  "renderer/src/Feed.tsx", "renderer/src/Discussion.tsx", "renderer/src/Participants.tsx", "renderer/src/SolutionPanel.tsx",
  "renderer/src/WaitPanel.tsx", "renderer/src/OwnerComposer.tsx", "renderer/src/SessionScreen.tsx",
  "renderer/src/session-ui.tsx", "renderer/src/StatusBadge.tsx", "shared/timeline.ts",
  "main/finish-notify.ts", "main/attention-notify.ts",
];

describe("'Discussion' screen in the selected language: no Russian labels", () => {
  it("no Cyrillic literals in screen, shared element and notification files outside logger calls", () => {
    const base = join(ROOT, "apps/desktop/src");
    expect(SESSION_SCREEN.flatMap((rel) => findCyrillicLiterals(rel, readFileSync(join(base, rel), "utf8")))).toEqual([]);
  });
});

// Session setup screen files (change 59): labels and refusals come from apps/desktop/src/shared/messages/
// setup.ts, session-setup.ts, new-discussion.ts, template-editor.ts, launch.ts and setup-main.ts.
const SETUP_SCREENS = [
  "renderer/src/NewDiscussion.tsx", "renderer/src/NewFlow.tsx", "renderer/src/SessionSetup.tsx", "renderer/src/setup.ts",
  "renderer/src/gallery.ts", "renderer/src/TemplateEditor.tsx", "renderer/src/TemplateEditorScreen.tsx", "renderer/src/template-editor.ts",
  "shared/setup.ts", "main/launcher.ts", "main/materials.ts", "main/materials-preview.ts", "main/lineups.ts",
  "main/setup-data.ts", "main/template-editor.ts", "main/rerun.ts",
];

describe("'New discussion', 'Session setup' and 'Template editor' screens in the selected language: no Russian labels", () => {
  it("no Cyrillic literals in screen files and their main refusals outside logger calls", () => {
    const base = join(ROOT, "apps/desktop/src");
    expect(SETUP_SCREENS.flatMap((rel) => findCyrillicLiterals(rel, readFileSync(join(base, rel), "utf8")))).toEqual([]);
  });
});

// Files of the 'Result' screen, the continuation panel and Markdown export (change 60): labels come from
// apps/desktop/src/shared/messages/result.ts and result-main.ts.
const RESULT_SCREEN = ["renderer/src/Result.tsx", "main/resume.ts", "main/markdown.ts", "main/export.ts"];

describe("'Result' screen in the selected language: no Russian labels", () => {
  it("no Cyrillic literals in screen, continuation panel and export files outside logger calls", () => {
    const base = join(ROOT, "apps/desktop/src");
    expect(RESULT_SCREEN.flatMap((rel) => findCyrillicLiterals(rel, readFileSync(join(base, rel), "utf8")))).toEqual([]);
  });
});

// Files of the 'History' screen and the 'Usage' block (change 61): labels come from apps/desktop/src/shared/messages/history.ts and usage.ts.
const HISTORY_SCREEN = ["renderer/src/History.tsx", "renderer/src/UsagePanel.tsx", "renderer/src/usage-summary.ts", "main/pins.ts"];

describe("'History' screen in the selected language: no Russian labels", () => {
  it("no Cyrillic literals in screen, 'Usage' block and pin files outside logger calls", () => {
    const base = join(ROOT, "apps/desktop/src");
    expect(HISTORY_SCREEN.flatMap((rel) => findCyrillicLiterals(rel, readFileSync(join(base, rel), "utf8")))).toEqual([]);
  });
});
