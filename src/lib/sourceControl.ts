import { appState } from "./store.svelte";
import { status } from "./git";
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
