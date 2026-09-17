//! Every line of riff that modifies a repository.
//!
//! riff writes in exactly seven ways: create a branch, rename a branch, delete
//! a branch, checkout, fetch/pull, rebase, and push. The one exception is
//! conflict resolution, which cleans up the state riff's own pull or rebase
//! created.
//! Rebase carries `--autostash`, so a rebase does set local changes aside and
//! put them back — git's own stash, taken and restored inside the one command,
//! never a stash riff leaves behind for the user to find. If
//! a change would add a method here that does not fit that sentence, it belongs
//! in another tool — see
//! docs/superpowers/specs/2026-08-12-vcs-scope-reduction-design.md and its
//! amendment, docs/superpowers/specs/2026-09-14-rebase-design.md.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::cli::{
    git_command, unmerged_paths, unresolved_conflict_files, validate_path, validate_ref, GitCli,
};
use super::{GitError, RebaseAction, RebaseStep};

/// Argv flag riff passes to *itself* when git invokes it as the rebase todo
/// editor — see `sequence_editor_command` and `main.rs`.
pub const REBASE_TODO_FLAG: &str = "--rebase-todo";

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

/// Whether git's autostash came back into a conflicted working tree.
///
/// `--autostash` sets local changes aside before a rebase and restores them
/// when it ends — after the final commit, or after `--continue` / `--skip` /
/// `--abort` finishes one that stopped. That restore can conflict with what the
/// rebase just wrote, and when it does git says so and *exits 0* (verified on
/// git 2.43.0.windows.1): the rebase really did succeed. The user is left with
/// conflict markers in the working tree and the changes still in the stash, so
/// this string is the only signal that anything needs their attention.
fn autostash_conflicted(text: &str) -> bool {
    text.contains("Applying autostash resulted in conflicts")
}

/// Reject anything that isn't a plain abbreviated-or-full commit SHA. The todo
/// lines these land in are executed by git's sequencer, so nothing else — a
/// ref name, an option, whitespace — may reach that file.
fn validate_sha(s: &str) -> Result<&str, GitError> {
    let ok = (7..=40).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit());
    if ok {
        Ok(s)
    } else {
        Err(GitError::InvalidRef(s.to_string()))
    }
}

/// Render the plan as a `git rebase -i` todo file. Pure so the refusals below
/// are unit-testable without a repo.
///
/// Two plans git would accept are refused here because riff cannot honour what
/// they ask for: a leading `squash`/`fixup` has no commit to meld into, and a
/// plan that drops everything is a reset to upstream — riff does not reset.
fn build_todo(steps: &[RebaseStep]) -> Result<String, GitError> {
    let mut lines = Vec::with_capacity(steps.len());
    let mut kept = 0usize;
    for step in steps {
        validate_sha(&step.sha)?;
        let verb = match step.action {
            RebaseAction::Pick => "pick",
            RebaseAction::Squash => "squash",
            RebaseAction::Fixup => "fixup",
            RebaseAction::Edit => "edit",
            RebaseAction::Drop => "drop",
        };
        if matches!(step.action, RebaseAction::Squash | RebaseAction::Fixup) && kept == 0 {
            return Err(GitError::CommandFailed(
                "the first commit in a rebase plan has nothing to squash into".into(),
            ));
        }
        if !matches!(step.action, RebaseAction::Drop) {
            kept += 1;
        }
        lines.push(format!("{verb} {}", step.sha));
    }
    if kept == 0 {
        return Err(GitError::CommandFailed(
            "a rebase plan must keep at least one commit".into(),
        ));
    }
    lines.push(String::new()); // trailing newline
    Ok(lines.join("\n"))
}

