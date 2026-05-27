import { appState } from "./store.svelte";
import { compare } from "./compare";
import type { CompareCtx } from "./types";

/** Capture overrides currently set on non-main repos. Round-tripped via
 * CompareCtx so back/forward navigation preserves them across drill-in. */
function captureOverrides(): Record<
  number,
  { startBranch: string; targetBranch: string }
> {
  const out: Record<number, { startBranch: string; targetBranch: string }> = {};
  for (let i = 0; i < appState.repos.length; i++) {
    const r = appState.repos[i];
    if (r.kind !== "main" && r.override) {
      out[i] = { ...r.override };
    }
  }
  return out;
}

/** Force repos[].override to match the ctx snapshot exactly: set the ones
 * in `desired`, clear any non-main override not in `desired`. */
function restoreOverrides(
  desired: Record<number, { startBranch: string; targetBranch: string }>,
): void {
  let mutated = false;
  const next = appState.repos.map((r, i) => {
    if (r.kind === "main") return r;
    const want = desired[i];
    if (want) {
      if (
        !r.override ||
        r.override.startBranch !== want.startBranch ||
        r.override.targetBranch !== want.targetBranch
      ) {
        mutated = true;
        return { ...r, override: { ...want } };
      }
      return r;
    }
    if (r.override) {
      mutated = true;
      return { ...r, override: undefined };
    }
    return r;
  });
  if (mutated) appState.repos = next;
}

/**
 * Push the current compare context onto the history stack and drill into a
 * single commit. Implemented as a `<sha>^..<sha>` two-dot branch compare so
 * the existing FileList/DiffView pipeline renders the change set unchanged.
 *
 * For multi-root drill-in (§13.8): pass the originating file's `repoIdx` so
 * the drilled view is automatically focused on that repo. When that repo is
 * a non-main one, the drill sets that repo's per-repo override (rather than
 * mutating main's refs) — gitlink-follow would otherwise try to resolve the
 * submodule's SHA inside main's history and fail.
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
    overrides: captureOverrides(),
  };
  appState.history.push(ctx);
  // Fresh drill invalidates any forward stack — matches browser back/forward
  // semantics (a new navigation from a back-tracked state drops the redo).
  appState.forwardHistory = [];
  // Drill always renders in compare mode — blame mode has no concept of a
  // single-commit diff view.
  appState.appMode = "compare";
  appState.compareMode = "branch";
  appState.mode = "two-dot";
  appState.selectedFile = null;

  const isMultiRootIdx =
    repoIdx !== undefined &&
    repoIdx >= 0 &&
    repoIdx < appState.repos.length &&
    appState.repos.length > 1;
  const targetRepo = isMultiRootIdx ? appState.repos[repoIdx!] : null;
  const isNonMainDrill = targetRepo !== null && targetRepo.kind !== "main";

  if (isNonMainDrill) {
    // Set the override on the target repo so fetchRepoChanges hits the
    // override branch (direct `git diff <sha>^ <sha>` inside that repo).
    // Without this, submodules would fall through to gitlink-follow which
    // tries to resolve the SHA in main's history and gets null.
    const next = [...appState.repos];
    next[repoIdx!] = {
      ...targetRepo!,
      override: { startBranch: `${sha}^`, targetBranch: sha },
    };
    appState.repos = next;
    appState.activeRepoIdx = repoIdx!;
    // Main refs stay untouched — they're irrelevant for a focused non-main
    // drill (focusedHasOwnRefs check uses repo.override).
  } else {
    appState.startBranch = `${sha}^`;
    appState.targetBranch = sha;
    if (isMultiRootIdx) {
      appState.activeRepoIdx = repoIdx!;
    }
  }
  void compare();
}

/** Snapshot the current workspace context for the forward (redo) stack. */
export function snapshot(): CompareCtx {
  return {
    appMode: appState.appMode,
    compareMode: appState.compareMode,
    mode: appState.mode,
    startBranch: appState.startBranch,
    targetBranch: appState.targetBranch,
    selectedFilePath: appState.selectedFile?.path ?? null,
    activeRepoIdx: appState.activeRepoIdx,
    overrides: captureOverrides(),
  };
}

function applyCtx(ctx: CompareCtx): void {
  appState.appMode = ctx.appMode;
  appState.compareMode = ctx.compareMode;
  appState.mode = ctx.mode;
  appState.startBranch = ctx.startBranch;
  appState.targetBranch = ctx.targetBranch;
  appState.activeRepoIdx = ctx.activeRepoIdx;
  appState.selectedFile = null;
  // Reconcile non-main overrides with the ctx snapshot. Drill-in's temporary
  // override gets cleared on Back; Forward to a drilled ctx re-applies it.
  // Fall back to {} for ctx values saved before the field existed.
  restoreOverrides(ctx.overrides ?? {});
  // Compare-side rehydration: reload the file list. Blame-side state lives
  // in `appState.blameTarget` and survives the drill round-trip on its own.
  if (ctx.appMode === "compare") {
    void compare({ preservePath: ctx.selectedFilePath });
  }
}

/** Pop the top history frame and restore the saved workspace context. The
 * current context goes onto the forward stack so it can be re-entered. */
export function popHistory(): void {
  const ctx = appState.history.pop();
  if (!ctx) return;
  appState.forwardHistory.push(snapshot());
  applyCtx(ctx);
}

/** Redo: pop the top forward frame and re-enter that drilled view. The
 * current context goes back onto the history stack. */
export function redoHistory(): void {
  const ctx = appState.forwardHistory.pop();
  if (!ctx) return;
  appState.history.push(snapshot());
  applyCtx(ctx);
}
