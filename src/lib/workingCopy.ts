import { appState } from "./store.svelte";
import {
  discardPaths as discardCmd,
  fetch as fetchCmd,
  merge as mergeCmd,
  opAbort,
  opContinue,
  pendingOp,
  pull as pullCmd,
  push as pushCmd,
  stage as stageCmd,
  status,
  unstage as unstageCmd,
} from "./git";
import { loadCommits, invalidateGraph, enterGraphView } from "./commitHistory";
import { confirmAction } from "./dialogs";
import type { ChangedFile, FileStatus, StatusEntry } from "./types";

/// Map a porcelain-v2 status code (X or Y for one side) to a `FileStatus` for
/// the diff header + per-side diff. `?` (untracked) shows as added; `U`
/// (conflict) and anything unrecognized fall back to modified.
function toFileStatus(code: string): FileStatus {
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
    case "?":
      return "added";
    default:
      return "modified";
  }
}

/// The repo the Changes screen stages/commits against — `changesRepoIdx`
/// (main or a submodule/manual repo), independent of the compare Focus.
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

/// An entry belongs to the Staged list when its index side changed (and isn't
/// untracked); to the Unstaged list when its worktree side changed (untracked
/// `?` counts here). A file modified in both shows in both.
export function isStaged(e: StatusEntry): boolean {
  return e.index_status !== "." && e.index_status !== "?";
}
export function isUnstaged(e: StatusEntry): boolean {
  return e.worktree_status !== ".";
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
  if (conflicts.length > 0) openChange(conflicts[0], "unstaged");
}

/// Open the next still-conflicted file (the first unmerged entry that isn't the
/// one already selected), used to auto-advance after a file is resolved. No-op
/// when none remain.
export function openNextConflict(): void {
  const conflicts = conflictedEntries();
  if (conflicts.length === 0) return;
  const cur = appState.selectedFile?.path;
  const next = conflicts.find((e) => e.path !== cur) ?? conflicts[0];
  openChange(next, "unstaged");
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
    const unstaged = st.entries.filter(isUnstaged);
    const staged = st.entries.filter(isStaged);
    // Keep the current selection if it still has changes on its side (so
    // staging a hunk/file doesn't jump the view); otherwise fall back to the
    // first available change.
    const cur = appState.selectedFile;
    const side = appState.changesSide;
    const sameSide = side === "staged" ? staged : unstaged;
    const kept = cur ? sameSide.find((e) => e.path === cur.path) : undefined;
    if (kept) {
      openChange(kept, side);
    } else if (unstaged.length > 0) {
      openChange(unstaged[0], "unstaged");
    } else if (staged.length > 0) {
      openChange(staged[0], "staged");
    } else {
      appState.selectedFile = null;
    }
  } catch (e) {
    if (session !== statusSession) return;
    appState.error = String(e);
    appState.repoStatus = null;
    appState.selectedFile = null;
  } finally {
    if (session === statusSession) appState.loadingStatus = false;
  }
}

/// Build a `ChangedFile` (consumed verbatim by DiffView) from a status entry on
/// a given side — the per-side status code drives the diff header + badge.
export function entryToChangedFile(
  entry: StatusEntry,
  side: "staged" | "unstaged",
): ChangedFile {
  const code = side === "staged" ? entry.index_status : entry.worktree_status;
  return {
    path: entry.path,
    old_path: entry.orig_path,
    status: toFileStatus(code),
    repoIdx: appState.changesRepoIdx,
  };
}

/// Select a change (already a `ChangedFile`) on a side, recording the side so
/// the diff loads the right gap.
export function selectChange(
  file: ChangedFile,
  side: "staged" | "unstaged",
): void {
  appState.changesSide = side;
  appState.selectedFile = file;
}

/// Select a change from a status entry on a given side.
export function openChange(
  entry: StatusEntry,
  side: "staged" | "unstaged",
): void {
  selectChange(entryToChangedFile(entry, side), side);
}

/// Run a stage/unstage op against the active repo, then refresh status so the
/// two lists + diff reflect the new index. Errors surface in the error banner
/// but still trigger a reload (the index may be partially updated).
async function applyAndReload(op: Promise<void>): Promise<void> {
  try {
    await op;
  } catch (e) {
    appState.error = String(e);
  }
  await loadStatus();
}

export function stagePath(path: string): Promise<void> {
  return applyAndReload(stageCmd(changesRepoPath(), [path]));
}
export function unstagePath(path: string): Promise<void> {
  return applyAndReload(unstageCmd(changesRepoPath(), [path]));
}
/// Discard a file's local changes (revert tracked → HEAD, delete new). Pass
/// `origPath` for a rename so its original is restored too. Destructive — the
/// caller confirms first. Reloads status, which drops the discarded path from
/// the list.
export function discardPath(path: string, origPath: string | null): Promise<void> {
  const paths = origPath ? [path, origPath] : [path];
  return applyAndReload(discardCmd(changesRepoPath(), paths));
}
/// Discard the file currently selected in Changes — the Delete-key shortcut.
/// Mirrors a row's ↩ button: a new file (staged-add / untracked) is deleted,
/// anything else reverts to HEAD. Destructive, so it confirms first. No-op
/// outside the Changes (Working) view or with nothing selected.
export async function discardSelectedFile(): Promise<void> {
  if (appState.appMode !== "changes") return;
  const sel = appState.selectedFile;
  if (!sel) return;
  const entry = (appState.repoStatus?.entries ?? []).find(
    (e) => e.path === sel.path,
  );
  const isNew =
    !!entry &&
    (entry.index_status === "A" ||
      (entry.index_status === "?" && entry.worktree_status === "?"));
  const ok = await confirmAction(
    isNew
      ? `Delete this new file? It is permanently removed from disk and can't be undone.\n\n${sel.path}`
      : `Discard changes to this file? It reverts to HEAD and can't be undone.\n\n${sel.path}`,
    { title: isNew ? "Delete file" : "Discard changes" },
  );
  if (!ok) return;
  await discardPath(sel.path, entry?.orig_path ?? null);
}

export function stageAll(): Promise<void> {
  return applyAndReload(stageCmd(changesRepoPath(), null));
}
export function unstageAll(): Promise<void> {
  return applyAndReload(unstageCmd(changesRepoPath(), null));
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
  appState.changesSide = "unstaged";
  appState.commitSubject = "";
  appState.commitBody = "";
  appState.commitAmend = false;
  appState.commitCoauthors = [];
}
