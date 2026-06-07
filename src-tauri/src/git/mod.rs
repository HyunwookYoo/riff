pub mod blame;
pub mod cli;
pub mod diff;
pub mod error;
pub mod uasset;

use serde::{Deserialize, Serialize};
use std::path::Path;

pub use blame::{Blame, BlameCommit};
pub use cli::GitCli;
pub use diff::Change;
pub use error::GitError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Branch {
    pub name: String,
    pub kind: BranchKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BranchKind {
    Local,
    Remote,
    Tag,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
}

/// One commit in the history browser's log list. `parents` holds full parent
/// SHAs (used by the frontend graph layout to wire lanes); `refs` are the raw
/// decoration names (`HEAD -> main`, `tag: v1`, `origin/main`) for display.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Commit {
    pub sha: String,
    pub short_sha: String,
    pub parents: Vec<String>,
    pub author: String,
    /// Author time, unix seconds.
    pub time: i64,
    pub summary: String,
    pub refs: Vec<String>,
}

/// One entry from `git status --porcelain=v2`. `index_status` / `worktree_status`
/// are the porcelain-v2 XY status codes: X is the *staged* side (HEAD↔index),
/// Y the *unstaged* side (index↔worktree). Each is a single character from
/// `.MADRCU?` where `.` means unmodified on that side; untracked files come back
/// as `?`/`?`. `orig_path` holds the pre-rename path for renames/copies.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StatusEntry {
    pub path: String,
    pub orig_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
}

/// Result of `git status --porcelain=v2 --branch`. `ahead` / `behind` are the
/// commit counts vs `upstream` (both 0 when there is no upstream). `branch` is
/// `None` on a detached HEAD.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RepoStatus {
    pub entries: Vec<StatusEntry>,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
}

/// One hunk of a file's unified diff, for the Changes screen's per-hunk
/// stage/unstage controls. `header` is the `@@ -a,b +c,d @@` line (with any
/// section heading); `added`/`removed` count changed lines for the badge.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Hunk {
    pub header: String,
    pub added: u32,
    pub removed: u32,
}

/// Submodule entry as declared in `.gitmodules`. `initialized` is true when
/// the submodule's working tree has been checked out (i.e. `<repo>/<path>/.git`
/// exists). Used by the multi-root workspace (§13) to populate the repo list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmoduleInfo {
    /// Path relative to the main repo root, as written in `.gitmodules`.
    pub path: String,
    /// Absolute filesystem path of the submodule's working tree.
    pub absolute_path: String,
    pub initialized: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DiffMode {
    ThreeDot,
    TwoDot,
}

/// Result of `file_diff`. `kind` is the serde tag so the frontend can switch on it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum FileDiff {
    Text {
        old_content: String,
        new_content: String,
        old_size: u64,
        new_size: u64,
        /// Precomputed diff (UTF-16 offsets) injected into the editor so it
        /// renders our diff instead of recomputing one. `old_content` /
        /// `new_content` are already EOL-normalized to match these offsets.
        #[serde(default)]
        changes: Vec<Change>,
        /// Set when the text is a *derived* view (e.g. an Unreal asset parsed
        /// to JSON) rather than the raw file bytes. The frontend shows a badge.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        derived_label: Option<String>,
        /// Engine version used to derive an Unreal asset view, echoed back so
        /// the UI's version dropdown reflects what was actually used.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ue_version: Option<String>,
    },
    Binary {
        old_size: u64,
        new_size: u64,
        /// Optional reason shown alongside the binary view — e.g. why an
        /// Unreal asset couldn't be parsed into a property diff.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    TooLarge {
        old_size: u64,
        new_size: u64,
    },
}

