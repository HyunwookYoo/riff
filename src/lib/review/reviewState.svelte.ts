import { appState } from "../store.svelte";
import { readFileAt } from "../git";
import { reanchorAll } from "./draft";
import { loadRecord, saveRecord } from "./draftStore";
import { deleteReview, fetchPr, listReviews, markPrSeen, prChangedFiles, prHunks } from "./gh";
import { prDetail } from "./github";
import { headMoveFor, keysToDelete, listedHeadMove, loadPrList, REFRESH_MS, type HostState } from "./prList";
import type { FileHunks, PrDetail, PrKey, PrRecord, PrSummary, ReviewThread } from "./types";

export const UNREADABLE = "This PR's saved draft can't be read; riff won't overwrite it.";

class ReviewState {
  prs = $state<PrSummary[]>([]);
  hosts = $state<HostState[]>([]);
  /** Open repos with a GitHub-like remote at the last list load; null before one. */
  githubRepos = $state<number | null>(null);
  loadingList = $state(false);
  selectedKey = $state<PrKey | null>(null);
  /** The head sha actually displayed; the only sha viewedHead/seen may be set to. */
  headSha = $state<string | null>(null);
  /** The base sha `files` (hunks) were computed against. */
  baseSha = $state<string | null>(null);
  detail = $state<PrDetail | null>(null);
  files = $state<FileHunks[]>([]);
  record = $state<PrRecord | null>(null);
  selectedPath = $state<string | null>(null);
  headMoved = $state<{ from: string; to: string } | null>(null);
  newSinceFiles = $state<string[]>([]);
  error = $state<string | null>(null);
}

export const reviewState = new ReviewState();

// Sequence tokens: a newer call supersedes an older one, whose results are dropped.
let listSeq = 0;
let openSeq = 0;
/** Bumped whenever openPr sets the displayed head. */
let shownSeq = 0;

export async function refreshList(): Promise<void> {
  const seq = ++listSeq;
  const shown = shownSeq;
  reviewState.loadingList = true;
  try {
    const r = await loadPrList(appState.repos);
    if (seq !== listSeq) return;
    const s = reviewState;
    s.prs = r.prs;
    s.hosts = r.hosts;
    s.githubRepos = r.githubRepos;
    // A push since the PR was opened. A list requested before the displayed
    // head was set may predate it, so it can't tell.
    const moved = shown === shownSeq ? listedHeadMove(r.prs, s.selectedKey, s.headSha, s.headMoved) : null;
    if (moved) s.headMoved = moved;
    void cleanupRecords().catch(() => {});
  } catch (e) {
    if (seq === listSeq) reviewState.error = String(e);
  } finally {
    if (seq === listSeq) reviewState.loadingList = false;
  }
}

async function readSide(repo: string, rev: string, file: string): Promise<string | undefined> {
  try {
    return await readFileAt(repo, rev, file);
  } catch {
    return undefined; // absent on this side (added/deleted)
  }
}

/**
 * Full text per `${path}|${side}` that the record's line items refer to. LEFT
 * is read at the merge-base: GitHub's LEFT lines (and the diff's old side) are.
 */
async function sideTexts(
  repo: string,
  rec: PrRecord,
  files: FileHunks[],
  mergeBase: string,
  headSha: string,
): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  const wanted = new Set<string>();
  for (const i of rec.items) {
    if (i.target.kind === "line") wanted.add(`${i.target.path}|${i.target.side}`);
  }
  await Promise.all(
    [...wanted].map(async (k) => {
      const sep = k.lastIndexOf("|");
      const path = k.slice(0, sep);
      const text =
        k.slice(sep + 1) === "RIGHT"
          ? await readSide(repo, headSha, path)
          : await readSide(repo, mergeBase, files.find((f) => f.path === path)?.oldPath ?? path);
      if (text !== undefined) texts.set(k, text);
    }),
  );
  return texts;
}

