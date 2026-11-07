import { invoke } from "@tauri-apps/api/core";
import type { PrHunks } from "./types";

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

export function prHunks(path: string, base: string, head: string): Promise<PrHunks> {
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

export type GhStatus = "ready" | "notinstalled" | "notloggedin";

export function ghStatus(host: string): Promise<GhStatus> {
  return invoke("gh_status", { host });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ghApi(host: string, method: string, endpoint: string, body?: unknown): Promise<any> {
  return invoke("gh_api", { host, method, endpoint, body: body ?? null });
}

export async function ghGraphql<T>(
  host: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await ghApi(host, "POST", "graphql", { query, variables });
  return res.data as T;
}

export function loadReview(key: string): Promise<unknown | null> {
  return invoke("load_review", { key });
}

export function saveReview(key: string, value: unknown): Promise<void> {
  return invoke("save_review", { key, value });
}

export function deleteReview(key: string): Promise<void> {
  return invoke("delete_review", { key });
}

export function listReviews(): Promise<string[]> {
  return invoke("list_reviews");
}
