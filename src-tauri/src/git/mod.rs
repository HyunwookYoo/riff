pub mod blame;
pub mod cli;
pub mod diff;
pub mod error;
pub mod uasset;
mod write;

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
/// `summary` is the subject line; `body` is the rest of the message (empty when
/// there is none).
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
    pub body: String,
}

/// One commit in a submodule's log between two gitlink SHAs. A lean subset of
/// `Commit` (no parents/refs/body) — the submodule diff view is a static list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmoduleCommit {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    /// Author time, unix seconds.
    pub time: i64,
    /// Subject line (first line of the commit message).
    pub subject: String,
}

/// Per-commit containment of the loaded commit graph against one `target` ref,
/// powering the graph's "Compare against" highlight. `not_in_target` holds the
/// SHAs reachable from `source` (or every ref, when source is empty) that are
/// NOT yet in `target` — the ● ("only here") marks. `equivalent` holds SHAs
/// whose patch is already applied in `target` under a different commit
/// (rebase / cherry-pick, via `git cherry`); shown ✓ and only computed for a
/// single-ref source. `ahead` / `behind` count `source` vs `target` (0 when
/// source is empty). `source_is_branch` echoes whether a single source ref was
/// given, so the UI knows ahead/behind + equivalence are meaningful.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Containment {
    pub not_in_target: Vec<String>,
    pub equivalent: Vec<String>,
    pub ahead: i64,
    pub behind: i64,
    pub source_is_branch: bool,
}

/// Detail for one commit's "Containment" panel. `in_target` is whether the
/// commit is an ancestor of the active target; `introduced_by` is the merge
/// commit that brought it into target (None when fast-forwarded / committed
/// directly, or when not contained at all).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainmentDetail {
    pub in_target: bool,
    pub introduced_by: Option<Commit>,
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

/// One entry from HEAD's reflog. `selector` is the `HEAD@{N}` form; `subject`
/// is git's reflog message (e.g. `commit: fix login`, `reset: moving to
/// HEAD~3`); `time` is when the reflog entry was written — i.e. when HEAD
/// actually moved — in UNIX seconds. That is deliberately NOT the commit's own
/// date: a `checkout:` onto an old commit happens now but points at something
/// authored long ago. The reflog is the only record of commits no ref points at
/// any more, so these entries can reference commits the graph cannot show.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReflogEntry {
    pub sha: String,
    pub selector: String,
    pub subject: String,
    pub time: i64,
}

/// The three index stages of a conflicted file (`base` = `:1:`, `ours` = `:2:`,
/// `theirs` = `:3:`) plus the working-tree copy (`merged`, which carries git's
/// `<<<<<<<` conflict markers). A stage absent from the index (e.g. add/add has
/// no base) comes back empty. `binary` is true when the working copy looks
/// binary — the 3-way text editor doesn't apply, so the UI offers a side-level
/// take-ours / take-theirs instead.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictVersions {
    pub base: String,
    pub ours: String,
    pub theirs: String,
    pub merged: String,
    pub binary: bool,
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
    /// Renderable image, both sides as base64 (the payload of a `data:` URL).
    /// An absent side (added → no old, deleted → no new) is an empty string.
    Image {
        old_b64: String,
        new_b64: String,
        /// MIME type for the data URL, from the file extension.
        mime: String,
        old_size: u64,
        new_size: u64,
    },
    TooLarge {
        old_size: u64,
        new_size: u64,
    },
    /// A submodule gitlink pointer move, rendered as the submodule's own commit
    /// log between the two SHAs (both directions) rather than the raw
    /// "Subproject commit <sha>" text. Emitted only when both SHAs resolve and
    /// the submodule's object DB can produce the log; otherwise `file_diff`
    /// falls back to `Text`.
    Submodule {
        /// Gitlink path as it appears in the parent tree; the UI shows its basename.
        name: String,
        /// The old endpoint (the commit the parent links to), with its message.
        old_commit: SubmoduleCommit,
        /// The new endpoint (the submodule's checked-out HEAD), with its message.
        new_commit: SubmoduleCommit,
        /// old..new, newest first, capped to SUBMODULE_LOG_CAP.
        added: Vec<SubmoduleCommit>,
        /// new..old, newest first, capped to SUBMODULE_LOG_CAP.
        removed: Vec<SubmoduleCommit>,
        /// Full count of added commits (>= added.len()).
        added_count: usize,
        /// Full count of removed commits (>= removed.len()).
        removed_count: usize,
    },
}