/// Split an upstream ref (`origin/feature/x`) into its remote and the branch
/// name on that remote, using the repo's actual remote list rather than the
/// first slash — `feature/x` has slashes of its own, and only the remote list
/// says where the boundary is. Longest match wins, so a remote named `origin`
/// and one named `origin/mirror` both resolve correctly.
fn split_upstream<'a>(upstream: &'a str, remotes: &[String]) -> Option<(&'a str, &'a str)> {
    remotes
        .iter()
        .filter(|r| {
            upstream.len() > r.len()
                && upstream.starts_with(r.as_str())
                && upstream.as_bytes()[r.len()] == b'/'
        })
        .max_by_key(|r| r.len())
        .map(|r| (&upstream[..r.len()], &upstream[r.len() + 1..]))
}

/// Pick the remote a branch with no upstream should be published to: `origin`
/// when it exists (the overwhelming convention), otherwise the only remote
/// there is. Ambiguity is refused rather than guessed — riff would be choosing
/// where someone's work goes.
fn default_remote(remotes: &[String]) -> Result<&str, GitError> {
    if let Some(origin) = remotes.iter().find(|r| *r == "origin") {
        return Ok(origin);
    }
    match remotes {
        [] => Err(GitError::CommandFailed(
            "this repository has no remote to push to".into(),
        )),
        [only] => Ok(only),
        many => Err(GitError::CommandFailed(format!(
            "no upstream set, and this repository has several remotes ({}) — \
             push it once from another client to choose one",
            many.join(", ")
        ))),
    }
}

/// The argv for one push. `remote_branch` is the name on the remote (the same
/// as `branch` for a first publish); `set_upstream` adds `-u` so the branch
/// tracks what it just created.
///
/// Force is always leased: `--force-with-lease` refuses unless the remote is
/// still where riff last saw it, and `--force-if-includes` additionally refuses
/// unless the local branch was built on top of that — together they are what
/// keeps "force" from meaning "discard whatever someone else pushed". A bare
/// `--force` is deliberately not reachable from riff.
fn push_args(
    remote: &str,
    branch: &str,
    remote_branch: &str,
    set_upstream: bool,
    force: bool,
) -> Vec<String> {
    let mut args = vec!["push".to_string()];
    if force {
        args.push("--force-with-lease".into());
        args.push("--force-if-includes".into());
    }
    if set_upstream {
        args.push("-u".into());
    }
    args.push(remote.to_string());
    args.push(format!("{branch}:{remote_branch}"));
    args
}

