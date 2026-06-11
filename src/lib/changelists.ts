import { appState } from "./store.svelte";
import {
  loadChangelists as loadCl,
  saveChangelists as saveCl,
  commitPaths,
} from "./git";
import { changesRepoPath, loadStatus } from "./sourceControl";
import { invalidateGraph } from "./commitHistory";
import type { Changelist } from "./types";

export const DEFAULT_CHANGELIST = "default";

function emptyDefault(): Changelist {
  return { id: DEFAULT_CHANGELIST, name: "Default", files: [] };
}

function currentPaths(): string[] {
  return (appState.repoStatus?.entries ?? []).map((e) => e.path);
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
  if (!appState.changelists.some((l) => l.id === appState.activeChangelistId)) {
    appState.activeChangelistId = DEFAULT_CHANGELIST;
  }
  void persist();
}

/// Re-bucket after a status change (new / removed files), keeping assignments.
export function reconcileChangelists(): void {
  if (appState.changelists.length === 0) return;
  appState.changelists = reconcile(appState.changelists);
  void persist();
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
  void persist();
}

/// Commit one changelist's files with the current commit-box message.
export async function commitChangelist(id: string): Promise<void> {
  const cl = appState.changelists.find((l) => l.id === id);
  const subject = appState.commitSubject.trim();
  if (!cl || cl.files.length === 0 || !subject || appState.committing) return;
  appState.committing = true;
  appState.error = null;
  try {
    await commitPaths(
      changesRepoPath(),
      cl.files,
      subject,
      appState.commitBody,
      appState.commitSignoff,
      appState.commitCoauthors.map((c) => c.trim()).filter(Boolean),
    );
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
