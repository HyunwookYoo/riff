import { appState } from "./store.svelte";
import {
  applyHunks,
  commit,
  commitPaths,
  fileHunks,
  loadChangelists as loadCl,
  saveChangelists as saveCl,
  stage,
  unstage,
} from "./git";
import { changesRepoPath, entryConflicted, loadStatus } from "./sourceControl";
import { invalidateGraph } from "./commitHistory";
import type { Changelist } from "./types";

export const DEFAULT_CHANGELIST = "default";

function emptyDefault(): Changelist {
  return { id: DEFAULT_CHANGELIST, name: "Default", files: [] };
}

function currentPaths(): string[] {
  // Conflicted (unmerged) files live in the dedicated Conflicts group, not in
  // changelists — exclude them so they don't double-show.
  return (appState.repoStatus?.entries ?? [])
    .filter((e) => !entryConflicted(e))
    .map((e) => e.path);
}

/// Drop paths no longer changed; route any unassigned changed path to Default.
/// A path can only live in one list (first wins) — keeps the buckets disjoint.
function reconcile(lists: Changelist[]): Changelist[] {
  const paths = new Set(currentPaths());
  const seen = new Set<string>();
  const out = lists.map((l) => {
    const files = l.files.filter((f) => paths.has(f) && !seen.has(f));
    files.forEach((f) => seen.add(f));
    return { ...l, files };
  });
  if (!out.some((l) => l.id === DEFAULT_CHANGELIST)) out.unshift(emptyDefault());
  const def = out.find((l) => l.id === DEFAULT_CHANGELIST)!;
  def.files = [...def.files, ...[...paths].filter((p) => !seen.has(p))];
  return out;
}

async function persist(): Promise<void> {
  try {
    await saveCl(changesRepoPath(), JSON.stringify({ lists: appState.changelists }));
  } catch {
    // Best-effort — the assignment is a convenience layer, not source of truth.
  }
}

/// Load persisted changelists for the current repo and reconcile to status.
export async function loadChangelistsForRepo(): Promise<void> {
  let lists: Changelist[] = [emptyDefault()];
  try {
    const raw = await loadCl(changesRepoPath());
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.lists)) lists = parsed.lists as Changelist[];
    }
  } catch {
    // Malformed store → start fresh with just Default.
  }
  appState.changelists = reconcile(lists);
  pruneHunkAssignments();
  if (!appState.changelists.some((l) => l.id === appState.activeChangelistId)) {
    appState.activeChangelistId = DEFAULT_CHANGELIST;
  }
  void persist();
}

/// Re-bucket after a status change (new / removed files), keeping assignments.
export function reconcileChangelists(): void {
  if (appState.changelists.length === 0) return;
  appState.changelists = reconcile(appState.changelists);
  pruneHunkAssignments();
  void persist();
}

// ── Hunk-level assignment (session-only) ───────────────────────────────────

/// The changelist a file currently lives in (its "home"). Files are disjoint
/// across lists post-reconcile; an unassigned file is in Default.
export function homeChangelistOf(file: string): string {
  return (
    appState.changelists.find((l) => l.files.includes(file))?.id ??
    DEFAULT_CHANGELIST
  );
}

/// The changelist a specific hunk belongs to: an explicit assignment, else the
/// file's home list.
export function hunkChangelistId(file: string, hunkId: string): string {
  return appState.hunkAssignments[file]?.[hunkId] ?? homeChangelistOf(file);
}

/// Assign a hunk to a changelist (session-only). Assigning back to the file's
/// home list clears the override.
export function assignHunk(file: string, hunkId: string, targetId: string): void {
  const home = homeChangelistOf(file);
  const cur = { ...(appState.hunkAssignments[file] ?? {}) };
  if (targetId === home) delete cur[hunkId];
  else cur[hunkId] = targetId;
  const next = { ...appState.hunkAssignments };
  if (Object.keys(cur).length === 0) delete next[file];
  else next[file] = cur;
  appState.hunkAssignments = next;
}

/// The cached hunk ids of `file` that belong to `clId`, plus the file's total
/// hunk count. `null` when the file has no cached hunks (binary, or never
/// opened) — callers treat it as a whole-file member of its home list.
export function fileHunksInList(
  file: string,
  clId: string,
): { ids: string[]; total: number } | null {
  const hunks = appState.hunksByFile[file];
  if (!hunks || hunks.length === 0) return null;
  const ids = hunks
    .filter((h) => hunkChangelistId(file, h.id) === clId)
    .map((h) => h.id);
  return { ids, total: hunks.length };
}

