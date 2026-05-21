import { invoke } from "@tauri-apps/api/core";
import type {
  Branch,
  ChangedFile,
  DiffMode,
  FileDiff,
  PersistedState,
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

export function listRefs(path: string): Promise<Branch[]> {
  return invoke("list_refs", { path });
}

export function diffFiles(
  path: string,
  start: string,
  target: string,
  mode: DiffMode,
  ignoreWhitespace: boolean,
): Promise<ChangedFile[]> {
  return invoke("diff_files", {
    path,
    start,
    target,
    mode,
    ignoreWhitespace,
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
