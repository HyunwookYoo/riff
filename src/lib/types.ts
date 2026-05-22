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

export interface PersistedState {
  recent_repos: string[];
  theme: ThemeChoice;
  font_size: number;
}
