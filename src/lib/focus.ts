import { appState } from "./store.svelte";
import { compare } from "./compare";

/**
 * Enter Focus mode (§13.3 #15-19) on `repoIdx`. While focused, only that
 * repo's group is rendered in the file picker and compare() fetches only
 * its files. Calling this is effectively a UI filter + a fetch scope
 * change — the in-flight files for other repos are cleared on the
 * subsequent compare.
 *
 * Idempotent: focusing on the same repo twice is a no-op (avoids a
 * redundant re-fetch).
 *
 * When `repoIdx` is out of bounds this falls through silently so the
 * caller (e.g. a drill-in helper carrying a stale idx) doesn't need to
 * pre-validate.
 */
export function enterFocus(repoIdx: number): void {
  if (repoIdx < 0 || repoIdx >= appState.repos.length) return;
  if (appState.activeRepoIdx === repoIdx) return;
  appState.activeRepoIdx = repoIdx;
  // Refetch with the narrower scope. Selection will drop because compare()
  // clears appState.files at start.
  if (appState.repoPath) void compare({ silent: true });
}

/**
 * Exit Focus mode. Restores the multi-root view by setting `activeRepoIdx`
 * back to null and re-running compare to repopulate the other repos' files.
 * No-op when already unfocused.
 */
export function exitFocus(): void {
  if (appState.activeRepoIdx === null) return;
  appState.activeRepoIdx = null;
  if (appState.repoPath) void compare({ silent: true });
}

/**
 * Toggle Focus on `repoIdx`. If currently focused on this repo, exit;
 * otherwise enter Focus on it (switching focus from another repo if
 * needed).
 */
export function toggleFocus(repoIdx: number): void {
  if (appState.activeRepoIdx === repoIdx) {
    exitFocus();
  } else {
    enterFocus(repoIdx);
  }
}
