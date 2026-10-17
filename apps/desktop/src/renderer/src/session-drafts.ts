import { useEffect, useRef, useState } from "react";
import type { SessionState } from "@model-council/core/protocol";
import type { DraftView } from "../../shared/bridge.ts";

export interface DraftTexts { byId: ReadonlyMap<string, DraftView>; error: string | null }

const NONE: ReadonlyMap<string, DraftView> = new Map();

/** The bridge response replaces the map entirely; the key is draftId, a repeated write gives no duplicate. */
export function draftMap(views: readonly DraftView[]): ReadonlyMap<string, DraftView> {
  return new Map(views.map((v) => [v.draftId, v]));
}

export const acceptedDrafts = (state: SessionState): number => state.drafts.filter((d) => d.done !== null).length;

/** The bridge is called only for a session with a phase and a known id. */
export const shouldFetchDrafts = (id: string | undefined, state: SessionState): id is string => id !== undefined && !!state.session?.drafts;

export type DraftsGot = { id: string; byId: ReadonlyMap<string, DraftView>; error: string | null } | null;

/** The non-React part of the texts request: request number, cutoff of a stale response, map replacement, error on refusal. */
export function draftsLoader(call: (id: string) => Promise<DraftView[]> | DraftView[], apply: (update: (g: DraftsGot) => DraftsGot) => void) {
  let latest = 0;
  return {
    load(id: string): Promise<void> {
      const n = ++latest;
      return Promise.resolve().then(() => call(id)).then(
        (views) => { if (n === latest) apply(() => ({ id, byId: draftMap(views), error: null })); },
        (e) => { if (n === latest) apply((g) => ({ id, byId: g?.id === id ? g.byId : NONE, error: e instanceof Error ? e.message : String(e) })); },
      );
    },
    cancel(): void { latest++; }, // an id change or unmount invalidates the running request
  };
}

export function useSessionDrafts(id: string | undefined, state: SessionState): DraftTexts {
  const [got, setGot] = useState<DraftsGot>(null);
  const loader = useRef<ReturnType<typeof draftsLoader> | null>(null);
  loader.current ??= draftsLoader((i) => window.council.sessionDrafts(i), (u) => setGot(u));
  const fetch = shouldFetchDrafts(id, state);
  const accepted = acceptedDrafts(state);
  useEffect(() => {
    if (!fetch || id === undefined) return;
    const l = loader.current!;
    void l.load(id);
    return () => l.cancel();
  }, [fetch, id, accepted]);
  if (!fetch || got === null || got.id !== id) return { byId: NONE, error: null };
  return got;
}
