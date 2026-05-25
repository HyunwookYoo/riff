pub mod blame;
pub mod cli;
pub mod error;

use serde::{Deserialize, Serialize};
use std::path::Path;

pub use blame::{Blame, BlameCommit};
pub use cli::GitCli;
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
    },
    Binary {
        old_size: u64,
        new_size: u64,
    },
    TooLarge {
        old_size: u64,
        new_size: u64,
    },
}

pub trait GitLayer {
    fn validate_repo(&self, path: &Path) -> Result<(), GitError>;
    fn list_refs(&self, path: &Path) -> Result<Vec<Branch>, GitError>;
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
    ) -> Result<FileDiff, GitError>;
    /// Stream the working tree changes vs HEAD: tracked diff via
    /// `git diff HEAD --name-status -z --find-renames`, followed by untracked
    /// files via `git ls-files --others --exclude-standard -z` (emitted as
    /// `Added`). Cancellation of any previously in-flight invocation is the
    /// implementation's responsibility.
    fn worktree_files(
        &self,
        path: &Path,
        ignore_whitespace: bool,
        on_file: &mut dyn FnMut(ChangedFile) -> Result<(), GitError>,
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
    ) -> Result<FileDiff, GitError>;
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
}
