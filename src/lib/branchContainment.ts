import { appState } from "./store.svelte";
import {
  commitContainmentDetail,
  commitLog,
  commitLogExcluding,
  containment,
  findCommit,
  squashCheck,
} from "./git";
import { compare, forgetListedRanges, listedRanges } from "./compare";
import { resolveRepoRanges } from "./repoRange";
import { EMPTY_TREE } from "./emptyTree";
import { startRebaseCheck } from "./rebaseCheck";
import { scopeLine, shortRef, type ToolbarPair } from "./rangeText";
import type { Counts, RowMark, SideNames, Summary } from "./commitTableText";
import type {
  BcGroup,
  Commit,
  CommitFind,
  Containment,
  RepoRange,
  SquashCheck,
  TabMark,
} from "./types";

/// Rows fetched per page of a commit-table group.
export const PAGE_SIZE = 100;

// Monotonic guard, bumped by every load (and by clearBranchContainment). A
// load that another has taken over — a call for a different pair, repo or
// override starts at once — finds it moved at its next await and drops its
// results. A refresh (same inputs) never bumps it while a load runs: it asks
// for one more pass, run once that load is done (see loadBranchContainment).
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
/// could not be read or are still loading), named by the toolbar pair, and
/// read as all in once none has ● left and none is still loading.
export function summarize(groups: VisibleGroup[], pair: ToolbarPair): Summary {
  if (groups.length === 0) return { kind: "no-refs" };
  if (groups.length === 1 && groups[0].group.base === groups[0].group.compare) {
    return { kind: "same" };
  }
  const ready = groups.filter((v) => v.group.status === "ready");
  const loading = groups.filter((v) => v.group.status === "loading").length;
  if (ready.length === 0) return loading > 0 ? { kind: "loading" } : { kind: "error" };
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
  const names = { base: shortRef(pair.base), compare: shortRef(pair.compare) };
  if (out > 0) {
    return {
      kind: "unmerged",
      names,
      out,
      patch,
      behind: null,
      repos: ready.length,
      failed,
      ...(loading > 0 ? { loading } : {}),
    };
  }
  if (loading > 0) return { kind: "loading" };
  return { kind: "all-in", names, repos: ready.length, failed };
}

