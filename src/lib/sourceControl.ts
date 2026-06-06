import { appState } from "./store.svelte";
import {
  commit as commitCmd,
  headCommitMessage,
  stage as stageCmd,
  status,
  unstage as unstageCmd,
} from "./git";
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

/// The repo whose status the Changes screen browses: the focused repo, or the
/// main repo when nothing is focused. Mirrors how compare resolves paths.
export function changesRepoPath(): string {
  const idx = appState.activeRepoIdx ?? 0;
  return appState.repos[idx]?.path ?? appState.repoPath;
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

export async function enterChangesMode(): Promise<void> {
  appState.appMode = "changes";
  await loadStatus();
}

/// Load `git status --porcelain=v2` for the active repo and auto-open the first
/// change so the diff pane isn't empty.
export async function loadStatus(): Promise<void> {
  if (!appState.repoPath) return;
  appState.loadingStatus = true;
  appState.error = null;
  try {
    const st = await status(changesRepoPath());
    appState.repoStatus = st;
    const unstaged = st.entries.filter(isUnstaged);
    const staged = st.entries.filter(isStaged);
    if (unstaged.length > 0) {
      openChange(unstaged[0], "unstaged");
    } else if (staged.length > 0) {
      openChange(staged[0], "staged");
    } else {
      appState.selectedFile = null;
    }
  } catch (e) {
    appState.error = String(e);
    appState.repoStatus = null;
    appState.selectedFile = null;
  } finally {
    appState.loadingStatus = false;
  }
}

/// Select a change on a given side. Builds a `ChangedFile` (reused verbatim by
/// DiffView) from the entry's per-side status and records the side so the diff
/// loads the right gap.
export function openChange(
  entry: StatusEntry,
  side: "staged" | "unstaged",
): void {
  const code = side === "staged" ? entry.index_status : entry.worktree_status;
  const file: ChangedFile = {
    path: entry.path,
    old_path: entry.orig_path,
    status: toFileStatus(code),
    repoIdx: appState.activeRepoIdx ?? 0,
  };
  appState.changesSide = side;
  appState.selectedFile = file;
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

export function stageEntry(entry: StatusEntry): Promise<void> {
  return applyAndReload(stageCmd(changesRepoPath(), [entry.path]));
}
export function unstageEntry(entry: StatusEntry): Promise<void> {
  return applyAndReload(unstageCmd(changesRepoPath(), [entry.path]));
}
export function stageAll(): Promise<void> {
  return applyAndReload(stageCmd(changesRepoPath(), null));
}
export function unstageAll(): Promise<void> {
  return applyAndReload(unstageCmd(changesRepoPath(), null));
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
  } catch (e) {
    appState.error = String(e);
  } finally {
    appState.committing = false;
    await loadStatus();
  }
}
