//! Every line of riff that modifies a repository.
//!
//! riff writes in exactly five ways: create a branch, rename a branch, delete a
//! branch, checkout, and fetch/pull. The one exception is conflict resolution,
//! which cleans up the state riff's own pull created. If a change would add a
//! method here that does not fit that sentence, it belongs in another tool —
//! see docs/superpowers/specs/2026-08-12-vcs-scope-reduction-design.md.

use std::fs;
use std::path::Path;

use super::cli::{
    git_command, unmerged_paths, unresolved_conflict_files, validate_path, validate_ref, GitCli,
};
use super::GitError;

/// Conservative cap on paths per `git add` invocation in `op_continue`.
/// Windows caps a `CreateProcess` command line at 32,767 characters; even at
/// a few hundred characters per path — long nested paths aren't unusual in
/// riff's own dogfood repo, a nested-submodule Unreal project — 100 paths
/// stays far under that limit, with headroom left for the
/// `git -C <repo> add --` prefix. `add -u` never had this problem (it takes
/// no path arguments); the narrowed `add --` does, since a merge or rebase
/// conflicting across a few hundred `.uasset` files is not exotic. Do not
/// "simplify" this back to one call.
const ADD_CHUNK_SIZE: usize = 100;

/// Split `paths` into `git add -- <chunk>` argv groups of at most
/// `ADD_CHUNK_SIZE` paths — see its doc comment for why batching exists. Pure
/// so the batching is unit-testable without a real repo. An empty `paths`
/// yields no groups at all (`[].chunks(n)` is already an empty iterator), so
/// callers never run a bare `git add --` with no arguments.
fn add_arg_chunks(paths: &[String]) -> Vec<Vec<&str>> {
    paths
        .chunks(ADD_CHUNK_SIZE)
        .map(|chunk| {
            let mut args: Vec<&str> = vec!["add", "--"];
            args.extend(chunk.iter().map(String::as_str));
            args
        })
        .collect()
}

/// Choose the error text from a failed command's captured output: stderr, or
/// stdout when stderr came back empty. `git rebase --continue`'s "You must
/// edit all merge conflicts..." refusal (when a tracked file still has
/// unstaged changes) is one confirmed case — exit 1, empty stderr, the
/// message on stdout instead (verified on git 2.43.0.windows.1). Without this
/// fallback that surfaces to the user as an empty `git command failed:`
/// banner. Merge (`commit --no-edit`) and cherry-pick/revert `--continue`
/// weren't observed to do this, but the fallback is harmless for them too.
fn command_error_text(stderr: &[u8], stdout: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }
    String::from_utf8_lossy(stdout).trim().to_string()
}

