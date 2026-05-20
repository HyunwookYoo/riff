import { invoke } from "@tauri-apps/api/core";
import type { Branch, ChangedFile, DiffMode, FileDiff } from "./types";

export function validateRepo(path: string): Promise<void> {
  return invoke("validate_repo", { path });
}

export function listRefs(path: string): Promise<Branch[]> {
  return invoke("list_refs", { path });
}

export function diffFiles(
  path: string,
  start: string,
  target: string,
  mode: DiffMode,
): Promise<ChangedFile[]> {
  return invoke("diff_files", { path, start, target, mode });
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
