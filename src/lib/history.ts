import { appState } from "./store.svelte";
import { compare } from "./compare";
import { commitLog } from "./git";
import { EMPTY_TREE } from "./emptyTree";
import { clearPick } from "./branchContainment";
import type { Commit, CompareCtx } from "./types";

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

/** Bumped by each drill; only the latest one in flight goes through. */
let drillSeq = 0;

/**
 * Push the current context and open one commit from Blame mode as the commit
 * view: a two-dot Branch compare of `parent..commit` that the Branch screen
 * renders as a commit (see `commitViewActive`). The commit is read first: the
 * commit card shows its message, and its first parent (the empty tree for a
 * root commit) is the base, so a root commit never asks for `<sha>^`.
 *
 * `repoIdx` is the blamed file's repo. A non-main repo gets the range as its
 * per-repo override (rather than mutating main's refs) — gitlink-follow
 * would otherwise try to resolve the submodule's SHA inside main's history.
 * `from` is the blamed file at that commit and the blamed line's number
 * there; the drill selects that file and DiffView scrolls to the line.
 *
 * When the commit can't be read nothing is pushed and Blame stays. A drill
 * overtaken by another, or by leaving Blame, during the read does nothing.
 */
export async function pushAndDrillToCommit(
  sha: string,
  repoIdx: number | undefined,
  from: { path: string; line: number } | null,
): Promise<void> {
  const idx =
    repoIdx !== undefined && repoIdx >= 0 && repoIdx < appState.repos.length
      ? repoIdx
      : 0;
  const repoPath = appState.repos[idx]?.path ?? appState.repoPath;
  const mine = ++drillSeq;
  let commit: Commit | undefined;
  try {
    [commit] = await commitLog(repoPath, sha, false, 1, 0);
  } catch (e) {
    appState.error = `couldn't open commit ${sha}: ${String(e)}`;
    return;
  }
  if (mine !== drillSeq || appState.appMode !== "blame") return;
  if (!commit) {
    appState.error = `couldn't open commit ${sha}: not found`;
    return;
  }
  const base = commit.parents[0] ?? EMPTY_TREE;
  const target = commit.sha;

  appState.history.push(snapshot());
  // Fresh drill invalidates any forward stack — matches browser back/forward
  // semantics (a new navigation from a back-tracked state drops the redo).
  appState.forwardHistory = [];
  appState.appMode = "compare";
  appState.compareMode = "branch";
  appState.mode = "two-dot";
  appState.selectedFile = null;
  // The drill leaves Blame; the older blame is in the frame just pushed, and
  // a later trip to Blame starts at HEAD.
  appState.blameRev = null;

  const multiRoot = appState.repos.length > 1;
  const targetRepo = appState.repos[idx];
  if (multiRoot && targetRepo && targetRepo.kind !== "main") {
    const next = [...appState.repos];
    next[idx] = { ...targetRepo, override: { startBranch: base, targetBranch: target } };
    appState.repos = next;
    appState.activeRepoIdx = idx;
  } else {
    appState.startBranch = base;
    appState.targetBranch = target;
    if (multiRoot) appState.activeRepoIdx = idx;
  }
  appState.commitView = { repoIdx: idx, base, target, commit, from };
  appState.revealLine = from ? { repoIdx: idx, path: from.path, line: from.line } : null;
  // A commit picked in the commit table outranks everything in compare(); a
  // drill (above all one into a submodule, which leaves the toolbar pair
  // alone) is a fresh view, so the pick goes first.
  clearPick();
  void compare({ preservePath: from?.path ?? null, preserveRepoIdx: idx });
}

/// The Branch screen renders as the commit view while a Blame drill-in's range
/// is still on screen: Branch mode, and the drilled repo's range exactly
/// base..target (its override for a non-main repo, else the toolbar pair).
/// Moving the range anywhere drops back to the ordinary Branch screen, and so
/// does picking another repo tab (the drill makes the drilled repo active).
export function commitViewActive(): boolean {
  const v = appState.commitView;
  if (!v || appState.appMode !== "compare" || appState.compareMode !== "branch") {
    return false;
  }
  const multiRoot = appState.repos.length > 1;
  if (multiRoot && (appState.activeRepoIdx ?? 0) !== v.repoIdx) return false;
  const repo = appState.repos[v.repoIdx];
  if (multiRoot && repo && repo.kind !== "main") {
    return (
      repo.override?.startBranch === v.base && repo.override?.targetBranch === v.target
    );
  }
  return appState.startBranch === v.base && appState.targetBranch === v.target;
}

/** Snapshot the current workspace context for the history stacks. */
export function snapshot(): CompareCtx {
  return {
    appMode: appState.appMode,
    compareMode: appState.compareMode,
    mode: appState.mode,
    startBranch: appState.startBranch,
    targetBranch: appState.targetBranch,
    selectedFilePath: appState.selectedFile?.path ?? null,
    selectedFileRepoIdx: appState.selectedFile?.repoIdx ?? null,
    activeRepoIdx: appState.activeRepoIdx,
    overrides: captureOverrides(),
    commitView: appState.commitView,
    blameTarget: appState.blameTarget,
    blameRev: appState.blameRev,
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
  appState.commitView = ctx.commitView ?? null;
  // A Blame ctx brings back the file and revision it showed. Fall back to the
  // current file for ctx values saved before the field existed.
  if (ctx.appMode === "blame") {
    if (ctx.blameTarget !== undefined) appState.blameTarget = ctx.blameTarget;
    appState.blameRev = ctx.blameRev ?? null;
  }
  // Compare-side rehydration: reload the file list. Blame-side state is
  // restored above.
  if (ctx.appMode === "compare") {
    // The restored view is not the one a commit was picked in.
    clearPick();
    void compare({
      preservePath: ctx.selectedFilePath,
      preserveRepoIdx: ctx.selectedFileRepoIdx,
    });
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

/** Leave every "Blame before this" step at once: pop while Blame shows an
 * older revision. Each popped frame goes onto the forward stack. */
export function backToHead(): void {
  while (
    appState.appMode === "blame" &&
    appState.blameRev &&
    appState.history.length > 0
  ) {
    popHistory();
  }
}

/// The commit view's "N files" count: only the drilled repo's files (the Tabs
/// layout scans every repo into `appState.files`), or "…" while they load.
export function commitViewFileCount(): string {
  const v = appState.commitView;
  if (!v || appState.loadingFiles) return "…";
  return String(appState.files.filter((f) => (f.repoIdx ?? 0) === v.repoIdx).length);
}
