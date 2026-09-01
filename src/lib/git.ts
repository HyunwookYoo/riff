import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  Blame,
  Branch,
  ChangedFile,
  Commit,
  Containment,
  ContainmentDetail,
  ConflictVersions,
  DiffMode,
  FileDiff,
  FileStatus,
  FileViewMode,
  PersistedState,
  ReflogEntry,
  RepoStatus,
  SubmoduleInfo,
  ThemeChoice,
  WorkspaceLayout,
} from "./types";

/// Resolves to the work tree root, which may differ from `path` when the user
/// picked a subdirectory. Callers must use the returned path, not theirs —
/// git reports every file path relative to the root.
export function validateRepo(path: string): Promise<string> {
  return invoke("validate_repo", { path });
}

export function loadState(): Promise<PersistedState> {
  return invoke("load_state");
}

export function addRecentRepo(path: string): Promise<string[]> {
  return invoke("add_recent_repo", { path });
}

export function removeRecentRepo(path: string): Promise<string[]> {
  return invoke("remove_recent_repo", { path });
}

export function setTheme(theme: ThemeChoice): Promise<void> {
  return invoke("set_theme", { theme });
}

export function setFontSize(size: number): Promise<void> {
  return invoke("set_font_size", { size });
}

export function setWorkspaceLayout(layout: WorkspaceLayout): Promise<void> {
  return invoke("set_workspace_layout", { layout });
}

export function setTabOrder(
  mainRepo: string,
  order: string[],
): Promise<void> {
  return invoke("set_tab_order", { mainRepo, order });
}

export function setBlamePickerWidth(width: number): Promise<void> {
  return invoke("set_blame_picker_width", { width });
}

export function setFileViewMode(mode: FileViewMode): Promise<void> {
  return invoke("set_file_view_mode", { mode });
}

export function setGraphRowHeight(height: number): Promise<void> {
  return invoke("set_graph_row_height", { height });
}

export function setParseUnrealAssets(enabled: boolean): Promise<void> {
  return invoke("set_parse_unreal_assets", { enabled });
}

export function setUassetguiPath(path: string | null): Promise<void> {
  return invoke("set_uassetgui_path", { path });
}

export function setUeVersionForRepo(
  repo: string,
  version: string,
): Promise<void> {
  return invoke("set_ue_version_for_repo", { repo, version });
}

export function listRefs(path: string): Promise<Branch[]> {
  return invoke("list_refs", { path });
}

/**
 * Create branch `name` (at `startPoint`, default HEAD). `checkout` also
 * switches to it.
 */
export function createBranch(
  path: string,
  name: string,
  startPoint: string | null,
  checkout: boolean,
): Promise<void> {
  return invoke("create_branch", { path, name, startPoint, checkout });
}

/** Switch the working tree to `refName` (`git checkout`). */
export function checkout(path: string, refName: string): Promise<void> {
  return invoke("checkout", { path, refName });
}

/** Fast-forward the current branch to `refName` (`git merge --ff-only`). */
export function fastForward(path: string, refName: string): Promise<void> {
  return invoke("fast_forward", { path, refName });
}

/** Read a conflicted file's base/ours/theirs index stages + working copy. */
export function conflictVersions(
  path: string,
  filePath: string,
): Promise<ConflictVersions> {
  return invoke("conflict_versions", { path, filePath });
}

/** Write `content` as the resolved file and stage it (clears the conflict). */
export function resolveConflict(
  path: string,
  filePath: string,
  content: string,
): Promise<void> {
  return invoke("resolve_conflict", { path, filePath, content });
}

/** Resolve a conflict by taking one whole side (`git checkout --ours|--theirs`). */
export function checkoutConflictSide(
  path: string,
  filePath: string,
  side: "ours" | "theirs",
): Promise<void> {
  return invoke("checkout_conflict_side", { path, filePath, side });
}

/** Rename a branch. */
export function renameBranch(
  path: string,
  oldName: string,
  newName: string,
): Promise<void> {
  return invoke("rename_branch", { path, old: oldName, new: newName });
}

/** Delete a branch. `force` (-D) drops unmerged commits — confirm first. */
export function deleteBranch(
  path: string,
  name: string,
  force: boolean,
): Promise<void> {
  return invoke("delete_branch", { path, name, force });
}

/** The 200 most recent HEAD reflog entries, newest first (`git reflog show`). */
export function reflog(path: string): Promise<ReflogEntry[]> {
  return invoke("reflog", { path });
}

/** Fetch all remotes (`git fetch --all --prune`). */
export function fetch(path: string): Promise<void> {
  return invoke("fetch", { path });
}

/**
 * Pull the current branch (fetch + merge). riff never rebases — rewriting
 * local history is outside its write surface.
 */
export function pull(path: string): Promise<void> {
  return invoke("pull", { path });
}

/** The in-progress op: "merge" | "rebase" | "cherry-pick" | "revert" | "none". */
export function pendingOp(path: string): Promise<string> {
  return invoke("pending_op", { path });
}

/** Abort the in-progress operation. */
export function opAbort(path: string, op: string): Promise<void> {
  return invoke("op_abort", { path, op });
}

/** Continue the in-progress operation (after resolving + staging conflicts). */
export function opContinue(path: string, op: string): Promise<void> {
  return invoke("op_continue", { path, op });
}

/**
 * Fetch up to `limit` commits reachable from `startRef` (empty = HEAD),
 * skipping the first `skip`. `skip` drives the history browser's "load more".
 */
export function commitLog(
  path: string,
  startRef: string,
  all: boolean,
  limit: number,
  skip: number,
): Promise<Commit[]> {
  return invoke("commit_log", { path, startRef, all, limit, skip });
}

