use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

use super::{Branch, BranchKind, ChangedFile, DiffMode, FileDiff, FileStatus, GitError, GitLayer};

/// Soft cap on a single side of a diff. Above this, frontend must opt in via `force`.
const LARGE_FILE_BYTES: u64 = 1_000_000;

/// Bytes scanned for NUL when sniffing for binary content.
const BINARY_SNIFF_BYTES: usize = 8192;

/// `Command::new("git")` with `CREATE_NO_WINDOW` on Windows so spawning git
/// from a GUI app doesn't flash a console window. No-op on other platforms.
fn git_command() -> Command {
    let cmd = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = cmd;
        cmd.creation_flags(CREATE_NO_WINDOW);
        return cmd;
    }
    #[cfg(not(windows))]
    cmd
}

/// Long-lived git CLI client. Holds a per-repo session with persistent
/// `git cat-file --batch-check` and `--batch` processes so that file_diff
/// doesn't pay process-spawn cost (and Defender scan) per call.
pub struct GitCli {
    session: Mutex<Option<Session>>,
}

struct Session {
    repo_path: PathBuf,
    batch_check: BatchProcess,
    batch: BatchProcess,
    merge_base_cache: HashMap<(String, String), String>,
    /// The currently in-flight `git diff` child for streaming diff_files.
    /// Replacing this slot is how we cancel an outstanding stream.
    diff_files_child: Option<Arc<Mutex<Option<Child>>>>,
}

/// A long-running `git cat-file` process kept around for a single repo.
/// Caller writes a spec on stdin and reads the response from stdout.
struct BatchProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

enum BatchResponse {
    Found { size: u64 },
    Missing,
}

enum BatchContent {
    Found { bytes: Vec<u8> },
    Missing,
}

impl BatchProcess {
    fn spawn(repo: &Path, mode_arg: &str) -> Result<Self, GitError> {
        let mut child = git_command()
            .arg("-C")
            .arg(repo)
            .args(["cat-file", mode_arg])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| GitError::CommandFailed("batch stdin not piped".into()))?;
        let stdout = child
            .stdout
            .take()
            .map(BufReader::new)
            .ok_or_else(|| GitError::CommandFailed("batch stdout not piped".into()))?;
        Ok(Self {
            child,
            stdin,
            stdout,
        })
    }

    fn write_spec(&mut self, spec: &str) -> Result<(), GitError> {
        self.stdin.write_all(spec.as_bytes())?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()?;
        Ok(())
    }

    fn read_header(&mut self) -> Result<BatchHeader, GitError> {
        let mut line = String::new();
        let n = self.stdout.read_line(&mut line)?;
        if n == 0 {
            return Err(GitError::CommandFailed("batch process EOF".into()));
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.ends_with(" missing") {
            return Ok(BatchHeader::Missing);
        }
        let mut parts = trimmed.splitn(3, ' ');
        let _oid = parts.next();
        let _ty = parts.next();
        let size: u64 = parts
            .next()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| GitError::Parse(format!("bad batch header: {trimmed}")))?;
        Ok(BatchHeader::Found { size })
    }

    /// `--batch-check` mode: write a spec, read one response line.
    fn query_size(&mut self, spec: &str) -> Result<BatchResponse, GitError> {
        self.write_spec(spec)?;
        Ok(match self.read_header()? {
            BatchHeader::Found { size } => BatchResponse::Found { size },
            BatchHeader::Missing => BatchResponse::Missing,
        })
    }

    /// `--batch` mode: write a spec, read header + content + trailing newline.
    fn query_content(&mut self, spec: &str) -> Result<BatchContent, GitError> {
        self.write_spec(spec)?;
        match self.read_header()? {
            BatchHeader::Missing => Ok(BatchContent::Missing),
            BatchHeader::Found { size } => {
                let mut buf = vec![0u8; size as usize];
                self.stdout.read_exact(&mut buf)?;
                let mut nl = [0u8; 1];
                self.stdout.read_exact(&mut nl)?;
                if nl[0] != b'\n' {
                    return Err(GitError::Parse(
                        "batch content missing trailing newline".into(),
                    ));
                }
                Ok(BatchContent::Found { bytes: buf })
            }
        }
    }
}

enum BatchHeader {
    Found { size: u64 },
    Missing,
}

