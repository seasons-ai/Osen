import type { StoredSession } from "@model-council/core";
import type { Language } from "@model-council/core/i18n";
import { resultMain } from "../shared/messages/result-main.ts";
import { shell } from "../shared/messages/shell.ts";

export interface ExportDeps {
  read(id: string): StoredSession | null;
  render(session: StoredSession, id: string): string;
  pickPath(defaultName: string): Promise<string | null>; // null — cancelled
  write(path: string, text: string): Promise<void>;
}

export function exportFileName(topic: string, language?: Language): string {
  const name = topic.slice(0, 60).replace(/[/\\:*?"<>|\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return `${name || resultMain(language).fallbackName}.md`;
}

export async function exportSession(id: string, deps: ExportDeps): Promise<{ path: string } | null> {
  const session = deps.read(id);
  if (session === null) throw new Error(shell().sessionNotFound(id));
  const path = await deps.pickPath(exportFileName(session.state.session?.topic ?? ""));
  if (path === null) return null;
  try {
    await deps.write(path, deps.render(session, id));
  } catch (e) {
    throw new Error(resultMain().saveFailed(path, e instanceof Error ? e.message : String(e)));
  }
  return { path };
}
