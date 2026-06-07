import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  Blame,
  Branch,
  ChangedFile,
  Commit,
  CompareMode,
  DiffMode,
  FileDiff,
  FileStatus,
  FileViewMode,
  Hunk,
  PersistedState,
  RepoStatus,
  SubmoduleInfo,
  ThemeChoice,
  WorkspaceLayout,
} from "./types";

export function validateRepo(path: string): Promise<void> {
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

export function setCompareMode(mode: CompareMode): Promise<void> {
  return invoke("set_compare_mode", { mode });
}

export function setWorkspaceLayout(layout: WorkspaceLayout): Promise<void> {
  return invoke("set_workspace_layout", { layout });
}

export function setBlamePickerWidth(width: number): Promise<void> {
  return invoke("set_blame_picker_width", { width });
}

export function setFileViewMode(mode: FileViewMode): Promise<void> {
  return invoke("set_file_view_mode", { mode });
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

/** Set a branch's upstream tracking ref. */
export function setUpstream(
  path: string,
  branch: string,
  upstream: string,
): Promise<void> {
  return invoke("set_upstream", { path, branch, upstream });
}

/**
 * Fetch up to `limit` commits reachable from `startRef` (empty = HEAD),
 * skipping the first `skip`. `skip` drives the history browser's "load more".
 */
export function commitLog(
  path: string,
  startRef: string,
  limit: number,
  skip: number,
): Promise<Commit[]> {
  return invoke("commit_log", { path, startRef, limit, skip });
}

/**
 * Full working-tree status (`git status --porcelain=v2 --branch`): staged /
 * unstaged / untracked entries plus the current branch's upstream and
 * ahead/behind counts. Drives the source-control Changes screen.
 */
export function status(path: string): Promise<RepoStatus> {
  return invoke("status", { path });
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
 * Stream uncommitted changes against HEAD (tracked diff + untracked files).
 * Mirrors `diffFiles` but takes no refs.
 */
export function worktreeFiles(
  path: string,
  ignoreWhitespace: boolean,
  onFile: (file: ChangedFile) => void,
): Promise<void> {
  const channel = new Channel<ChangedFile>();
  channel.onmessage = onFile;
  return invoke("worktree_files", {
    path,
    ignoreWhitespace,
    onFile: channel,
  });
}

export function worktreeFileDiff(
  path: string,
  filePath: string,
  oldPath: string | null,
  status: FileStatus,
  force: boolean,
  ueVersion: string | null = null,
): Promise<FileDiff> {
  return invoke("worktree_file_diff", {
    path,
    filePath,
    oldPath,
    status,
    force,
    ueVersion,
  });
}

/**
 * Per-side diff for the Changes screen. `staged` true → HEAD↔index gap;
 * false → index↔worktree gap. `status` is the porcelain status for that side.
 */
export function changesFileDiff(
  path: string,
  filePath: string,
  oldPath: string | null,
  status: FileStatus,
  staged: boolean,
  force: boolean,
): Promise<FileDiff> {
  return invoke("changes_file_diff", {
    path,
    filePath,
    oldPath,
    status,
    staged,
    force,
  });
}

/**
 * Stage paths into the index (`git add`). `files = null` stages everything
 * (`git add -A`); an array stages just those paths.
 */
export function stage(path: string, files: string[] | null): Promise<void> {
  return invoke("stage", { path, files });
}

/**
 * Unstage paths (`git restore --staged`), keeping working-tree changes.
 * `files = null` unstages everything.
 */
export function unstage(path: string, files: string[] | null): Promise<void> {
  return invoke("unstage", { path, files });
}

/**
 * Commit the staged index. `subject`/`body` form the message; `amend` rewrites
 * HEAD; `signoff` adds Signed-off-by; `coauthors` ("Name <email>") become
 * Co-authored-by trailers. Rejects on empty subject or hook failure.
 */
export function commit(
  path: string,
  subject: string,
  body: string,
  amend: boolean,
  signoff: boolean,
  coauthors: string[],
): Promise<void> {
  return invoke("commit", {
    path,
    subject,
    body,
    amend,
    signoff,
    coauthors,
  });
}

/** Full message of HEAD, for pre-filling the box when amending. */
export function headCommitMessage(path: string): Promise<string> {
  return invoke("head_commit_message", { path });
}

/**
 * Parse one file's unified diff into hunks. `staged` true → HEAD↔index
 * (`git diff --cached`); false → index↔worktree. Empty for untracked/binary.
 */
export function fileHunks(
  path: string,
  filePath: string,
  staged: boolean,
): Promise<Hunk[]> {
  return invoke("file_hunks", { path, filePath, staged });
}

/**
 * Stage (`staged=false`) or unstage (`staged=true`) the hunks at the given
 * indices. Rejects if an index is out of range (the file changed since listing).
 */
export function applyHunks(
  path: string,
  filePath: string,
  staged: boolean,
  hunks: number[],
): Promise<void> {
  return invoke("apply_hunks", { path, filePath, staged, hunks });
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
