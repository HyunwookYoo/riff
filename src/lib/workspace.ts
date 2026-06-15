import { appState } from "./store.svelte";
import {
  addManualRepo,
  addRecentRepo,
  listRefs,
  listRepoFiles,
  listSubmodules,
  removeManualRepo,
  submoduleShaAt,
  validateRepo,
} from "./git";
import { compare } from "./compare";
import { resetHistory } from "./commitHistory";
import {
  loadCurrentBranch,
  loadPendingOp,
  loadStashes,
  loadStatus,
  resetSourceControl,
} from "./sourceControl";
import { clearBlameCache } from "./blameCache";
import type { Branch, RepoEntry, RepoFile } from "./types";

/**
 * Last path component, OS-agnostic. Trims trailing slashes so paths like
 * `C:\repo\` produce `repo`, not an empty string.
 */
function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Build the full workspace repo list (§13.4) given the main repo path and
 * any manually saved extras. The main repo is always entry 0. Submodules
 * declared in `.gitmodules` are appended automatically — uninitialized ones
 * are skipped (their working tree doesn't exist on disk, so there's nothing
 * to diff). Manual repos that no longer resolve to a valid git repo are
 * dropped silently.
 *
 * Discovery failures are non-fatal: a bad `.gitmodules` shouldn't block the
 * user from opening their main repo. On any error this falls back to
 * `[main only]`.
 */
export async function buildWorkspace(
  mainPath: string,
  manualPaths: string[],
): Promise<RepoEntry[]> {
  const repos: RepoEntry[] = [
    {
      path: mainPath,
      kind: "main",
      displayName: basename(mainPath),
    },
  ];

  try {
    const submodules = await listSubmodules(mainPath);
    for (const sm of submodules) {
      // Uninitialized submodule = no working tree → no files to diff, no
      // blame target. Skip entirely; the user can `git submodule update`
      // and reopen the repo.
      if (!sm.initialized) continue;
      repos.push({
        path: sm.absolute_path,
        kind: "submodule",
        displayName: sm.path, // relative path inside main, e.g. "vendor/sub"
        parentGitlinkPath: sm.path,
      });
    }
  } catch (e) {
    console.warn("listSubmodules failed:", e);
  }

  // Validate manual repos in parallel and append the valid ones in their
  // saved order. Failed entries fall through silently — the user can retry
  // via the Add repo UI later.
  const validated = await Promise.all(
    manualPaths.map(async (p) => {
      try {
        await validateRepo(p);
        return p;
      } catch {
        return null;
      }
    }),
  );
  for (const p of validated) {
    if (p === null) continue;
    repos.push({
      path: p,
      kind: "manual",
      displayName: basename(p),
    });
  }

  return repos;
}

/**
 * Lazy-load and cache `git for-each-ref` output for the repo at `idx`. Used
 * by BranchPicker to populate the dropdown for non-main repos (main is
 * mirrored into the cache at load time by loadMainRepo). Failures are
 * non-fatal — returns an empty list so the picker can still accept
 * free-text input.
 */
export async function loadBranchesFor(idx: number): Promise<Branch[]> {
  if (appState.branchesByRepoIdx[idx]) {
    return appState.branchesByRepoIdx[idx];
  }
  const repo = appState.repos[idx];
  if (!repo) return [];
  try {
    const branches = await listRefs(repo.path);
    appState.branchesByRepoIdx = {
      ...appState.branchesByRepoIdx,
      [idx]: branches,
    };
    return branches;
  } catch (e) {
    console.warn(`listRefs failed for ${repo.path}:`, e);
    appState.branchesByRepoIdx = {
      ...appState.branchesByRepoIdx,
      [idx]: [],
    };
    return [];
  }
}

/// Force-refetch branches for `idx`, replacing any cached list. `loadBranchesFor`
/// is a write-once cache, so call this after a branch-mutating op (create /
/// checkout / delete / rename / fast-forward) so consumers that read
/// `branchesByRepoIdx` — the graph badge merge, checkout DWIM, branch pickers —
/// see fresh local/remote refs instead of stale ones.
export async function reloadBranchesFor(idx: number): Promise<void> {
  const repo = appState.repos[idx];
  if (!repo) return;
  try {
    const branches = await listRefs(repo.path);
    appState.branchesByRepoIdx = {
      ...appState.branchesByRepoIdx,
      [idx]: branches,
    };
  } catch (e) {
    console.warn(`listRefs failed for ${repo.path}:`, e);
  }
}

/**
 * Resolve a repo-qualified file target (§13.3 #23) to the absolute repo
 * path needed by `blameFile` / `readRepoFile`. Returns null when the
 * workspace no longer contains that repo idx (e.g. user switched main).
 */
export function repoPathFor(target: RepoFile | null): string | null {
  if (!target) return null;
  return appState.repos[target.repoIdx]?.path ?? null;
}

