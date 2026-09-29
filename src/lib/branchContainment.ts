import { appState } from "./store.svelte";
import {
  commitContainmentDetail,
  commitLog,
  commitLogExcluding,
  containment,
} from "./git";
import { compare } from "./compare";
import { resolveRepoRanges } from "./repoRange";
import type { ToolbarPair } from "./rangeText";
import type { Counts, RowMark, SideNames, Summary } from "./commitTableText";
import type { BcGroup, Commit, RepoRange } from "./types";

/// Rows fetched per page of a commit-table group.
export const PAGE_SIZE = 100;

/// Git's empty-tree object — the "before" side for a root commit (no parent).
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Monotonic guard: every reload bumps it, so the results of an older load,
// page or detail fetch can't land on the new groups.
let bcSession = 0;

/// Whether repo `idx` is on screen: the active tab in Tabs, the focused repo
/// (or every repo) in Unified. The commit table and the file list agree on it.
export function isRepoVisible(idx: number): boolean {
  if (appState.workspaceLayout === "tabs") {
    return idx === (appState.activeRepoIdx ?? 0);
  }
  return appState.activeRepoIdx === null || appState.activeRepoIdx === idx;
}

/// ● (not in base), ◐ (in base as an equivalent patch) and behind counts.
export function groupCounts(g: BcGroup): Counts {
  if (!g.marks) return { out: 0, patch: 0, behind: 0 };
  const patch = g.marks.equivalent.length;
  return {
    out: Math.max(0, g.marks.ahead - patch),
    patch,
    behind: g.marks.behind,
  };
}

/// A row's mark from its group's ● and ◐ sets.
export function rowMark(
  sha: string,
  notIn: Set<string>,
  equiv: Set<string>,
): RowMark {
  if (equiv.has(sha)) return "patch";
  if (notIn.has(sha)) return "out";
  return "in";
}

/// A group on screen, with the names its range's sides go by.
export interface VisibleGroup {
  idx: number;
  group: BcGroup;
  names: SideNames;
}

/// The summary line's state for the groups on screen: one group speaks for
/// itself; several give totals, and read as all in once none has ● left.
export function summarize(groups: VisibleGroup[], pair: ToolbarPair): Summary {
  if (groups.length === 0) return { kind: "no-refs" };
  if (groups.length === 1 && groups[0].group.base === groups[0].group.compare) {
    return { kind: "same" };
  }
  const ready = groups.filter((v) => v.group.status === "ready");
  if (ready.length === 0) {
    return groups.some((v) => v.group.status === "loading")
      ? { kind: "loading" }
      : { kind: "error" };
  }
  if (groups.length === 1) {
    const { group: g, names } = groups[0];
    const c = groupCounts(g);
    if (c.out > 0) {
      return { kind: "unmerged", names, out: c.out, patch: c.patch, behind: c.behind, repos: 1 };
    }
    if (c.patch > 0) return { kind: "patches", names, patch: c.patch };
    return { kind: "merged", names, mergedBy: g.mergedBy ?? null };
  }
  let out = 0;
  let patch = 0;
  for (const v of ready) {
    const c = groupCounts(v.group);
    out += c.out;
    patch += c.patch;
  }
  if (out > 0) {
    return { kind: "unmerged", names: pair, out, patch, behind: null, repos: groups.length };
  }
  if (ready.length < groups.length) return { kind: "loading" };
  return { kind: "all-in", names: pair, repos: groups.length };
}

function emptyGroup(range: Extract<RepoRange, { ok: true }>): BcGroup {
  return {
    path: range.path,
    base: range.base,
    compare: range.compare,
    status: "loading",
    error: null,
    marks: null,
    commits: [],
    hasMore: false,
    loadingMore: false,
    mergedBy: undefined,
  };
}

function patchGroup(idx: number, patch: Partial<BcGroup>): void {
  const cur = appState.bcGroups[idx];
  if (!cur) return;
  appState.bcGroups = { ...appState.bcGroups, [idx]: { ...cur, ...patch } };
}

/// One page of a group's rows. Default: compare's commits the base lacks.
/// With merged commits shown: what the introducing merge brought in when it
/// is known, otherwise compare's history.
function fetchPage(g: BcGroup, skip: number): Promise<Commit[]> {
  if (!appState.bcShowMerged) {
    return commitLogExcluding(g.path, g.compare, g.base, PAGE_SIZE, skip);
  }
  const beforeMerge = g.mergedBy?.parents[0];
  return beforeMerge
    ? commitLogExcluding(g.path, g.compare, beforeMerge, PAGE_SIZE, skip)
    : commitLog(g.path, g.compare, false, PAGE_SIZE, skip);
}

