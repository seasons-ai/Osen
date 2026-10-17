import type { TemplateRemoveMode } from "../../shared/setup.ts";

export interface GalleryState {
  confirming: { id: string; mode: TemplateRemoveMode } | null;
  removing: boolean;
  failure: { id: string | null; message: string } | null;
}

export type GalleryAction =
  | { type: "ask"; id: string; mode: TemplateRemoveMode }
  | { type: "cancel" }
  | { type: "removing" }
  | { type: "removed" }
  | { type: "failed"; id: string | null; message: string }
  | { type: "dismiss" };

export const initialGallery: GalleryState = { confirming: null, removing: false, failure: null };

export function reduceGallery(state: GalleryState, a: GalleryAction): GalleryState {
  switch (a.type) {
    case "ask": return { ...state, confirming: { id: a.id, mode: a.mode }, failure: null };
    case "cancel": return state.removing ? state : { ...state, confirming: null };
    case "removing": return { ...state, removing: true };
    case "removed": return { ...state, confirming: null, removing: false };
    case "failed": return { confirming: null, removing: false, failure: { id: a.id, message: a.message } };
    case "dismiss": return { ...state, failure: null };
  }
}