export async function openPr(key: PrKey): Promise<void> {
  const seq = ++openSeq;
  const s = reviewState;
  const summary = s.prs.find((p) => p.key === key);
  if (!summary) return;
  s.selectedKey = key;
  s.headSha = null;
  s.baseSha = null;
  s.error = null;
  s.detail = null;
  s.files = [];
  s.record = null;
  s.selectedPath = null;
  s.headMoved = null;
  s.newSinceFiles = [];
  const repoPath = appState.repos[summary.repoIdx].path;
  try {
    let headSha = await fetchPr(repoPath, summary.remote, summary.number, summary.baseRef, summary.baseSha);
    if (seq !== openSeq) return;
    const detail = await prDetail(summary.repo.host, summary.nodeId);
    if (seq !== openSeq) return;
    // The detail's base, not the (older) list's: the base branch may have moved.
    const { baseSha } = detail;
    if (detail.headSha !== headSha || baseSha !== summary.baseSha) {
      // A push landed between the calls: fetch the newer head (and base) once.
      headSha = await fetchPr(repoPath, summary.remote, summary.number, summary.baseRef, baseSha);
      if (seq !== openSeq) return;
    }
    const { mergeBase, files } = await prHunks(repoPath, baseSha, headSha);
    if (seq !== openSeq) return;
    let rec: PrRecord;
    try {
      rec = await loadRecord(key);
    } catch (e) {
      if (seq !== openSeq) return;
      if (e instanceof Error && e.message === "unreadable-review-record") {
        s.headSha = headSha;
        shownSeq++;
        s.baseSha = baseSha;
        s.detail = detail;
        s.files = files;
        s.error = UNREADABLE; // record stays null; never saved over
        return;
      }
      throw e;
    }
    if (seq !== openSeq) return;

    let dirty = false;
    if (rec.viewedHead === null) {
      rec = { ...rec, viewedHead: headSha };
      await markPrSeen(repoPath, summary.number, headSha);
      dirty = true;
    }
    const moved = headMoveFor(rec, headSha);
    const newSince = moved ? await prChangedFiles(repoPath, baseSha, moved.from, headSha) : [];
    if (rec.anchorHead !== null && rec.anchorHead !== headSha) {
      const texts = await sideTexts(repoPath, rec, files, mergeBase, headSha);
      rec = reanchorAll(rec, headSha, texts, files);
      dirty = true;
    } else if (rec.anchorHead === null) {
      rec = { ...rec, anchorHead: headSha };
      dirty = true;
    }
    if (seq !== openSeq) return;
    if (dirty) await saveRecord(rec);
    if (seq !== openSeq) return;
    s.headSha = headSha;
    shownSeq++;
    s.baseSha = baseSha;
    s.detail = detail;
    s.files = files;
    s.record = rec;
    // If the PR still moved past the displayed head, keep the gate explicit.
    s.headMoved = moved ?? (detail.headSha !== headSha ? { from: headSha, to: detail.headSha } : null);
    s.newSinceFiles = newSince;
    s.selectedPath = sortedPaths(files)[0] ?? null;
  } catch (e) {
    if (seq === openSeq) s.error = String(e);
  }
}

/** The review file list order (path order); file navigation follows it. */
export function sortedPaths(files: FileHunks[]): string[] {
  return files.map((f) => f.path).sort();
}

/** Shown at its line; outdated and file-level threads go to the Outdated area. */
export function isInlineThread(t: ReviewThread): boolean {
  return !t.isOutdated && t.line !== null;
}

let detailSeq = 0;

/** Re-reads the open PR's detail (threads, conversation) in place. */
export async function reloadDetail(): Promise<void> {
  const s = reviewState;
  const key = s.selectedKey;
  const seq = openSeq;
  const dseq = ++detailSeq;
  const summary = s.prs.find((p) => p.key === key);
  if (!summary || !s.detail) return;
  const detail = await prDetail(summary.repo.host, summary.nodeId);
  if (seq !== openSeq || dseq !== detailSeq || s.selectedKey !== key) return;
  s.detail = detail;
  // As in openPr: the PR moved past the displayed head, keep the gate explicit.
  if (s.headSha && detail.headSha !== s.headSha && !s.headMoved) {
    s.headMoved = { from: s.headSha, to: detail.headSha };
  }
}

/** Shows `next` at once and persists it; a failed save keeps it on screen. */
export async function writeRecord(next: PrRecord): Promise<void> {
  reviewState.record = next;
  try {
    await saveRecord(next);
  } catch (e) {
    reviewState.error = `Draft not saved: ${e}`;
  }
}

export async function markNewSinceSeen(): Promise<void> {
  const s = reviewState;
  const key = s.selectedKey;
  const seq = openSeq;
  const summary = s.prs.find((p) => p.key === key);
  const head = s.headSha;
  if (!s.record || !s.detail || !summary || !key || !head) return;
  // The PR moved past what is displayed: reload rather than mark an unseen head.
  if (s.detail.headSha !== head) return openPr(key);
  const next = { ...s.record, viewedHead: head };
  await markPrSeen(appState.repos[summary.repoIdx].path, summary.number, head);
  if (seq !== openSeq || s.selectedKey !== key) return;
  await saveRecord(next);
  if (seq !== openSeq || s.selectedKey !== key) return;
  s.record = next;
  s.headMoved = null;
}

export function startAutoRefresh(): () => void {
  const id = setInterval(() => void refreshList(), REFRESH_MS);
  return () => clearInterval(id);
}

/** Deletes stored records for unlisted PRs that hold no draft, on ready hosts only. */
export async function cleanupRecords(): Promise<void> {
  const keys = await listReviews();
  const records = new Map<string, PrRecord | null>();
  for (const key of keys) {
    try {
      records.set(key, await loadRecord(key));
    } catch {
      records.set(key, null); // unreadable: keep
    }
  }
  const listed = new Set(reviewState.prs.map((p) => p.key));
  for (const key of keysToDelete(keys, records, listed, reviewState.hosts)) {
    await deleteReview(key);
  }
}
