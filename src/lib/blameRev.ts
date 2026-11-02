import { diff } from "@codemirror/merge";
import { appState } from "./store.svelte";
import { readFileAt } from "./git";
import { snapshot } from "./history";
import type { BlameCommit, BlameRev, RepoFile } from "./types";

/// A change between two texts in character offsets (old = a, new = b), the
/// shape @codemirror/merge's `diff` returns.
export interface LineChange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

/// Offset of each line's start in `text` (line 1 at index 0).
function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") out.push(i + 1);
  return out;
}

/// 1-based line holding offset `pos`.
function lineAt(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/// Where line `newLine` of `newText` sat in `oldText`. The line's start is
/// mapped through the changes (sorted by position, as `diff` returns them): a
/// start past a change shifts by what the changes before it added or removed,
/// and a start inside a change maps to where that change began in the old
/// text — so an inserted line lands on the insertion point. Clamped to both
/// files.
export function mapLineBack(
  oldText: string,
  newText: string,
  changes: readonly LineChange[],
  newLine: number,
): number {
  const newStarts = lineStarts(newText);
  const oldStarts = lineStarts(oldText);
  const line = Math.min(Math.max(1, newLine), newStarts.length);
  const p = newStarts[line - 1];
  let oldPos = p;
  for (const c of changes) {
    if (c.fromB > p) break;
    if (p < c.toB) {
      oldPos = c.fromA;
      break;
    }
    oldPos = p - c.toB + c.toA;
  }
  return lineAt(oldStarts, oldPos);
}

/// The revision Blame shows: `rev` while it still belongs to the blamed file,
/// else null (HEAD). Many places repoint `blameTarget`; this keeps a stale
/// revision from loading for another file.
export function blameRevFor(rev: BlameRev | null, target: RepoFile | null): BlameRev | null {
  if (!rev || !target) return null;
  return rev.target.repoIdx === target.repoIdx && rev.target.path === target.path
    ? rev
    : null;
}

/// Bounds on the character diff, which runs on the main thread: unbounded it
/// takes over a minute on a large, heavily rewritten file. A bounded diff is
/// coarser, and a line inside a coarse hunk maps to the hunk's start. 500 is
/// MergeView's own default scan limit.
const DIFF_LIMITS = { scanLimit: 500, timeout: 200 };

/// Bumped by each `blameBefore`; only the latest one in flight goes through.
let beforeSeq = 0;

/// "Blame before this": push the current view and re-blame the file at
/// `commit`'s parent, scrolled to where line `lineInCommit` (its number in the
/// commit's version) sat before the commit. Does nothing for a commit that
/// added the file. When either version can't be read the line falls back to
/// the commit's own number; the view clamps it. A step overtaken by another,
/// or by leaving Blame or its file, during the reads does nothing.
export async function blameBefore(commit: BlameCommit, lineInCommit: number): Promise<void> {
  const prev = commit.previous;
  const target = appState.blameTarget;
  if (!prev || !target) return;
  const repoPath = appState.repos[target.repoIdx]?.path;
  if (!repoPath) return;
  const mine = ++beforeSeq;
  let line = lineInCommit;
  try {
    const [oldText, newText] = await Promise.all([
      readFileAt(repoPath, prev.sha, prev.path),
      readFileAt(repoPath, commit.sha, commit.filename),
    ]);
    line = mapLineBack(oldText, newText, diff(oldText, newText, DIFF_LIMITS), lineInCommit);
  } catch {
    // Keep the commit's own number.
  }
  const now = appState.blameTarget;
  if (
    mine !== beforeSeq ||
    appState.appMode !== "blame" ||
    now?.repoIdx !== target.repoIdx ||
    now.path !== target.path
  ) {
    return;
  }
  appState.history.push(snapshot());
  appState.forwardHistory = [];
  appState.blameRev = {
    target,
    rev: prev.sha,
    path: prev.path,
    before: { sha: commit.sha, summary: commit.summary },
    line,
  };
}