/// A Branch-mode repo tab's mark: what the commit table knows about the repo,
/// in one glyph. `repoName`, `superName` and `pair` word a gap's tooltip. A gap
/// is `—`, except a repo whose clone lacks a ref, which is `!`.
export function repoTabMark(
  range: RepoRange | undefined,
  group: BcGroup | undefined,
  repoName: string,
  superName: string,
  pair: ToolbarPair,
): TabMark | null {
  if (!range) return null;
  if (!range.ok) {
    const line = scopeLine(range, repoName, superName, pair);
    const title = line.kind === "note" ? line.text : undefined;
    return range.reason === "missing"
      ? { text: "!", tone: "error", title }
      : { text: "—", tone: "muted", title };
  }
  if (!group || group.status === "loading") {
    return { text: "…", tone: "muted", title: "reading commits…" };
  }
  if (group.status === "error") {
    return { text: "!", tone: "error", title: `couldn't read commits: ${group.error ?? "unknown error"}` };
  }
  const out = groupCounts(group).out;
  return out > 0 ? { text: `● ${out}`, tone: "out" } : { text: "✓", tone: "in" };
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
    rebase: null,
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

/// Whether a group's list goes on past `rows`, `page` being the last page
/// fetched (`limit` rows asked for). The default list is as long as
/// containment's ahead count; a merged-commits list has no known length, so
/// only a full page says so.
function moreToLoad(
  marks: Containment | null,
  rows: Commit[],
  page: Commit[],
  limit = PAGE_SIZE,
): boolean {
  return appState.bcShowMerged
    ? page.length === limit
    : rows.length < (marks?.ahead ?? 0);
}

/// One page of a group's rows. Default: compare's commits the base lacks.
/// With merged commits shown: what the introducing merge (`mergedBy`) brought
/// in when it is known, otherwise compare's history.
function fetchPage(
  g: Pick<BcGroup, "path" | "base" | "compare">,
  mergedBy: BcGroup["mergedBy"],
  skip: number,
  limit = PAGE_SIZE,
): Promise<Commit[]> {
  const exclude = listExclude(g, mergedBy);
  return exclude !== null
    ? commitLogExcluding(g.path, g.compare, exclude, limit, skip)
    : commitLog(g.path, g.compare, false, limit, skip);
}

/// What the list fetchPage reads leaves out — everything in this ref — or
/// null for compare's whole history.
function listExclude(
  g: Pick<BcGroup, "base">,
  mergedBy: BcGroup["mergedBy"],
): string | null {
  if (!appState.bcShowMerged) return g.base;
  return mergedBy?.parents[0] ?? null;
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
  // A kept group whose check never answered (the table was unmounted under a
  // commit view, which cancels the runs) starts it again.
  else if (!rebaseRuns.has(idx) && (g.rebase === null || g.rebase.kind === "checking")) {
    checkRebase(idx);
  }
}

// Running rebase checks by group; an entry is removed once its result lands.
const rebaseRuns = new Map<number, { cancel: () => void }>();

/// Cancel every running rebase check (the table leaving the screen, or cleared).
export function cancelRebaseChecks(): void {
  for (const run of rebaseRuns.values()) run.cancel();
  rebaseRuns.clear();
}

/// Start group `idx`'s rebase conflict preview, replacing any run for it. A
/// range with an empty-tree side (a submodule pin that appeared or vanished)
/// has nothing to rebase. Updates land only while this run is current and the
/// group's range is the one it was started for.
function checkRebase(idx: number): void {
  rebaseRuns.get(idx)?.cancel();
  rebaseRuns.delete(idx);
  const g = appState.bcGroups[idx];
  if (!g || g.base === EMPTY_TREE || g.compare === EMPTY_TREE) {
    patchGroup(idx, { rebase: null });
    return;
  }
  const { path, base, compare: branch } = g;
  const run = { cancel: () => {} };
  rebaseRuns.set(idx, run);
  run.cancel = startRebaseCheck(path, base, branch, null, (state) => {
    const cur = appState.bcGroups[idx];
    if (rebaseRuns.get(idx) !== run || cur?.path !== path || cur.base !== base || cur.compare !== branch) {
      return;
    }
    if (state.kind !== "checking") rebaseRuns.delete(idx);
    patchGroup(idx, { rebase: state });
  });
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
    // on the next refresh. With ● rows they wait for the squash verdict: a
    // check that a newer load abandons leaves none, so that load reloads the
    // group rather than skipping it with "checking" or an old verdict on it.
    patchGroup(idx, {
      marks,
      mergedBy,
      commits,
      hasMore: moreToLoad(marks, commits, commits),
      status: "ready",
      error: null,
      loadingMore: false,
      ...(unmerged ? { baseTip: null, compareTip: null } : { ...tips, squash: null }),
    });
    checkRebase(idx);
    settlePick(idx);
    if (unmerged) await checkSquash(idx, s, tips);
  } catch (e) {
    // No tips: a failed group loads again on the next refresh.
    if (s === bcSession) {
      // The old tips' preview no longer describes anything riff could read.
      rebaseRuns.get(idx)?.cancel();
      rebaseRuns.delete(idx);
      patchGroup(idx, {
        status: "error",
        error: String(e),
        baseTip: null,
        compareTip: null,
        rebase: null,
      });
    }
  }
}

/// Once group `idx` has reloaded: a pick in it that the fresh results no
/// longer hold — neither a row nor one of its ● / ◐ commits, as when compare
/// was amended or rebased — is dropped and the files go back to all changes;
/// a pick they still hold has its detail looked up again, since base may have
/// moved too.
function settlePick(idx: number): void {
  const sel = appState.bcSelected;
  const g = appState.bcGroups[idx];
  if (!sel || sel.repoIdx !== idx || !g) return;
  const sha = sel.commit.sha;
  if (g.commits.some((c) => c.sha === sha) || g.marks?.not_in_target.includes(sha)) {
    appState.bcSelectedDetail = null;
    void loadSelectedDetail(idx, sha);
    return;
  }
  clearPick();
  // Only Branch mode's list: a load that ends after the mode was left must
  // not seed selectedFile, which Working Copy shares.
  if (appState.appMode === "compare") void compare({ silent: true });
}

/// Ask whether a group's unmerged commits landed as a squash. The group is
/// already on screen; only its marks and wording change when the answer comes.
/// A group that has an answer keeps it while the next one is on its way —
/// refsRefresh fires on every saved file, and ◐ rows must not flicker back to ●.
/// The group's tips are stored with the answer (or the failure); an answer
/// dropped because a newer load took over stores none. Nor does one that
/// lands after a merged-commits toggle: the group's rows are the other list's
/// until the toggle's refetch lands, and the tips the toggle cleared are what
/// makes a load that drops that refetch reload the group.
async function checkSquash(idx: number, s: number, tips: Tips): Promise<void> {
  const g = appState.bcGroups[idx];
  if (!g) return;
  const list = listSession;
  if (g.squash === null) patchGroup(idx, { squash: "checking" });
  const stored = () => (list === listSession ? tips : {});
  try {
    const result = await squashCheck(g.path, g.compare, g.base);
    if (s === bcSession) patchGroup(idx, { squash: result, ...stored() });
  } catch {
    if (s === bcSession) patchGroup(idx, { squash: null, ...stored() });
  }
}

