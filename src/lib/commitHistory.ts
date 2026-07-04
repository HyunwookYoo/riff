import { appState } from "./store.svelte";
import { commitLog, status } from "./git";
import { compare } from "./compare";
import { loadCurrentBranch, loadPendingOp, loadStashes } from "./sourceControl";
import type { Branch, Commit } from "./types";

/// Commits fetched per page; "load more" appends another page.
const PAGE_SIZE = 100;

/// Git's well-known empty tree object (SHA-1). Used as the "before" side when a
/// root commit (no parents) is selected, so its diff is the full initial state.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Monotonic guard so a slow log fetch from a previous repo/ref can't overwrite
// a newer one's results.
let logSession = 0;

type Overrides = Record<number, { startBranch: string; targetBranch: string }>;

/// Snapshot the per-repo overrides currently set on non-main repos, so leaving
/// history can put them back exactly (history may set its own while browsing a
/// submodule's commits).
function captureOverrides(): Overrides {
  const out: Overrides = {};
  for (let i = 0; i < appState.repos.length; i++) {
    const r = appState.repos[i];
    if (r.kind !== "main" && r.override) out[i] = { ...r.override };
  }
  return out;
}

/// Force repos[].override to match `desired`: set those listed, clear any
/// non-main override that isn't.
function restoreOverrides(desired: Overrides): void {
  let mutated = false;
  const next = appState.repos.map((r, i) => {
    if (r.kind === "main") return r;
    const want = desired[i];
    if (want) {
      if (
        !r.override ||
        r.override.startBranch !== want.startBranch ||
        r.override.targetBranch !== want.targetBranch
      ) {
        mutated = true;
        return { ...r, override: { ...want } };
      }
      return r;
    }
    if (r.override) {
      mutated = true;
      return { ...r, override: undefined };
    }
    return r;
  });
  if (mutated) appState.repos = next;
}

/// Path of the repo whose history is being browsed.
function historyRepoPath(): string {
  return appState.repos[appState.historyRepoIdx]?.path ?? appState.repoPath;
}

/// Enter the history browser. Snapshots the compare context (so it can be
/// restored on exit), then loads the selected repo's log and shows the chosen
/// (or newest) commit's diff.
export async function enterHistoryMode(): Promise<void> {
  if (appState.savedHistoryCtx === null) {
    appState.savedHistoryCtx = {
      start: appState.startBranch,
      target: appState.targetBranch,
      activeRepoIdx: appState.activeRepoIdx,
      overrides: captureOverrides(),
    };
  }
  appState.appMode = "history";
  appState.lastScmView = "history";
  if (!appState.repoPath) return;

  if (appState.commits.length === 0) {
    await loadCommits();
    return;
  }
  // Returning with a cached log: refresh the WIP count (changes may have been
  // staged/discarded meanwhile) and re-render the previously selected commit's
  // diff (the diff pane may have been replaced by another mode meanwhile).
  void loadWipCount();
  const sel =
    appState.commits.find((c) => c.sha === appState.selectedCommitSha) ??
    appState.commits[0];
  if (sel) openCommit(sel);
}

/// Enter the commit-graph sub-view of the source-control area. When coming
/// from the working (Changes) view, point the graph at the same repo.
export async function enterGraphView(): Promise<void> {
  // Ordinary entry resets the WIP back/forward pair; mouse-back re-arms
  // wipForward after calling this.
  appState.wipReturn = false;
  appState.wipForward = false;
  if (
    appState.appMode !== "history" &&
    appState.historyRepoIdx !== appState.changesRepoIdx
  ) {
    appState.historyRepoIdx = appState.changesRepoIdx;
    appState.historyRef = "";
    appState.commits = [];
    appState.selectedCommitSha = null;
  }
  await enterHistoryMode();
  void loadPendingOp();
  void loadStashes();
}

/// Restore the compare context snapshotted on entering history (branch refs,
/// per-repo overrides, focus). Called when transitioning back into a compare
/// mode. No-op if history was never entered.
export function restoreCompareContext(): void {
  const saved = appState.savedHistoryCtx;
  if (!saved) return;
  appState.startBranch = saved.start;
  appState.targetBranch = saved.target;
  appState.activeRepoIdx = saved.activeRepoIdx;
  restoreOverrides(saved.overrides);
  appState.savedHistoryCtx = null;
}

/// Switch which repo's history is shown (main or a submodule/manual repo) and
/// reload its log from HEAD.
export function setHistoryRepo(idx: number): void {
  if (idx === appState.historyRepoIdx) return;
  appState.historyRepoIdx = idx;
  // Keep the working (Changes) repo in lockstep — they're one source-control
  // repo — and refresh the toolbar branch chip to this repo's branch.
  appState.changesRepoIdx = idx;
  appState.historyRef = "";
  appState.selectedCommitSha = null;
  void loadCommits();
  void loadCurrentBranch();
}

/// Switch which ref the commit log follows (empty = HEAD) and reload. Used by
/// the history-mode branch picker.
export function setHistoryRef(ref: string): void {
  if (ref === appState.historyRef) return;
  appState.historyRef = ref;
  void loadCommits();
}

