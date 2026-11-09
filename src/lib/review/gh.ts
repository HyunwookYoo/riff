import { Channel, invoke } from "@tauri-apps/api/core";
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

/** `git diff <mergeBase> <head>` with renames detected. */
export function prDiffText(path: string, mergeBase: string, head: string): Promise<string> {
  return invoke("pr_diff_text", { path, mergeBase, head });
}

/** Commit subjects of `mergeBase..head`, newest first. */
export function prCommitSubjects(path: string, mergeBase: string, head: string): Promise<string[]> {
  return invoke("pr_commit_subjects", { path, mergeBase, head });
}

export function prChangedFiles(
  path: string,
  base: string,
  oldHead: string,
  newHead: string,
): Promise<string[]> {
  return invoke("pr_changed_files", { path, base, oldHead, newHead });
}

export interface FileCompare {
  path: string;
  oldPatch: string;
  newPatch: string;
}

/** Per file, the PR-only patch (merge-base..head) at `oldHead` and at `newHead`. */
export function prFileCompare(
  path: string,
  base: string,
  oldHead: string,
  newHead: string,
  files: string[],
): Promise<FileCompare[]> {
  return invoke("pr_file_compare", { path, base, oldHead, newHead, files });
}

/** Make a commit local by SHA (a review made on the web may not be). */
export function fetchCommit(path: string, remote: string, sha: string): Promise<void> {
  return invoke("fetch_commit", { path, remote, sha });
}

export function markPrSeen(path: string, number: number, sha: string): Promise<void> {
  return invoke("mark_pr_seen", { path, number, sha });
}

export type GhStatus = "ready" | "notinstalled" | "notloggedin";

export function ghStatus(host: string): Promise<GhStatus> {
  return invoke("gh_status", { host });
}

type LoginEvent = { kind: "code"; code: string; url: string };

// Random start: the backend's cancelled set outlives a webview reload (see rebaseCheck.ts).
let nextLoginId = crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;

/**
 * `gh auth login --web` for `host`. `onCode` gets the device code to enter at
 * `url`; `done` rejects with gh's message, or "cancelled" after `cancel()`.
 */
export function ghLogin(
  host: string,
  onCode: (c: { code: string; url: string }) => void,
): { done: Promise<void>; cancel: () => void } {
  const id = nextLoginId++;
  const channel = new Channel<LoginEvent>();
  channel.onmessage = (e) => {
    if (e.kind === "code") onCode({ code: e.code, url: e.url });
  };
  const done = invoke<void>("gh_login", { host, onEvent: channel, id });
  return { done, cancel: () => void invoke("cancel_gh_login", { id }).catch(() => {}) };
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
