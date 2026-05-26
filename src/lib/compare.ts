import { appState } from "./store.svelte";
import {
  diffFiles,
  setCompareMode,
  submoduleShaAt,
  worktreeFiles,
} from "./git";
import { detectLanguage } from "./diff/lang";
import { preloadLanguages } from "./diff/shiki";
import type { ChangedFile, CompareMode, RepoEntry } from "./types";

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
  if (appState.compareMode === "branch") {
    // Branch mode needs refs from *somewhere*. When focused on a non-main
    // repo with its own override, that repo's refs are enough — main's
    // start/target may legitimately be blank. Otherwise main must be filled.
    const focusedRepo =
      appState.activeRepoIdx !== null
        ? appState.repos[appState.activeRepoIdx]
        : null;
    const focusedHasOwnRefs =
      focusedRepo && focusedRepo.kind !== "main" && !!focusedRepo.override;
    if (
      !focusedHasOwnRefs &&
      (!appState.startBranch || !appState.targetBranch)
    ) {
      if (!opts.silent) appState.error = "start and target are required";
      return;
    }
  }
  const session = ++compareSession;
  // Worktree refreshes preserve the user's current selection if it survives;
  // branch compares (different ref pair) reset to the first file. With
  // multi-root, the previous repoIdx matters too — same path in two repos
  // shouldn't false-match.
  const previousPath =
    opts.preservePath !== undefined
      ? opts.preservePath
      : appState.compareMode === "worktree"
        ? (appState.selectedFile?.path ?? null)
        : null;
  const previousRepoIdx = appState.selectedFile?.repoIdx ?? null;

  appState.loadingFiles = true;
  appState.error = null;
  appState.files = [];
  appState.selectedFile = null;

  // Paths of submodule gitlinks inside main. When main lists a changed
  // file at one of these paths it's actually the submodule-pointer bump
  // (git reports submodule mods as `M\t<path>` in name-status output).
  // Drop those — the submodule's own group renders the real change set
  // with the right semantics, and clicking the gitlink as a regular file
  // would try to read a directory and trigger ACCESS_DENIED.
  const submoduleGitlinkPaths = new Set(
    appState.repos
      .filter((r) => r.kind === "submodule" && r.parentGitlinkPath)
      .map((r) => r.parentGitlinkPath!),
  );

  const makeOnFile = (repoIdx: number) => (file: ChangedFile) => {
    if (session !== compareSession) return;
    if (repoIdx === 0 && submoduleGitlinkPaths.has(file.path)) return;
    file.repoIdx = repoIdx;
    appState.files.push(file);
    if (previousPath) {
      if (
        file.path === previousPath &&
        file.repoIdx === previousRepoIdx &&
        !appState.selectedFile
      ) {
        appState.selectedFile = file;
      }
    } else if (!appState.selectedFile) {
      appState.selectedFile = file;
    }
    void preloadLanguages([detectLanguage(file.path)]);
  };

  // repos[] is the source of truth. Fall back to [main only] when it hasn't
  // been built yet (defensive; loadRepo always populates it).
  const repos: RepoEntry[] =
    appState.repos.length > 0
      ? appState.repos
      : [{ path: appState.repoPath, kind: "main", displayName: "" }];
  const mainPath = repos[0].path;

  try {
    for (let i = 0; i < repos.length; i++) {
      if (session !== compareSession) break;
      // Focus (§13.3 #15-19): skip repos that aren't the active one. During
      // a commit drill-in the refs only make sense for one repo anyway, and
      // for manual Focus the user explicitly asked to see just this repo.
      if (
        appState.activeRepoIdx !== null &&
        appState.activeRepoIdx !== i
      ) {
        continue;
      }
      const repo = repos[i];
      try {
        await fetchRepoChanges(repo, mainPath, makeOnFile(i));
      } catch (e) {
        // One repo failing shouldn't kill the whole compare. Submodule pointer
        // missing, override refs invalid, manual repo's branches don't
        // exist — all common and recoverable. Log; user sees that repo's
        // group is empty.
        console.warn(`compare: repo ${repo.path} failed:`, e);
      }
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

/**
 * Fetch one repo's changed files for the current compare mode/refs and feed
 * them to `onFile`. Implements the per-kind resolution rules (§13.3 #7-#10):
 *
 * - main: refs from appState directly
 * - submodule (branch mode): derive old/new SHAs via submoduleShaAt from
 *   main's start/target gitlinks (gitlink-follow)
 * - submodule (worktree mode): plain `git diff HEAD` inside the submodule
 * - manual: override refs if set, else same names as main
 */
async function fetchRepoChanges(
  repo: RepoEntry,
  mainPath: string,
  onFile: (file: ChangedFile) => void,
): Promise<void> {
  if (appState.compareMode === "worktree") {
    await worktreeFiles(repo.path, appState.ignoreWhitespace, onFile);
    return;
  }
  // Branch mode below.
  if (repo.kind === "main") {
    await diffFiles(
      repo.path,
      appState.startBranch,
      appState.targetBranch,
      appState.mode,
      appState.ignoreWhitespace,
      onFile,
    );
    return;
  }
  if (repo.kind === "submodule") {
    // Per-repo override (§13.3 #9) wins over gitlink-follow when set. Useful
    // when the user wants to compare two branches *inside* the submodule
    // independently of where main's gitlinks point.
    if (repo.override) {
      const { startBranch, targetBranch } = repo.override;
      if (!startBranch || !targetBranch) return;
      await diffFiles(
        repo.path,
        startBranch,
        targetBranch,
        appState.mode,
        appState.ignoreWhitespace,
        onFile,
      );
      return;
    }
    if (!repo.parentGitlinkPath) return;
    const [oldSha, newSha] = await Promise.all([
      submoduleShaAt(mainPath, appState.startBranch, repo.parentGitlinkPath),
      submoduleShaAt(mainPath, appState.targetBranch, repo.parentGitlinkPath),
    ]);
    // Both sides must resolve to a gitlink commit. Newly-added or removed
    // submodules (one side null) are skipped for now — §13.10 tracks this.
    if (!oldSha || !newSha || oldSha === newSha) return;
    await diffFiles(
      repo.path,
      oldSha,
      newSha,
      appState.mode,
      appState.ignoreWhitespace,
      onFile,
    );
    return;
  }
  if (repo.kind === "manual") {
    const start = repo.override?.startBranch ?? appState.startBranch;
    const target = repo.override?.targetBranch ?? appState.targetBranch;
    if (!start || !target) return;
    await diffFiles(
      repo.path,
      start,
      target,
      appState.mode,
      appState.ignoreWhitespace,
      onFile,
    );
    return;
  }
  // Exhaustive: unreachable for known RepoKind values.
  const _exhaustive: never = repo.kind;
  void _exhaustive;
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

/// Cycle the workspace: branch-compare → worktree-compare → blame → branch-compare.
/// Triggered by Ctrl+Shift+W. Leaving blame always lands on branch-compare —
/// the cycle is positional, not a stack pop.
export function cycleAppMode(): void {
  if (appState.appMode === "blame") {
    appState.appMode = "compare";
    if (appState.compareMode !== "branch") {
      setMode("branch");
    }
    return;
  }
  if (appState.compareMode === "branch") {
    setMode("worktree");
    return;
  }
  // Entering blame from compare: carry the currently selected file over so
  // the user lands on its blame view instead of an empty picker. The current
  // selection always wins — a stale blameTarget from an earlier visit would
  // be confusing here. Repo-qualified so multi-root opens the right repo.
  if (appState.selectedFile) {
    appState.blameTarget = {
      repoIdx: appState.selectedFile.repoIdx ?? 0,
      path: appState.selectedFile.path,
    };
  }
  appState.appMode = "blame";
}
