import type {
  AppMode,
  Branch,
  ChangedFile,
  CompareCtx,
  CompareMode,
  DiffMode,
  FileViewMode,
  RepoEntry,
  RepoFile,
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
  // Unreal asset preview (§ uasset). Master toggle, global UAssetGUI.exe path,
  // and per-repo UE version map. Mirrored from PersistedState on load; written
  // back via git.ts setters.
  parseUnrealAssets = $state<boolean>(true);
  uassetguiPath = $state<string | null>(null);
  ueVersionByRepo = $state<Record<string, string>>({});
}

export const appState = new AppState();
