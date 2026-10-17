import { getProcessLanguage } from "@model-council/core/i18n";
import { TemplateStoreError, builtinTemplateIds, createUserTemplate, deleteUserTemplate, loadTemplates, saveUserTemplate, takenTemplateIds } from "@model-council/core";
import type { LoadedTemplate, Logger, TemplateDirs } from "@model-council/core";
import type { TemplateDraft, TemplateEditorData, TemplateSaveResult } from "../shared/setup.ts";
import { setupMain } from "../shared/messages/setup-main.ts";

export interface TemplateEditorApi {
  open(request: unknown): TemplateEditorData;
  create(draft: unknown): TemplateSaveResult;
  save(id: unknown, draft: unknown): TemplateSaveResult;
  remove(id: unknown, mode: unknown): void;
}

const notFound = (id: string) => new Error(setupMain().templateNotFound(id));
const bad = (what: string) => new Error(setupMain().editorBadRequest(what));

const draftOf = (t: LoadedTemplate): TemplateDraft => {
  const limits: TemplateDraft["limits"] = {};
  if (t.limits.maxRounds !== undefined) limits.maxRounds = t.limits.maxRounds;
  if (t.limits.turnTimeoutSec !== undefined) limits.turnTimeoutSec = t.limits.turnTimeoutSec;
  if (t.limits.contextChars !== undefined) limits.contextChars = t.limits.contextChars;
  return { title: t.title, category: t.category, description: t.description, exampleTopic: t.exampleTopic, framing: t.framing, roles: [...t.roles], limits };
};
const emptyDraft = (): TemplateDraft => ({ title: "", category: "", description: "", exampleTopic: "", framing: "", roles: [], limits: {} });

export function createTemplateEditor(deps: { dirs(): TemplateDirs; logger: Logger; sessionFraming(sessionId: string): string | null }): TemplateEditorApi {
  const { logger } = deps;
  // the identifier is looked up only among loaded templates: a path or ".." matches nothing, files outside the folders are not read
  const find = (templates: LoadedTemplate[], id: unknown): LoadedTemplate => {
    const t = typeof id === "string" ? templates.find((x) => x.id === id) : undefined;
    if (!t) throw notFound(typeof id === "string" ? id : "");
    return t;
  };
  const failure = (e: unknown, id: string | null): TemplateSaveResult => {
    if (!(e instanceof TemplateStoreError)) throw e;
    logger.error(`Template ${id ?? "(new)"} not written: ${e.code}`);
    return { ok: false, error: e.message, issues: e.issues.map((i) => ({ path: i.path, message: i.message })) };
  };

  return {
    open(request) {
      if (typeof request !== "object" || request === null || Array.isArray(request)) throw bad(setupMain().editorReqObject);
      const r = request as Record<string, unknown>;
      const dirs = deps.dirs();
      const catalog = loadTemplates(dirs);
      const base = {
        categories: [...new Set(catalog.templates.map((t) => t.category))].sort((a, b) => a.localeCompare(b, getProcessLanguage())),
        takenIds: [...takenTemplateIds(dirs)].sort(),
      };
      switch (r["mode"]) {
        case "new":
          return { id: null, origin: "new", draft: { ...emptyDraft(), framing: catalog.neutralFraming }, ...base };
        case "edit": {
          const t = find(catalog.templates, r["id"]);
          const origin = t.source === "builtin" ? "builtin" : builtinTemplateIds(dirs).has(t.id) ? "modified" : "user";
          return { id: t.id, origin, draft: draftOf(t), ...base };
        }
        case "duplicate": {
          const d = draftOf(find(catalog.templates, r["id"]));
          return { id: null, origin: "new", draft: { ...d, title: `${d.title} ${setupMain().copySuffix}` }, ...base };
        }
        case "snapshot": {
          const t = r["templateId"] === null ? null : find(catalog.templates, r["templateId"]);
          const from = r["framingFrom"];
          let framing = t ? t.framing : catalog.neutralFraming;
          if (from !== undefined) {
            if (typeof from !== "string") throw bad(setupMain().editorFramingFromString);
            const sessionFraming = deps.sessionFraming(from);
            if (sessionFraming === null) throw new Error(setupMain().framingSessionNotFound(from));
            framing = sessionFraming;
          }
          return { id: null, origin: "new", draft: { ...emptyDraft(), framing, category: t ? t.category : "" }, ...base };
        }
        default:
          throw bad(setupMain().editorUnknownMode);
      }
    },

    create(draft) {
      try {
        const t = createUserTemplate(deps.dirs(), draft);
        logger.info(`Template ${t.id} created`);
        return { ok: true, id: t.id };
      } catch (e) {
        return failure(e, null);
      }
    },

    save(id, draft) {
      const dirs = deps.dirs();
      if (typeof id !== "string" || !loadTemplates(dirs).templates.some((t) => t.id === id)) {
        return { ok: false, error: setupMain().templateNotFound(typeof id === "string" ? id : ""), issues: [] };
      }
      try {
        saveUserTemplate(dirs, id, draft);
        logger.info(`Template ${id} saved`);
        return { ok: true, id };
      } catch (e) {
        return failure(e, id);
      }
    },

    remove(id, mode) {
      if (mode !== "delete" && mode !== "reset") throw bad(setupMain().editorModeDeleteReset);
      const dirs = deps.dirs();
      const t = find(loadTemplates(dirs).templates, id);
      const overrides = t.source === "user" && builtinTemplateIds(dirs).has(t.id);
      if (t.source === "builtin") throw new Error(setupMain().builtinNoDelete);
      if (mode === "reset" && !overrides) throw new Error(setupMain().resetOnlyModified);
      try {
        deleteUserTemplate(dirs, t.id);
      } catch (e) {
        if (e instanceof TemplateStoreError) logger.error(`Template ${t.id} not removed: ${e.code}`);
        throw e instanceof TemplateStoreError ? new Error(e.message) : e;
      }
      logger.info(mode === "reset" ? `Template ${t.id} reset to the built-in one` : `Template ${t.id} removed`);
    },
  };
}
