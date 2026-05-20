import { invoke } from "@tauri-apps/api/core";
import type { Branch, ChangedFile, DiffMode } from "./types";

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
