import { applyEvent, initialState } from "@model-council/core/protocol";
import type { SessionState } from "@model-council/core/protocol";
import type { StoredStatus } from "@model-council/core";
import type { RerunView } from "../../shared/setup.ts";
import type { BridgeEvent, HistoryItem, LiveText } from "../../shared/bridge.ts";
import type { WaitExpiry } from "../../shared/timeline.ts";

export type Section = "new" | "history" | "settings";

export interface HistoryFilter { query: string; status: "all" | StoredStatus }

/** from/to — dates entered in "Range" mode, YYYY-MM-DD or "". */
export interface UsagePeriod { mode: "today" | "month" | "range"; from: string; to: string }

export interface PendingOwner { requestId: string; text: string; answerTo: string | null }

export interface UiState {
  section: Section;
  sessions: HistoryItem[] | null;
  historyFilter: HistoryFilter; // lives only in memory: reset by an app restart
  usagePeriod: UsagePeriod; // only in window memory; survives the list auto-refresh and leaving the screen
  openId: string | null;
  session: SessionState;
  expiredWaits: WaitExpiry[];
  live: LiveText | null; // streamed text of the turn being prepared
  errors: { id: number; message: string }[];
  resultRequest: number; // counter of requests to show "Result": changes the session screen key
  // ponytail: the list lives only in window memory: after an app restart a sent but not yet applied message
  // is not shown in the feed as pending (it stays in the session queue and will be applied); store on disk if this starts to hurt.
  rerun: RerunView | null; // data of the past session for "Session setup"; lives while the setup is alive (moving to "New" and "Settings"), reset by other navigation
  setupKept: boolean; // "setup is alive": NewFlow stays mounted when leaving for "Settings"; reset by history, open, started
  pendingOwner: Record<string, PendingOwner[]>; // pending owner messages by session id, in send order
}

export type UiAction =
  | { type: "navigate"; section: Section }
  | { type: "open"; id: string }
  | { type: "started"; id: string }
  | { type: "rerun"; view: RerunView }
  | { type: "owner-sent"; id: string; requestId: string; text: string; answerTo: string | null }
  | { type: "sessions"; sessions: HistoryItem[] }
  | { type: "history-filter"; filter: HistoryFilter }
  | { type: "usage-period"; period: UsagePeriod }
  | { type: "bridge"; event: BridgeEvent }
  | { type: "error"; message: string }
  | { type: "dismiss"; id: number };

export function initialUi(): UiState {
  return { section: "history", sessions: null, historyFilter: { query: "", status: "all" }, usagePeriod: { mode: "today", from: "", to: "" }, openId: null, session: initialState(), expiredWaits: [], live: null, errors: [], resultRequest: 0, rerun: null, setupKept: false, pendingOwner: {} };
}

const NO_PENDING: PendingOwner[] = [];
export function pendingFor(state: UiState, id: string | null): PendingOwner[] {
  return (id !== null && state.pendingOwner[id]) || NO_PENDING;
}

function withPending(state: UiState, id: string, list: PendingOwner[]): UiState {
  const { [id]: _old, ...rest } = state.pendingOwner;
  return { ...state, pendingOwner: list.length > 0 ? { ...rest, [id]: list } : rest };
}

export function reduce(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "navigate":
      return {
        ...state, section: action.section, openId: null, expiredWaits: [], live: null,
        ...(action.section === "history" ? { rerun: null, setupKept: false } : action.section === "new" ? { setupKept: true } : {}),
      };
    case "rerun":
      return { ...state, section: "new", openId: null, live: null, rerun: action.view, setupKept: true };
    case "open":
      return { ...state, openId: action.id, session: initialState(), expiredWaits: [], live: null, rerun: null, setupKept: false };
    case "started":
      return { ...state, section: "history", openId: action.id, session: initialState(), expiredWaits: [], live: null, rerun: null, setupKept: false };
    case "owner-sent": {
      const list = state.pendingOwner[action.id] ?? [];
      if (list.some((p) => p.requestId === action.requestId)) return state;
      return withPending(state, action.id, [...list, { requestId: action.requestId, text: action.text, answerTo: action.answerTo }]);
    }
    case "sessions":
      return { ...state, sessions: action.sessions };
    case "history-filter":
      return { ...state, historyFilter: action.filter };
    case "usage-period":
      return { ...state, usagePeriod: action.period };
    case "error": {
      if (state.errors[state.errors.length - 1]?.message === action.message) return state;
      const id = (state.errors[state.errors.length - 1]?.id ?? 0) + 1;
      return { ...state, errors: [...state.errors, { id, message: action.message }] };
    }
    case "dismiss":
      return { ...state, errors: state.errors.filter((e) => e.id !== action.id) };
    case "bridge": {
      const e = action.event;
      if (e.type === "sessions") return reduce(state, { type: "sessions", sessions: e.sessions });
      if (e.type === "error") return reduce(state, { type: "error", message: e.message });
      if (e.type === "appearance") return state; // the theme is applied on <html> by theme.ts, it does not affect screen state
      if (e.type === "language") return state; // the language is applied by LanguageProvider, it does not affect screen state
      if (e.type === "turn-text") {
        if (e.id !== state.openId) return state;
        if (e.offset === 0) return { ...state, live: { turn: e.turn, attempt: e.attempt, text: e.text } };
        const l = state.live;
        if (!l || l.turn !== e.turn || l.attempt !== e.attempt || l.text.length !== e.offset) return state;
        return { ...state, live: { ...l, text: l.text + e.text } };
      }
      if (e.type === "open-result") {
        const resultRequest = state.resultRequest + 1;
        if (e.id === state.openId) return { ...state, section: "history", resultRequest, rerun: null, setupKept: false };
        return { ...state, section: "history", openId: e.id, session: initialState(), expiredWaits: [], live: null, resultRequest, rerun: null, setupKept: false };
      }
      if (e.type === "open-session") {
        if (e.id === state.openId) return { ...state, section: "history", rerun: null, setupKept: false };
        return reduce({ ...state, section: "history" }, { type: "open", id: e.id });
      }
      if (e.id !== state.openId || e.event.seq <= state.session.lastSeq) return state;
      const next = { ...state, session: applyEvent(state.session, e.event) };
      const ev = e.event;
      if (ev.type === "owner_wait_finished" && ev.reason === "expired") {
        const waiting = state.session.waiting;
        const afterTurn = waiting?.waitId === ev.waitId ? waiting.afterTurn : state.session.lastStarted?.turn ?? 0;
        return { ...next, expiredWaits: [...state.expiredWaits, { waitId: ev.waitId, afterTurn, at: ev.ts }] };
      }
      if (ev.type === "owner_message") return withPending(next, e.id, pendingFor(next, e.id).filter((p) => p.requestId !== ev.requestId));
      if (ev.type === "session_finished") return withPending(next, e.id, []);
      return next;
    }
  }
}
