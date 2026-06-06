import { appState } from "./store.svelte";
import {
  diffFiles,
  setCompareMode,
  submoduleShaAt,
  worktreeFiles,
} from "./git";
import { detectLanguage } from "./diff/lang";
import { preloadLanguages } from "./diff/shiki";
import { enterHistoryMode, restoreCompareContext } from "./commitHistory";
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
  const isTabMode = appState.workspaceLayout === "tabs";
  if (appState.compareMode === "branch") {
    // Branch mode needs refs from *somewhere*. When focused on a non-main
    // repo with its own override, that repo's refs are enough — main's
    // start/target may legitimately be blank. Otherwise main must be filled.
    // In Tabs the active tab plays the same role as Focus.
    const focusIdx = isTabMode
      ? (appState.activeRepoIdx ?? 0)
      : appState.activeRepoIdx;
    const focusedRepo = focusIdx !== null ? appState.repos[focusIdx] : null;
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

  // Worktree refreshes (focus auto-refresh, F5) re-scan the *same* ref pair —
  // HEAD vs working tree. Blanking the file list + diff pane for the scan
  // duration just to repaint the same content is jarring, so keep the current
  // snapshot on screen and swap it in one shot at the end. Branch compares
  // change refs, so the old diff is meaningless — clear upfront and stream.
  const keepStale = appState.compareMode === "worktree";
  // Fresh scan buffer for the keepStale swap-at-end path.
  const incoming: ChangedFile[] = [];

  appState.loadingFiles = true;
  appState.error = null;
  if (!keepStale) {
    appState.files = [];
    appState.selectedFile = null;
  }

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

  // C: batch file arrivals. Per-file `appState.files.push(...)` triggers
  // Svelte 5 reactivity for each push — with 100+ files that's 100+ reactive
  // cycles + render passes during the stream. Buffer arrivals and flush via
  // requestAnimationFrame so the file list grows in one batch per frame.
  // The pending languages set is also accumulated to dedupe preloadLanguages
  // calls.
  let buffer: ChangedFile[] = [];
  const pendingLangs = new Set<string | null>();
  let flushScheduled = false;
  function flushBuffer() {
    flushScheduled = false;
    if (session !== compareSession) {
      buffer = [];
      pendingLangs.clear();
      return;
    }
    if (buffer.length > 0) {
      // One reactive set vs N pushes. Spread the existing array so the
      // previous identity is preserved-but-replaced — any $derived watchers
      // observe a single change.
      appState.files = appState.files.concat(buffer);
      buffer = [];
    }
    if (pendingLangs.size > 0) {
      void preloadLanguages([...pendingLangs]);
      pendingLangs.clear();
    }
  }
  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    requestAnimationFrame(flushBuffer);
  }

  const makeOnFile = (repoIdx: number) => (file: ChangedFile) => {
    if (session !== compareSession) return;
    if (repoIdx === 0 && submoduleGitlinkPaths.has(file.path)) return;
    file.repoIdx = repoIdx;
    if (keepStale) {
      // Collect silently; the old snapshot stays on screen until the swap at
      // the end. No reactive writes to files/selectedFile during the scan.
      incoming.push(file);
      pendingLangs.add(detectLanguage(file.path));
      return;
    }
    buffer.push(file);
    // Selection updates immediately so a previously-viewed file is reopened
    // as soon as it arrives — DiffView reads selectedFile directly and
    // doesn't need the file to be in `appState.files` yet.
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
    pendingLangs.add(detectLanguage(file.path));
    scheduleFlush();
  };

  // repos[] is the source of truth. Fall back to [main only] when it hasn't
  // been built yet (defensive; loadRepo always populates it).
  const repos: RepoEntry[] =
    appState.repos.length > 0
      ? appState.repos
      : [{ path: appState.repoPath, kind: "main", displayName: "" }];
  const mainPath = repos[0].path;

  try {
    // Sequential per-repo. The Rust `GitCli` keeps a single
    // `Mutex<Option<Session>>` slot so parallel calls with different
    // paths would thrash and drop each others' children mid-stream. A
    // per-path session map would unlock real parallelism — tracked as a
    // future optimization (§14 follow-up).
    for (let i = 0; i < repos.length; i++) {
      if (session !== compareSession) break;
      if (
        !isTabMode &&
        appState.activeRepoIdx !== null &&
        appState.activeRepoIdx !== i
      ) {
        continue;
      }
      const repo = repos[i];
      try {
        await fetchRepoChanges(repo, mainPath, makeOnFile(i));
      } catch (e) {
        // One repo failing shouldn't kill the whole compare.
        console.warn(`compare: repo ${repo.path} failed:`, e);
      }
    }
    if (keepStale) {
      // Swap the stale snapshot for the fresh scan in one shot. Re-selecting
      // a *new* object for the same path (rather than keeping the old one)
      // forces DiffView to reload the file's fresh content; the double-buffer
      // there makes that swap flicker-free.
      if (session === compareSession) {
        appState.files = incoming;
        const prev = previousPath
          ? incoming.find(
              (f) =>
                f.path === previousPath &&
                (f.repoIdx ?? 0) === (previousRepoIdx ?? 0),
            )
          : undefined;
        appState.selectedFile = prev ?? incoming[0] ?? null;
        if (pendingLangs.size > 0) {
          void preloadLanguages([...pendingLangs]);
          pendingLangs.clear();
        }
      }
    } else {
      // Final flush so anything queued in the last frame lands before we
      // judge "did the previous selection survive?".
      flushBuffer();
      // Previous selection didn't survive the refresh — fall back to first file.
      if (
        session === compareSession &&
        previousPath &&
        !appState.selectedFile &&
        appState.files.length > 0
      ) {
        appState.selectedFile = appState.files[0];
      }
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

/// Cycle the workspace: branch → worktree → history → blame → branch.
/// Triggered by Ctrl+Shift+W. The cycle is positional, not a stack pop.
export function cycleAppMode(): void {
  if (appState.appMode === "blame") {
    restoreCompareContext();
    appState.appMode = "compare";
    if (appState.compareMode !== "branch") {
      setMode("branch");
    }
    return;
  }
  // Changes → branch compare. The staging view doesn't snapshot compare
  // context (it never touches start/target), so just hand back to compare.
  if (appState.appMode === "changes") {
    appState.appMode = "compare";
    if (appState.compareMode !== "branch") {
      setMode("branch");
    }
    return;
  }
  // History → blame: carry the selected file so blame opens on it.
  if (appState.appMode === "history") {
    carrySelectionToBlame();
    appState.appMode = "blame";
    return;
  }
  if (appState.compareMode === "branch") {
    setMode("worktree");
    return;
  }
  // Worktree → history.
  void enterHistoryMode();
}

/// Pin the currently selected file as the blame target so entering blame mode
/// lands on it instead of an empty picker. Repo-qualified for multi-root.
function carrySelectionToBlame(): void {
  if (appState.selectedFile) {
    appState.blameTarget = {
      repoIdx: appState.selectedFile.repoIdx ?? 0,
      path: appState.selectedFile.path,
    };
  }
}
