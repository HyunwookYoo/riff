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
