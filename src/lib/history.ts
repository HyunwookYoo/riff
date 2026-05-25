import { appState } from "./store.svelte";
import { compare } from "./compare";
import type { CompareCtx } from "./types";

/**
 * Push the current compare context onto the history stack and drill into a
 * single commit. Implemented as a `<sha>^..<sha>` two-dot branch compare so
 * the existing FileList/DiffView pipeline renders the change set unchanged.
 */
export function pushAndDrillToCommit(sha: string): void {
  const ctx: CompareCtx = {
    appMode: appState.appMode,
    compareMode: appState.compareMode,
    mode: appState.mode,
    startBranch: appState.startBranch,
    targetBranch: appState.targetBranch,
    selectedFilePath: appState.selectedFile?.path ?? null,
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
  appState.selectedFile = null;
  // Compare-side rehydration: reload the file list. Blame-side state lives in
  // `appState.blameFilePath` and survives the drill round-trip on its own.
  if (ctx.appMode === "compare") {
    void compare({ preservePath: ctx.selectedFilePath });
  }
}
