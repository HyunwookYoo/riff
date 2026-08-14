/// Classify a raw git stderr string (as surfaced by `GitError::CommandFailed`)
/// into a recoverable failure kind. Case A of the error-recovery design:
/// operations blocked by local changes. Matching is on stable English
/// substrings; anything unrecognized (localized git, network/auth, divergent
/// pull, …) returns `unknown` so the caller falls back to the raw error banner.

export type GitFailureKind =
  | "local-changes-blocked"
  | "untracked-collision"
  | "unknown";

export interface GitFailure {
  kind: GitFailureKind;
  raw: string;
}

// "Your tracked local changes block this op" — checkout, merge, or pull(-rebase).
const LOCAL_CHANGES_MARKERS = [
  "would be overwritten by checkout",
  "would be overwritten by merge",
  "Please commit your changes or stash them before",
  "cannot pull with rebase: You have unstaged changes",
];

// "An untracked file would be clobbered."
const UNTRACKED_MARKER =
  "The following untracked working tree files would be overwritten by";

export function classifyGitError(stderr: string): GitFailure {
  const raw = stderr ?? "";
  if (raw.includes(UNTRACKED_MARKER)) {
    return { kind: "untracked-collision", raw };
  }
  if (LOCAL_CHANGES_MARKERS.some((m) => raw.includes(m))) {
    return { kind: "local-changes-blocked", raw };
  }
  return { kind: "unknown", raw };
}
