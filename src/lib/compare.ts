import { appState } from "./store.svelte";
import { diffFiles, setCompareMode, worktreeFiles } from "./git";
import { detectLanguage } from "./diff/lang";
import { preloadLanguages } from "./diff/shiki";
import type { ChangedFile, CompareMode } from "./types";

// Monotonic id so a stale stream from a cancelled compare can't poison the
// newer one's state. The Rust side also kills its previous child, but events
// already in flight on the JS bus would otherwise still land.
let compareSession = 0;

interface CompareOptions {
  /**
   * If true, swallow errors (only log to console). Used by background
   * triggers like focus auto-refresh where surfacing an error to the user
   * would be jarring.
   */
  silent?: boolean;
  /**
   * If set, prefer to re-select the file at this path after the new file
   * list streams in. Used by drill-in Back to restore the previously viewed
   * file. Overrides the worktree-only auto-preserve default; pass `null` to
   * force "select first file".
   */
  preservePath?: string | null;
}

export async function compare(opts: CompareOptions = {}): Promise<void> {
  if (!appState.repoPath) {
    if (!opts.silent) appState.error = "no repository selected";
    return;
  }
  if (
    appState.compareMode === "branch" &&
    (!appState.startBranch || !appState.targetBranch)
  ) {
    if (!opts.silent) appState.error = "start and target are required";
    return;
  }
  const session = ++compareSession;
  // Worktree refreshes preserve the user's current selection if it survives;
  // branch compares (different ref pair) reset to the first file.
  const previousPath =
    opts.preservePath !== undefined
      ? opts.preservePath
      : appState.compareMode === "worktree"
        ? (appState.selectedFile?.path ?? null)
        : null;

  appState.loadingFiles = true;
  appState.error = null;
  appState.files = [];
  appState.selectedFile = null;

  const onFile = (file: ChangedFile) => {
    if (session !== compareSession) return;
    appState.files.push(file);
    if (previousPath) {
      if (file.path === previousPath && !appState.selectedFile) {
        appState.selectedFile = file;
      }
    } else if (!appState.selectedFile) {
      appState.selectedFile = file;
    }
    void preloadLanguages([detectLanguage(file.path)]);
  };

  try {
    if (appState.compareMode === "worktree") {
      await worktreeFiles(appState.repoPath, appState.ignoreWhitespace, onFile);
    } else {
      await diffFiles(
        appState.repoPath,
        appState.startBranch,
        appState.targetBranch,
        appState.mode,
        appState.ignoreWhitespace,
        onFile,
      );
    }
    // Previous selection didn't survive the refresh — fall back to first file.
    if (
      session === compareSession &&
      previousPath &&
      !appState.selectedFile &&
      appState.files.length > 0
    ) {
      appState.selectedFile = appState.files[0];
    }
  } catch (e) {
    if (session === compareSession) {
      if (opts.silent) {
        console.warn("background compare failed:", e);
      } else {
        appState.error = String(e);
        appState.files = [];
        appState.selectedFile = null;
      }
    }
  } finally {
    if (session === compareSession) {
      appState.loadingFiles = false;
    }
  }
}

export function setMode(m: CompareMode): void {
  if (m === appState.compareMode) return;
  appState.compareMode = m;
  void setCompareMode(m);
  appState.files = [];
  appState.selectedFile = null;
  appState.error = null;
  if (!appState.repoPath) return;
  // Auto-reload after toggling. Worktree never needs inputs; branch needs
  // both refs filled — otherwise leave it for the user to type and Compare.
  if (m === "worktree") {
    void compare();
  } else if (appState.startBranch && appState.targetBranch) {
    void compare();
  }
}

export function toggleMode(): void {
  setMode(appState.compareMode === "branch" ? "worktree" : "branch");
}
