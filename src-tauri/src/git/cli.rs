use std::path::Path;
use std::process::Command;

use super::{Branch, BranchKind, ChangedFile, DiffMode, FileDiff, FileStatus, GitError, GitLayer};

/// Soft cap on a single side of a diff. Above this, frontend must opt in via `force`.
const LARGE_FILE_BYTES: u64 = 1_000_000;

/// Bytes scanned for NUL when sniffing for binary content.
const BINARY_SNIFF_BYTES: usize = 8192;

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

    /// Like `run`, but returns `Ok(None)` when git exits nonzero (e.g. object missing
    /// because the file didn't exist at that ref). Use only for queries where absence
    /// is a valid answer.
    fn run_optional(&self, path: &Path, args: &[&str]) -> Result<Option<Vec<u8>>, GitError> {
        let output = Command::new("git").arg("-C").arg(path).args(args).output()?;
        if output.status.success() {
            Ok(Some(output.stdout))
        } else {
            Ok(None)
        }
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

/// Reject obviously-malformed path arguments. Real path validity is enforced by git.
fn validate_path(s: &str) -> Result<(), GitError> {
    if s.is_empty() || s.starts_with('-') {
        return Err(GitError::InvalidRef(format!("invalid path: {s}")));
    }
    Ok(())
}

fn is_binary(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(BINARY_SNIFF_BYTES)];
    head.contains(&0)
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
        ignore_whitespace: bool,
    ) -> Result<Vec<ChangedFile>, GitError> {
        let start = validate_ref(start)?;
        let target = validate_ref(target)?;

        let spec = match mode {
            DiffMode::ThreeDot => format!("{start}...{target}"),
            DiffMode::TwoDot => format!("{start}..{target}"),
        };

        let mut args = vec!["diff", "--name-status", "-z", "--find-renames"];
        if ignore_whitespace {
            args.push("-w");
        }
        args.push(&spec);

        let stdout = self.run(path, &args)?;

        parse_name_status_z(&stdout)
    }

    fn file_diff(
        &self,
        path: &Path,
        start: &str,
        target: &str,
        mode: DiffMode,
        file_path: &str,
        old_path: Option<&str>,
        force: bool,
    ) -> Result<FileDiff, GitError> {
        let start = validate_ref(start)?;
        let target = validate_ref(target)?;
        validate_path(file_path)?;
        if let Some(p) = old_path {
            validate_path(p)?;
        }

        // Resolve the "old" ref. For three-dot, that's merge-base(start, target).
        let old_ref = match mode {
            DiffMode::ThreeDot => self.merge_base(path, start, target)?,
            DiffMode::TwoDot => start.to_string(),
        };
        let new_ref = target.to_string();

        let old_target = old_path.unwrap_or(file_path);
        let old_spec = format!("{old_ref}:{old_target}");
        let new_spec = format!("{new_ref}:{file_path}");

        // Sizes (None = file absent on that side, e.g. add or delete)
        let old_size = self.cat_file_size(path, &old_spec)?;
        let new_size = self.cat_file_size(path, &new_spec)?;

        let max_side = old_size.unwrap_or(0).max(new_size.unwrap_or(0));
        if !force && max_side > LARGE_FILE_BYTES {
            return Ok(FileDiff::TooLarge {
                old_size: old_size.unwrap_or(0),
                new_size: new_size.unwrap_or(0),
            });
        }

        let old_bytes = if old_size.is_some() {
            self.run_optional(path, &["show", &old_spec])?
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let new_bytes = if new_size.is_some() {
            self.run_optional(path, &["show", &new_spec])?
                .unwrap_or_default()
        } else {
            Vec::new()
        };

        if is_binary(&old_bytes) || is_binary(&new_bytes) {
            return Ok(FileDiff::Binary {
                old_size: old_size.unwrap_or(0),
                new_size: new_size.unwrap_or(0),
            });
        }

        Ok(FileDiff::Text {
            old_content: String::from_utf8_lossy(&old_bytes).into_owned(),
            new_content: String::from_utf8_lossy(&new_bytes).into_owned(),
            old_size: old_size.unwrap_or(0),
            new_size: new_size.unwrap_or(0),
        })
    }
}

impl GitCli {
    fn merge_base(&self, path: &Path, a: &str, b: &str) -> Result<String, GitError> {
        let out = self.run(path, &["merge-base", a, b])?;
        let s = String::from_utf8_lossy(&out).trim().to_string();
        if s.is_empty() {
            return Err(GitError::CommandFailed(format!(
                "no merge-base between {a} and {b}"
            )));
        }
        Ok(s)
    }

    fn cat_file_size(&self, path: &Path, spec: &str) -> Result<Option<u64>, GitError> {
        let Some(out) = self.run_optional(path, &["cat-file", "-s", spec])? else {
            return Ok(None);
        };
        let s = String::from_utf8_lossy(&out);
        s.trim()
            .parse::<u64>()
            .map(Some)
            .map_err(|_| GitError::Parse(format!("cat-file -s output not a number: {s}")))
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

    #[test]
    fn reject_invalid_path() {
        assert!(validate_path("").is_err());
        assert!(validate_path("-rf").is_err());
        assert!(validate_path("src/main.rs").is_ok());
        assert!(validate_path("a b/c.txt").is_ok());
    }

    #[test]
    fn binary_detection() {
        assert!(!is_binary(b""));
        assert!(!is_binary(b"hello world\nfoo"));
        assert!(is_binary(b"hello\0world"));
        // NUL outside the sniff window is ignored
        let mut big = vec![b'a'; BINARY_SNIFF_BYTES + 10];
        big[BINARY_SNIFF_BYTES + 5] = 0;
        assert!(!is_binary(&big));
    }
}
