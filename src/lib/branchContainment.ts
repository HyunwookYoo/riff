import { appState } from "./store.svelte";
import {
  commitContainmentDetail,
  commitLog,
  commitLogExcluding,
  containment,
  squashCheck,
} from "./git";
import { compare } from "./compare";
import { resolveRepoRanges } from "./repoRange";
import type { ToolbarPair } from "./rangeText";
import type { Counts, RowMark, SideNames, Summary } from "./commitTableText";
import type { BcGroup, Commit, RepoRange, SquashCheck } from "./types";

/// Rows fetched per page of a commit-table group.
export const PAGE_SIZE = 100;

/// Git's empty-tree object — the "before" side for a root commit (no parent).
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Monotonic guard: every reload bumps it, so the results of an older load,
// page or detail fetch can't land on the new groups.
let bcSession = 0;

// Bumped by every "Show merged commits" toggle: a page fetched for the other
// list (first page, "Load more" or refetch) is dropped when it lands.
let listSession = 0;

/// Whether repo `idx` is on screen: the active tab in Tabs, the focused repo
/// (or every repo) in Unified. The commit table and the file list agree on it.
export function isRepoVisible(idx: number): boolean {
  if (appState.workspaceLayout === "tabs") {
    return idx === (appState.activeRepoIdx ?? 0);
  }
  return appState.activeRepoIdx === null || appState.activeRepoIdx === idx;
}

/// The group's squash answer when it puts the ● commits in base.
export function squashLanded(g: BcGroup): SquashCheck | null {
  const sq = g.squash;
  return sq && sq !== "checking" && (sq.verdict === "squash" || sq.verdict === "content")
    ? sq
    : null;
}

/// ● (not in base), ◐ (in base as a patch, or by a squash) and behind counts.
export function groupCounts(g: BcGroup): Counts {
  if (!g.marks) return { out: 0, patch: 0, behind: 0 };
  const patch = g.marks.equivalent.length;
  const out = Math.max(0, g.marks.ahead - patch);
  // A detected squash puts the ● commits in base too, by content.
  if (squashLanded(g)) return { out: 0, patch: patch + out, behind: g.marks.behind };
  return { out, patch, behind: g.marks.behind };
}

/// A row's mark from its group's ● and ◐ sets; `squashed` when the group's
/// squash check put its ● commits in base.
export function rowMark(
  sha: string,
  notIn: Set<string>,
  equiv: Set<string>,
  squashed = false,
): RowMark {
  if (equiv.has(sha)) return "patch";
  if (notIn.has(sha)) return squashed ? "squash" : "out";
  return "in";
}

/// A group on screen, with the names its range's sides go by.
export interface VisibleGroup {
  idx: number;
  group: BcGroup;
  names: SideNames;
}

/// The summary line's state for the groups on screen: one group speaks for
/// itself; several give totals over the groups that answered (noting how many
/// could not be read), and read as all in once none has ● left and none is
/// still loading.
export function summarize(groups: VisibleGroup[], pair: ToolbarPair): Summary {
  if (groups.length === 0) return { kind: "no-refs" };
  if (groups.length === 1 && groups[0].group.base === groups[0].group.compare) {
    return { kind: "same" };
  }
  const ready = groups.filter((v) => v.group.status === "ready");
  const loading = groups.some((v) => v.group.status === "loading");
  if (ready.length === 0) return loading ? { kind: "loading" } : { kind: "error" };
  if (groups.length === 1) {
    const { group: g, names } = groups[0];
    const landed = squashLanded(g);
    if (landed) {
      return landed.verdict === "squash" && landed.squash_commit
        ? { kind: "squash", names, commit: landed.squash_commit }
        : { kind: "content", names };
    }
    if (g.squash && g.squash !== "checking" && g.squash.verdict === "no-net-change") {
      return { kind: "no-net-change", names };
    }
    const c = groupCounts(g);
    if (c.out > 0) {
      return {
        kind: "unmerged",
        names,
        out: c.out,
        patch: c.patch,
        behind: c.behind,
        repos: 1,
        failed: 0,
      };
    }
    if (c.patch > 0) return { kind: "patches", names, patch: c.patch };
    return { kind: "merged", names, mergedBy: g.mergedBy };
  }
  let out = 0;
  let patch = 0;
  for (const v of ready) {
    const c = groupCounts(v.group);
    out += c.out;
    patch += c.patch;
  }
  const failed = groups.filter((v) => v.group.status === "error").length;
  if (out > 0) {
    return {
      kind: "unmerged",
      names: pair,
      out,
      patch,
      behind: null,
      repos: ready.length,
      failed,
    };
  }
  if (loading) return { kind: "loading" };
  return { kind: "all-in", names: pair, repos: ready.length, failed };
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
    squash: null,
  };
}

function patchGroup(idx: number, patch: Partial<BcGroup>): void {
  const cur = appState.bcGroups[idx];
  if (!cur) return;
  appState.bcGroups = { ...appState.bcGroups, [idx]: { ...cur, ...patch } };
}

