import { appState } from "./store.svelte";
import {
  commitContainmentDetail,
  commitLog,
  containment,
  submoduleShaAt,
} from "./git";
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

/// The main repo's path — the one whose gitlinks say where a submodule sits.
function mainPath(): string {
  return appState.repos[0]?.path ?? appState.repoPath;
}

/// The repo and refs this pane describes: whatever Focus is on, resolved the
/// same way `compare()` resolves it, so the marks always describe the diff on
/// screen.
///
/// This used to be main-only, reading `appState.startBranch` / `targetBranch`
/// against `repos[0]`. In a multi-root workspace those are not the refs the
/// toolbar edits once Focus moves off main — it edits that repo's *override*
/// instead — so the pane sat inert: no marks, and picking refs changed
/// nothing, because main's refs never moved.
interface BcContext {
  path: string;
  start: string;
  target: string;
  /// What to call the repo in the pane's header.
  repo: string;
}

async function resolveContext(): Promise<BcContext | null> {
  if (appState.appMode !== "compare" || !appState.repoPath) return null;
  const idx = appState.activeRepoIdx ?? 0;
  const repo = appState.repos[idx];
  const label = repo?.displayName || "repo";
  // Main (or a single-repo workspace): the toolbar's own refs.
  if (!repo || repo.kind === "main") {
    if (!appState.startBranch || !appState.targetBranch) return null;
    return {
      path: mainPath(),
      start: appState.startBranch,
      target: appState.targetBranch,
      repo: label,
    };
  }
  // A per-repo override wins wherever it is set — it is exactly what the
  // toolbar pickers write while that repo is focused.
  if (repo.override?.startBranch && repo.override.targetBranch) {
    return {
      path: repo.path,
      start: repo.override.startBranch,
      target: repo.override.targetBranch,
      repo: label,
    };
  }
  if (repo.kind === "manual") return null;
  // Gitlink-follow: an un-overridden submodule is compared between the commits
  // main's two refs point at, so containment answers the same question about
  // that commit range.
  if (!repo.parentGitlinkPath || !appState.startBranch || !appState.targetBranch) {
    return null;
  }
  const [oldSha, newSha] = await Promise.all([
    submoduleShaAt(mainPath(), appState.startBranch, repo.parentGitlinkPath),
    submoduleShaAt(mainPath(), appState.targetBranch, repo.parentGitlinkPath),
  ]);
  if (!oldSha || !newSha || oldSha === newSha) return null;
  // Same mapping as everywhere else in Branch mode: start is what the toolbar
  // calls start (main's start ref), target is its target — here, the commits
  // those two refs pin the submodule to.
  return { path: repo.path, start: oldSha, target: newSha, repo: label };
}

/// The context the current list and marks were loaded for; `loadMore` and the
/// per-commit detail must use the same one.
let bcContext: BcContext | null = null;

/// Load `start`'s commit list + the ✓/●/equiv marks and ahead/behind for
/// start↔target. Resets the per-commit drill to "All changes" (no auto-diff —
/// the user clicks a row or the toolbar Compare, preserving Branch mode's
/// explicit-compare behavior).
export async function loadBranchContainment(): Promise<void> {
  const s0 = ++bcSession;
  const ctx = await resolveContext();
  if (s0 !== bcSession) return;
  if (!ctx) {
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
  const s = s0;
  bcContext = ctx;
  appState.bcRefs = { start: ctx.start, target: ctx.target, repo: ctx.repo };
  const { path: p, start, target } = ctx;
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
  const ctx = bcContext;
  if (appState.bcLoadingCommits || !appState.bcHasMore || !ctx) return;
  // Don't bump the session — just detect a context change (a reload bumps it).
  const s = bcSession;
  appState.bcLoadingCommits = true;
  try {
    const page = await commitLog(
      ctx.path,
      ctx.start,
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
  const ctx = bcContext;
  if (!ctx) return;
  const s = bcSession;
  try {
    const d = await commitContainmentDetail(ctx.path, sha, ctx.target);
    if (s !== bcSession) return;
    appState.containmentDetail = d;
  } catch {
    if (s === bcSession) appState.containmentDetail = null;
  }
}

/// Reset all Branch-mode containment state (leaving compare mode / repo switch).
export function clearBranchContainment(): void {
  bcSession++;
  bcContext = null;
  appState.bcRefs = null;
  appState.bcCommits = [];
  appState.bcSelectedSha = null;
  appState.bcHasMore = false;
  appState.bcDiffRange = null;
  appState.containment = null;
  appState.containmentDetail = null;
}