pub trait GitLayer {
    fn validate_repo(&self, path: &Path) -> Result<(), GitError>;
    fn list_refs(&self, path: &Path) -> Result<Vec<Branch>, GitError>;
    /// Return up to `limit` commits, skipping the first `skip` (drives "load
    /// more" pagination). When `all` is true the log spans every ref
    /// (`git log --all --date-order`, the default graph view); otherwise it
    /// follows `start_ref` (or HEAD when empty).
    fn commit_log(
        &self,
        path: &Path,
        start_ref: &str,
        all: bool,
        limit: u32,
        skip: u32,
    ) -> Result<Vec<Commit>, GitError>;
    /// Full working-tree status via `git status --porcelain=v2 --branch -z`:
    /// staged (index) and unstaged (worktree) state per file, untracked files,
    /// and the current branch's upstream + ahead/behind counts. Drives the
    /// source-control Changes screen.
    fn status(&self, path: &Path) -> Result<RepoStatus, GitError>;
    /// Stream the changed files between `start` and `target`.
    /// `on_file` is invoked once per parsed entry as it arrives.
    /// Cancelling a previously-in-flight invocation against the same session
    /// is the implementation's responsibility.
    fn diff_files(
        &self,
        path: &Path,
        start: &str,
        target: &str,
        mode: DiffMode,
        ignore_whitespace: bool,
        on_file: &mut dyn FnMut(ChangedFile) -> Result<(), GitError>,
    ) -> Result<(), GitError>;
    fn file_diff(
        &self,
        path: &Path,
        start: &str,
        target: &str,
        mode: DiffMode,
        file_path: &str,
        old_path: Option<&str>,
        force: bool,
        uasset_cfg: &uasset::Config,
    ) -> Result<FileDiff, GitError>;
    /// Stream the working tree changes vs HEAD: tracked diff via
    /// `git diff HEAD --name-status -z --find-renames` plus untracked files
    /// via `git ls-files --others --exclude-standard -z` (emitted as `Added`).
    /// Implementations may run the two passes concurrently — hence the `Send`
    /// bound on `on_file`. Cancellation of any previously in-flight invocation
    /// is the implementation's responsibility.
    fn worktree_files(
        &self,
        path: &Path,
        ignore_whitespace: bool,
        on_file: &mut (dyn FnMut(ChangedFile) -> Result<(), GitError> + Send),
    ) -> Result<(), GitError>;
    /// Per-file diff for working tree mode. Old side reads from HEAD blob
    /// (skipped when `status == Added`); new side reads from the filesystem
    /// (skipped when `status == Deleted`).
    fn worktree_file_diff(
        &self,
        path: &Path,
        file_path: &str,
        old_path: Option<&str>,
        status: FileStatus,
        force: bool,
        uasset_cfg: &uasset::Config,
    ) -> Result<FileDiff, GitError>;
    /// Per-file diff for the source-control Changes screen, one *side* at a
    /// time. `staged` selects the HEAD↔index gap (old = `HEAD:path`, new = the
    /// index blob); otherwise the index↔worktree gap (old = index blob, new =
    /// the working-tree file). `status` is the porcelain status for *that side*,
    /// driving which side is absent (added → no old, deleted → no new). Unreal
    /// asset derivation is intentionally skipped (raw bytes / binary
    /// placeholder) — staging is code-centric; rich preview stays in compare.
    fn changes_file_diff(
        &self,
        path: &Path,
        file_path: &str,
        old_path: Option<&str>,
        status: FileStatus,
        staged: bool,
        force: bool,
    ) -> Result<FileDiff, GitError>;
    /// Stage paths into the index (`git add`). `files = None` stages everything
    /// (`git add -A`, including untracked and deletions); `Some` stages just
    /// those paths. Used by the Changes screen's stage / Stage-all actions.
    fn stage(&self, path: &Path, files: Option<&[String]>) -> Result<(), GitError>;
    /// Remove paths from the index while keeping working-tree changes
    /// (`git restore --staged`). `files = None` unstages everything.
    fn unstage(&self, path: &Path, files: Option<&[String]>) -> Result<(), GitError>;
    /// Create a commit from the staged index. `subject` is the first line;
    /// `body` (when non-empty) follows after a blank line. `amend` rewrites
    /// HEAD; `signoff` adds a Signed-off-by trailer; each `coauthors` entry
    /// ("Name <email>") becomes a Co-authored-by trailer. GPG signing and
    /// hooks follow the user's git config — never bypassed (no --no-verify).
    fn commit(
        &self,
        path: &Path,
        subject: &str,
        body: &str,
        amend: bool,
        signoff: bool,
        coauthors: &[String],
    ) -> Result<(), GitError>;
    /// The full message of HEAD (`git log -1 --format=%B`), used to pre-fill the
    /// commit box when the user toggles "Amend".
    fn head_commit_message(&self, path: &Path) -> Result<String, GitError>;
    /// Parse one file's unified diff into hunks for per-hunk staging. `staged`
    /// true → `git diff --cached` (HEAD↔index); false → `git diff`
    /// (index↔worktree). Empty for untracked/binary files.
    fn file_hunks(&self, path: &Path, file_path: &str, staged: bool) -> Result<Vec<Hunk>, GitError>;
    /// Stage (`staged=false`) or unstage (`staged=true`) the hunks at the given
    /// indices: re-diffs the file, builds a sub-patch of just those hunks, and
    /// applies it to the index (`git apply --cached`, reversed for unstage).
    /// Rejects when an index is out of range — the file changed since the hunks
    /// were listed.
    fn apply_hunks(
        &self,
        path: &Path,
        file_path: &str,
        staged: bool,
        hunks: &[u32],
    ) -> Result<(), GitError>;
    /// Create branch `name` (at `start_point`, default HEAD). When `checkout`
    /// is true, also switch to it (`git checkout -b`); otherwise just create it.
    fn create_branch(
        &self,
        path: &Path,
        name: &str,
        start_point: Option<&str>,
        checkout: bool,
    ) -> Result<(), GitError>;
    /// Switch the working tree to `ref_name` (`git checkout`).
    fn checkout(&self, path: &Path, ref_name: &str) -> Result<(), GitError>;
    /// Rename branch `old` to `new` (`git branch -m`).
    fn rename_branch(&self, path: &Path, old: &str, new: &str) -> Result<(), GitError>;
    /// Delete branch `name`. `force` uses `-D` (drops unmerged commits) instead
    /// of the safe `-d`; callers must confirm before forcing.
    fn delete_branch(&self, path: &Path, name: &str, force: bool) -> Result<(), GitError>;
    /// Set `branch`'s upstream tracking ref (`git branch --set-upstream-to`).
    fn set_upstream(&self, path: &Path, branch: &str, upstream: &str) -> Result<(), GitError>;
    /// Create a lightweight tag `name` at `target` (`git tag`).
    fn create_tag(&self, path: &Path, name: &str, target: &str) -> Result<(), GitError>;
    /// Move the current branch to `target` (`git reset --<mode>`); `mode` is one
    /// of "soft" | "mixed" | "hard". Hard discards working-tree changes — the
    /// caller must confirm first.
    fn reset(&self, path: &Path, target: &str, mode: &str) -> Result<(), GitError>;
    /// Apply `target`'s changes onto the current branch (`git cherry-pick`).
    fn cherry_pick(&self, path: &Path, target: &str) -> Result<(), GitError>;
    /// Create a commit that undoes `target` (`git revert --no-edit`).
    fn revert(&self, path: &Path, target: &str) -> Result<(), GitError>;
    /// Rebase the current branch onto `onto` (`git rebase`). Conflicts surface
    /// as an error; resolving them is done outside the app for now.
    fn rebase(&self, path: &Path, onto: &str) -> Result<(), GitError>;
    /// Fetch every remote, pruning deleted branches (`git fetch --all --prune`).
    fn fetch(&self, path: &Path) -> Result<(), GitError>;
    /// Integrate the upstream into the current branch (`git pull`); `rebase`
    /// switches to `git pull --rebase`. Conflicts surface as an error.
    fn pull(&self, path: &Path, rebase: bool) -> Result<(), GitError>;
    /// Push the current branch (`git push`). `set_upstream_branch` runs
    /// `--set-upstream origin <branch>` for a first push; `force` adds
    /// `--force-with-lease` (never a bare `--force`) — confirm before using.
    fn push(
        &self,
        path: &Path,
        set_upstream_branch: Option<&str>,
        force: bool,
    ) -> Result<(), GitError>;
    /// List every tracked file in the repo (`git ls-files -s -z`), filtering
    /// out gitlink entries (mode 160000) so submodule paths don't surface to
    /// the blame file picker — `git blame` doesn't work on them.
    fn list_repo_files(&self, path: &Path) -> Result<Vec<String>, GitError>;
    /// Run `git blame --porcelain -w -M` on `file_path` at `rev` and return a
    /// deduplicated line→commit mapping. When `use_contents` is true, blame
    /// reads the working-copy contents at `repo/file_path` against HEAD —
    /// uncommitted lines come back with the zero SHA (see
    /// `blame::UNCOMMITTED_SHORT`). Cancellation of any prior in-flight
    /// blame is the implementation's responsibility.
    fn blame_file(
        &self,
        path: &Path,
        file_path: &str,
        rev: &str,
        use_contents: bool,
    ) -> Result<Blame, GitError>;
    /// Read `.gitmodules` (if present) and return the declared submodules.
    /// Empty list when there is no `.gitmodules` or it contains no
    /// `submodule.<name>.path` entries. Used to auto-populate the multi-root
    /// workspace (§13).
    fn list_submodules(&self, path: &Path) -> Result<Vec<SubmoduleInfo>, GitError>;
    /// Look up the gitlink commit SHA for `submodule_path` inside `tree_ish`
    /// (a branch / tag / commit). Returns `None` when the path is not a
    /// gitlink at that tree. Used to derive each submodule's old/new SHA
    /// for branch compare (§13.3 #7, gitlink-follow).
    fn submodule_sha_at(
        &self,
        path: &Path,
        tree_ish: &str,
        submodule_path: &str,
    ) -> Result<Option<String>, GitError>;
}
