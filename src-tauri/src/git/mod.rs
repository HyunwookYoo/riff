pub mod cli;
pub mod error;

use serde::{Deserialize, Serialize};
use std::path::Path;

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

pub trait GitLayer {
    fn validate_repo(&self, path: &Path) -> Result<(), GitError>;
    fn list_refs(&self, path: &Path) -> Result<Vec<Branch>, GitError>;
    fn diff_files(
        &self,
        path: &Path,
        start: &str,
        target: &str,
        mode: DiffMode,
    ) -> Result<Vec<ChangedFile>, GitError>;
}
