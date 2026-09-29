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

// Monotonic guard: every reload bumps it, so the results of an older load or
// detail fetch can't land on the new groups.
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

type OkRange = Extract<RepoRange, { ok: true }>;

/// Where a group's base and compare point (BcGroup.baseTip / compareTip).
type Tips = Pick<BcGroup, "baseTip" | "compareTip">;

function emptyGroup(range: OkRange): BcGroup {
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
    baseTip: null,
    compareTip: null,
  };
}

/// The commits a range's sides point at now: a one-commit log per ref. A
/// gitlink range's sides are commits already.
async function readTips(range: OkRange): Promise<Tips> {
  if (range.source === "gitlink") {
    return { baseTip: range.base, compareTip: range.compare };
  }
  const [base, compare] = await Promise.all([
    commitLog(range.path, range.base, false, 1, 0),
    commitLog(range.path, range.compare, false, 1, 0),
  ]);
  return { baseTip: base[0]?.sha ?? null, compareTip: compare[0]?.sha ?? null };
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

/// Refresh group `idx`: reload it, unless both of its tips still point where
/// they did when it last loaded — then its marks, rows, merge and squash
/// verdict all still hold, and no further git work is done.
async function refreshGroup(idx: number, range: OkRange, s: number): Promise<void> {
  let tips: Tips;
  try {
    tips = await readTips(range);
  } catch {
    // Unreadable (a ref is gone): reload, and let the load report it.
    tips = { baseTip: null, compareTip: null };
  }
  if (s !== bcSession) return;
  const g = appState.bcGroups[idx];
  const unmoved =
    !!g &&
    tips.baseTip !== null &&
    tips.compareTip !== null &&
    tips.baseTip === g.baseTip &&
    tips.compareTip === g.compareTip;
  if (!unmoved) await loadGroup(idx, s, tips);
}

async function loadGroup(idx: number, s: number, tips: Tips): Promise<void> {
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
    // A verdict describes ● rows: with none left, it goes too. The tips are
    // those read before this load, so a commit landing meanwhile moves them
    // on the next refresh; its squash check lands before that refresh starts
    // (loads never overlap).
    patchGroup(idx, {
      marks,
      mergedBy,
      commits,
      hasMore: commits.length === PAGE_SIZE,
      status: "ready",
      error: null,
      loadingMore: false,
      ...tips,
      ...(unmerged ? {} : { squash: null }),
    });
    if (unmerged) await checkSquash(idx, s);
  } catch (e) {
    // No tips: a failed group loads again on the next refresh.
    if (s === bcSession) {
      patchGroup(idx, { status: "error", error: String(e), baseTip: null, compareTip: null });
    }
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

// One load runs at a time. refsRefresh fires on every saved file, and loads
// left to overlap pile up git processes that no one waits for (see
// inflight.ts): a call made while one runs asks for one more, run after it.
let loadRunning = false;
let loadAgain = false;

/// Rebuild the commit table for the current inputs: one group per repo whose
/// range resolved, each loading its marks and first page on its own. A group
/// whose range is unchanged keeps its rows and marks while its fresh results
/// load — a refresh (fetch, checkout, a saved file) must not blank the table
/// or reset the diff being read — and so does a commit picked in it; a group
/// whose tips did not move is not reloaded at all. A pick whose range changed
/// or vanished belonged to the old comparison, so it is dropped and the file
/// list goes back to all changes. Calls made while a load runs collapse into
/// one more load after it.
export async function loadBranchContainment(): Promise<void> {
  if (loadRunning) {
    loadAgain = true;
    return;
  }
  loadRunning = true;
  try {
    do {
      loadAgain = false;
      await loadOnce();
    } while (loadAgain);
  } finally {
    loadRunning = false;
  }
}

async function loadOnce(): Promise<void> {
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
  const toLoad: [number, OkRange][] = [];
  ranges.forEach((r, i) => {
    if (!r.ok) return;
    const prev = before[i];
    if (prev && prev.path === r.path && prev.base === r.base && prev.compare === r.compare) {
      groups[i] = prev;
      unchanged.add(i);
    } else {
      groups[i] = emptyGroup(r);
    }
    toLoad.push([i, r]);
  });
  const drill = appState.bcDiffRange;
  const keepPick = drill !== null && unchanged.has(drill.repoIdx);
  if (!keepPick) clearPick();
  appState.bcGroups = groups;
  if (Object.keys(groups).length === 0) {
    // Nothing to compare yet: drop a leftover selection (e.g. a file opened in
    // Changes) so the diff pane shows its placeholder, not an error.
    appState.selectedFile = null;
    appState.files = [];
    return;
  }
  if (drill && !keepPick) void compare({ silent: true });
  await Promise.all(toLoad.map(([i, r]) => refreshGroup(i, r, s)));
}

/// The next page of group `idx` — its "Load 100 more" row.
export async function loadMoreGroup(idx: number): Promise<void> {
  const g = appState.bcGroups[idx];
  if (!g || g.status !== "ready" || !g.hasMore || g.loadingMore) return;
  const list = listSession;
  // The rows this page continues: once a reload or a toggle has replaced them,
  // its offset means nothing and the page is dropped.
  const rows = g.commits;
  patchGroup(idx, { loadingMore: true });
  try {
    const page = await fetchPage(g, g.mergedBy, rows.length);
    if (list !== listSession) return;
    if (appState.bcGroups[idx]?.commits !== rows) {
      patchGroup(idx, { loadingMore: false });
      return;
    }
    // compare's history can shift between two pages; a row is listed once.
    const listed = new Set(rows.map((c) => c.sha));
    patchGroup(idx, {
      commits: rows.concat(page.filter((c) => !listed.has(c.sha))),
      hasMore: page.length === PAGE_SIZE,
      loadingMore: false,
    });
  } catch {
    if (list === listSession) patchGroup(idx, { loadingMore: false });
  }
}

/// Show or hide the commits already in base, reloading every group's rows.
export async function setShowMerged(on: boolean): Promise<void> {
  appState.bcShowMerged = on;
  const list = ++listSession;
  const s = bcSession;
  // A "Load more" in flight belongs to the other list and will be dropped, so
  // it can no longer clear its own "Loading…". Until its refetch lands a
  // group's rows belong to the other list too, so its tips go: a refresh that
  // drops the refetch must reload the group, not skip it as unmoved.
  for (const k of Object.keys(appState.bcGroups)) {
    patchGroup(Number(k), { loadingMore: false, baseTip: null, compareTip: null });
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

/// Drop the picked commit: its selection, detail and diff range. Re-listing
/// the files is the caller's job.
export function clearPick(): void {
  appState.bcSelected = null;
  appState.bcSelectedDetail = null;
  appState.bcDiffRange = null;
}

/// Drop the picked commit and show all changes again.
export function showAllChanges(): void {
  clearPick();
  void compare();
}

/// Drop the picked commit when the view narrows to a repo other than the
/// pick's own — its files would otherwise stay listed under a table that
/// shows a different repo. Returns whether a pick was dropped.
export function dropPickOutside(idx: number): boolean {
  const d = appState.bcDiffRange;
  if (!d || d.repoIdx === idx) return false;
  clearPick();
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
  clearPick();
}
