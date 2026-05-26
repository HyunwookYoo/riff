import { appState } from "./store.svelte";
import { compare } from "./compare";
import type { CompareCtx } from "./types";

/**
 * Push the current compare context onto the history stack and drill into a
 * single commit. Implemented as a `<sha>^..<sha>` two-dot branch compare so
 * the existing FileList/DiffView pipeline renders the change set unchanged.
 *
 * For multi-root drill-in (§13.8): pass the originating file's `repoIdx` so
 * the drilled view is automatically focused on that repo — the other repos'
 * refs wouldn't resolve `<sha>^` anyway. Omit `repoIdx` for single-repo
 * drill-in (current behavior).
 */
export function pushAndDrillToCommit(sha: string, repoIdx?: number): void {
  const ctx: CompareCtx = {
    appMode: appState.appMode,
    compareMode: appState.compareMode,
    mode: appState.mode,
    startBranch: appState.startBranch,
    targetBranch: appState.targetBranch,
    selectedFilePath: appState.selectedFile?.path ?? null,
    activeRepoIdx: appState.activeRepoIdx,
  };
  appState.history.push(ctx);
  // Drill always renders in compare mode — blame mode has no concept of a
  // single-commit diff view.
  appState.appMode = "compare";
  appState.compareMode = "branch";
  appState.mode = "two-dot";
  appState.startBranch = `${sha}^`;
  appState.targetBranch = sha;
  appState.selectedFile = null;
  // Multi-root: focus on the originating repo so compare() only fetches
  // changes from that repo (§13.8). For single-repo this stays null.
  if (
    repoIdx !== undefined &&
    repoIdx >= 0 &&
    repoIdx < appState.repos.length &&
    appState.repos.length > 1
  ) {
    appState.activeRepoIdx = repoIdx;
  }
  void compare();
}

/** Pop the top history frame and restore the saved workspace context. */
export function popHistory(): void {
  const ctx = appState.history.pop();
  if (!ctx) return;
  appState.appMode = ctx.appMode;
  appState.compareMode = ctx.compareMode;
  appState.mode = ctx.mode;
  appState.startBranch = ctx.startBranch;
  appState.targetBranch = ctx.targetBranch;
  appState.activeRepoIdx = ctx.activeRepoIdx;
  appState.selectedFile = null;
  // Compare-side rehydration: reload the file list. Blame-side state lives in
  // `appState.blameFilePath` and survives the drill round-trip on its own.
  if (ctx.appMode === "compare") {
    void compare({ preservePath: ctx.selectedFilePath });
  }
}
