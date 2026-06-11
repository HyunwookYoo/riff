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

/// A changed range in UTF-16 offsets, computed by the backend and injected
/// into `@codemirror/merge` via `diffConfig.override`. Mirrors Rust `Change`.
export interface DiffChange {
  from_a: number;
  to_a: number;
  from_b: number;
  to_b: number;
}

export type FileDiff =
  | {
      kind: "text";
      old_content: string;
      new_content: string;
      old_size: number;
      new_size: number;
      /// Precomputed diff. `old_content`/`new_content` are EOL-normalized to
      /// match these offsets.
      changes: DiffChange[];
      /// Present when the text is a derived view (e.g. an Unreal asset parsed
      /// to JSON) rather than raw bytes. Drives the "derived" badge.
      derived_label?: string | null;
      /// Engine version actually used to derive an Unreal asset view.
      ue_version?: string | null;
    }
  | {
      kind: "binary";
      old_size: number;
      new_size: number;
      /// Optional reason shown with the binary view (e.g. why an Unreal asset
      /// couldn't be parsed).
      note?: string | null;
    }
  | {
      kind: "image";
      /// Base64 image bytes (data-URL payload); empty for an absent side.
      old_b64: string;
      new_b64: string;
      mime: string;
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

/// Only branch (two-ref) compare remains — the Working Tree sub-mode was folded
/// into the Changes screen.
export type CompareMode = "branch";

/// Workspace layout choice (§14). "unified" is the §13 multi-root view with
/// repo group headers + Focus toggle; "tabs" is the opt-in Fork-style tab
/// bar where one repo is visible at a time.
export type WorkspaceLayout = "unified" | "tabs";

/// File list rendering: "flat" lists full paths; "tree" nests by directory.
/// Global, persisted. Defaults to "tree".
export type FileViewMode = "flat" | "tree";

/// Top-level workspace mode. `compare` covers branch + worktree diff (the
/// sub-mode is `CompareMode`); `blame` is the standalone blame workspace;
/// `history` browses a commit log and shows the selected commit's diff (via
/// the same branch-compare pipeline, parent..commit); `changes` is the source-
/// control staging view (staged/unstaged split + per-side diff). Session-only.
export type AppMode = "compare" | "blame" | "history" | "changes";

/// One commit row in the history browser. Mirrors Rust `git::Commit`.
/// `parents` are full SHAs (drive the graph lane layout); `refs` are raw
/// decoration strings ("HEAD -> main", "tag: v1", "origin/main").
export interface Commit {
  sha: string;
  short_sha: string;
  parents: string[];
  author: string;
  /// Author time, unix seconds.
  time: number;
  summary: string;
  refs: string[];
}

/// One entry from `git status --porcelain=v2`. Mirrors Rust `StatusEntry`.
/// `index_status` (X, staged side) and `worktree_status` (Y, unstaged side)
/// are single-character porcelain codes (`.MADRCU?`, `.` = unmodified);
/// untracked files come back as `?`/`?`. `orig_path` is the pre-rename path.
export interface StatusEntry {
  path: string;
  orig_path: string | null;
  index_status: string;
  worktree_status: string;
}

/// Working-tree status snapshot. Mirrors Rust `RepoStatus`. `ahead`/`behind`
/// count commits vs `upstream` (0 when no upstream); `branch` is null on a
/// detached HEAD.
export interface RepoStatus {
  entries: StatusEntry[];
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

/// The three index stages of a conflicted file plus the working-tree copy
/// (with `<<<<<<<` markers). Mirrors Rust `ConflictVersions`. Absent stages
/// come back as empty strings; `binary` flags a non-text merge.
export interface ConflictVersions {
  base: string;
  ours: string;
  theirs: string;
  merged: string;
  binary: boolean;
}

/// A named bucket of changed files (Perforce/JetBrains-style changelist).
/// Persisted per-repo; "default" is always present and non-deletable.
export interface Changelist {
  id: string;
  name: string;
  files: string[];
}

/// One hunk of a file's unified diff, for per-hunk stage/unstage. Mirrors Rust
/// `Hunk`. `header` is the `@@ -a,b +c,d @@` line; `added`/`removed` are line
/// counts for the badge. The hunk's index in the returned array identifies it
/// for `applyHunks`.
export interface Hunk {
  header: string;
  added: number;
  removed: number;
}

/// One `git stash list` entry. Mirrors Rust `Stash`. `index` is its position
/// (`stash@{index}`); `message` is the subject.
export interface Stash {
  index: number;
  message: string;
}

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
  /// File list rendering mode (flat vs tree). Global. Defaults to "tree".
  file_view_mode: FileViewMode;
  /// Commit-graph row height (px). Clamped 28-72 on the backend; defaults to 40.
  graph_row_height: number;
  /// Master toggle for deriving Unreal asset (.uasset/.umap) previews.
  parse_unreal_assets: boolean;
  /// Absolute path to UAssetGUI.exe (global). null/empty disables previews.
  uassetgui_path: string | null;
  /// Per-main-repo Unreal Engine version string (e.g. "5.3"), keyed by repo path.
  ue_version_by_repo: Record<string, string>;
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
  /// Snapshot of non-main repos' overrides at this ctx, keyed by repoIdx.
  /// Missing key = no override at that idx. Lets drill-in/back/forward
  /// preserve overrides correctly when drilling into a submodule commit
  /// sets a temporary override on that repo.
  overrides: Record<number, { startBranch: string; targetBranch: string }>;
}
