import { invoke } from "@tauri-apps/api/core";
import type { FileHunks } from "./types";

export function gitRemotes(path: string): Promise<{ name: string; url: string }[]> {
  return invoke("git_remotes", { path });
}

/** Fetch a PR head (and its base) into refs/riff/pr/<N>/*; resolves to the head SHA. */
export function fetchPr(
  path: string,
  remote: string,
  number: number,
  baseRef: string,
  baseSha: string,
): Promise<string> {
  return invoke("fetch_pr", { path, remote, number, baseRef, baseSha });
}

export function prHunks(path: string, base: string, head: string): Promise<FileHunks[]> {
  return invoke("pr_hunks", { path, base, head });
}

export function prChangedFiles(
  path: string,
  base: string,
  oldHead: string,
  newHead: string,
): Promise<string[]> {
  return invoke("pr_changed_files", { path, base, oldHead, newHead });
}

export function markPrSeen(path: string, number: number, sha: string): Promise<void> {
  return invoke("mark_pr_seen", { path, number, sha });
}
