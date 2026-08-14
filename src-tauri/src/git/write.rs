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
        // file they touch, so this is a no-op for conflicts resolved through
        // riff; it's what stages one resolved by hand in an external editor.
        let unmerged = unmerged_paths(path);
        if !unmerged.is_empty() {
            let mut add_args: Vec<&str> = vec!["add", "--"];
            add_args.extend(unmerged.iter().map(String::as_str));
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
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(GitError::CommandFailed(stderr));
        }
        self.drop_session();
        Ok(())
    }
}