impl GitCli {
    pub(super) fn create_branch_impl(
        &self,
        path: &Path,
        name: &str,
        start_point: Option<&str>,
        checkout: bool,
    ) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(name)?;
        if let Some(sp) = start_point {
            validate_ref(sp)?;
        }
        let mut args: Vec<&str> = if checkout {
            vec!["checkout", "-b", name]
        } else {
            vec!["branch", name]
        };
        if let Some(sp) = start_point {
            args.push(sp);
        }
        self.run(path, &args)?;
        if checkout {
            self.drop_session();
        }
        Ok(())
    }

    pub(super) fn rename_branch_impl(&self, path: &Path, old: &str, new: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(old)?;
        validate_ref(new)?;
        self.run(path, &["branch", "-m", old, new])?;
        Ok(())
    }

    pub(super) fn delete_branch_impl(&self, path: &Path, name: &str, force: bool) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(name)?;
        let flag = if force { "-D" } else { "-d" };
        self.run(path, &["branch", flag, name])?;
        Ok(())
    }

    pub(super) fn checkout_impl(&self, path: &Path, ref_name: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(ref_name)?;
        self.run(path, &["checkout", ref_name])?;
        self.drop_session();
        Ok(())
    }

    pub(super) fn fast_forward_impl(&self, path: &Path, ref_name: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(ref_name)?;
        self.run(path, &["merge", "--ff-only", ref_name])?;
        self.drop_session();
        Ok(())
    }

    pub(super) fn fetch_impl(&self, path: &Path) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        self.run_network(path, &["fetch", "--all", "--prune"])?;
        // Newly-fetched objects/refs won't be visible to the cached batch.
        self.drop_session();
        Ok(())
    }

    pub(super) fn pull_impl(&self, path: &Path) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        // Always a merge pull: `--rebase` would rewrite local history, which is
        // outside riff's write surface.
        self.run_network(path, &["pull"])?;
        self.drop_session();
        Ok(())
    }

    pub(super) fn resolve_conflict_impl(
        &self,
        path: &Path,
        file_path: &str,
        content: &str,
    ) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_path(file_path)?;
        fs::write(path.join(file_path), content).map_err(GitError::Io)?;
        // Staging a path with no conflict markers marks it resolved for the op.
        self.run(path, &["add", "--", file_path])?;
        self.drop_session();
        Ok(())
    }

    pub(super) fn checkout_conflict_side_impl(
        &self,
        path: &Path,
        file_path: &str,
        side: &str,
    ) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_path(file_path)?;
        let flag = match side {
            "ours" => "--ours",
            "theirs" => "--theirs",
            _ => return Err(GitError::CommandFailed("invalid conflict side".into())),
        };
        self.run(path, &["checkout", flag, "--", file_path])?;
        self.run(path, &["add", "--", file_path])?;
        self.drop_session();
        Ok(())
    }

    pub(super) fn op_abort_impl(&self, path: &Path, op: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        let sub = match op {
            "merge" | "rebase" | "cherry-pick" | "revert" => op,
            _ => return Err(GitError::CommandFailed("no operation in progress".into())),
        };
        self.run(path, &[sub, "--abort"])?;
        self.drop_session();
        Ok(())
    }

    pub(super) fn op_continue_impl(&self, path: &Path, op: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        // For merge, complete the commit (--continue would open an editor);
        // for the sequencer ops, --continue with the editor suppressed.
        let args: &[&str] = match op {
            "merge" => &["commit", "--no-edit"],
            "rebase" => &["rebase", "--continue"],
            "cherry-pick" => &["cherry-pick", "--continue"],
            "revert" => &["revert", "--continue"],
            _ => return Err(GitError::CommandFailed("no operation in progress".into())),
        };
        // A resolution left unstaged in the working tree makes git bail with
        // "you have unstaged changes" / "unmerged files" — but first refuse if
        // a conflict still has markers, so a half-resolved file is never
        // committed as the resolution.
        let unresolved = unresolved_conflict_files(path);
        if !unresolved.is_empty() {
            return Err(GitError::CommandFailed(format!(
                "resolve the remaining conflict markers first: {}",
                unresolved.join(", ")
            )));
        }
        // Stage exactly the files that were part of the conflict — not `add -u`
        // (every modified tracked file in the repo). op_continue is riff's only
        // path that creates a commit, and the module invariant above is that
        // riff never commits work the user didn't ask it to: an unrelated
        // uncommitted edit sitting alongside a conflict must not get folded
        // into the merge commit just because Continue happened to run.
        // `resolve_conflict` and `checkout_conflict_side` already `git add` the
        // file they touch, which resolves it in git's index (no more conflict
        // stages) — so it has already dropped out of unmerged_paths by the
        // time Continue runs. What's left to add here is only what's still
        // genuinely unmerged: a conflict resolved by hand in an external
        // editor. Chunked (see ADD_CHUNK_SIZE) so a conflict spanning hundreds
        // of paths can't overflow a single command line.
        let unmerged = unmerged_paths(path);
        for add_args in add_arg_chunks(&unmerged) {
            self.run(path, &add_args)?;
        }
        let output = git_command()
            .arg("-C")
            .arg(path)
            .args(args)
            .env("GIT_EDITOR", "true")
            .env("GIT_SEQUENCE_EDITOR", "true")
            .output()?;
        if !output.status.success() {
            // Not always stderr: see command_error_text's doc comment.
            return Err(GitError::CommandFailed(command_error_text(
                &output.stderr,
                &output.stdout,
            )));
        }
        self.drop_session();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_arg_chunks_empty_produces_no_groups() {
        let paths: Vec<String> = vec![];
        assert!(add_arg_chunks(&paths).is_empty());
    }

    #[test]
    fn add_arg_chunks_one_group_under_the_cap() {
        let paths = vec!["a.txt".to_string(), "b.txt".to_string()];
        let chunks = add_arg_chunks(&paths);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], vec!["add", "--", "a.txt", "b.txt"]);
    }

    #[test]
    fn add_arg_chunks_splits_at_the_cap() {
        let paths: Vec<String> = (0..ADD_CHUNK_SIZE + 1).map(|i| format!("f{i}.txt")).collect();
        let chunks = add_arg_chunks(&paths);
        assert_eq!(chunks.len(), 2);
        // Each group is ["add", "--", ...paths].
        assert_eq!(chunks[0].len(), 2 + ADD_CHUNK_SIZE);
        assert_eq!(chunks[1].len(), 2 + 1);
        assert_eq!(chunks[0][0], "add");
        assert_eq!(chunks[0][1], "--");
        assert_eq!(chunks[1][2], "f100.txt");
    }

    #[test]
    fn add_arg_chunks_exactly_the_cap_is_one_group() {
        let paths: Vec<String> = (0..ADD_CHUNK_SIZE).map(|i| format!("f{i}.txt")).collect();
        assert_eq!(add_arg_chunks(&paths).len(), 1);
    }

    #[test]
    fn command_error_text_prefers_stderr() {
        assert_eq!(command_error_text(b"stderr msg", b"stdout msg"), "stderr msg");
    }

    #[test]
    fn command_error_text_falls_back_to_stdout_when_stderr_is_empty() {
        // git rebase --continue's "unstaged changes" refusal: exit 1, empty
        // stderr, message on stdout.
        assert_eq!(
            command_error_text(b"", b"You must edit all merge conflicts..."),
            "You must edit all merge conflicts..."
        );
    }

    #[test]
    fn command_error_text_falls_back_when_stderr_is_only_whitespace() {
        assert_eq!(command_error_text(b"   \n", b"real message"), "real message");
    }

    #[test]
    fn command_error_text_trims_both_streams() {
        assert_eq!(command_error_text(b"  stderr text \n", b""), "stderr text");
    }

    #[test]
    fn command_error_text_empty_both_is_empty() {
        assert_eq!(command_error_text(b"", b""), "");
    }
}