/**
 * Containment of the loaded graph against `target`: which commits aren't in it
 * yet (●) and which are already applied as an equivalent patch (✓). `source`
 * ("" = every ref) scopes ahead/behind + patch-equivalence. Drives the graph's
 * "Compare against" highlight.
 */
export function containment(
  path: string,
  source: string,
  target: string,
): Promise<Containment> {
  return invoke("containment", { path, source, target });
}

/**
 * Like `commitLog`, but excludes everything reachable from `target`
 * (`<source|--all> --not <target>`): exactly the commits still missing from
 * target. Drives the "only not in target" filter.
 */
export function commitLogExcluding(
  path: string,
  source: string,
  target: string,
  limit: number,
  skip: number,
): Promise<Commit[]> {
  return invoke("commit_log_excluding", { path, source, target, limit, skip });
}

/** One commit's Containment detail: containing refs + the introducing merge. */
export function commitContainmentDetail(
  path: string,
  sha: string,
  target: string,
): Promise<ContainmentDetail> {
  return invoke("commit_containment_detail", { path, sha, target });
}

/**
 * Full working-tree status (`git status --porcelain=v2 --branch`): staged /
 * unstaged / untracked entries plus the current branch's upstream and
 * ahead/behind counts. Drives the source-control Changes screen.
 */
export function status(path: string): Promise<RepoStatus> {
  return invoke("status", { path });
}

/// Declare which repo roots the backend filesystem watcher observes. Submodules
/// are covered by the main root's recursive watch, so pass main + manual repos.
export function setWatchedRepos(paths: string[]): Promise<void> {
  return invoke("set_watched_repos", { paths });
}

/**
 * Stream the changed files between two refs. `onFile` is invoked once per
 * entry as it arrives from the backend. The returned promise resolves when
 * the stream ends, or rejects on error.
 */
export function diffFiles(
  path: string,
  start: string,
  target: string,
  mode: DiffMode,
  ignoreWhitespace: boolean,
  onFile: (file: ChangedFile) => void,
): Promise<void> {
  const channel = new Channel<ChangedFile>();
  channel.onmessage = onFile;
  return invoke("diff_files", {
    path,
    start,
    target,
    mode,
    ignoreWhitespace,
    onFile: channel,
  });
}

export function fileDiff(
  path: string,
  start: string,
  target: string,
  mode: DiffMode,
  filePath: string,
  oldPath: string | null,
  force: boolean,
  ueVersion: string | null = null,
): Promise<FileDiff> {
  return invoke("file_diff", {
    path,
    start,
    target,
    mode,
    filePath,
    oldPath,
    force,
    ueVersion,
  });
}


/**
 * Per-file diff for the Changes screen: always the HEAD↔working-tree gap.
 * `status` is the file's HEAD-relative porcelain status.
 */
export function changesFileDiff(
  path: string,
  filePath: string,
  oldPath: string | null,
  status: FileStatus,
  force: boolean,
  ueVersion: string | null = null,
): Promise<FileDiff> {
  return invoke("changes_file_diff", {
    path,
    filePath,
    oldPath,
    status,
    force,
    ueVersion,
  });
}

/**
 * Run `git blame --porcelain -w -M` on a file. `rev` is ignored when
 * `useContents` is true (worktree mode blames the working copy against HEAD).
 * Lines with no commit (uncommitted edits) come back with sha "00000000".
 */
/**
 * List every tracked file in the repo. Submodule gitlinks are filtered out.
 * Returns a flat list of repo-relative paths in `git ls-files` order.
 */
export function listRepoFiles(path: string): Promise<string[]> {
  return invoke("list_repo_files", { path });
}

/**
 * Read a tracked file's working-tree contents. Hard 2MB cap on the backend —
 * larger files reject with a `CommandFailed` error.
 */
export function readRepoFile(path: string, filePath: string): Promise<string> {
  return invoke("read_repo_file", { path, filePath });
}

export function blameFile(
  path: string,
  filePath: string,
  rev: string,
  useContents: boolean,
): Promise<Blame> {
  return invoke("blame_file", {
    path,
    filePath,
    rev,
    useContents,
  });
}

/** Commits that touched `filePath` (newest first) — the file-timelapse timeline. */
export function fileRevisions(path: string, filePath: string): Promise<Commit[]> {
  return invoke("file_revisions", { path, filePath });
}

/**
 * One timelapse frame: the file at `sha` plus change ranges vs `prevSha` (the
 * older adjacent revision; null → diff against empty). Same `FileDiff` shape as
 * the diff viewer; only the `text` variant is playable.
 */
export function timelapseFrame(
  path: string,
  sha: string,
  prevSha: string | null,
  filePath: string,
): Promise<FileDiff> {
  return invoke("timelapse_frame", { path, sha, prevSha, filePath });
}

/**
 * Parse `.gitmodules` (via `git config -z`) and return declared submodules.
 * Empty list when there is no `.gitmodules` or it has no entries.
 */
export function listSubmodules(path: string): Promise<SubmoduleInfo[]> {
  return invoke("list_submodules", { path });
}

/**
 * Look up the gitlink commit SHA for `submodulePath` inside `treeIsh`
 * (a branch / tag / commit). Returns null when the path is not a gitlink
 * at that tree. Used for gitlink-follow branch compare (§13.3 #7).
 */
export function submoduleShaAt(
  path: string,
  treeIsh: string,
  submodulePath: string,
): Promise<string | null> {
  return invoke("submodule_sha_at", {
    path,
    treeIsh,
    submodulePath,
  });
}

export function addManualRepo(
  mainRepo: string,
  repo: string,
): Promise<string[]> {
  return invoke("add_manual_repo", { mainRepo, repo });
}

export function removeManualRepo(
  mainRepo: string,
  repo: string,
): Promise<string[]> {
  return invoke("remove_manual_repo", { mainRepo, repo });
}
