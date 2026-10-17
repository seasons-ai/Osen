import { PreparedMaterialsError, buildMaterialsPreview, getProcessLanguage, savePreparedMaterials } from "@model-council/core";
import type { Logger } from "@model-council/core";
import type { MaterialsPreviewView } from "../shared/setup.ts";
import { MaterialsDraftError } from "./materials.ts";
import type { MaterialsDraft } from "./materials.ts";
import { setupMain } from "../shared/messages/setup-main.ts";

export class PreviewError extends Error {} // the message is shown to the owner

export interface PreviewDeps {
  dataDir: string;
  logger: Logger;
  materials: Pick<MaterialsDraft, "snapshot" | "refresh" | "view">;
  save?: typeof savePreparedMaterials;
}

// Preview: saves the prepared set and returns the exact texts of the request sections. Creates no sessions, calls no participants.
export function previewMaterials(deps: PreviewDeps, refresh: boolean): MaterialsPreviewView {
  if (refresh) {
    try {
      deps.materials.refresh();
    } catch (e) {
      if (e instanceof MaterialsDraftError) throw new PreviewError(e.message);
      throw e;
    }
  }
  const snap = deps.materials.snapshot();
  if (snap.materials.length === 0 && snap.workspace.length === 0) throw new PreviewError(setupMain().previewEmpty);
  let set;
  try {
    set = (deps.save ?? savePreparedMaterials)(deps.dataDir, snap);
  } catch (e) {
    if (e instanceof PreparedMaterialsError) throw new PreviewError(e.message);
    deps.logger.error("Failed to save the prepared materials set", e);
    throw new PreviewError(setupMain().previewSaveFailed((e as NodeJS.ErrnoException).code ?? setupMain().writeError));
  }
  deps.logger.info(`Materials preview: set ${set.id}, materials ${set.materials.length}, chars ${set.materials.reduce((n, m) => n + m.chars, 0)}, folder files ${set.workspace.length}${refresh ? ", sources re-read" : ""}`);
  return {
    sources: set.sources.map((x) => ({ id: x.id, url: `${x.scheme}://${x.host}${x.pathname}`, fetchedAt: x.fetchedAt })), handle: set.id, stamp: set.stamp, createdAt: set.createdAt,
    ...buildMaterialsPreview({ language: getProcessLanguage(), materials: set.materials, workspace: set.workspace, skipped: set.skipped.filter((x) => x.excludedPath === undefined), left: set.left }),
    materials: deps.materials.view(),
  };
}