/**
 * Background-populate `appState.repoFiles` from every workspace repo's
 * `git ls-files` so the blame picker opens instantly. Idempotent — bails
 * early when the list is already populated, or when the user has navigated
 * away mid-flight (path mismatch).
 *
 * Errors per-repo are swallowed (logged) so a single broken repo can't
 * block the others from showing up.
 */
async function prewarmRepoFiles(
  expectedMainPath: string,
  repos: RepoEntry[],
): Promise<void> {
  if (appState.repoFiles.length > 0) return;
  if (repos.length === 0) return;
  try {
    const lists = await Promise.all(
      repos.map(async (r) => {
        try {
          return await listRepoFiles(r.path);
        } catch (e) {
          console.warn(`prewarm listRepoFiles failed for ${r.path}:`, e);
          return [] as string[];
        }
      }),
    );
    if (appState.repoPath !== expectedMainPath) return;
    if (appState.repoFiles.length > 0) return;
    const out: RepoFile[] = [];
    for (let i = 0; i < lists.length; i++) {
      for (const path of lists[i]) {
        out.push({ repoIdx: i, path });
      }
    }
    appState.repoFiles = out;
  } catch (e) {
    console.warn("prewarmRepoFiles failed:", e);
  }
}

/**
 * Resolve the (repo path, start ref, target ref) tuple to use when
 * fetching a single file's diff from `repos[idx]`. Mirrors the per-kind
 * rules in compare()'s fetchRepoChanges so DiffView opens the right file
 * with the same refs that compare() listed it under.
 *
 * Returns null when the refs can't be resolved (missing inputs, missing
 * gitlink, etc.) — caller should treat that as "no diff available".
 */
export async function resolveDiffRefsFor(
  idx: number,
): Promise<{ path: string; start: string; target: string } | null> {
  const repo = appState.repos[idx];
  if (!repo) return null;
  if (repo.kind === "main") {
    if (!appState.startBranch || !appState.targetBranch) return null;
    return {
      path: repo.path,
      start: appState.startBranch,
      target: appState.targetBranch,
    };
  }
  if (repo.override) {
    const { startBranch, targetBranch } = repo.override;
    if (!startBranch || !targetBranch) return null;
    return { path: repo.path, start: startBranch, target: targetBranch };
  }
  if (repo.kind === "submodule") {
    if (!repo.parentGitlinkPath) return null;
    if (!appState.startBranch || !appState.targetBranch) return null;
    const mainPath = appState.repos[0]?.path;
    if (!mainPath) return null;
    const [oldSha, newSha] = await Promise.all([
      submoduleShaAt(mainPath, appState.startBranch, repo.parentGitlinkPath),
      submoduleShaAt(mainPath, appState.targetBranch, repo.parentGitlinkPath),
    ]);
    if (!oldSha || !newSha) return null;
    return { path: repo.path, start: oldSha, target: newSha };
  }
  // manual + no override: match main's branch names
  if (!appState.startBranch || !appState.targetBranch) return null;
  return {
    path: repo.path,
    start: appState.startBranch,
    target: appState.targetBranch,
  };
}

/**
 * Open `path` as the workspace main repo. Clears the previous workspace's
 * compare / blame state, builds the new workspace (submodules + saved
 * manual repos), and triggers an initial compare when worktree mode is
 * active.
 *
 * Used by RepoChip popover (recents click, Browse, drag-drop) and by
 * InputBar's window-level drag handler. `opts.silent` swallows the error
 * banner — used by the startup auto-restore so a stale recent entry
 * (folder deleted, etc.) doesn't greet the user on launch.
 */
export async function loadMainRepo(
  path: string,
  opts: { silent?: boolean } = {},
): Promise<void> {
  appState.loadingRepo = true;
  if (!opts.silent) appState.error = null;
  // Clear previous repo's compare state — branches/files no longer apply.
  appState.files = [];
  appState.selectedFile = null;
  appState.startBranch = "";
  appState.targetBranch = "";
  // Blame-mode caches/file pin from the previous repo are also stale.
  appState.repoFiles = [];
  appState.blameTarget = null;
  // History browser's commit log belongs to the old repo — drop it.
  resetHistory();
  resetSourceControl();
  clearBlameCache();
  try {
    await validateRepo(path);
    appState.repoPath = path;
    const manualPaths = appState.manualReposByMain[path] ?? [];
    appState.repos = await buildWorkspace(path, manualPaths);
    appState.activeRepoIdx = null;
    appState.collapsedRepos = new Set();
    appState.branchesByRepoIdx = {};
    const [branches, recentRepos] = await Promise.all([
      listRefs(path),
      addRecentRepo(path),
    ]);
    appState.branches = branches;
    // Mirror main's branches into the per-repo cache so BranchPicker can
    // pull from one source regardless of which repo is focused.
    appState.branchesByRepoIdx = { 0: branches };
    appState.recentRepos = recentRepos;
    // Populate the toolbar branch chip + stash list up front.
    void loadCurrentBranch();
    void loadStashes();
    // Pre-warm the blame picker's file list in the background. BlameView's
    // own `$effect` does the same lazily on first entry, but kicking it off
    // here hides the latency: by the time the user clicks Blame the list is
    // usually already populated and entering blame mode feels instant.
    // Cheap to skip if the user never enters blame — listRepoFiles for each
    // repo runs in parallel, and the backend caches the result.
    void prewarmRepoFiles(path, appState.repos);
    // The Working (Changes) view is the default on app open — populate its
    // status here (loadMainRepo doesn't otherwise). Other modes load on entry,
    // and a mid-session repo switch keeps whatever mode the user is in.
    if (appState.appMode === "changes") {
      void loadStatus();
      void loadPendingOp();
    }
  } catch (e) {
    if (opts.silent) {
      console.warn("loadMainRepo failed:", e);
    } else {
      appState.error = String(e);
    }
    appState.branches = [];
  } finally {
    appState.loadingRepo = false;
  }
}

