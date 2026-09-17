/// Classify a raw git stderr string (as surfaced by `GitError::CommandFailed`)
/// into a recoverable failure kind. Case A of the error-recovery design:
/// operations blocked by local changes. Matching is on stable English
/// substrings; anything unrecognized (localized git, network/auth, divergent
/// pull, …) returns `unknown` so the caller falls back to the raw error banner.

export type GitFailureKind =
  | "local-changes-blocked"
  | "untracked-collision"
  | "push-rejected-non-ff"
  | "push-rejected-stale"
  | "push-rejected-not-included"
  | "unknown";

export interface GitFailure {
  kind: GitFailureKind;
  raw: string;
}

// "Your tracked local changes block this op" — checkout, merge, pull, or
// rebase. Rebase refuses with its own wording ("error: cannot rebase: You have
// unstaged changes." / "…: Your index contains uncommitted changes."), whose
// second line ("Please commit or stash them.") is not the longer sentence the
// other commands use — so both rebase forms are listed here explicitly.
const LOCAL_CHANGES_MARKERS = [
  "would be overwritten by checkout",
  "would be overwritten by merge",
  "Please commit your changes or stash them before",
  "cannot pull with rebase: You have unstaged changes",
  "cannot rebase: You have unstaged changes",
  "cannot rebase: Your index contains uncommitted changes",
];

// "An untracked file would be clobbered."
const UNTRACKED_MARKER =
  "The following untracked working tree files would be overwritten by";

// The three ways `git push` turns riff down, read off the `! [rejected]` line
// (verified on git 2.43.0.windows.1). Each one needs different advice, so they
// are separate kinds rather than one "push failed":
//   (fetch first) / (non-fast-forward) — the remote has commits this branch
//     doesn't; pull, or force if the branch was rebased on purpose.
//   (stale info) — the lease failed: the remote moved since riff last fetched,
//     so forcing now would overwrite something riff has never seen.
//   (remote ref updated since checkout) — `--force-if-includes` failed: the
//     fetch happened, but this branch was never built on what it brought back.
const PUSH_NON_FF_MARKERS = ["(fetch first)", "(non-fast-forward)"];
const PUSH_STALE_MARKER = "(stale info)";
const PUSH_NOT_INCLUDED_MARKER = "(remote ref updated since checkout)";

export function classifyGitError(stderr: string): GitFailure {
  const raw = stderr ?? "";
  if (raw.includes(PUSH_STALE_MARKER)) {
    return { kind: "push-rejected-stale", raw };
  }
  if (raw.includes(PUSH_NOT_INCLUDED_MARKER)) {
    return { kind: "push-rejected-not-included", raw };
  }
  if (PUSH_NON_FF_MARKERS.some((m) => raw.includes(m))) {
    return { kind: "push-rejected-non-ff", raw };
  }
  if (raw.includes(UNTRACKED_MARKER)) {
    return { kind: "untracked-collision", raw };
  }
  if (LOCAL_CHANGES_MARKERS.some((m) => raw.includes(m))) {
    return { kind: "local-changes-blocked", raw };
  }
  return { kind: "unknown", raw };
}