/// Files shown under changelist `clId`: its home files that still have ≥1 hunk
/// here, plus foreign files with hunks reassigned here. `partial` marks a file
/// split across lists (drives the "k/n hunks" badge).
export function filesInChangelist(
  clId: string,
): Array<{ path: string; inCount: number; total: number; partial: boolean }> {
  const out = new Map<
    string,
    { path: string; inCount: number; total: number; partial: boolean }
  >();
  const cl = appState.changelists.find((l) => l.id === clId);
  for (const f of cl?.files ?? []) {
    const sub = fileHunksInList(f, clId);
    if (!sub) {
      out.set(f, { path: f, inCount: 0, total: 0, partial: false });
    } else if (sub.ids.length > 0) {
      out.set(f, {
        path: f,
        inCount: sub.ids.length,
        total: sub.total,
        partial: sub.ids.length < sub.total,
      });
    }
    // else: every hunk reassigned away → don't show in its home list.
  }
  for (const [file, map] of Object.entries(appState.hunkAssignments)) {
    if (homeChangelistOf(file) === clId) continue; // handled above as a home file
    if (!Object.values(map).some((c) => c === clId)) continue;
    const sub = fileHunksInList(file, clId);
    if (sub && sub.ids.length > 0) {
      out.set(file, {
        path: file,
        inCount: sub.ids.length,
        total: sub.total,
        partial: true,
      });
    }
  }
  return [...out.values()];
}

/// Drop assignments / cache for files no longer changed and assignments to
/// changelists that no longer exist. Keeps the session maps from growing stale.
function pruneHunkAssignments(): void {
  const paths = new Set(currentPaths());
  const clIds = new Set(appState.changelists.map((l) => l.id));
  const nextAssign: Record<string, Record<string, string>> = {};
  for (const [file, map] of Object.entries(appState.hunkAssignments)) {
    if (!paths.has(file)) continue;
    const m: Record<string, string> = {};
    for (const [hid, cl] of Object.entries(map)) {
      if (clIds.has(cl)) m[hid] = cl;
    }
    if (Object.keys(m).length) nextAssign[file] = m;
  }
  appState.hunkAssignments = nextAssign;
  const nextCache: Record<string, (typeof appState.hunksByFile)[string]> = {};
  for (const [file, hunks] of Object.entries(appState.hunksByFile)) {
    if (paths.has(file)) nextCache[file] = hunks;
  }
  appState.hunksByFile = nextCache;
}

export function moveFileToChangelist(filePath: string, targetId: string): void {
  appState.changelists = appState.changelists.map((l) => ({
    ...l,
    files:
      l.id === targetId
        ? l.files.includes(filePath)
          ? l.files
          : [...l.files, filePath]
        : l.files.filter((f) => f !== filePath),
  }));
  void persist();
}

export function createChangelist(name: string): string {
  const id =
    "cl-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  appState.changelists = [
    ...appState.changelists,
    { id, name: name.trim() || "New changelist", files: [] },
  ];
  void persist();
  return id;
}

export function renameChangelist(id: string, name: string): void {
  if (id === DEFAULT_CHANGELIST || !name.trim()) return;
  appState.changelists = appState.changelists.map((l) =>
    l.id === id ? { ...l, name: name.trim() } : l,
  );
  void persist();
}

export function deleteChangelist(id: string): void {
  if (id === DEFAULT_CHANGELIST) return;
  const cl = appState.changelists.find((l) => l.id === id);
  if (!cl) return;
  // Its files fall back to Default; then drop the list.
  appState.changelists = appState.changelists
    .map((l) =>
      l.id === DEFAULT_CHANGELIST ? { ...l, files: [...l.files, ...cl.files] } : l,
    )
    .filter((l) => l.id !== id);
  if (appState.activeChangelistId === id)
    appState.activeChangelistId = DEFAULT_CHANGELIST;
  // Hunks assigned to the deleted list fall back to their file's home.
  pruneHunkAssignments();
  void persist();
}

/// Commit one changelist with the current commit-box message. A whole-file
/// changelist uses the atomic path-scoped commit; a hunk-split one stages
/// exactly its content (whole files + selected hunks) into a clean index, then
/// commits the index, leaving the unselected hunks uncommitted.
export async function commitChangelist(id: string): Promise<void> {
  const subject = appState.commitSubject.trim();
  if (!subject || appState.committing) return;
  const files = filesInChangelist(id);
  if (files.length === 0) return;
  const repo = changesRepoPath();
  const coauthors = appState.commitCoauthors
    .map((c) => c.trim())
    .filter(Boolean);
  const whole = files.filter((f) => !f.partial).map((f) => f.path);
  const partial = files.filter((f) => f.partial);
  appState.committing = true;
  appState.error = null;
  try {
    if (partial.length === 0) {
      await commitPaths(
        repo,
        whole,
        subject,
        appState.commitBody,
        appState.commitSignoff,
        coauthors,
      );
    } else {
      // Clean index, then stage exactly this changelist's content.
      await unstage(repo, null);
      if (whole.length > 0) await stage(repo, whole);
      for (const f of partial) {
        const sub = fileHunksInList(f.path, id);
        if (!sub || sub.ids.length === 0) continue;
        // Resolve hunk ids → current indices against the (index==HEAD) diff.
        const cur = await fileHunks(repo, f.path, false);
        const idx: number[] = [];
        cur.forEach((h, i) => {
          if (sub.ids.includes(h.id)) idx.push(i);
        });
        if (idx.length > 0) await applyHunks(repo, f.path, false, idx);
      }
      await commit(
        repo,
        subject,
        appState.commitBody,
        false,
        appState.commitSignoff,
        coauthors,
      );
    }
    appState.commitSubject = "";
    appState.commitBody = "";
    appState.commitCoauthors = [];
    invalidateGraph();
  } catch (e) {
    appState.error = String(e);
  } finally {
    appState.committing = false;
    await loadStatus();
    reconcileChangelists();
  }
}
