import { appState } from "./store.svelte";
import {
  addManualRepo,
  addRecentRepo,
  listRefs,
  listSubmodules,
  removeManualRepo,
  validateRepo,
} from "./git";
import { compare } from "./compare";
import type { RepoEntry, RepoFile } from "./types";

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
 * Resolve a repo-qualified file target (§13.3 #23) to the absolute repo
 * path needed by `blameFile` / `readRepoFile`. Returns null when the
 * workspace no longer contains that repo idx (e.g. user switched main).
 */
export function repoPathFor(target: RepoFile | null): string | null {
  if (!target) return null;
  return appState.repos[target.repoIdx]?.path ?? null;
}

/**
 * Open `path` as the workspace main repo. Clears the previous workspace's
 * compare / blame state, builds the new workspace (submodules + saved
 * manual repos), and triggers an initial compare when worktree mode is
 * active.
 *
 * Used by RepoChip popover (recents click, Browse, drag-drop) and by
 * InputBar's window-level drag handler.
 */
export async function loadMainRepo(path: string): Promise<void> {
  appState.loadingRepo = true;
  appState.error = null;
  // Clear previous repo's compare state — branches/files no longer apply.
  appState.files = [];
  appState.selectedFile = null;
  appState.startBranch = "";
  appState.targetBranch = "";
  // Blame-mode caches/file pin from the previous repo are also stale.
  appState.repoFiles = [];
  appState.blameTarget = null;
  try {
    await validateRepo(path);
    appState.repoPath = path;
    const manualPaths = appState.manualReposByMain[path] ?? [];
    appState.repos = await buildWorkspace(path, manualPaths);
    appState.activeRepoIdx = null;
    appState.collapsedRepos = new Set();
    const [branches, recentRepos] = await Promise.all([
      listRefs(path),
      addRecentRepo(path),
    ]);
    appState.branches = branches;
    appState.recentRepos = recentRepos;
    // Working tree mode has no inputs to fill in — load immediately so the
    // user sees their uncommitted changes on repo open.
    if (appState.compareMode === "worktree") {
      void compare();
    }
  } catch (e) {
    appState.error = String(e);
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
  if (
    appState.compareMode === "worktree" ||
    (appState.startBranch && appState.targetBranch)
  ) {
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
  triggerCompareIfReady();
}

function triggerCompareIfReady(): void {
  if (!appState.repoPath) return;
  if (
    appState.compareMode === "worktree" ||
    (appState.startBranch && appState.targetBranch)
  ) {
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
  if (
    appState.compareMode === "worktree" ||
    (appState.startBranch && appState.targetBranch)
  ) {
    void compare({ silent: true });
  }
}

