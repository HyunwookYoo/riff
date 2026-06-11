import type {
  AppMode,
  Branch,
  ChangedFile,
  Changelist,
  Commit,
  CompareCtx,
  CompareMode,
  DiffMode,
  FileViewMode,
  RepoEntry,
  RepoFile,
  RepoStatus,
  Stash,
  ThemeChoice,
  ViewMode,
  WorkspaceLayout,
} from "./types";

/// Per-tab UI memory (§14.2, Step 7). When the user switches tabs, the
/// previously active tab's selectedFile and CodeMirror scroll position are
/// restored. `scrollPos` is the scroll offset in pixels for the DiffView
/// scroller; undefined means "scroll to top" on restore.
export interface TabMemoryEntry {
  filePath: string | null;
  scrollPos?: number;
}

class AppState {
  repoPath = $state("");
  // Multi-root workspace (§13.4). The main repo is always repos[0] and its
  // path mirrors `repoPath` above. Submodule entries are appended when the
  // main loads; manual entries from user action. Single-repo code paths
  // that read `repoPath` keep working — `repos` is purely additive scaffold
  // until §13 Steps 3-7 wire it into compare/blame/UI.
  repos = $state<RepoEntry[]>([]);
  branches = $state<Branch[]>([]);
  startBranch = $state("");
  targetBranch = $state("");
  mode = $state<DiffMode>("three-dot");
  compareMode = $state<CompareMode>("branch");
  files = $state<ChangedFile[]>([]);
  selectedFile = $state<ChangedFile | null>(null);
  loadingRepo = $state(false);
  loadingFiles = $state(false);
  error = $state<string | null>(null);
  viewMode = $state<ViewMode>("side-by-side");
  recentRepos = $state<string[]>([]);
  theme = $state<ThemeChoice>("system");
  effectiveTheme = $state<"light" | "dark">("light");
  fontSize = $state<number>(13);
  // Global, persisted (PersistedState.file_view_mode). Mirrored on load;
  // written back via setFileViewMode() in git.ts when toggled.
  fileViewMode = $state<FileViewMode>("tree");
  ignoreWhitespace = $state(false);
  availableUpdate = $state<{ version: string; notes: string | null } | null>(
    null,
  );
  updateInstalling = $state(false);
  // Top-level workspace mode. Session-only — first run starts in compare.
  appMode = $state<AppMode>("compare");
  // File currently being blamed, repo-qualified (§13.3 #23). Persists across
  // drill-in/back so returning to blame mode lands you on the same file.
  // Session-only.
  blameTarget = $state<RepoFile | null>(null);
  // Cached `git ls-files` results for every repo in the workspace (§13.3 #20).
  // Each entry is `{ repoIdx, path }`; the blame picker fuzzy-searches the
  // whole union. Cleared on repo switch by InputBar.
  repoFiles = $state<RepoFile[]>([]);
  // Drill-in history stack. Each entry is the compare context the user can
  // return to. Session-only.
  history = $state<CompareCtx[]>([]);
  // Forward (redo) stack for drill-in. Populated by `popHistory` so the
  // user can mouse-forward back into the drilled view. Cleared whenever
  // a fresh drill is pushed (browser semantics).
  forwardHistory = $state<CompareCtx[]>([]);
  // Focus state (§13.3 #15, drill-in #17). null = multi-root view (all repos
  // visible), number = focused on repos[activeRepoIdx]. Session-only.
  activeRepoIdx = $state<number | null>(null);
  // Mirror of PersistedState.manual_repos_by_main — kept in sync with the
  // backend so the popover can render without re-fetching on every open.
  manualReposByMain = $state<Record<string, string[]>>({});
  // Per-repo collapse state (§13.3 #14). repos[idx] collapsed if idx in set.
  // Files in collapsed repos are skipped by j/k navigation. Session-only.
  collapsedRepos = $state(new Set<number>());
  // Lazy-loaded branch list per repo idx for the BranchPicker dropdown.
  // Main is mirrored from `branches` (repos[0]) on load. Cleared on repo
  // switch by InputBar.
  branchesByRepoIdx = $state<Record<number, Branch[]>>({});
  // Workspace layout (§14). "unified" = §13 multi-root view; "tabs" = Fork-
  // style tab bar. Mirrored from PersistedState.workspace_layout on load and
  // written back via setWorkspaceLayout() in git.ts.
  workspaceLayout = $state<WorkspaceLayout>("unified");
  // Per-tab UI memory (§14.2). Keyed by repoIdx. Populated when the user
  // selects a file or scrolls; consumed on tab switch to restore the prior
  // view. Session-only — not persisted.
  tabMemory = $state<Map<number, TabMemoryEntry>>(new Map());
  // Width (px) of blame view's left picker panel. Mirrored from
  // PersistedState.blame_picker_width on load; written back (debounced) on
  // drag-handle release.
  blamePickerWidth = $state<number>(300);
  // Commit-graph row height (px). A density control for the graph view.
  // Mirrored from PersistedState.graph_row_height on load; written back when
  // the user picks a size. Global.
  graphRowHeight = $state<number>(40);
  // Unreal asset preview (§ uasset). Master toggle, global UAssetGUI.exe path,
  // and per-repo UE version map. Mirrored from PersistedState on load; written
  // back via git.ts setters.
  parseUnrealAssets = $state<boolean>(true);
  uassetguiPath = $state<string | null>(null);
  ueVersionByRepo = $state<Record<string, string>>({});
  // History browser (commit log) state. Session-only. `commits` is the loaded
  // window (paginated via "load more"); `selectedCommitSha` highlights the row
  // whose parent..self diff is showing; `historyRef` anchors the log ("" =
  // HEAD). `commitsHasMore` gates the load-more affordance.
  commits = $state<Commit[]>([]);
  selectedCommitSha = $state<string | null>(null);
  loadingCommits = $state(false);
  commitsHasMore = $state(false);
  historyRef = $state("");
  // Count of uncommitted changes in the graph repo, for the WIP node drawn
  // above HEAD. Loaded alongside the commit log; 0 = clean (no node).
  wipCount = $state(0);
  // Mouse back/forward between the graph's WIP node and the Changes screen.
  // `wipReturn`: in Changes, mouse-back returns to the graph. `wipForward`: in
  // the graph, mouse-forward returns to Changes. Both are reset by any ordinary
  // navigation (enterChangesMode / enterGraphView) and re-armed by the special
  // WIP / back / forward steps.
  wipReturn = $state(false);
  wipForward = $state(false);
  // Which repo's history is being browsed: index into `repos`. 0 = main;
  // submodule/manual repos let you browse their own log + branches.
  historyRepoIdx = $state(0);
  // Graph mode: width (px) of the right-hand commit-detail panel (files + diff).
  // The graph itself takes the remaining (majority) width. Drag-resizable,
  // session-only.
  graphDetailWidth = $state(460);
  // Command palette (Ctrl+Shift+P) visibility. Session-only.
  paletteOpen = $state(false);
  // Pending "switch with local changes" prompt. Set when a checkout is
  // requested on a dirty working tree; the CheckoutDialog reads it to offer
  // stash / bring / discard. `ffTo` (a remote ref) fast-forwards the local to
  // the remote after the switch. null = no prompt open. Session-only.
  checkoutPrompt = $state<{
    repoPath: string;
    target: string;
    ffTo?: string;
  } | null>(null);
  // The user's compare context, snapshotted when entering history mode (which
  // reuses start/target + per-repo overrides + focus to render parent..commit)
  // and restored when returning to compare — so peeking at history doesn't
  // clobber their ref selection, submodule overrides, or focus.
  savedHistoryCtx = $state<{
    start: string;
    target: string;
    activeRepoIdx: number | null;
    overrides: Record<number, { startBranch: string; targetBranch: string }>;
  } | null>(null);
  // Source-control status (VC Phase 0 scaffold). Populated from
  // `git status --porcelain=v2` once the Changes screen (Phase 1) wires it in;
  // entries split there into staged (index_status≠'.') / unstaged
  // (worktree_status≠'.') / untracked. `ahead`/`behind`/`upstream` feed the
  // network toolbar. Session-only; additive until Phase 1 consumes it.
  repoStatus = $state<RepoStatus | null>(null);
  loadingStatus = $state(false);
  // Which side of the Changes screen the selected file is being viewed on:
  // "unstaged" (index↔worktree) or "staged" (HEAD↔index). DiffView reads this
  // to pick the per-side diff. Session-only.
  changesSide = $state<"staged" | "unstaged">("unstaged");
  // Changelists (Perforce/JetBrains-style named buckets) for the changes repo,
  // loaded + reconciled against status. `activeChangelistId` is the bucket the
  // commit box targets. Persisted per-repo via the backend. Session mirror.
  changelists = $state<Changelist[]>([]);
  activeChangelistId = $state("default");
  // Which repo the Changes screen stages/commits against: index into `repos`.
  // 0 = main; submodule/manual repos let you stage & commit inside them. Like
  // History's `historyRepoIdx`, independent of the compare Focus. Session-only.
  changesRepoIdx = $state(0);
  // Top (Unstaged) share of the Changes list area; the draggable divider
  // between the Unstaged and Staged panes adjusts it. Session-only.
  changesPaneFraction = $state(0.5);
  // refs sidebar (Working/Graph nav + branches/tags) visibility. Toggleable
  // (Ctrl+B); shown by default so the Fork-style view nav is visible.
  // Session-only.
  sidebarOpen = $state(true);
  // refs sidebar width (px), drag-resizable. Session-only.
  sidebarWidth = $state(240);
  // Current branch of the source-control repo, shown by the toolbar branch
  // chip. Set by loadStatus / loadCurrentBranch; null on detached HEAD.
  // Session-only.
  currentBranch = $state<string | null>(null);
  currentUpstream = $state<string | null>(null);
  currentAhead = $state(0);
  currentBehind = $state(0);
  // True while a fetch/pull/push runs (disables the sync buttons + spinner).
  syncing = $state(false);
  // In-progress operation that may need resolving: "merge" | "rebase" |
  // "cherry-pick" | "revert" | "none". Drives the conflict banner.
  pendingOp = $state("none");
  // Stash entries (git stash list) for the source-control repo. Shown in the
  // refs sidebar. Session-only.
  stashes = $state<Stash[]>([]);
  // Bumped after network ops so the refs sidebar re-lists (new remotes/branches)
  // without going through a full status reload.
  refsRefresh = $state(0);
  // Commit box state (Phase 1.3). `commitSignoff` is sticky across commits (a
  // user preference); subject/body/amend/coauthors are cleared on success.
  // Session-only.
  commitSubject = $state("");
  commitBody = $state("");
  commitAmend = $state(false);
  commitSignoff = $state(false);
  commitCoauthors = $state<string[]>([]);
  committing = $state(false);
}

export const appState = new AppState();
