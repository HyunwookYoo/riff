import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  Blame,
  Branch,
  ChangedFile,
  CompareMode,
  DiffMode,
  FileDiff,
  FileStatus,
  PersistedState,
  SubmoduleInfo,
  ThemeChoice,
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

export function listRefs(path: string): Promise<Branch[]> {
  return invoke("list_refs", { path });
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
): Promise<FileDiff> {
  return invoke("file_diff", {
    path,
    start,
    target,
    mode,
    filePath,
    oldPath,
    force,
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
): Promise<FileDiff> {
  return invoke("worktree_file_diff", {
    path,
    filePath,
    oldPath,
    status,
    force,
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