/// The complete set of git operations riff can perform. Everything the app can
/// do to a repository is declared here — `GitCli::run` is private, so a method
/// that is not on this trait cannot be reached.
///
/// riff writes in exactly five ways: create a branch, rename a branch, delete a
/// branch, checkout, and fetch/pull. The one exception is conflict resolution,
/// which cleans up the state riff's own pull created. Committing, publishing,
/// stashing, and rewriting history are deliberately absent — see
/// docs/superpowers/specs/2026-08-12-vcs-scope-reduction-design.md.
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
    /// Per-file diff for the source-control Changes screen. The gap is always
    /// HEAD↔working tree (old = `HEAD:path`, new = the working-tree file).
    /// `status` is the file's HEAD-relative porcelain status, driving which
    /// side is absent (added → no old, deleted → no new). Unreal assets are
    /// derived to a property view per `uasset_cfg`.
    fn changes_file_diff(
        &self,
        path: &Path,
        file_path: &str,
        old_path: Option<&str>,
        status: FileStatus,
        force: bool,
        uasset_cfg: &uasset::Config,
    ) -> Result<FileDiff, GitError>;
    /// Create branch `name` (at `start_point`, default HEAD). When `checkout`
    /// is true, also switch to it (`git checkout -b`); otherwise just create it.
    fn create_branch(
        &self,
        path: &Path,
        name: &str,
        start_point: Option<&str>,
        checkout: bool,
    ) -> Result<(), GitError>;
    /// Switch the working tree to `ref_name` (`git checkout`). Carries
    /// uncommitted changes over when they don't conflict; errors otherwise.
    fn checkout(&self, path: &Path, ref_name: &str) -> Result<(), GitError>;
    /// Fast-forward the current branch to `ref_name` (`git merge --ff-only`).
    /// Used after checking out a remote branch's local tracker so the local
    /// catches up to the remote. Errors (without moving HEAD) if the histories
    /// have diverged.
    fn fast_forward(&self, path: &Path, ref_name: &str) -> Result<(), GitError>;
    /// Read the three index stages (base `:1:`, ours `:2:`, theirs `:3:`) of a
    /// conflicted file plus its working-tree copy (with conflict markers).
    fn conflict_versions(
        &self,
        path: &Path,
        file_path: &str,
    ) -> Result<ConflictVersions, GitError>;
    /// Write `content` as the resolved file and stage it (`git add`), clearing
    /// the conflict for that path.
    fn resolve_conflict(
        &self,
        path: &Path,
        file_path: &str,
        content: &str,
    ) -> Result<(), GitError>;
    /// Resolve a conflict by taking one whole side — `git checkout --ours` or
    /// `--theirs` — then stage it. `side` is "ours" or "theirs".
    fn checkout_conflict_side(
        &self,
        path: &Path,
        file_path: &str,
        side: &str,
    ) -> Result<(), GitError>;
    /// Rename branch `old` to `new` (`git branch -m`).
    fn rename_branch(&self, path: &Path, old: &str, new: &str) -> Result<(), GitError>;
    /// Delete branch `name`. `force` uses `-D` (drops unmerged commits) instead
    /// of the safe `-d`; callers must confirm before forcing.
    fn delete_branch(&self, path: &Path, name: &str, force: bool) -> Result<(), GitError>;
    /// The most recent HEAD reflog entries (`git reflog show`), newest first.
    /// Read-only. Feeds the recovery panel, which points a new branch at one of
    /// them — including commits that are no longer reachable from any ref.
    fn reflog(&self, path: &Path) -> Result<Vec<ReflogEntry>, GitError>;
    /// Fetch every remote, pruning deleted branches (`git fetch --all --prune`).
    fn fetch(&self, path: &Path) -> Result<(), GitError>;
    /// Integrate the upstream into the current branch (`git pull`). riff only
    /// ever merge-pulls: `--rebase` would rewrite local history, which is
    /// outside its write surface. Conflicts surface as an error.
    fn pull(&self, path: &Path) -> Result<(), GitError>;
    /// The in-progress operation, if any: "merge" | "rebase" | "cherry-pick" |
    /// "revert" | "none". Drives the conflict banner.
    fn pending_op(&self, path: &Path) -> Result<String, GitError>;
    /// Abort the in-progress `op` (`git <op> --abort`).
    fn op_abort(&self, path: &Path, op: &str) -> Result<(), GitError>;
    /// Continue the in-progress `op` after conflicts are resolved + staged
    /// (editor suppressed so it can't hang).
    fn op_continue(&self, path: &Path, op: &str) -> Result<(), GitError>;
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
    /// Commits that touched `file_path` (newest first) — the timeline for the
    /// file timelapse. No rename-follow in v1, so history stops where the
    /// current path was introduced.
    fn file_revisions(&self, path: &Path, file_path: &str) -> Result<Vec<Commit>, GitError>;
    /// One timelapse frame: the file's content at `sha` plus the change ranges
    /// versus `prev_sha` (the older adjacent revision; `None` diffs against
    /// empty, i.e. the file's first appearance). Returns the diff viewer's
    /// `FileDiff` shape — `Text` carries `new_content` + `changes` for the
    /// single-pane highlight; `Binary` / `TooLarge` mark an un-playable frame.
    fn timelapse_frame(
        &self,
        path: &Path,
        sha: &str,
        prev_sha: Option<&str>,
        file_path: &str,
    ) -> Result<FileDiff, GitError>;
    /// Per-commit containment of the loaded graph against `target`, for the
    /// "Compare against" highlight. `source` ("" = every ref) scopes which
    /// commits feed `ahead`/`behind` + patch-equivalence. Returns the SHAs not
    /// yet in `target` (drives the ● mark) and those already applied as an
    /// equivalent patch (rebase/cherry-pick → shown ✓; only for a single-ref
    /// source). One `rev-list --not` call, plus `cherry` + a left-right count
    /// when `source` is a branch.
    fn containment(&self, path: &Path, source: &str, target: &str)
        -> Result<Containment, GitError>;
    /// Like `commit_log`, but excludes everything reachable from `target`
    /// (`<source|--all> --not <target>`): exactly the commits still missing
    /// from target. Drives the graph's "only not in target" filter.
    fn commit_log_excluding(
        &self,
        path: &Path,
        source: &str,
        target: &str,
        limit: u32,
        skip: u32,
    ) -> Result<Vec<Commit>, GitError>;
    /// Detail for one commit's Containment panel: every branch/tag that
    /// contains `sha`, whether it's in `target`, and the merge commit that
    /// introduced it into `target` (None when fast-forwarded / not contained).
    fn commit_containment_detail(
        &self,
        path: &Path,
        sha: &str,
        target: &str,
    ) -> Result<ContainmentDetail, GitError>;
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
