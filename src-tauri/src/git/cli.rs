use std::path::Path;
use std::process::Command;

use super::{Branch, BranchKind, ChangedFile, DiffMode, FileStatus, GitError, GitLayer};

pub struct GitCli;

impl GitCli {
    pub fn new() -> Self {
        Self
    }

    fn run(&self, path: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
        let output = Command::new("git").arg("-C").arg(path).args(args).output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(GitError::CommandFailed(stderr));
        }
        Ok(output.stdout)
    }
}

impl Default for GitCli {
    fn default() -> Self {
        Self::new()
    }
}

fn validate_ref(s: &str) -> Result<&str, GitError> {
    if s.is_empty() || s.starts_with('-') {
        return Err(GitError::InvalidRef(s.to_string()));
    }
    Ok(s)
}

impl GitLayer for GitCli {
    fn validate_repo(&self, path: &Path) -> Result<(), GitError> {
        if !path.exists() {
            return Err(GitError::NotARepo(path.display().to_string()));
        }
        self.run(path, &["rev-parse", "--git-dir"])
            .map_err(|_| GitError::NotARepo(path.display().to_string()))?;
        Ok(())
    }

    fn list_refs(&self, path: &Path) -> Result<Vec<Branch>, GitError> {
        let stdout = self.run(
            path,
            &[
                "for-each-ref",
                "--format=%(refname:short)\t%(refname)",
                "refs/heads",
                "refs/remotes",
                "refs/tags",
            ],
        )?;

        let text = String::from_utf8_lossy(&stdout);
        let mut refs = Vec::new();
        for line in text.lines() {
            if line.is_empty() {
                continue;
            }
            let mut parts = line.splitn(2, '\t');
            let short = parts.next().unwrap_or("");
            let full = parts.next().unwrap_or("");
            if short.is_empty() || full.is_empty() {
                continue;
            }

            let kind = if full.starts_with("refs/heads/") {
                BranchKind::Local
            } else if full.starts_with("refs/remotes/") {
                if short.ends_with("/HEAD") {
                    continue;
                }
                BranchKind::Remote
            } else if full.starts_with("refs/tags/") {
                BranchKind::Tag
            } else {
                continue;
            };

            refs.push(Branch {
                name: short.to_string(),
                kind,
            });
        }
        Ok(refs)
    }

    fn diff_files(
        &self,
        path: &Path,
        start: &str,
        target: &str,
        mode: DiffMode,
    ) -> Result<Vec<ChangedFile>, GitError> {
        let start = validate_ref(start)?;
        let target = validate_ref(target)?;

        let spec = match mode {
            DiffMode::ThreeDot => format!("{start}...{target}"),
            DiffMode::TwoDot => format!("{start}..{target}"),
        };

        let stdout = self.run(
            path,
            &[
                "diff",
                "--name-status",
                "-z",
                "--find-renames",
                &spec,
            ],
        )?;

        parse_name_status_z(&stdout)
    }
}

/// Parse `git diff --name-status -z` output.
///
/// The stream is NUL-separated. Each entry is either two fields (status, path)
/// for A/M/D/T, or three fields (status, old_path, new_path) for R/C.
fn parse_name_status_z(bytes: &[u8]) -> Result<Vec<ChangedFile>, GitError> {
    let mut files = Vec::new();
    let mut it = bytes.split(|&b| b == 0).peekable();

    while let Some(status_raw) = it.next() {
        if status_raw.is_empty() {
            continue;
        }

        let status_str = std::str::from_utf8(status_raw)
            .map_err(|_| GitError::Parse("status not utf-8".into()))?;
        let first = status_str
            .chars()
            .next()
            .ok_or_else(|| GitError::Parse("empty status".into()))?;

        let (status, has_old_path) = match first {
            'A' => (FileStatus::Added, false),
            'M' => (FileStatus::Modified, false),
            'D' => (FileStatus::Deleted, false),
            'T' => (FileStatus::TypeChanged, false),
            'R' => (FileStatus::Renamed, true),
            'C' => (FileStatus::Copied, true),
            _ => continue,
        };

        if has_old_path {
            let old = it
                .next()
                .ok_or_else(|| GitError::Parse("missing old path".into()))?;
            let new = it
                .next()
                .ok_or_else(|| GitError::Parse("missing new path".into()))?;
            files.push(ChangedFile {
                path: bytes_to_string(new)?,
                old_path: Some(bytes_to_string(old)?),
                status,
            });
        } else {
            let p = it
                .next()
                .ok_or_else(|| GitError::Parse("missing path".into()))?;
            files.push(ChangedFile {
                path: bytes_to_string(p)?,
                old_path: None,
                status,
            });
        }
    }

    Ok(files)
}

fn bytes_to_string(b: &[u8]) -> Result<String, GitError> {
    std::str::from_utf8(b)
        .map(|s| s.to_string())
        .map_err(|_| GitError::Parse("path not utf-8".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_modified() {
        let input = b"M\0src/main.rs\0";
        let out = parse_name_status_z(input).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "src/main.rs");
        assert_eq!(out[0].status, FileStatus::Modified);
        assert!(out[0].old_path.is_none());
    }

    #[test]
    fn parse_rename() {
        let input = b"R100\0old.txt\0new.txt\0M\0other.rs\0";
        let out = parse_name_status_z(input).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].path, "new.txt");
        assert_eq!(out[0].old_path.as_deref(), Some("old.txt"));
        assert_eq!(out[0].status, FileStatus::Renamed);
        assert_eq!(out[1].path, "other.rs");
        assert_eq!(out[1].status, FileStatus::Modified);
    }

    #[test]
    fn parse_empty() {
        let out = parse_name_status_z(b"").unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn reject_invalid_ref() {
        assert!(validate_ref("").is_err());
        assert!(validate_ref("-foo").is_err());
        assert!(validate_ref("main").is_ok());
        assert!(validate_ref("feature/x").is_ok());
    }
}