async function loadGroup(idx: number, s: number): Promise<void> {
  const g = appState.bcGroups[idx];
  if (!g) return;
  try {
    const marks = await containment(g.path, g.compare, g.base);
    if (s !== bcSession) return;
    let mergedBy: Commit | null | undefined;
    if (marks.ahead === 0) {
      try {
        mergedBy = (await commitContainmentDetail(g.path, g.compare, g.base))
          .introduced_by;
      } catch {
        mergedBy = undefined;
      }
      if (s !== bcSession) return;
    }
    patchGroup(idx, { marks, mergedBy });
    const commits = await fetchPage(appState.bcGroups[idx], 0);
    if (s !== bcSession) return;
    patchGroup(idx, {
      status: "ready",
      commits,
      hasMore: commits.length === PAGE_SIZE,
    });
  } catch (e) {
    if (s === bcSession) patchGroup(idx, { status: "error", error: String(e) });
  }
}

/// Rebuild the commit table for the current inputs: one group per repo whose
/// range resolved, each loading its marks and first page on its own. A picked
/// commit belonged to the old comparison, so it is dropped — and the file list
/// goes back to all changes rather than keep showing that commit's files.
export async function loadBranchContainment(): Promise<void> {
  const s = ++bcSession;
  if (appState.appMode !== "compare" || !appState.repoPath) {
    clearBranchContainment();
    return;
  }
  const ranges = await resolveRepoRanges();
  if (s !== bcSession) return;
  const hadPick = appState.bcDiffRange !== null;
  appState.bcSelected = null;
  appState.bcSelectedDetail = null;
  appState.bcDiffRange = null;
  const groups: Record<number, BcGroup> = {};
  ranges.forEach((r, i) => {
    if (r.ok) groups[i] = emptyGroup(r);
  });
  appState.bcGroups = groups;
  if (Object.keys(groups).length === 0) {
    // Nothing to compare yet: drop a leftover selection (e.g. a file opened in
    // Changes) so the diff pane shows its placeholder, not an error.
    appState.selectedFile = null;
    appState.files = [];
    return;
  }
  if (hadPick) void compare({ silent: true });
  await Promise.all(Object.keys(groups).map((k) => loadGroup(Number(k), s)));
}

/// The next page of group `idx` — its "Load 100 more" row.
export async function loadMoreGroup(idx: number): Promise<void> {
  const g = appState.bcGroups[idx];
  if (!g || g.status !== "ready" || !g.hasMore || g.loadingMore) return;
  const s = bcSession;
  patchGroup(idx, { loadingMore: true });
  try {
    const page = await fetchPage(g, g.commits.length);
    if (s !== bcSession) return;
    patchGroup(idx, {
      commits: appState.bcGroups[idx].commits.concat(page),
      hasMore: page.length === PAGE_SIZE,
      loadingMore: false,
    });
  } catch {
    if (s === bcSession) patchGroup(idx, { loadingMore: false });
  }
}

/// Show or hide the commits already in base, reloading every group's rows.
export async function setShowMerged(on: boolean): Promise<void> {
  appState.bcShowMerged = on;
  const s = bcSession;
  await Promise.all(
    Object.keys(appState.bcGroups).map(async (k) => {
      const idx = Number(k);
      const g = appState.bcGroups[idx];
      if (!g || g.status !== "ready") return;
      try {
        const commits = await fetchPage(g, 0);
        if (s !== bcSession) return;
        patchGroup(idx, { commits, hasMore: commits.length === PAGE_SIZE });
      } catch (e) {
        if (s === bcSession) patchGroup(idx, { status: "error", error: String(e) });
      }
    }),
  );
}

/// Pick a commit: its own diff (parent..commit) shows, inside its repo only.
export function selectBranchCommit(repoIdx: number, commit: Commit): void {
  appState.bcSelected = { repoIdx, commit };
  appState.bcSelectedDetail = null;
  appState.bcDiffRange = {
    repoIdx,
    start: commit.parents[0] ?? EMPTY_TREE,
    target: commit.sha,
  };
  void loadSelectedDetail(repoIdx, commit.sha);
  void compare();
}

/// Drop the picked commit and show all changes again.
export function showAllChanges(): void {
  appState.bcSelected = null;
  appState.bcSelectedDetail = null;
  appState.bcDiffRange = null;
  void compare();
}

/// Drop the picked commit when the view narrows to a repo other than the
/// pick's own — its files would otherwise stay listed under a table that
/// shows a different repo. Returns whether a pick was dropped.
export function dropPickOutside(idx: number): boolean {
  const d = appState.bcDiffRange;
  if (!d || d.repoIdx === idx) return false;
  appState.bcSelected = null;
  appState.bcSelectedDetail = null;
  appState.bcDiffRange = null;
  return true;
}

/// How the picked commit reached base (the introducing merge), for the Files
/// header.
async function loadSelectedDetail(repoIdx: number, sha: string): Promise<void> {
  const g = appState.bcGroups[repoIdx];
  if (!g) return;
  const s = bcSession;
  try {
    const d = await commitContainmentDetail(g.path, sha, g.base);
    if (s !== bcSession || appState.bcSelected?.commit.sha !== sha) return;
    appState.bcSelectedDetail = d;
  } catch {
    /* the header falls back to the row's own mark */
  }
}

/// Reset the commit table (leaving compare mode, switching repo).
export function clearBranchContainment(): void {
  bcSession++;
  appState.bcGroups = {};
  appState.bcSelected = null;
  appState.bcSelectedDetail = null;
  appState.bcDiffRange = null;
}