/// What a load is for, refsRefresh aside: the repo, the toolbar pair and the
/// repos with their overrides (the range resolver's other inputs).
function loadInputs(): string {
  return JSON.stringify([
    appState.repoPath,
    appState.startBranch,
    appState.targetBranch,
    appState.repos.map((r) => [r.path, r.kind, r.parentGitlinkPath ?? "", r.override ?? null]),
  ]);
}

// The load running now, and the inputs it started with. refsRefresh fires on
// every saved file, and refreshes left to overlap pile up git processes that
// no one waits for (see inflight.ts): a call for the same inputs asks the
// running load for one more pass after it. A call for other inputs takes
// over at once, so the old range's rows never land under the new labels.
let running: { inputs: string; again: boolean } | null = null;

/// Rebuild the commit table for the current inputs: one group per repo whose
/// range resolved, each loading its marks and first page on its own. A group
/// whose range is unchanged keeps its rows and marks while its fresh results
/// load — a refresh (fetch, checkout, a saved file) must not blank the table
/// or reset the diff being read — and so does a commit picked in it; a group
/// whose tips did not move is not reloaded at all. A pick whose range changed
/// or vanished belonged to the old comparison, so it is dropped and the file
/// list goes back to all changes. A call made while a load runs collapses into
/// one more load after it, unless the pair, repo or overrides changed: then it
/// starts now, and the load it replaces drops its results.
export async function loadBranchContainment(): Promise<void> {
  const inputs = loadInputs();
  if (running && running.inputs === inputs) {
    running.again = true;
    return;
  }
  const me = { inputs, again: false };
  running = me;
  try {
    do {
      me.again = false;
      await loadOnce();
      // Asked for in Branch mode: once it is left the table is off screen,
      // and its groups stay for the way back (the next visit loads anyway).
    } while (me.again && running === me && appState.appMode === "compare");
  } finally {
    if (running === me) running = null;
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
  // The file list and the selection are Branch mode's to touch only while it
  // is on screen: Working Copy shares selectedFile, and a load can end after
  // the mode was left. Whatever is skipped here, the first load back does.
  const listing = appState.appMode === "compare";
  if (Object.keys(groups).length === 0) {
    // Nothing to compare yet: drop a leftover selection (e.g. a file opened in
    // Changes) so the diff pane shows its placeholder, not an error.
    if (listing) {
      appState.selectedFile = null;
      appState.files = [];
      forgetListedRanges();
    }
    return;
  }
  if (listing && drill && !keepPick) {
    void compare({ silent: true });
  } else if (listing && !drill && listedRanges() !== JSON.stringify(ranges)) {
    // The file list follows the ranges as the table does, so no two surfaces
    // describe different ones: list these unless compare() already has. (A
    // kept pick's own files are what the list holds.) The open file stays
    // open if the new list has it.
    void compare({ silent: true, preservePath: appState.selectedFile?.path ?? null });
  }
  await Promise.all(toLoad.map(([i, r]) => refreshGroup(i, r, s)));
}

/// The next page of group `idx` — its "Load 100 more" row — or, with `upTo`,
/// as many pages as it takes to list at least that many rows.
export async function loadMoreGroup(idx: number, upTo = 0): Promise<void> {
  const g = appState.bcGroups[idx];
  if (!g || g.status !== "ready" || !g.hasMore || g.loadingMore) return;
  const list = listSession;
  // The rows this page continues: once a reload or a toggle has replaced them,
  // its offset means nothing and the page is dropped.
  const rows = g.commits;
  patchGroup(idx, { loadingMore: true });
  const limit = Math.max(1, Math.ceil((upTo - rows.length) / PAGE_SIZE)) * PAGE_SIZE;
  try {
    const page = await fetchPage(g, g.mergedBy, rows.length, limit);
    if (list !== listSession) return;
    if (appState.bcGroups[idx]?.commits !== rows) {
      patchGroup(idx, { loadingMore: false });
      return;
    }
    // compare's history can shift between two pages; a row is listed once.
    const listed = new Set(rows.map((c) => c.sha));
    const commits = rows.concat(page.filter((c) => !listed.has(c.sha)));
    patchGroup(idx, {
      commits,
      hasMore: moreToLoad(g.marks, commits, page, limit),
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
        const marks = appState.bcGroups[idx]?.marks ?? null;
        patchGroup(idx, { commits, hasMore: moreToLoad(marks, commits, commits) });
      } catch (e) {
        if (s === bcSession && list === listSession) {
          patchGroup(idx, { status: "error", error: String(e) });
        }
      }
    }),
  );
}

