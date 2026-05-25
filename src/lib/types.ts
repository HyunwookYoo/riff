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

export interface PersistedState {
  recent_repos: string[];
  theme: ThemeChoice;
  font_size: number;
  compare_mode: CompareMode;
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

/** Snapshot of a compare context, pushed onto the history stack on drill-in. */
export interface CompareCtx {
  compareMode: CompareMode;
  mode: DiffMode;
  startBranch: string;
  targetBranch: string;
  selectedFilePath: string | null;
}