impl Drop for BatchProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Session {
    fn new(repo: &Path) -> Result<Self, GitError> {
        let batch_check = BatchProcess::spawn(repo, "--batch-check")?;
        let batch = BatchProcess::spawn(repo, "--batch")?;
        Ok(Self {
            repo_path: repo.to_path_buf(),
            batch_check,
            batch,
            merge_base_cache: HashMap::new(),
            diff_files_child: None,
        })
    }

    /// Resolve the merge-base of two refs, caching the result for the session.
    fn merge_base(&mut self, a: &str, b: &str) -> Result<String, GitError> {
        let key = (a.to_string(), b.to_string());
        if let Some(v) = self.merge_base_cache.get(&key) {
            return Ok(v.clone());
        }
        let out = git_command()
            .arg("-C")
            .arg(&self.repo_path)
            .args(["merge-base", a, b])
            .output()?;
        if !out.status.success() {
            return Err(GitError::CommandFailed(format!(
                "no merge-base between {a} and {b}"
            )));
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            return Err(GitError::CommandFailed(format!(
                "no merge-base between {a} and {b}"
            )));
        }
        self.merge_base_cache.insert(key, s.clone());
        Ok(s)
    }
}

impl GitCli {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
        }
    }

    fn run(&self, path: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
        let output = git_command().arg("-C").arg(path).args(args).output()?;
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

/// Ensure the cached session targets `path`. Drops the previous session
/// (which terminates its child processes) before spawning a new one.
fn ensure_session(
    guard: &mut std::sync::MutexGuard<'_, Option<Session>>,
    path: &Path,
) -> Result<(), GitError> {
    let needs_new = match guard.as_ref() {
        Some(s) => s.repo_path != path,
        None => true,
    };
    if needs_new {
        // Drop the old session first so its batch processes shut down before
        // we spawn new ones — keeps the process count bounded.
        guard.take();
        **guard = Some(Session::new(path)?);
    }
    Ok(())
}

impl GitLayer for GitCli {
    fn validate_repo(&self, path: &Path) -> Result<(), GitError> {
        if !path.exists() {
            return Err(GitError::NotARepo(path.display().to_string()));
        }
        self.run(path, &["rev-parse", "--git-dir"])
            .map_err(|_| GitError::NotARepo(path.display().to_string()))?;
        let mut guard = self.session.lock().unwrap();
        ensure_session(&mut guard, path)?;
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
        on_file: &mut dyn FnMut(ChangedFile) -> Result<(), GitError>,
    ) -> Result<(), GitError> {
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

        let mut child = git_command()
            .arg("-C")
            .arg(path)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| GitError::CommandFailed("diff stdout not piped".into()))?;

        // Install our killable handle in the session, cancelling any prior in-flight stream.
        let kill_slot = Arc::new(Mutex::new(Some(child)));
        {
            let mut guard = self.session.lock().unwrap();
            ensure_session(&mut guard, path)?;
            let session = guard.as_mut().expect("ensure_session populated guard");
            let prev = session.diff_files_child.replace(kill_slot.clone());
            drop(guard);
            if let Some(prev) = prev {
                if let Some(mut c) = prev.lock().unwrap().take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
        }

        // Drain stdout via the streaming parser. Errors from the closure short-circuit
        // (frontend channel closed / parse failure).
        let mut reader = BufReader::new(stdout);
        let parse_result = stream_parse_name_status(&mut reader, on_file);

        // Reap our own child (may already be dead if a newer call killed it).
        if let Some(mut c) = kill_slot.lock().unwrap().take() {
            let _ = c.wait();
        }

        // Clear our slot in the session if it still points at us.
        {
            let mut guard = self.session.lock().unwrap();
            if let Some(session) = guard.as_mut() {
                let still_ours = session
                    .diff_files_child
                    .as_ref()
                    .map(|cur| Arc::ptr_eq(cur, &kill_slot))
                    .unwrap_or(false);
                if still_ours {
                    session.diff_files_child = None;
                }
            }
        }

        parse_result
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

        let mut guard = self.session.lock().unwrap();
        ensure_session(&mut guard, path)?;
        let session = guard.as_mut().expect("ensure_session populated guard");

        let old_ref = match mode {
            DiffMode::ThreeDot => session.merge_base(start, target)?,
            DiffMode::TwoDot => start.to_string(),
        };
        let new_ref = target.to_string();

        let old_target = old_path.unwrap_or(file_path);
        let old_spec = format!("{old_ref}:{old_target}");
        let new_spec = format!("{new_ref}:{file_path}");

        let old_size = match session.batch_check.query_size(&old_spec)? {
            BatchResponse::Found { size } => Some(size),
            BatchResponse::Missing => None,
        };
        let new_size = match session.batch_check.query_size(&new_spec)? {
            BatchResponse::Found { size } => Some(size),
            BatchResponse::Missing => None,
        };

        let max_side = old_size.unwrap_or(0).max(new_size.unwrap_or(0));
        if !force && max_side > LARGE_FILE_BYTES {
            return Ok(FileDiff::TooLarge {
                old_size: old_size.unwrap_or(0),
                new_size: new_size.unwrap_or(0),
            });
        }

        let old_bytes = if old_size.is_some() {
            match session.batch.query_content(&old_spec)? {
                BatchContent::Found { bytes } => bytes,
                BatchContent::Missing => Vec::new(),
            }
        } else {
            Vec::new()
        };
        let new_bytes = if new_size.is_some() {
            match session.batch.query_content(&new_spec)? {
                BatchContent::Found { bytes } => bytes,
                BatchContent::Missing => Vec::new(),
            }
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

/// Read one NUL-terminated field, returning the bytes without the trailing NUL.
/// Returns `Ok(None)` on clean EOF.
fn read_nul_field<R: BufRead>(reader: &mut R) -> Result<Option<Vec<u8>>, GitError> {
    let mut buf = Vec::new();
    let n = reader.read_until(0, &mut buf)?;
    if n == 0 {
        return Ok(None);
    }
    if buf.last() == Some(&0) {
        buf.pop();
    }
    Ok(Some(buf))
}

/// Streaming parser for `git diff --name-status -z`. Each parsed entry is
/// passed to `emit`; an `Err` from `emit` aborts parsing and propagates up.
fn stream_parse_name_status<R: BufRead>(
    reader: &mut R,
    emit: &mut dyn FnMut(ChangedFile) -> Result<(), GitError>,
) -> Result<(), GitError> {
    loop {
        let Some(status_raw) = read_nul_field(reader)? else {
            return Ok(());
        };
        if status_raw.is_empty() {
            continue;
        }
        let status_str = std::str::from_utf8(&status_raw)
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

        let entry = if has_old_path {
            let old = read_nul_field(reader)?
                .ok_or_else(|| GitError::Parse("missing old path".into()))?;
            let new = read_nul_field(reader)?
                .ok_or_else(|| GitError::Parse("missing new path".into()))?;
            ChangedFile {
                path: bytes_to_string(&new)?,
                old_path: Some(bytes_to_string(&old)?),
                status,
            }
        } else {
            let p = read_nul_field(reader)?
                .ok_or_else(|| GitError::Parse("missing path".into()))?;
            ChangedFile {
                path: bytes_to_string(&p)?,
                old_path: None,
                status,
            }
        };

        emit(entry)?;
    }
}

fn bytes_to_string(b: &[u8]) -> Result<String, GitError> {
    std::str::from_utf8(b)
        .map(|s| s.to_string())
        .map_err(|_| GitError::Parse("path not utf-8".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn collect(input: &[u8]) -> Vec<ChangedFile> {
        let mut out = Vec::new();
        let mut reader = Cursor::new(input);
        stream_parse_name_status(&mut reader, &mut |f| {
            out.push(f);
            Ok(())
        })
        .unwrap();
        out
    }

    #[test]
    fn parse_simple_modified() {
        let out = collect(b"M\0src/main.rs\0");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "src/main.rs");
        assert_eq!(out[0].status, FileStatus::Modified);
        assert!(out[0].old_path.is_none());
    }

    #[test]
    fn parse_rename() {
        let out = collect(b"R100\0old.txt\0new.txt\0M\0other.rs\0");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].path, "new.txt");
        assert_eq!(out[0].old_path.as_deref(), Some("old.txt"));
        assert_eq!(out[0].status, FileStatus::Renamed);
        assert_eq!(out[1].path, "other.rs");
        assert_eq!(out[1].status, FileStatus::Modified);
    }

    #[test]
    fn parse_empty() {
        let out = collect(b"");
        assert!(out.is_empty());
    }

    #[test]
    fn callback_error_short_circuits() {
        let input = b"M\0a\0M\0b\0M\0c\0";
        let mut reader = Cursor::new(input);
        let mut count = 0;
        let res = stream_parse_name_status(&mut reader, &mut |_| {
            count += 1;
            if count == 2 {
                Err(GitError::CommandFailed("stop".into()))
            } else {
                Ok(())
            }
        });
        assert!(res.is_err());
        assert_eq!(count, 2);
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
