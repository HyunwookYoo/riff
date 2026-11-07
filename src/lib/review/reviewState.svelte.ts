import { appState } from "../store.svelte";
import { readFileAt } from "../git";
import { reanchorAll } from "./draft";
import { loadRecord, saveRecord } from "./draftStore";
import { deleteReview, fetchPr, listReviews, markPrSeen, prChangedFiles, prHunks } from "./gh";
import { prDetail } from "./github";
import { loadPrList, REFRESH_MS, type HostState } from "./prList";
import type { FileHunks, PrDetail, PrKey, PrRecord, PrSummary } from "./types";

const UNREADABLE = "This PR's saved draft can't be read; riff won't overwrite it.";

class ReviewState {
  prs = $state<PrSummary[]>([]);
  hosts = $state<HostState[]>([]);
  loadingList = $state(false);
  selectedKey = $state<PrKey | null>(null);
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

export async function refreshList(): Promise<void> {
  const seq = ++listSeq;
  reviewState.loadingList = true;
  try {
    const r = await loadPrList(appState.repos);
    if (seq !== listSeq) return;
    reviewState.prs = r.prs;
    reviewState.hosts = r.hosts;
    void cleanupRecords();
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

/** Full text per `${path}|${side}` that the record's line items refer to. */
async function sideTexts(
  repo: string,
  rec: PrRecord,
  files: FileHunks[],
  baseSha: string,
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
          : await readSide(repo, baseSha, files.find((f) => f.path === path)?.oldPath ?? path);
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
  s.error = null;
  s.detail = null;
  s.files = [];
  s.record = null;
  s.selectedPath = null;
  s.headMoved = null;
  s.newSinceFiles = [];
  const repoPath = appState.repos[summary.repoIdx].path;
  const { baseSha } = summary;
  try {
    const headSha = await fetchPr(repoPath, summary.remote, summary.number, summary.baseRef, baseSha);
    if (seq !== openSeq) return;
    const detail = await prDetail(summary.repo.host, summary.nodeId);
    if (seq !== openSeq) return;
    const files = await prHunks(repoPath, baseSha, headSha);
    if (seq !== openSeq) return;
    let rec: PrRecord;
    try {
      rec = await loadRecord(key);
    } catch (e) {
      if (seq !== openSeq) return;
      if (e instanceof Error && e.message === "unreadable-review-record") {
        s.detail = detail;
        s.files = files;
        s.error = UNREADABLE; // record stays null; never saved over
        return;
      }
      throw e;
    }
    if (seq !== openSeq) return;

    const prevViewed = rec.viewedHead;
    let moved: { from: string; to: string } | null = null;
    let newSince: string[] = [];
    let dirty = false;
    if (rec.viewedHead === null) {
      rec = { ...rec, viewedHead: headSha };
      await markPrSeen(repoPath, summary.number, headSha);
      dirty = true;
    }
    if (rec.anchorHead !== null && rec.anchorHead !== headSha) {
      const from = prevViewed ?? rec.anchorHead;
      moved = { from, to: headSha };
      newSince = await prChangedFiles(repoPath, baseSha, from, headSha);
      const texts = await sideTexts(repoPath, rec, files, baseSha, headSha);
      rec = reanchorAll(rec, headSha, texts, files);
      dirty = true;
    } else if (rec.anchorHead === null) {
      rec = { ...rec, anchorHead: headSha };
      dirty = true;
    }
    if (seq !== openSeq) return;
    if (dirty) await saveRecord(rec);
    if (seq !== openSeq) return;
    s.detail = detail;
    s.files = files;
    s.record = rec;
    s.headMoved = moved;
    s.newSinceFiles = newSince;
    s.selectedPath = files[0]?.path ?? null;
  } catch (e) {
    if (seq === openSeq) s.error = String(e);
  }
}

export async function markNewSinceSeen(): Promise<void> {
  const s = reviewState;
  const summary = s.prs.find((p) => p.key === s.selectedKey);
  if (!s.record || !s.detail || !summary) return;
  const next = { ...s.record, viewedHead: s.detail.headSha };
  await markPrSeen(appState.repos[summary.repoIdx].path, summary.number, s.detail.headSha);
  await saveRecord(next);
  s.record = next;
  s.headMoved = null;
}

export function startAutoRefresh(): () => void {
  const id = setInterval(() => void refreshList(), REFRESH_MS);
  return () => clearInterval(id);
}

/** Deletes stored records for PRs no longer listed that hold no items. */
export async function cleanupRecords(): Promise<void> {
  const listed = new Set(reviewState.prs.map((p) => p.key));
  for (const key of await listReviews()) {
    if (listed.has(key)) continue;
    try {
      const rec = await loadRecord(key);
      if (rec.items.length === 0) await deleteReview(key);
    } catch {
      // unreadable or failing read: keep
    }
  }
}
