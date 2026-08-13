import { appState } from "./store.svelte";
import {
  fetch as fetchCmd,
  merge as mergeCmd,
  opAbort,
  opContinue,
  pendingOp,
  pull as pullCmd,
  push as pushCmd,
  status,
} from "./git";
import { loadCommits, invalidateGraph, enterGraphView } from "./commitHistory";
import type { ChangedFile, FileStatus, StatusEntry } from "./types";

/// Map one porcelain-v2 side code to a `FileStatus`. Unrecognized codes fall
/// back to modified.
function codeToStatus(code: string): FileStatus {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typechanged";
    default:
      return "modified";
  }
}

/// A file's status relative to HEAD — what Working Copy's single list shows.
/// Porcelain v2 reports two codes (X = index vs HEAD, Y = worktree vs index)
/// and neither alone answers the question: `AM` is *added* since HEAD even
/// though Y says modified, and `MD` is *deleted* even though X says modified.
/// Read them newest-state-first: gone from disk wins, then never-in-HEAD, then
/// whichever side actually changed.
export function headRelativeStatus(e: StatusEntry): FileStatus {
  const x = e.index_status;
  const y = e.worktree_status;
  if (x === "?" || y === "?") return "added";
  if (y === "D") return "deleted";
  return codeToStatus(x === "." ? y : x);
}

/// The repo the Changes screen reads status for — `changesRepoIdx` (main or a
/// submodule/manual repo), independent of the compare Focus.
export function changesRepoPath(): string {
  return appState.repos[appState.changesRepoIdx]?.path ?? appState.repoPath;
}

/// Switch which repo the Changes screen operates on (main vs a submodule).
/// Clears the per-repo commit box and selection, then reloads that repo's
/// status. Used by the Changes-mode repo picker.
export function setChangesRepo(idx: number): void {
  if (idx === appState.changesRepoIdx) return;
  appState.changesRepoIdx = idx;
  // Keep the graph (history) repo in lockstep, and drop its cached log so the
  // graph reloads for the new repo on next visit.
  appState.historyRepoIdx = idx;
  appState.commits = [];
  appState.selectedCommitSha = null;
  appState.repoStatus = null;
  appState.selectedFile = null;
  appState.commitSubject = "";
  appState.commitBody = "";
  appState.commitAmend = false;
  appState.commitCoauthors = [];
  void loadStatus();
}

// Porcelain v2 unmerged XY codes (both sides come from a `u` record).
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
export function entryConflicted(e: StatusEntry): boolean {
  return CONFLICT_CODES.has(e.index_status + e.worktree_status);
}
/// True when `path` is an unmerged (conflicted) entry in the current status.
export function isPathConflicted(path: string): boolean {
  const e = appState.repoStatus?.entries.find((x) => x.path === path);
  return !!e && entryConflicted(e);
}
/// Count of unresolved (conflicted) files in the current status.
export function conflictCount(): number {
  return (appState.repoStatus?.entries ?? []).filter(entryConflicted).length;
}

/// The conflicted (unmerged) entries in the current status.
export function conflictedEntries(): StatusEntry[] {
  return (appState.repoStatus?.entries ?? []).filter(entryConflicted);
}

/// Jump to conflict resolution: enter the Working (Changes) view and open the
/// first conflicted file in the 3-way resolver. Used by the banner's Resolve
/// button.
export async function enterConflictResolution(): Promise<void> {
  await enterChangesMode();
  const conflicts = conflictedEntries();
  if (conflicts.length > 0) openChange(conflicts[0]);
}

/// Open the next still-conflicted file (the first unmerged entry that isn't the
/// one already selected), used to auto-advance after a file is resolved. No-op
/// when none remain.
export function openNextConflict(): void {
  const conflicts = conflictedEntries();
  if (conflicts.length === 0) return;
  const cur = appState.selectedFile?.path;
  const next = conflicts.find((e) => e.path !== cur) ?? conflicts[0];
  openChange(next);
}

