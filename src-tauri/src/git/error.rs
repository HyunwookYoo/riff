use std::io;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GitError {
    #[error("path is not a git repository: {0}")]
    NotARepo(String),

    #[error("git command failed: {0}")]
    CommandFailed(String),

    #[error("io error: {0}")]
    Io(#[from] io::Error),

    #[error("invalid ref name: {0}")]
    InvalidRef(String),

    #[error("failed to parse git output: {0}")]
    Parse(String),
}

impl serde::Serialize for GitError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
