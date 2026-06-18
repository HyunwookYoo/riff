import { appState } from "./store.svelte";
import { commitContainmentDetail, commitLog, containment } from "./git";
import { compare } from "./compare";
import type { Commit } from "./types";

/// Commits fetched per page of the Branch-mode containment list.
const PAGE_SIZE = 100;

/// Git's empty-tree object — the "before" side for a root commit (no parent).
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Monotonic guard so a stale list/marks fetch (refs changed mid-flight) can't
// overwrite a newer one — and so an in-flight "load more" / detail fetch is
// abandoned when the comparison context changes.
let bcSession = 0;

/// The repo Branch-mode containment operates on. V1 is main-repo only (the
/// start→target pickers are main's refs).
function mainPath(): string {
  return appState.repos[0]?.path ?? appState.repoPath;
}

/// Whether containment applies right now: Branch (compare) mode with both refs.
function ready(): boolean {
  return (
    appState.appMode === "compare" &&
    !!appState.repoPath &&
    !!appState.startBranch &&
    !!appState.targetBranch
  );
}

/// Load `start`'s commit list + the ✓/●/equiv marks and ahead/behind for
/// start↔target. Resets the per-commit drill to "All changes" (no auto-diff —
/// the user clicks a row or the toolbar Compare, preserving Branch mode's
/// explicit-compare behavior).
export async function loadBranchContainment(): Promise<void> {
  if (!ready()) {
    clearBranchContainment();
    // No refs to compare yet → drop any leftover selection (e.g. a file
    // auto-opened in Changes mode) so the diff pane shows the neutral
    // placeholder instead of a "no refs to compare for this file" error.
    if (appState.appMode === "compare") {
      appState.selectedFile = null;
      appState.files = [];
    }
    return;
  }
  const s = ++bcSession;
  const p = mainPath();
  const start = appState.startBranch;
  const target = appState.targetBranch;
  // New comparison context → drop any per-commit drill + stale detail.
  appState.bcSelectedSha = null;
  appState.bcDiffRange = null;
  appState.containmentDetail = null;
  appState.bcLoadingCommits = true;
  appState.loadingContainment = true;
  try {
    const [commits, marks] = await Promise.all([
      commitLog(p, start, false, PAGE_SIZE, 0),
      containment(p, start, target),
    ]);
    if (s !== bcSession) return;
    appState.bcCommits = commits;
    appState.bcHasMore = commits.length === PAGE_SIZE;
    appState.containment = marks;
  } catch {
    if (s === bcSession) {
      appState.bcCommits = [];
      appState.bcHasMore = false;
      appState.containment = null;
    }
  } finally {
    if (s === bcSession) {
      appState.bcLoadingCommits = false;
      appState.loadingContainment = false;
    }
  }
}

/// Append the next page of `start`'s commits (the list's infinite scroll).
export async function loadMoreBranchCommits(): Promise<void> {
  if (appState.bcLoadingCommits || !appState.bcHasMore || !ready()) return;
  // Don't bump the session — just detect a context change (a reload bumps it).
  const s = bcSession;
  const p = mainPath();
  appState.bcLoadingCommits = true;
  try {
    const page = await commitLog(
      p,
      appState.startBranch,
      false,
      PAGE_SIZE,
      appState.bcCommits.length,
    );
    if (s !== bcSession) return;
    appState.bcCommits = appState.bcCommits.concat(page);
    appState.bcHasMore = page.length === PAGE_SIZE;
  } catch {
    /* keep what we have */
  } finally {
    if (s === bcSession) appState.bcLoadingCommits = false;
  }
}

/// Select a commit to view its diff (parent..commit) + containment detail, or
/// `null` for "All changes" (the aggregate start↔target diff). The diff range
/// is applied via `bcDiffRange` so the toolbar ref pickers stay put.
export function selectBranchCommit(commit: Commit | null): void {
  if (!commit) {
    appState.bcSelectedSha = null;
    appState.bcDiffRange = null;
    appState.containmentDetail = null;
    void compare();
    return;
  }
  appState.bcSelectedSha = commit.sha;
  appState.bcDiffRange = {
    start: commit.parents[0] ?? EMPTY_TREE,
    target: commit.sha,
  };
  void loadBranchCommitDetail(commit.sha);
  void compare();
}

/// Load one commit's containment detail (containing refs + introducing merge).
async function loadBranchCommitDetail(sha: string): Promise<void> {
  const s = bcSession;
  try {
    const d = await commitContainmentDetail(
      mainPath(),
      sha,
      appState.targetBranch,
    );
    if (s !== bcSession) return;
    appState.containmentDetail = d;
  } catch {
    if (s === bcSession) appState.containmentDetail = null;
  }
}

/// Reset all Branch-mode containment state (leaving compare mode / repo switch).
export function clearBranchContainment(): void {
  bcSession++;
  appState.bcCommits = [];
  appState.bcSelectedSha = null;
  appState.bcHasMore = false;
  appState.bcDiffRange = null;
  appState.containment = null;
  appState.containmentDetail = null;
}