/// One page of a group's rows. Default: compare's commits the base lacks.
/// With merged commits shown: what the introducing merge (`mergedBy`) brought
/// in when it is known, otherwise compare's history.
function fetchPage(
  g: Pick<BcGroup, "path" | "base" | "compare">,
  mergedBy: BcGroup["mergedBy"],
  skip: number,
): Promise<Commit[]> {
  if (!appState.bcShowMerged) {
    return commitLogExcluding(g.path, g.compare, g.base, PAGE_SIZE, skip);
  }
  const beforeMerge = mergedBy?.parents[0];
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
    // Fetch again if the list was toggled meanwhile: the toggle skips a group
    // that has no rows yet, so this is what puts it in the new list.
    let commits: Commit[];
    let list: number;
    do {
      list = listSession;
      commits = await fetchPage(g, mergedBy, 0);
      if (s !== bcSession) return;
    } while (list !== listSession);
    // ● rows by containment alone: groupCounts folds a stored squash verdict
    // in, and a kept group with one would never be checked again.
    const unmerged = Math.max(0, marks.ahead - marks.equivalent.length) > 0;
    // One patch, so a group refreshed in place never shows new marks over old
    // rows (and a page abandoned by this reload stops showing "Loading…").
    // A verdict describes ● rows: with none left, it goes too.
    patchGroup(idx, {
      marks,
      mergedBy,
      commits,
      hasMore: commits.length === PAGE_SIZE,
      status: "ready",
      error: null,
      loadingMore: false,
      ...(unmerged ? {} : { squash: null }),
    });
    if (unmerged) await checkSquash(idx, s);
  } catch (e) {
    if (s === bcSession) patchGroup(idx, { status: "error", error: String(e) });
  }
}

/// Ask whether a group's unmerged commits landed as a squash. The group is
/// already on screen; only its marks and wording change when the answer comes.
/// A group that has an answer keeps it while the next one is on its way —
/// refsRefresh fires on every saved file, and ◐ rows must not flicker back to ●.
async function checkSquash(idx: number, s: number): Promise<void> {
  const g = appState.bcGroups[idx];
  if (!g) return;
  if (g.squash === null) patchGroup(idx, { squash: "checking" });
  try {
    const result = await squashCheck(g.path, g.compare, g.base);
    if (s === bcSession) patchGroup(idx, { squash: result });
  } catch {
    if (s === bcSession) patchGroup(idx, { squash: null });
  }
}

/// Rebuild the commit table for the current inputs: one group per repo whose
/// range resolved, each loading its marks and first page on its own. A group
/// whose range is unchanged keeps its rows and marks while its fresh results
/// load — a refresh (fetch, checkout, a saved file) must not blank the table
/// or reset the diff being read — and so does a commit picked in it. A pick
/// whose range changed or vanished belonged to the old comparison, so it is
/// dropped and the file list goes back to all changes.
export async function loadBranchContainment(): Promise<void> {
  const s = ++bcSession;
  if (appState.appMode !== "compare" || !appState.repoPath) {
    clearBranchContainment();
    return;
  }
  const ranges = await resolveRepoRanges();
  if (s !== bcSession) return;
  const before = appState.bcGroups;
  const groups: Record<number, BcGroup> = {};
  const unchanged = new Set<number>();
  ranges.forEach((r, i) => {
    if (!r.ok) return;
    const prev = before[i];
    if (prev && prev.path === r.path && prev.base === r.base && prev.compare === r.compare) {
      groups[i] = prev;
      unchanged.add(i);
    } else {
      groups[i] = emptyGroup(r);
    }
  });
  const drill = appState.bcDiffRange;
  const keepPick = drill !== null && unchanged.has(drill.repoIdx);
  if (!keepPick) {
    appState.bcSelected = null;
    appState.bcSelectedDetail = null;
    appState.bcDiffRange = null;
  }
  appState.bcGroups = groups;
  if (Object.keys(groups).length === 0) {
    // Nothing to compare yet: drop a leftover selection (e.g. a file opened in
    // Changes) so the diff pane shows its placeholder, not an error.
    appState.selectedFile = null;
    appState.files = [];
    return;
  }
  if (drill && !keepPick) void compare({ silent: true });
  await Promise.all(Object.keys(groups).map((k) => loadGroup(Number(k), s)));
}

/// The next page of group `idx` — its "Load 100 more" row.
export async function loadMoreGroup(idx: number): Promise<void> {
  const g = appState.bcGroups[idx];
  if (!g || g.status !== "ready" || !g.hasMore || g.loadingMore) return;
  const s = bcSession;
  const list = listSession;
  patchGroup(idx, { loadingMore: true });
  try {
    const page = await fetchPage(g, g.mergedBy, g.commits.length);
    if (s !== bcSession || list !== listSession) return;
    patchGroup(idx, {
      commits: appState.bcGroups[idx].commits.concat(page),
      hasMore: page.length === PAGE_SIZE,
      loadingMore: false,
    });
  } catch {
    if (s === bcSession && list === listSession) {
      patchGroup(idx, { loadingMore: false });
    }
  }
}

/// Show or hide the commits already in base, reloading every group's rows.
export async function setShowMerged(on: boolean): Promise<void> {
  appState.bcShowMerged = on;
  const list = ++listSession;
  const s = bcSession;
  // A "Load more" in flight belongs to the other list and will be dropped, so
  // it can no longer clear its own "Loading…".
  for (const k of Object.keys(appState.bcGroups)) {
    if (appState.bcGroups[Number(k)].loadingMore) {
      patchGroup(Number(k), { loadingMore: false });
    }
  }
  await Promise.all(
    Object.keys(appState.bcGroups).map(async (k) => {
      const idx = Number(k);
      const g = appState.bcGroups[idx];
      if (!g || g.status !== "ready") return;
      try {
        const commits = await fetchPage(g, g.mergedBy, 0);
        if (s !== bcSession || list !== listSession) return;
        patchGroup(idx, { commits, hasMore: commits.length === PAGE_SIZE });
      } catch (e) {
        if (s === bcSession && list === listSession) {
          patchGroup(idx, { status: "error", error: String(e) });
        }
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