export async function enterChangesMode(): Promise<void> {
  // Ordinary entry resets the WIP back/forward pair; the special WIP-node and
  // mouse-forward steps re-arm the relevant flag after calling this.
  appState.wipReturn = false;
  appState.wipForward = false;
  // Returning from the graph (history) sub-view: keep the same repo selected.
  if (appState.appMode === "history") {
    appState.changesRepoIdx = appState.historyRepoIdx;
  }
  appState.appMode = "changes";
  appState.lastScmView = "changes";
  await loadStatus();
  void loadPendingOp();
}

/// Enter the source-control area, restoring whichever sub-view (Working or the
/// commit Graph) was last shown — so leaving for Branch/Blame and coming back
/// lands on the same view instead of always snapping to Working.
export function enterScm(): Promise<void> {
  return appState.lastScmView === "history"
    ? enterGraphView()
    : enterChangesMode();
}

// Monotonic guard so a slow status fetch — now off the main thread, so the
// watcher and user actions can fire overlapping refreshes — from an earlier
// call can't land after and overwrite a newer one's results.
let statusSession = 0;

/// Load `git status --porcelain=v2` for the active repo and auto-open the first
/// change so the diff pane isn't empty.
export async function loadStatus(): Promise<void> {
  if (!appState.repoPath) return;
  const session = ++statusSession;
  appState.loadingStatus = true;
  appState.error = null;
  try {
    const st = await status(changesRepoPath());
    // A newer loadStatus started while we awaited — drop this stale result.
    if (session !== statusSession) return;
    appState.repoStatus = st;
    appState.currentBranch = st.branch;
    appState.currentUpstream = st.upstream;
    appState.currentAhead = st.ahead;
    appState.currentBehind = st.behind;
    const changed = st.entries;
    const cur = appState.selectedFile;
    const kept = cur ? changed.find((e) => e.path === cur.path) : undefined;
    if (kept) openChange(kept);
    else if (changed.length > 0) openChange(changed[0]);
    else appState.selectedFile = null;
  } catch (e) {
    if (session !== statusSession) return;
    appState.error = String(e);
    appState.repoStatus = null;
    appState.selectedFile = null;
  } finally {
    if (session === statusSession) appState.loadingStatus = false;
  }
}

/// Build a `ChangedFile` (consumed verbatim by DiffView) from a status entry.
/// The badge and the diff both describe the HEAD↔worktree gap.
export function entryToChangedFile(entry: StatusEntry): ChangedFile {
  return {
    path: entry.path,
    old_path: entry.orig_path,
    status: headRelativeStatus(entry),
    repoIdx: appState.changesRepoIdx,
  };
}

export function selectChange(file: ChangedFile): void {
  appState.selectedFile = file;
}

export function openChange(entry: StatusEntry): void {
  selectChange(entryToChangedFile(entry));
}

/// Refresh just the current-branch indicator (name + ahead/behind) for the
/// source-control repo, without touching the staging selection. Called after
/// branch ops (checkout, etc.) so the toolbar chip stays accurate.
export async function loadCurrentBranch(): Promise<void> {
  if (!appState.repoPath) return;
  try {
    const st = await status(changesRepoPath());
    appState.currentBranch = st.branch;
    appState.currentUpstream = st.upstream;
    appState.currentAhead = st.ahead;
    appState.currentBehind = st.behind;
  } catch {
    // Keep the last known value.
  }
}

/// Refresh whichever source-control view is active — Changes status, or the
/// graph + branch chip — and nudge the refs sidebar to re-list. Used after
/// in-app network ops *and* on window-focus regain, so changes made elsewhere
/// (e.g. an external `git checkout`) show up without a manual reload.
export async function refreshActiveView(): Promise<void> {
  if (appState.appMode === "changes") {
    await loadStatus();
    // A HEAD-moving op (checkout, sync) ran while in Changes — drop the graph's
    // cached log so it reflects the new HEAD on next visit.
    invalidateGraph();
  } else {
    await loadCurrentBranch();
    if (appState.appMode === "history")
      await loadCommits({ preserveSelection: true });
  }
  appState.refsRefresh++;
}