/// What a SHA search of the commit table came to.
export type FindResult =
  /// The row is listed now (merged commits shown and pages loaded as needed).
  | { kind: "found"; repoIdx: number; sha: string }
  /// Not 4 to 40 hex digits.
  | { kind: "invalid" }
  /// No commit on screen's compare side has that prefix.
  | { kind: "not-in-range" }
  /// More than one does.
  | { kind: "ambiguous" }
  /// In base from before the merge the merged list starts at: no list has it.
  | { kind: "unlisted" }
  | { kind: "error"; message: string }
  /// The table reloaded (other refs, repo or layout) while the search ran.
  | { kind: "stale" };

/// Find the commit whose SHA starts with `query` among the groups on screen
/// and make its row listed: turn merged commits on when it is in base, and
/// load pages through its row. Scrolling to the row is the table's job.
export async function findInTable(query: string): Promise<FindResult> {
  const prefix = query.trim().toLowerCase();
  if (!/^[0-9a-f]{4,40}$/.test(prefix)) return { kind: "invalid" };
  const s = bcSession;
  const ask = (idx: number): Promise<CommitFind> => {
    const g = appState.bcGroups[idx];
    return findCommit(g.path, prefix, g.compare, g.base, listExclude(g, g.mergedBy));
  };
  const idxs = Object.keys(appState.bcGroups)
    .map(Number)
    .filter((i) => isRepoVisible(i) && appState.bcGroups[i].status === "ready");
  let matches = 0;
  let failed: string | null = null;
  const hits: { idx: number; find: CommitFind }[] = [];
  await Promise.all(
    idxs.map(async (idx) => {
      try {
        const find = await ask(idx);
        matches += find.matches;
        if (find.sha) hits.push({ idx, find });
      } catch (e) {
        failed = String(e);
      }
    }),
  );
  if (s !== bcSession) return { kind: "stale" };
  if (matches > 1) return { kind: "ambiguous" };
  if (hits.length === 0) {
    return failed !== null ? { kind: "error", message: failed } : { kind: "not-in-range" };
  }
  const idx = hits[0].idx;
  let find = hits[0].find;
  if (find.index === null && find.in_target && !appState.bcShowMerged) {
    await setShowMerged(true);
    if (s !== bcSession || !appState.bcGroups[idx]) return { kind: "stale" };
    try {
      find = await ask(idx);
    } catch (e) {
      return { kind: "error", message: String(e) };
    }
    if (s !== bcSession) return { kind: "stale" };
  }
  const { sha, index } = find;
  if (sha === null || index === null) return { kind: "unlisted" };
  // A "Load more" already running makes loadMoreGroup a no-op; a few rounds
  // let it land first.
  for (let round = 0; round < 3; round++) {
    const g = appState.bcGroups[idx];
    if (s !== bcSession || !g) return { kind: "stale" };
    if (g.commits.some((c) => c.sha === sha)) return { kind: "found", repoIdx: idx, sha };
    if (!g.hasMore) break;
    await loadMoreGroup(idx, index + 1);
  }
  const g = appState.bcGroups[idx];
  if (s !== bcSession || !g) return { kind: "stale" };
  return g.commits.some((c) => c.sha === sha)
    ? { kind: "found", repoIdx: idx, sha }
    : { kind: "error", message: "couldn't load its row" };
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

// Bumped by every detail lookup, so only the latest one for a pick lands.
let detailSeq = 0;

/// How the picked commit reached base (the introducing merge), for the Files
/// header. Lands only while that commit, in that repo, is still the pick — a
/// refresh in between does not make it stale.
async function loadSelectedDetail(repoIdx: number, sha: string): Promise<void> {
  const g = appState.bcGroups[repoIdx];
  if (!g) return;
  const seq = ++detailSeq;
  try {
    const d = await commitContainmentDetail(g.path, sha, g.base);
    const sel = appState.bcSelected;
    if (seq !== detailSeq || sel?.repoIdx !== repoIdx || sel.commit.sha !== sha) return;
    appState.bcSelectedDetail = d;
  } catch {
    /* the header falls back to the row's own mark */
  }
}

/// Empty the commit table and drop the pick; results of a load still in
/// flight are dropped too. A load calls it when there is nothing to load:
/// outside Branch mode, or with no repo open.
export function clearBranchContainment(): void {
  bcSession++;
  cancelRebaseChecks();
  appState.bcGroups = {};
  clearPick();
}
