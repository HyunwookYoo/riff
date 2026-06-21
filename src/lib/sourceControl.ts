import { appState } from "./store.svelte";
import {
  commit as commitCmd,
  discardPaths as discardCmd,
  fetch as fetchCmd,
  headCommitMessage,
  merge as mergeCmd,
  opAbort,
  opContinue,
  pendingOp,
  pull as pullCmd,
  push as pushCmd,
  stage as stageCmd,
  stashApply,
  stashDrop,
  stashList,
  stashSave,
  status,
  unstage as unstageCmd,
} from "./git";
import { loadCommits, invalidateGraph } from "./commitHistory";
import {
  loadChangelistsForRepo,
  reconcileChangelists,
} from "./changelists";
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
  // Drop the old repo's changelists so the new repo's load fresh on loadStatus.
  appState.changelists = [];
  appState.activeChangelistId = "default";
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
  await loadStatus();
  void loadPendingOp();
  void loadStashes();
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
    // Load changelists on the first status, then re-bucket on later ones.
    if (appState.changelists.length === 0) void loadChangelistsForRepo();
    else reconcileChangelists();
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
/// caller confirms first. Reloads status, which re-buckets the changelists so
/// the discarded path drops out.
export function discardPath(path: string, origPath: string | null): Promise<void> {
  const paths = origPath ? [path, origPath] : [path];
  return applyAndReload(discardCmd(changesRepoPath(), paths));
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
async function runSync(op: Promise<void>, label: string): Promise<void> {
  if (appState.syncing) return;
  appState.syncing = true;
  appState.beginGitOp(label);
  appState.error = null;
  try {
    await op;
  } catch (e) {
    appState.error = String(e);
  } finally {
    appState.syncing = false;
    await refreshActiveView();
    await loadPendingOp();
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
  appState.beginGitOp("Merging…");
  try {
    await mergeCmd(changesRepoPath(), branch);
  } catch (e) {
    appState.error = String(e);
  } finally {
    await refreshActiveView();
    await loadPendingOp();
    appState.endGitOp();
  }
}

/// Abort the in-progress operation.
export async function abortOp(): Promise<void> {
  const op = appState.pendingOp;
  if (op === "none") return;
  appState.beginGitOp("Aborting…");
  try {
    await opAbort(changesRepoPath(), op);
  } catch (e) {
    appState.error = String(e);
  } finally {
    await refreshActiveView();
    await loadPendingOp();
    appState.endGitOp();
  }
}

/// Continue the in-progress operation (conflicts must be resolved + staged).
export async function continueOp(): Promise<void> {
  const op = appState.pendingOp;
  if (op === "none") return;
  appState.beginGitOp("Resuming…");
  try {
    await opContinue(changesRepoPath(), op);
  } catch (e) {
    appState.error = String(e);
  } finally {
    await refreshActiveView();
    await loadPendingOp();
    appState.endGitOp();
  }
}

/// Load the stash list for the source-control repo (shown in the sidebar).
export async function loadStashes(): Promise<void> {
  if (!appState.repoPath) {
    appState.stashes = [];
    return;
  }
  try {
    appState.stashes = await stashList(changesRepoPath());
  } catch {
    appState.stashes = [];
  }
}

/// Stash the working tree (including untracked) under an optional message.
export async function doStashSave(message?: string): Promise<void> {
  try {
    await stashSave(changesRepoPath(), message ?? null, true);
  } catch (e) {
    appState.error = String(e);
  }
  await refreshActiveView();
  await loadStashes();
}

/// Apply (or pop) a stash back onto the working tree.
export async function doStashApply(index: number, pop: boolean): Promise<void> {
  try {
    await stashApply(changesRepoPath(), index, pop);
  } catch (e) {
    appState.error = String(e);
  }
  await refreshActiveView();
  await loadStashes();
}

/// Drop a stash (no working-tree change).
export async function doStashDrop(index: number): Promise<void> {
  try {
    await stashDrop(changesRepoPath(), index);
  } catch (e) {
    appState.error = String(e);
  }
  await loadStashes();
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
  appState.stashes = [];
  appState.changesRepoIdx = 0;
  appState.changesSide = "unstaged";
  appState.commitSubject = "";
  appState.commitBody = "";
  appState.commitAmend = false;
  appState.commitCoauthors = [];
}

/// Pre-fill the commit box with HEAD's message when "Amend" is toggled on.
/// Splits the first line into the subject and the remainder (past the blank
/// line) into the body. No-op on an unborn branch (no HEAD to read).
export async function loadAmendMessage(): Promise<void> {
  try {
    const msg = await headCommitMessage(changesRepoPath());
    const nl = msg.indexOf("\n");
    if (nl === -1) {
      appState.commitSubject = msg;
      appState.commitBody = "";
    } else {
      appState.commitSubject = msg.slice(0, nl);
      appState.commitBody = msg.slice(nl + 1).replace(/^\n/, "");
    }
  } catch {
    // Unborn branch / no HEAD — leave the box as-is.
  }
}

/// Number of entries currently staged — gates the Commit button.
export function stagedCount(): number {
  return (appState.repoStatus?.entries ?? []).filter(isStaged).length;
}

/// Commit the staged index from the box state. Validates a non-empty subject
/// and (unless amending) a non-empty index. Surfaces hook/commit failures in
/// the error banner; on success clears the box (sign-off stays sticky) and
/// refreshes status so the lists, diff, and ahead/behind reflect the new HEAD.
export async function doCommit(): Promise<void> {
  const subject = appState.commitSubject.trim();
  if (!subject || appState.committing) return;
  if (stagedCount() === 0 && !appState.commitAmend) {
    appState.error = "No staged changes to commit.";
    return;
  }
  appState.committing = true;
  appState.error = null;
  try {
    await commitCmd(
      changesRepoPath(),
      subject,
      appState.commitBody,
      appState.commitAmend,
      appState.commitSignoff,
      appState.commitCoauthors.map((c) => c.trim()).filter(Boolean),
    );
    appState.commitSubject = "";
    appState.commitBody = "";
    appState.commitAmend = false;
    appState.commitCoauthors = [];
    // HEAD moved — drop the graph's cached log so it refetches on next visit.
    invalidateGraph();
  } catch (e) {
    appState.error = String(e);
  } finally {
    appState.committing = false;
    await loadStatus();
  }
}
