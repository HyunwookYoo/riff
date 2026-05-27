export type BranchKind = "local" | "remote" | "tag";

export interface Branch {
  name: string;
  kind: BranchKind;
}

export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechanged";

export interface ChangedFile {
  path: string;
  old_path: string | null;
  status: FileStatus;
  /// Index into `appState.repos` identifying the repo this file belongs to.
  /// Set by the JS-side compare orchestrator after receiving the file from
  /// Rust — backend doesn't know about workspace structure. Defaults to 0
  /// (the main repo) so single-repo code paths keep working unchanged.
  repoIdx: number;
}

export type DiffMode = "three-dot" | "two-dot";

export type FileDiff =
  | {
      kind: "text";
      old_content: string;
      new_content: string;
      old_size: number;
      new_size: number;
    }
  | {
      kind: "binary";
      old_size: number;
      new_size: number;
    }
  | {
      kind: "too-large";
      old_size: number;
      new_size: number;
    };

export type ViewMode = "side-by-side" | "unified";

export type ThemeChoice = "system" | "light" | "dark";

export type CompareMode = "branch" | "worktree";

/// Workspace layout choice (§14). "unified" is the §13 multi-root view with
/// repo group headers + Focus toggle; "tabs" is the opt-in Fork-style tab
/// bar where one repo is visible at a time.
export type WorkspaceLayout = "unified" | "tabs";

/// Top-level workspace mode. `compare` covers branch + worktree diff (the
/// sub-mode is `CompareMode`); `blame` is the standalone blame workspace.
/// Session-only — never persisted.
export type AppMode = "compare" | "blame";

export interface PersistedState {
  recent_repos: string[];
  theme: ThemeChoice;
  font_size: number;
  compare_mode: CompareMode;
  /// Per-main-repo list of manually added extra repos (§13.3 #5).
  /// Submodules are not stored here — they're rediscovered from .gitmodules.
  manual_repos_by_main: Record<string, string[]>;
  /// Workspace layout (§14.5 #13). Global. Defaults to "unified".
  workspace_layout: WorkspaceLayout;
  /// Width (px) of the blame view's left file-picker. Clamped 200-600 on
  /// the backend; defaults to 300 for new installs.
  blame_picker_width: number;
}

/// A repo-qualified file path. Used by the unified blame picker
/// (§13.3 #20-23) to remember which repo a path lives in.
export interface RepoFile {
  repoIdx: number;
  path: string;
}

/// Submodule info as returned by the backend `list_submodules` command.
/// Mirror of Rust `SubmoduleInfo`.
export interface SubmoduleInfo {
  path: string;
  absolute_path: string;
  initialized: boolean;
}

export type RepoKind = "main" | "submodule" | "manual";

/// One entry in the multi-root workspace (§13.4). The main repo is always
/// `appState.repos[0]`. Submodule entries are populated from `.gitmodules`
/// when the main repo loads; manual entries from user "Add repo" action.
export interface RepoEntry {
  /// Absolute filesystem path. Used directly for all git commands.
  path: string;
  kind: RepoKind;
  /// Short label shown in file picker group header. For submodules this is
  /// the path relative to main (e.g. "vendor/sub"); for manual repos the
  /// basename; for main, the directory basename.
  displayName: string;
  /// For submodules: the path inside main's tree (i.e. the gitlink path).
  /// Needed to look up old/new SHAs via `submodule_sha_at` (§13.3 #7).
  parentGitlinkPath?: string;
  /// Per-repo branch override (§13.3 #9). When unset, the resolution rule
  /// for the repo's kind applies (gitlink-follow for submodule, same-name
  /// for manual).
  override?: {
    startBranch: string;
    targetBranch: string;
  };
}

export interface BlameCommit {
  sha: string;
  author: string;
  author_time: number;
  summary: string;
}

export interface Blame {
  commits: BlameCommit[];
  /** `line_commit[i]` is the index into `commits` for (1-based) line `i+1`. */
  line_commit: number[];
}

/** Snapshot of a workspace context, pushed onto the history stack on drill-in.
 * `appMode` lets us return to blame mode if that's where the drill started.
 * `activeRepoIdx` carries the Focus state (§13.3 #18,#19): null = multi-root
 * view, number = focused on a single repo. */
export interface CompareCtx {
  appMode: AppMode;
  compareMode: CompareMode;
  mode: DiffMode;
  startBranch: string;
  targetBranch: string;
  selectedFilePath: string | null;
  activeRepoIdx: number | null;
}