/**
 * Add `path` as a manual repo for the current main and rebuild the
 * workspace so the new repo's files surface immediately. No-op when no
 * main is open, when the path is the main itself, or when it's already a
 * workspace repo.
 */
export async function addManualRepoToWorkspace(path: string): Promise<void> {
  const main = appState.repoPath;
  if (!main) return;
  if (path === main) return;
  if (appState.repos.some((r) => r.path === path)) return;
  try {
    await validateRepo(path);
  } catch (e) {
    appState.error = `not a git repo: ${e}`;
    return;
  }
  try {
    const list = await addManualRepo(main, path);
    appState.manualReposByMain = {
      ...appState.manualReposByMain,
      [main]: list,
    };
  } catch (e) {
    appState.error = String(e);
    return;
  }
  appState.repos = await buildWorkspace(
    main,
    appState.manualReposByMain[main] ?? [],
  );
  // Repopulate file lists (blame picker) and changed files (compare).
  appState.repoFiles = [];
  if (appState.startBranch && appState.targetBranch) {
    void compare({ silent: true });
  }
}

/**
 * Set / clear a per-repo branch override (§13.3 #9). Main repo is excluded
 * — its refs come from InputBar. Triggers a silent compare so the new refs
 * apply immediately.
 *
 * Session-only: overrides are not persisted across app restarts. (§13.11
 * tracks whether to persist this; for now the chip popover discloses the
 * setting on every load.)
 */
export function setRepoOverride(
  idx: number,
  startBranch: string,
  targetBranch: string,
): void {
  const repo = appState.repos[idx];
  if (!repo || repo.kind === "main") return;
  const next = [...appState.repos];
  next[idx] = {
    ...repo,
    override: { startBranch, targetBranch },
  };
  appState.repos = next;
  triggerCompareIfReady();
}

export function clearRepoOverride(idx: number): void {
  const repo = appState.repos[idx];
  if (!repo || !repo.override) return;
  const next = [...appState.repos];
  next[idx] = { ...repo, override: undefined };
  appState.repos = next;
  // When branch mode + main has no refs, triggerCompareIfReady bails and
  // compare() would early-return without touching appState.files. Prune this
  // repo's stale entries synchronously so the UI matches the cleared override.
  if (
    appState.compareMode === "branch" &&
    (!appState.startBranch || !appState.targetBranch)
  ) {
    appState.files = appState.files.filter((f) => (f.repoIdx ?? 0) !== idx);
    if (
      appState.selectedFile &&
      (appState.selectedFile.repoIdx ?? 0) === idx
    ) {
      appState.selectedFile = null;
    }
  }
  triggerCompareIfReady();
}

function triggerCompareIfReady(): void {
  if (!appState.repoPath) return;
  // Active repo with its own override needs no main refs (§13.3 #9 — let
  // submodule-only comparisons work without the user first filling main).
  const idx = appState.activeRepoIdx;
  if (idx !== null) {
    const r = appState.repos[idx];
    if (r && r.kind !== "main" && r.override) {
      void compare({ silent: true });
      return;
    }
  }
  if (appState.startBranch && appState.targetBranch) {
    void compare({ silent: true });
  }
}

/**
 * Remove `path` from the manual-repo list for the current main and rebuild.
 * Silently no-ops for non-manual entries (main + submodule must be removed
 * via different mechanisms).
 */
export async function removeManualRepoFromWorkspace(
  path: string,
): Promise<void> {
  const main = appState.repoPath;
  if (!main) return;
  const entry = appState.repos.find((r) => r.path === path);
  if (!entry || entry.kind !== "manual") return;
  try {
    const list = await removeManualRepo(main, path);
    const next = { ...appState.manualReposByMain };
    if (list.length === 0) delete next[main];
    else next[main] = list;
    appState.manualReposByMain = next;
  } catch (e) {
    appState.error = String(e);
    return;
  }
  appState.repos = await buildWorkspace(
    main,
    appState.manualReposByMain[main] ?? [],
  );
  appState.repoFiles = [];
  if (appState.startBranch && appState.targetBranch) {
    void compare({ silent: true });
  }
}