/// Fetch the commit log (a fresh page, or append the next page when
/// `opts.more`). A fresh load auto-opens the newest commit's diff.
export async function loadCommits(
  opts: { more?: boolean; preserveSelection?: boolean } = {},
): Promise<void> {
  if (!appState.repoPath) return;
  const more = opts.more === true;
  const skip = more ? appState.commits.length : 0;
  const session = ++logSession;
  appState.loadingCommits = true;
  if (!more) appState.error = null;
  try {
    const page = await commitLog(
      historyRepoPath(),
      appState.historyRef,
      // Empty ref → show every branch (the default graph); a picked ref scopes
      // the log to just that branch.
      appState.historyRef === "",
      PAGE_SIZE,
      skip,
    );
    if (session !== logSession) return;
    appState.commits = more ? appState.commits.concat(page) : page;
    appState.commitsHasMore = page.length === PAGE_SIZE;
    if (!more && page.length > 0) {
      // On a refresh (FS-watcher), keep the selected commit so the graph
      // doesn't snap back to the top; only open the newest when there was no
      // selection or it's gone (HEAD moved / rebased away).
      const keep =
        opts.preserveSelection &&
        appState.selectedCommitSha != null &&
        page.some((c) => c.sha === appState.selectedCommitSha);
      if (!keep) openCommit(page[0]);
    }
    // Refresh the WIP node's change count alongside a fresh log load.
    if (!more) void loadWipCount();
  } catch (e) {
    if (session === logSession && !more) {
      appState.error = String(e);
      appState.commits = [];
      appState.selectedCommitSha = null;
    }
  } finally {
    if (session === logSession) appState.loadingCommits = false;
  }
}

/// Append the next page of commits (the list's infinite scroll).
export async function loadMoreCommits(): Promise<void> {
  if (appState.loadingCommits || !appState.commitsHasMore) return;
  await loadCommits({ more: true });
}

/// Refresh the uncommitted-change count for the graph's WIP node. Reads status
/// for the history repo *without* the selection side effects of loadStatus, so
/// it's safe to call while browsing the graph.
export async function loadWipCount(): Promise<void> {
  if (!appState.repoPath) return;
  try {
    const st = await status(historyRepoPath());
    appState.wipCount = st.entries.length;
  } catch {
    appState.wipCount = 0;
  }
}

/// Drop the cached commit log so the next graph entry refetches it. The graph
/// reuses its cache (enterHistoryMode skips reload when commits are present), so
/// after a HEAD-moving op done outside history mode — commit, checkout, sync —
/// the cache must be cleared or the graph would miss the new state.
export function invalidateGraph(): void {
  appState.commits = [];
  appState.selectedCommitSha = null;
  appState.commitsHasMore = false;
}

/// Show one commit's diff: `parent..commit` as a two-dot branch compare, so the
/// existing FileList/DiffView pipeline renders it unchanged. Merge commits diff
/// against their first parent; root commits against the empty tree.
///
/// For the main repo the diff uses the global start/target refs; for a
/// submodule/manual repo it sets that repo's per-repo override so `compare()`
/// diffs *inside* that repo. Either way focus is pinned to the browsed repo so
/// only it is scanned.
export function openCommit(commit: Commit): void {
  const idx = appState.historyRepoIdx;
  const repo = appState.repos[idx];
  const start = commit.parents[0] ?? EMPTY_TREE;
  const target = commit.sha;

  appState.selectedCommitSha = commit.sha;
  appState.compareMode = "branch";
  appState.mode = "two-dot";
  appState.selectedFile = null;
  // A per-commit drill from Branch mode (`bcDiffRange`) takes priority in
  // compare() — so a leftover one would make the graph keep diffing that stale
  // range instead of the commit just clicked (empty/wrong file list). This is
  // the graph's own parent..commit view, so clear the drill.
  appState.bcDiffRange = null;

  if (!repo || repo.kind === "main") {
    appState.startBranch = start;
    appState.targetBranch = target;
  } else {
    const next = [...appState.repos];
    next[idx] = { ...repo, override: { startBranch: start, targetBranch: target } };
    appState.repos = next;
  }
  if (appState.repos.length > 1) appState.activeRepoIdx = idx;
  void compare();
}

/// Single-click a branch/tag in the sidebar while the graph is open: reveal it
/// in the graph. If its tip is already in the loaded page, select that commit in
/// place (row highlight + its diff), keeping the all-branches graph. Otherwise —
/// common in large repos, where the tip sits far below the first page — scope
/// the graph to this ref so its tip loads at the top and is selected; the user
/// restores the full graph with the "Showing → ✕ All" reset.
export function selectBranchInGraph(branch: Branch): void {
  // A local branch decorates as "name" (or "HEAD -> name" when checked out);
  // remotes as "<remote>/name"; tags as "tag: name".
  const want = branch.kind === "tag" ? `tag: ${branch.name}` : branch.name;
  const head = `HEAD -> ${branch.name}`;
  const commit = appState.commits.find((c) =>
    c.refs.some((r) => r === want || r === head),
  );
  if (commit) openCommit(commit);
  else setHistoryRef(branch.name);
}

/// Reset the history browser when the active repo changes, so a stale log from
/// the previous repo never shows.
export function resetHistory(): void {
  logSession++;
  appState.commits = [];
  appState.selectedCommitSha = null;
  appState.commitsHasMore = false;
  appState.savedHistoryCtx = null;
  appState.historyRef = "";
  appState.historyRepoIdx = 0;
}
