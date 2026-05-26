use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

use super::blame::{parse_porcelain, Blame};
use super::{
    Branch, BranchKind, ChangedFile, DiffMode, FileDiff, FileStatus, GitError, GitLayer,
    SubmoduleInfo,
};

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
    /// Same pattern as `diff_files_child`, but for `worktree_files`. Each
    /// worktree_files invocation spawns up to two children (diff + ls-files)
    /// in sequence and stores the active one here.
    worktree_files_child: Option<Arc<Mutex<Option<Child>>>>,
    /// Same pattern as the other `*_child` slots, but for in-flight blame.
    blame_child: Option<Arc<Mutex<Option<Child>>>>,
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

impl Drop for Session {
    fn drop(&mut self) {
        // Batch processes clean themselves up via their own Drop, but an
        // in-flight diff_files child is owned by an Arc shared with the
        // streaming task — dropping our Arc reference alone won't kill it.
        for slot in [
            self.diff_files_child.take(),
            self.worktree_files_child.take(),
            self.blame_child.take(),
        ] {
            if let Some(arc) = slot {
                if let Some(mut child) = arc.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
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
            worktree_files_child: None,
            blame_child: None,
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

    fn worktree_files(
        &self,
        path: &Path,
        ignore_whitespace: bool,
        on_file: &mut dyn FnMut(ChangedFile) -> Result<(), GitError>,
    ) -> Result<(), GitError> {
        // Long-lived single kill slot for this invocation. A newer call replaces
        // it in the session, which cancels whichever child we currently hold.
        let kill_slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
        {
            let mut guard = self.session.lock().unwrap();
            ensure_session(&mut guard, path)?;
            let session = guard.as_mut().expect("ensure_session populated guard");
            let prev = session.worktree_files_child.replace(kill_slot.clone());
            drop(guard);
            if let Some(prev) = prev {
                if let Some(mut c) = prev.lock().unwrap().take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
        }

        // Phase 1: tracked changes via `git diff HEAD --name-status -z --find-renames [-w]`.
        let mut diff_args = vec!["diff", "HEAD", "--name-status", "-z", "--find-renames"];
        if ignore_whitespace {
            diff_args.push("-w");
        }
        let mut diff_child = git_command()
            .arg("-C")
            .arg(path)
            .args(&diff_args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let diff_stdout = diff_child
            .stdout
            .take()
            .ok_or_else(|| GitError::CommandFailed("worktree diff stdout not piped".into()))?;
        *kill_slot.lock().unwrap() = Some(diff_child);

        let mut reader = BufReader::new(diff_stdout);
        let parse_result = stream_parse_name_status(&mut reader, on_file);
        if let Some(mut c) = kill_slot.lock().unwrap().take() {
            let _ = c.wait();
        }
        if let Err(e) = parse_result {
            clear_worktree_slot_if_ours(&self.session, &kill_slot);
            return Err(e);
        }

        // If a newer call cancelled us, skip phase 2.
        {
            let guard = self.session.lock().unwrap();
            let still_active = guard
                .as_ref()
                .and_then(|s| s.worktree_files_child.as_ref())
                .map(|cur| Arc::ptr_eq(cur, &kill_slot))
                .unwrap_or(false);
            if !still_active {
                return Ok(());
            }
        }

        // Phase 2: untracked files via `git ls-files --others --exclude-standard -z`.
        let mut ls_child = git_command()
            .arg("-C")
            .arg(path)
            .args(["ls-files", "--others", "--exclude-standard", "-z"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let ls_stdout = ls_child
            .stdout
            .take()
            .ok_or_else(|| GitError::CommandFailed("ls-files stdout not piped".into()))?;
        *kill_slot.lock().unwrap() = Some(ls_child);

        let mut reader = BufReader::new(ls_stdout);
        let parse_result = stream_parse_ls_files(&mut reader, on_file);
        if let Some(mut c) = kill_slot.lock().unwrap().take() {
            let _ = c.wait();
        }

        clear_worktree_slot_if_ours(&self.session, &kill_slot);
        parse_result
    }

    fn worktree_file_diff(
        &self,
        path: &Path,
        file_path: &str,
        old_path: Option<&str>,
        status: FileStatus,
        force: bool,
    ) -> Result<FileDiff, GitError> {
        validate_path(file_path)?;
        if let Some(p) = old_path {
            validate_path(p)?;
        }

        let mut guard = self.session.lock().unwrap();
        ensure_session(&mut guard, path)?;
        let session = guard.as_mut().expect("ensure_session populated guard");

        let needs_head = !matches!(status, FileStatus::Added);
        let needs_fs = !matches!(status, FileStatus::Deleted);

        let head_target = old_path.unwrap_or(file_path);
        let head_spec = format!("HEAD:{head_target}");
        let old_size = if needs_head {
            match session.batch_check.query_size(&head_spec)? {
                BatchResponse::Found { size } => Some(size),
                BatchResponse::Missing => None,
            }
        } else {
            None
        };

        let fs_path = path.join(file_path);
        let new_size = if needs_fs {
            match fs::metadata(&fs_path) {
                Ok(m) => Some(m.len()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(GitError::Io(e)),
            }
        } else {
            None
        };

        let max_side = old_size.unwrap_or(0).max(new_size.unwrap_or(0));
        if !force && max_side > LARGE_FILE_BYTES {
            return Ok(FileDiff::TooLarge {
                old_size: old_size.unwrap_or(0),
                new_size: new_size.unwrap_or(0),
            });
        }

        let old_bytes = if old_size.is_some() {
            match session.batch.query_content(&head_spec)? {
                BatchContent::Found { bytes } => bytes,
                BatchContent::Missing => Vec::new(),
            }
        } else {
            Vec::new()
        };
        let new_bytes = if new_size.is_some() {
            match fs::read(&fs_path) {
                Ok(b) => b,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
                Err(e) => return Err(GitError::Io(e)),
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

    fn list_repo_files(&self, path: &Path) -> Result<Vec<String>, GitError> {
        let stdout = self.run(path, &["ls-files", "-s", "-z"])?;
        parse_ls_files_stage(&stdout)
    }

    fn blame_file(
        &self,
        path: &Path,
        file_path: &str,
        rev: &str,
        use_contents: bool,
    ) -> Result<Blame, GitError> {
        validate_path(file_path)?;
        if !use_contents {
            validate_ref(rev)?;
        }

        // Args: blame -w -M --porcelain. When `use_contents`, blame the
        // working copy against HEAD; otherwise blame at `rev`.
        let mut args: Vec<String> = vec![
            "blame".into(),
            "-w".into(),
            "-M".into(),
            "--porcelain".into(),
        ];
        let fs_path_str;
        if use_contents {
            let fs_path = path.join(file_path);
            fs_path_str = fs_path.to_string_lossy().into_owned();
            args.push("--contents".into());
            args.push(fs_path_str);
            args.push("HEAD".into());
        } else {
            args.push(rev.into());
        }
        args.push("--".into());
        args.push(file_path.into());

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
            .ok_or_else(|| GitError::CommandFailed("blame stdout not piped".into()))?;
        let stderr = child.stderr.take();

        // Install killable handle in session, cancelling any prior blame.
        let kill_slot = Arc::new(Mutex::new(Some(child)));
        {
            let mut guard = self.session.lock().unwrap();
            ensure_session(&mut guard, path)?;
            let session = guard.as_mut().expect("ensure_session populated guard");
            let prev = session.blame_child.replace(kill_slot.clone());
            drop(guard);
            if let Some(prev) = prev {
                if let Some(mut c) = prev.lock().unwrap().take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
        }

        let mut buf = Vec::new();
        let mut reader = BufReader::new(stdout);
        let read_result = reader.read_to_end(&mut buf);

        // Reap our own child (may have been killed by a newer call).
        let exit_status = kill_slot
            .lock()
            .unwrap()
            .take()
            .and_then(|mut c| c.wait().ok());

        // Clear our slot if it still points at us; record whether we were
        // still the active blame at completion.
        let still_ours = {
            let mut guard = self.session.lock().unwrap();
            if let Some(session) = guard.as_mut() {
                let s = session
                    .blame_child
                    .as_ref()
                    .map(|cur| Arc::ptr_eq(cur, &kill_slot))
                    .unwrap_or(false);
                if s {
                    session.blame_child = None;
                }
                s
            } else {
                false
            }
        };

        if !still_ours {
            return Err(GitError::CommandFailed("blame cancelled".into()));
        }

        read_result?;

        if let Some(status) = exit_status {
            if !status.success() {
                let mut stderr_buf = String::new();
                if let Some(mut s) = stderr {
                    use std::io::Read;
                    let _ = s.read_to_string(&mut stderr_buf);
                }
                let trimmed = stderr_buf.trim();
                return Err(GitError::CommandFailed(if trimmed.is_empty() {
                    format!("git blame failed: exit {status}")
                } else {
                    trimmed.to_string()
                }));
            }
        }

        parse_porcelain(&buf)
    }

    fn list_submodules(&self, path: &Path) -> Result<Vec<SubmoduleInfo>, GitError> {
        // No `.gitmodules` → no submodules. Skip even spawning git.
        let gitmodules = path.join(".gitmodules");
        if !gitmodules.exists() {
            return Ok(Vec::new());
        }
        // `git config --get-regexp` exits 1 with empty stderr when there are
        // no matches. Distinguish that from real errors by using `output()`
        // directly instead of `self.run()`.
        let out = git_command()
            .arg("-C")
            .arg(path)
            .args([
                "config",
                "--file",
                ".gitmodules",
                "-z",
                "--get-regexp",
                r"^submodule\..*\.path$",
            ])
            .output()?;
        if !out.status.success() {
            // exit 1 + empty stderr = "no matching keys" — treat as empty.
            if out.status.code() == Some(1) && out.stderr.is_empty() {
                return Ok(Vec::new());
            }
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(GitError::CommandFailed(stderr));
        }
        let entries = parse_gitmodules_paths(&out.stdout)?;
        let mut result = Vec::with_capacity(entries.len());
        for relpath in entries {
            let absolute = path.join(&relpath);
            // Initialized when the working tree has a `.git` entry — that's
            // either a directory (older clones) or a gitfile (modern). Both
            // satisfy `exists()`.
            let initialized = absolute.join(".git").exists();
            result.push(SubmoduleInfo {
                path: relpath,
                absolute_path: absolute.to_string_lossy().into_owned(),
                initialized,
            });
        }
        Ok(result)
    }

    fn submodule_sha_at(
        &self,
        path: &Path,
        tree_ish: &str,
        submodule_path: &str,
    ) -> Result<Option<String>, GitError> {
        let tree_ish = validate_ref(tree_ish)?;
        validate_path(submodule_path)?;
        let stdout = self.run(path, &["ls-tree", tree_ish, "--", submodule_path])?;
        parse_gitlink_sha(&stdout)
    }
}

fn clear_worktree_slot_if_ours(
    session: &Mutex<Option<Session>>,
    kill_slot: &Arc<Mutex<Option<Child>>>,
) {
    let mut guard = session.lock().unwrap();
    if let Some(s) = guard.as_mut() {
        let still_ours = s
            .worktree_files_child
            .as_ref()
            .map(|cur| Arc::ptr_eq(cur, kill_slot))
            .unwrap_or(false);
        if still_ours {
            s.worktree_files_child = None;
        }
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

/// Streaming parser for `git ls-files -z` output. Each NUL-terminated path is
/// emitted as a `ChangedFile { status: Added, old_path: None }`.
fn stream_parse_ls_files<R: BufRead>(
    reader: &mut R,
    emit: &mut dyn FnMut(ChangedFile) -> Result<(), GitError>,
) -> Result<(), GitError> {
    loop {
        let Some(p) = read_nul_field(reader)? else {
            return Ok(());
        };
        if p.is_empty() {
            continue;
        }
        emit(ChangedFile {
            path: bytes_to_string(&p)?,
            old_path: None,
            status: FileStatus::Added,
        })?;
    }
}

/// Parse `git ls-files -s -z` output. Each NUL-terminated record is
/// `<mode> SP <oid> SP <stage>\t<path>`. Gitlink entries (mode 160000) are
/// dropped — submodules can't be blamed.
fn parse_ls_files_stage(bytes: &[u8]) -> Result<Vec<String>, GitError> {
    let mut out = Vec::new();
    for entry in bytes.split(|&b| b == 0) {
        if entry.is_empty() {
            continue;
        }
        let tab = entry
            .iter()
            .position(|&b| b == b'\t')
            .ok_or_else(|| GitError::Parse("ls-files -s: missing tab".into()))?;
        let meta = &entry[..tab];
        let path = &entry[tab + 1..];
        let mode_end = meta.iter().position(|&b| b == b' ').unwrap_or(meta.len());
        if &meta[..mode_end] == b"160000" {
            continue;
        }
        out.push(bytes_to_string(path)?);
    }
    Ok(out)
}

/// Parse `git config -z --get-regexp ^submodule\..*\.path$` output. Each
/// NUL-terminated record is `<key>\n<value>` — we want the values.
fn parse_gitmodules_paths(bytes: &[u8]) -> Result<Vec<String>, GitError> {
    let mut out = Vec::new();
    for entry in bytes.split(|&b| b == 0) {
        if entry.is_empty() {
            continue;
        }
        let nl = entry
            .iter()
            .position(|&b| b == b'\n')
            .ok_or_else(|| GitError::Parse("gitmodules entry missing newline".into()))?;
        let value = &entry[nl + 1..];
        if value.is_empty() {
            continue;
        }
        out.push(bytes_to_string(value)?);
    }
    Ok(out)
}

/// Parse `git ls-tree <tree> -- <path>` output for a gitlink entry. Returns
/// the commit SHA, or `None` when the path is not a gitlink at that tree
/// (empty output, or some other object type).
fn parse_gitlink_sha(bytes: &[u8]) -> Result<Option<String>, GitError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| GitError::Parse("ls-tree output not utf-8".into()))?;
    let line = text.lines().next().unwrap_or("");
    if line.is_empty() {
        return Ok(None);
    }
    // Format: `<mode> SP <type> SP <sha>\t<path>`. Gitlink mode is 160000,
    // type is `commit`. Anything else is not a submodule pointer.
    let mut parts = line.splitn(3, ' ');
    let mode = parts.next().unwrap_or("");
    let ty = parts.next().unwrap_or("");
    if mode != "160000" || ty != "commit" {
        return Ok(None);
    }
    let rest = parts.next().unwrap_or("");
    let tab = rest
        .find('\t')
        .ok_or_else(|| GitError::Parse("ls-tree gitlink: missing tab".into()))?;
    Ok(Some(rest[..tab].to_string()))
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
    fn parse_ls_files_untracked() {
        let input = b"src/new.rs\0docs/draft.md\0";
        let mut out = Vec::new();
        let mut reader = Cursor::new(input);
        stream_parse_ls_files(&mut reader, &mut |f| {
            out.push(f);
            Ok(())
        })
        .unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].path, "src/new.rs");
        assert_eq!(out[0].status, FileStatus::Added);
        assert!(out[0].old_path.is_none());
        assert_eq!(out[1].path, "docs/draft.md");
        assert_eq!(out[1].status, FileStatus::Added);
    }

    #[test]
    fn parse_ls_files_empty() {
        let mut out = Vec::new();
        let mut reader = Cursor::new(b"");
        stream_parse_ls_files(&mut reader, &mut |f| {
            out.push(f);
            Ok(())
        })
        .unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn parse_ls_files_stage_basic() {
        let input = b"100644 abc123 0\tsrc/main.rs\0100755 def456 0\tscripts/run.sh\0";
        let out = parse_ls_files_stage(input).unwrap();
        assert_eq!(out, vec!["src/main.rs", "scripts/run.sh"]);
    }

    #[test]
    fn parse_ls_files_stage_filters_submodule() {
        let input = b"100644 abc123 0\tsrc/main.rs\0160000 deadbeef 0\tvendor/sub\0100644 def456 0\tREADME\0";
        let out = parse_ls_files_stage(input).unwrap();
        assert_eq!(out, vec!["src/main.rs", "README"]);
    }

    #[test]
    fn parse_ls_files_stage_empty() {
        assert!(parse_ls_files_stage(b"").unwrap().is_empty());
    }

    #[test]
    fn parse_ls_files_stage_path_with_spaces() {
        let input = b"100644 abc123 0\tsrc/file with spaces.rs\0";
        let out = parse_ls_files_stage(input).unwrap();
        assert_eq!(out, vec!["src/file with spaces.rs"]);
    }

    #[test]
    fn parse_ls_files_stage_rejects_missing_tab() {
        // No tab between meta and path — malformed.
        let input = b"100644 abc123 0 src/main.rs\0";
        assert!(parse_ls_files_stage(input).is_err());
    }

    #[test]
    fn parse_gitmodules_paths_basic() {
        // `git config -z --get-regexp` output: key\nvalue\0key\nvalue\0...
        let input = b"submodule.vendor/sub.path\nvendor/sub\0submodule.shared.path\nshared/lib\0";
        let out = parse_gitmodules_paths(input).unwrap();
        assert_eq!(out, vec!["vendor/sub", "shared/lib"]);
    }

    #[test]
    fn parse_gitmodules_paths_empty() {
        assert!(parse_gitmodules_paths(b"").unwrap().is_empty());
    }

    #[test]
    fn parse_gitmodules_paths_path_with_spaces() {
        let input = b"submodule.my name.path\npath with spaces/sub\0";
        let out = parse_gitmodules_paths(input).unwrap();
        assert_eq!(out, vec!["path with spaces/sub"]);
    }

    #[test]
    fn parse_gitmodules_paths_rejects_missing_newline() {
        // Entry without the `\n` separator between key and value — malformed.
        let input = b"submodule.bad.pathvendor/sub\0";
        assert!(parse_gitmodules_paths(input).is_err());
    }

    #[test]
    fn parse_gitlink_sha_basic() {
        let input = b"160000 commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\tvendor/sub\n";
        let out = parse_gitlink_sha(input).unwrap();
        assert_eq!(
            out.as_deref(),
            Some("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")
        );
    }

    #[test]
    fn parse_gitlink_sha_empty_means_none() {
        // Path is not present at that tree — ls-tree produces no output.
        assert!(parse_gitlink_sha(b"").unwrap().is_none());
    }

    #[test]
    fn parse_gitlink_sha_blob_means_none() {
        // Path exists at the tree but as a regular file, not a gitlink.
        let input = b"100644 blob abc123\tsrc/main.rs\n";
        assert!(parse_gitlink_sha(input).unwrap().is_none());
    }

    #[test]
    fn parse_gitlink_sha_tree_means_none() {
        // Path is a directory, not a gitlink.
        let input = b"040000 tree abc123\tvendor\n";
        assert!(parse_gitlink_sha(input).unwrap().is_none());
    }

    #[test]
    fn parse_gitlink_sha_rejects_missing_tab() {
        let input = b"160000 commit abc123 vendor/sub\n";
        assert!(parse_gitlink_sha(input).is_err());
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
