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
  paths: string[];
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
    return { kind: "untracked-collision", paths: parseBlockedPaths(raw), raw };
  }
  if (LOCAL_CHANGES_MARKERS.some((m) => raw.includes(m))) {
    return { kind: "local-changes-blocked", paths: parseBlockedPaths(raw), raw };
  }
  return { kind: "unknown", paths: [], raw };
}

// git lists the offending paths on tab-indented lines beneath the message
// header (e.g. "\tsrc/foo.rs"). Collect them; the surrounding "error:" /
// "Please …" / "Aborting" lines are not tab-indented, so they never match.
// Best-effort — an empty result is fine (the dialog still functions).
export function parseBlockedPaths(stderr: string): string[] {
  const out: string[] = [];
  for (const line of stderr.split("\n")) {
    if (line.startsWith("\t")) {
      const p = line.trim();
      if (p) out.push(p);
    }
  }
  return out;
}
