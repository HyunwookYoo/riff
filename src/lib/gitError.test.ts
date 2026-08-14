import { describe, it, expect } from "vitest";
import { classifyGitError } from "./gitError";

// Real git stderr shapes. Lines are real newlines; path lines are tab-indented
// (the `\t` escape is an actual tab, which is what git emits).
const CHECKOUT_LOCAL = `error: Your local changes to the following files would be overwritten by checkout:
\tsrc/foo.rs
\tsrc/bar.rs
Please commit your changes or stash them before you switch branches.
Aborting`;

const CHECKOUT_UNTRACKED = `error: The following untracked working tree files would be overwritten by checkout:
\tnotes.txt
Please move or remove them before you switch branches.
Aborting`;

const MERGE_DIRTY = `error: Your local changes to the following files would be overwritten by merge:
\tREADME.md
Please commit your changes or stash them before you merge.
Aborting`;

const PULL_REBASE_DIRTY = `error: cannot pull with rebase: You have unstaged changes.
error: Please commit or stash them.`;

const AUTH_FAIL = `fatal: Authentication failed for 'https://example.com/repo.git/'`;
const DIVERGENT = `fatal: Need to specify how to reconcile divergent branches.`;

describe("classifyGitError", () => {
  it("classifies checkout blocked by tracked local changes", () => {
    expect(classifyGitError(CHECKOUT_LOCAL).kind).toBe("local-changes-blocked");
  });

  it("classifies an untracked-file collision distinctly", () => {
    expect(classifyGitError(CHECKOUT_UNTRACKED).kind).toBe("untracked-collision");
  });

  it("classifies a dirty merge as local-changes-blocked", () => {
    expect(classifyGitError(MERGE_DIRTY).kind).toBe("local-changes-blocked");
  });

  it("classifies a dirty rebase-pull as local-changes-blocked", () => {
    expect(classifyGitError(PULL_REBASE_DIRTY).kind).toBe("local-changes-blocked");
  });

  it("leaves auth failures unknown (no false recovery)", () => {
    expect(classifyGitError(AUTH_FAIL).kind).toBe("unknown");
  });

  it("leaves divergent-branch pull unknown (out of case-A scope)", () => {
    expect(classifyGitError(DIVERGENT).kind).toBe("unknown");
  });

  it("returns unknown for empty input", () => {
    expect(classifyGitError("")).toEqual({ kind: "unknown", raw: "" });
  });

  it("classifies through the 'git command failed: ' IPC prefix", () => {
    // GitError::CommandFailed serializes as `git command failed: <stderr>`, so
    // classification must match the embedded substring, not the whole string.
    const f = classifyGitError("git command failed: " + CHECKOUT_LOCAL);
    expect(f.kind).toBe("local-changes-blocked");
  });
});