/// A path as the shell git hands the editor command to reads it: forward
/// slashes, because a backslash is that shell's escape character even when the
/// path came from Windows.
fn sh_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// The `GIT_SEQUENCE_EDITOR` command: riff's own executable in `--rebase-todo`
/// mode. git appends the todo path as a final argument, so the helper receives
/// `--rebase-todo <plan> <todo>` and copies one over the other. Both paths are
/// quoted — an install path with spaces ("C:/Program Files/...") is the norm.
///
/// Going through riff's own binary keeps this free of any external tool: the
/// usual `GIT_SEQUENCE_EDITOR="cp <plan>"` trick depends on git's bundled
/// `cp` being on the shell's PATH.
fn sequence_editor_command(exe: &Path, plan: &Path) -> String {
    format!(
        "\"{}\" {REBASE_TODO_FLAG} \"{}\"",
        sh_path(exe),
        sh_path(plan)
    )
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

    /// Run one rebase invocation with both of git's editors neutralised, so a
    /// GUI launch can never end up blocked on an editor that has no terminal to
    /// open in. `sequence_editor` supplies the todo (interactive); without it
    /// `true` accepts whatever git generated, which for a non-interactive
    /// rebase is nothing at all.
    ///
    /// `--no-autostash` is explicit rather than inherited from
    /// `rebase.autoStash`: riff never stashes, and a config that silently
    /// stashed and restored the user's working tree would break that promise
    /// from inside.
    fn run_sequencer(
        &self,
        path: &Path,
        args: &[&str],
        sequence_editor: Option<&str>,
    ) -> Result<String, GitError> {
        let mut cmd: Command = git_command();
        cmd.arg("-C")
            .arg(path)
            .args(args)
            .env("GIT_EDITOR", "true")
            .env("GIT_SEQUENCE_EDITOR", sequence_editor.unwrap_or("true"));
        let output = cmd.output()?;
        if !output.status.success() {
            // A conflict lands here too — git says what stopped it, and
            // `pending_op` then tells the UI a rebase is in progress.
            // Not always stderr: see command_error_text's doc comment.
            return Err(GitError::CommandFailed(command_error_text(
                &output.stderr,
                &output.stdout,
            )));
        }
        // Both streams: git reports the autostash on stderr while the rest of
        // its progress goes to stdout.
        let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
        text.push('\n');
        text.push_str(&String::from_utf8_lossy(&output.stderr));
        Ok(text)
    }

    pub(super) fn rebase_impl(
        &self,
        path: &Path,
        upstream: &str,
        branch: Option<&str>,
    ) -> Result<bool, GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(upstream)?;
        let mut args: Vec<&str> = vec!["rebase", "--autostash", upstream];
        if let Some(b) = branch {
            args.push(validate_ref(b)?);
        }
        let res = self.run_sequencer(path, &args, None);
        // HEAD has moved whether the rebase finished or stopped on a conflict.
        self.drop_session();
        Ok(autostash_conflicted(&res?))
    }

    pub(super) fn rebase_interactive_impl(
        &self,
        path: &Path,
        upstream: &str,
        branch: Option<&str>,
        steps: &[RebaseStep],
    ) -> Result<bool, GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(upstream)?;
        let todo = build_todo(steps)?;
        let exe = std::env::current_exe()?;
        // Outside the repo: the plan is riff's scratch, not repo content, and a
        // `.git/` file would show up in the very status views riff renders.
        let plan: PathBuf =
            std::env::temp_dir().join(format!("riff-rebase-{}.todo", std::process::id()));
        fs::write(&plan, todo).map_err(GitError::Io)?;
        let editor = sequence_editor_command(&exe, &plan);
        let mut args: Vec<&str> = vec!["rebase", "-i", "--autostash", upstream];
        if let Some(b) = branch {
            args.push(validate_ref(b)?);
        }
        let res = self.run_sequencer(path, &args, Some(&editor));
        // git has read the todo by now — on success and on a conflict stop
        // alike, since the sequencer copies it into `.git/rebase-merge/`.
        let _ = fs::remove_file(&plan);
        self.drop_session();
        Ok(autostash_conflicted(&res?))
    }

    /// The repo's remotes, in `git remote`'s order. Empty when there are none.
    fn remotes(&self, path: &Path) -> Result<Vec<String>, GitError> {
        let out = self.run(path, &["remote"])?;
        Ok(String::from_utf8_lossy(&out)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect())
    }

    /// `branch`'s upstream as `<remote>/<branch>`, or None when it has none.
    /// git exits non-zero for "no upstream configured", which is the answer
    /// here rather than a failure.
    fn upstream_of(&self, path: &Path, branch: &str) -> Option<String> {
        let spec = format!("{branch}@{{upstream}}");
        let out = self
            .run(path, &["rev-parse", "--abbrev-ref", &spec])
            .ok()?;
        let up = String::from_utf8_lossy(&out).trim().to_string();
        (!up.is_empty()).then_some(up)
    }

    pub(super) fn push_impl(&self, path: &Path, branch: &str, force: bool) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(branch)?;
        let remotes = self.remotes(path)?;
        // A branch that already tracks something goes back where it came from,
        // under its remote name — which is not always its local name. Without
        // an upstream this is a first publish, so `-u` records the one chosen.
        let args = match self.upstream_of(path, branch) {
            Some(upstream) => match split_upstream(&upstream, &remotes) {
                Some((remote, remote_branch)) => {
                    push_args(remote, branch, remote_branch, false, force)
                }
                // The upstream names a remote the repo no longer has.
                None => {
                    return Err(GitError::CommandFailed(format!(
                        "'{branch}' tracks '{upstream}', which is not one of this repository's remotes"
                    )))
                }
            },
            None => push_args(default_remote(&remotes)?, branch, branch, true, force),
        };
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        self.run_network(path, &argv)?;
        // Remote-tracking refs moved; the cached batch would still resolve the
        // old ones behind the graph's badges.
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

    pub(super) fn op_abort_impl(&self, path: &Path, op: &str) -> Result<bool, GitError> {
        let _w = self.write_lock.lock().unwrap();
        let sub = match op {
            "merge" | "rebase" | "cherry-pick" | "revert" => op,
            _ => return Err(GitError::CommandFailed("no operation in progress".into())),
        };
        // Aborting ends the rebase, so this is one of the places git puts the
        // autostash back — and one of the places that can conflict.
        let out = self.run_sequencer(path, &[sub, "--abort"], None);
        self.drop_session();
        Ok(autostash_conflicted(&out?))
    }

    pub(super) fn op_skip_impl(&self, path: &Path, op: &str) -> Result<bool, GitError> {
        let _w = self.write_lock.lock().unwrap();
        // A merge has no per-commit step to skip: its only outs are finishing
        // the commit and aborting.
        let sub = match op {
            "rebase" | "cherry-pick" | "revert" => op,
            _ => return Err(GitError::CommandFailed("nothing to skip".into())),
        };
        // Skipping resumes the sequencer, which can stop again on the next
        // commit — or finish it, which is where the autostash comes back.
        let out = self.run_sequencer(path, &[sub, "--skip"], None);
        self.drop_session();
        Ok(autostash_conflicted(&out?))
    }

    pub(super) fn op_continue_impl(&self, path: &Path, op: &str) -> Result<bool, GitError> {
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
        let out = self.run_sequencer(path, args, None);
        self.drop_session();
        // Finishing the last commit is where a rebase puts the autostash back.
        Ok(autostash_conflicted(&out?))
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

    fn step(action: RebaseAction, sha: &str) -> RebaseStep {
        RebaseStep {
            action,
            sha: sha.to_string(),
        }
    }

    #[test]
    fn build_todo_writes_one_line_per_step_in_order() {
        let steps = vec![
            step(RebaseAction::Pick, "1111111"),
            step(RebaseAction::Fixup, "2222222"),
            step(RebaseAction::Drop, "3333333"),
            step(RebaseAction::Edit, "4444444"),
        ];
        assert_eq!(
            build_todo(&steps).unwrap(),
            "pick 1111111\nfixup 2222222\ndrop 3333333\nedit 4444444\n"
        );
    }

    #[test]
    fn build_todo_refuses_a_leading_squash() {
        let steps = vec![
            step(RebaseAction::Squash, "1111111"),
            step(RebaseAction::Pick, "2222222"),
        ];
        assert!(build_todo(&steps).is_err());
    }

    #[test]
    fn build_todo_refuses_a_squash_left_first_by_dropping_what_preceded_it() {
        let steps = vec![
            step(RebaseAction::Drop, "1111111"),
            step(RebaseAction::Squash, "2222222"),
        ];
        assert!(build_todo(&steps).is_err());
    }

    #[test]
    fn build_todo_refuses_a_plan_that_keeps_nothing() {
        let steps = vec![
            step(RebaseAction::Drop, "1111111"),
            step(RebaseAction::Drop, "2222222"),
        ];
        assert!(build_todo(&steps).is_err());
    }

    #[test]
    fn build_todo_refuses_anything_that_is_not_a_sha() {
        for bad in ["", "main", "1111111 && rm -rf", "-x1111111", "zzzzzzz"] {
            assert!(
                build_todo(&[step(RebaseAction::Pick, bad)]).is_err(),
                "accepted {bad:?}"
            );
        }
    }

    #[test]
    fn build_todo_accepts_a_full_length_sha() {
        let sha = "a".repeat(40);
        assert_eq!(
            build_todo(&[step(RebaseAction::Pick, &sha)]).unwrap(),
            format!("pick {sha}\n")
        );
    }

    #[test]
    fn sequence_editor_command_quotes_both_paths_with_forward_slashes() {
        let cmd = sequence_editor_command(
            Path::new(r"C:\Program Files\riff\riff.exe"),
            Path::new(r"C:\Users\me\AppData\Local\Temp\riff-rebase-1.todo"),
        );
        assert_eq!(
            cmd,
            "\"C:/Program Files/riff/riff.exe\" --rebase-todo \
             \"C:/Users/me/AppData/Local/Temp/riff-rebase-1.todo\""
        );
    }

    #[test]
    fn split_upstream_splits_on_the_remote_not_the_first_slash() {
        let remotes = vec!["origin".to_string(), "fork".to_string()];
        assert_eq!(
            split_upstream("origin/feature/login", &remotes),
            Some(("origin", "feature/login"))
        );
        assert_eq!(split_upstream("fork/main", &remotes), Some(("fork", "main")));
        // A remote that isn't configured here can't be split.
        assert_eq!(split_upstream("upstream/main", &remotes), None);
        assert_eq!(split_upstream("origin", &remotes), None);
    }

    #[test]
    fn split_upstream_prefers_the_longest_matching_remote() {
        let remotes = vec!["origin".to_string(), "origin/mirror".to_string()];
        assert_eq!(
            split_upstream("origin/mirror/main", &remotes),
            Some(("origin/mirror", "main"))
        );
    }

    #[test]
    fn default_remote_prefers_origin_then_the_only_one() {
        let many = vec!["upstream".to_string(), "origin".to_string()];
        assert_eq!(default_remote(&many).unwrap(), "origin");
        let one = vec!["fork".to_string()];
        assert_eq!(default_remote(&one).unwrap(), "fork");
    }

    #[test]
    fn default_remote_refuses_to_guess() {
        assert!(default_remote(&[]).is_err());
        let ambiguous = vec!["fork".to_string(), "upstream".to_string()];
        assert!(default_remote(&ambiguous).is_err());
    }

    #[test]
    fn push_args_tracks_an_existing_upstream_under_its_remote_name() {
        assert_eq!(
            push_args("origin", "local-name", "remote-name", false, false),
            vec!["push", "origin", "local-name:remote-name"]
        );
    }

    #[test]
    fn push_args_sets_upstream_on_a_first_publish() {
        assert_eq!(
            push_args("origin", "feature", "feature", true, false),
            vec!["push", "-u", "origin", "feature:feature"]
        );
    }

    #[test]
    fn push_args_force_is_always_leased() {
        let args = push_args("origin", "feature", "feature", false, true);
        assert_eq!(
            args,
            vec![
                "push",
                "--force-with-lease",
                "--force-if-includes",
                "origin",
                "feature:feature"
            ]
        );
        // The unleashed form must never be reachable.
        assert!(!args.iter().any(|a| a == "--force" || a == "-f"));
    }

    #[test]
    fn autostash_conflicted_reads_gits_own_wording() {
        // git 2.43.0.windows.1, stderr, alongside "Successfully rebased".
        let text = "Rebasing (1/1)Applying autostash resulted in conflicts.
                    Your changes are safe in the stash.
                    You can run \"git stash pop\" or \"git stash drop\" at any time.
                    Successfully rebased and updated refs/heads/topic.
";
        assert!(autostash_conflicted(text));
    }

    #[test]
    fn autostash_conflicted_is_false_for_a_clean_restore() {
        assert!(!autostash_conflicted(
            "Applied autostash.
Successfully rebased and updated refs/heads/topic.
"
        ));
        assert!(!autostash_conflicted("Created autostash: a41b195
"));
        assert!(!autostash_conflicted(""));
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
