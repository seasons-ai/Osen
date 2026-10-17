import { currentVersion } from "@model-council/core/protocol";
import type { SessionState, SolutionVersion } from "@model-council/core/protocol";

// The final version shown by "Result": from the finish event, otherwise the last one.
export function finalVersion(state: SessionState): SolutionVersion | null {
  const n = state.finish?.version ?? null;
  return (n !== null ? state.versions.find((v) => v.number === n) : undefined) ?? currentVersion(state);
}

// The version chosen by the owner; null — no choice or no such version in the state.
export function chosenVersion(state: SessionState): SolutionVersion | null {
  const sel = state.ownerSelection;
  return sel === null ? null : state.versions.find((v) => v.number === sel.version) ?? null;
}