/// Run a fetch/pull/push against the source-control repo with a busy flag,
/// surfacing errors and refreshing afterward.
async function runSync(
  op: Promise<void>,
  label: string,
  onError?: (raw: string) => boolean,
): Promise<void> {
  if (appState.syncing) return;
  appState.syncing = true;
  appState.beginGitOp(label);
  appState.error = null;
  try {
    await op;
  } catch (e) {
    const raw = String(e);
    // Always surface the raw message (the finally preserves it across the
    // refresh); onError may open the recovery dialog on top, and Cancel reveals
    // this banner.
    appState.error = raw;
    onError?.(raw);
  } finally {
    appState.syncing = false;
    // Keep a sync failure's message: refreshActiveView() runs loadStatus()/
    // loadCommits(), which reset appState.error — without this a rejected push
    // (e.g. after a rebase) would flash and vanish before you could read it.
    const err = appState.error;
    await refreshActiveView();
    await loadPendingOp();
    if (err) appState.error = err;
    appState.endGitOp();
  }
}

/// Refresh the in-progress-operation indicator (drives the conflict banner).
export async function loadPendingOp(): Promise<void> {
  if (!appState.repoPath) {
    appState.pendingOp = "none";
    return;
  }
  try {
    appState.pendingOp = await pendingOp(changesRepoPath());
  } catch {
    appState.pendingOp = "none";
  }
}

/// Merge a branch into the current one. On conflict the repo is left mid-merge
/// and the banner appears; resolve + stage in Working, then Continue.
export async function doMergeBranch(branch: string): Promise<void> {
  const repo = changesRepoPath();
  appState.beginGitOp("Merging…");
  appState.error = null;
  try {
    await mergeCmd(repo, branch);
  } catch (e) {
    appState.error = String(e);
  } finally {
    const err = appState.error;
    await refreshActiveView();
    await loadPendingOp();
    if (err) appState.error = err;
    appState.endGitOp();
  }
}

/// Abort the in-progress operation.
export async function abortOp(): Promise<void> {
  const op = appState.pendingOp;
  if (op === "none") return;
  appState.beginGitOp("Aborting…");
  appState.error = null;
  try {
    await opAbort(changesRepoPath(), op);
  } catch (e) {
    appState.error = String(e);
  } finally {
    const err = appState.error;
    await refreshActiveView();
    await loadPendingOp();
    if (err) appState.error = err;
    appState.endGitOp();
  }
}

/// Continue the in-progress operation (conflicts must be resolved + staged).
export async function continueOp(): Promise<void> {
  const op = appState.pendingOp;
  if (op === "none") return;
  appState.beginGitOp("Resuming…");
  appState.error = null;
  try {
    await opContinue(changesRepoPath(), op);
  } catch (e) {
    appState.error = String(e);
  } finally {
    const err = appState.error;
    await refreshActiveView();
    await loadPendingOp();
    if (err) appState.error = err;
    appState.endGitOp();
  }
}

export function doFetch(): Promise<void> {
  return runSync(fetchCmd(changesRepoPath()), "Fetching…");
}
export function doPull(rebase: boolean): Promise<void> {
  return runSync(pullCmd(changesRepoPath(), rebase), "Pulling…");
}
export function doPush(force: boolean): Promise<void> {
  // First push (no upstream): set it on the current branch while pushing.
  const setUpstream =
    !appState.currentUpstream && appState.currentBranch
      ? appState.currentBranch
      : null;
  return runSync(pushCmd(changesRepoPath(), setUpstream, force), "Pushing…");
}

/// Clear all Changes-screen state on repo switch — the status, repo selection,
/// and commit box belong to the old workspace.
export function resetSourceControl(): void {
  appState.repoStatus = null;
  appState.changesRepoIdx = 0;
  appState.commitSubject = "";
  appState.commitBody = "";
  appState.commitAmend = false;
  appState.commitCoauthors = [];
}
