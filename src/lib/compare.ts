import { appState } from "./store.svelte";
import { diffFiles, submoduleShaAt } from "./git";
import { detectLanguage } from "./diff/lang";
import { preloadLanguages } from "./diff/shiki";
import { restoreCompareContext } from "./commitHistory";
import { enterChangesMode } from "./sourceControl";
import type { ChangedFile, RepoEntry } from "./types";

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
  // Branch compares reset to the first file unless the caller asked to
  // preserve a path (drill-in Back). The previous repoIdx matters too in
  // multi-root — same path in two repos shouldn't false-match.
  const previousPath = opts.preservePath ?? null;
  const previousRepoIdx = appState.selectedFile?.repoIdx ?? null;

  appState.loadingFiles = true;
  appState.error = null;
  appState.files = [];
  appState.selectedFile = null;

  // Which repos this pass will actually scan (mirrors the per-repo loop's
  // skips below). A submodule that won't be scanned has no group of its own in
  // this view, which drives the gitlink decision just below.
  const willScan = (i: number) =>
    !(appState.bcDiffRange && i !== 0) &&
    !(!isTabMode && appState.activeRepoIdx !== null && appState.activeRepoIdx !== i);

  // Paths of submodule gitlinks inside main. When main lists a changed file at
  // one of these paths it's actually the submodule-pointer bump (git reports
  // submodule mods as `M\t<path>` in name-status output). Drop it ONLY when the
  // submodule's own group is also rendered this pass — that group shows the real
  // change set, so the gitlink row would be a broken duplicate. When the
  // submodule is focused-out (e.g. the graph's per-commit view on main), keep
  // the gitlink so the bump still shows as "Subproject commit a→b" instead of
  // vanishing — file_diff renders that pointer move and never reads the dir.
  const submoduleGitlinkPaths = new Set(
    appState.repos
      .filter(
        (r, i) => r.kind === "submodule" && r.parentGitlinkPath && willScan(i),
      )
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
      // A per-commit drill (Branch-mode containment) is a single-repo view —
      // diff only the main repo, not submodule gitlinks for unrelated refs.
      if (appState.bcDiffRange && i !== 0) continue;
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
    // Final flush so anything queued in the last frame lands before we judge
    // "did the previous selection survive?".
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
 * - submodule: derive old/new SHAs via submoduleShaAt from main's start/target
 *   gitlinks (gitlink-follow), unless a per-repo override is set
 * - manual: override refs if set, else same names as main
 */
async function fetchRepoChanges(
  repo: RepoEntry,
  mainPath: string,
  onFile: (file: ChangedFile) => void,
): Promise<void> {
  if (repo.kind === "main") {
    // Branch-mode containment drills into one commit via `bcDiffRange`
    // (parent..commit, two-dot) without disturbing the toolbar ref pickers.
    // null = the user's start↔target ("All changes").
    const range = appState.bcDiffRange;
    await diffFiles(
      repo.path,
      range ? range.start : appState.startBranch,
      range ? range.target : appState.targetBranch,
      range ? "two-dot" : appState.mode,
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

/// Cycle the workspace: Changes → Compare → Blame → Changes.
/// Triggered by Ctrl+Shift+W. The graph sub-view returns to Changes. The cycle
/// is positional, not a stack pop.
export function cycleAppMode(): void {
  // Graph sub-view or Blame → back to the working (Changes) view.
  if (appState.appMode === "history" || appState.appMode === "blame") {
    void enterChangesMode();
    return;
  }
  // Changes → branch compare. Restore the compare refs a graph visit may have
  // overwritten (parent..commit) before re-comparing.
  if (appState.appMode === "changes") {
    restoreCompareContext();
    appState.appMode = "compare";
    return;
  }
  // Branch compare → blame: carry the selected file so blame opens on it.
  carrySelectionToBlame();
  appState.appMode = "blame";
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
