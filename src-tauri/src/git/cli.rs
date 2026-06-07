use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

use super::blame::{parse_porcelain, Blame};
use super::diff;
use super::uasset;
use super::{
    Branch, BranchKind, ChangedFile, Commit, DiffMode, FileDiff, FileStatus, GitError, GitLayer,
    Hunk, RepoStatus, StatusEntry, SubmoduleInfo,
};

/// Soft cap on a single side of a diff. Above this, frontend must opt in via `force`.
const LARGE_FILE_BYTES: u64 = 1_000_000;

/// Bytes scanned for NUL when sniffing for binary content.
const BINARY_SNIFF_BYTES: usize = 8192;

/// `git log` pretty format for the history browser. Fields are separated by
/// the Unit Separator (\x1f) and records by NUL (`-z`), neither of which can
/// appear in any field — so parsing is a plain split. Field order:
/// sha, short sha, parents, author name, author unix time, subject, refs.
const COMMIT_LOG_FORMAT: &str =
    "--format=%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%s%x1f%D";

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
    /// Per-path worktree caches with their FS watchers. Persists across
    /// `session` swaps so multi-root mode toggles don't keep paying the
    /// cold git startup cost. Entries are created lazily on first
    /// `worktree_files` call against a given path.
    worktree_caches: Mutex<HashMap<PathBuf, WorktreeCacheEntry>>,
}

struct Session {
    repo_path: PathBuf,
    batch_check: BatchProcess,
    batch: BatchProcess,
    merge_base_cache: HashMap<(String, String), String>,
    /// The currently in-flight `git diff` child for streaming diff_files.
    /// Replacing this slot is how we cancel an outstanding stream.
    diff_files_child: Option<Arc<Mutex<Option<Child>>>>,
    /// Same pattern as `diff_files_child`, but for `worktree_files`. The
    /// two passes (diff HEAD + ls-files untracked) now run concurrently so
    /// this holds *both* in-flight children — a Vec lets a newer call kill
    /// the whole batch with one slot swap.
    worktree_files_child: Option<Arc<Mutex<Vec<Child>>>>,
    /// Same pattern as the other `*_child` slots, but for in-flight blame.
    blame_child: Option<Arc<Mutex<Option<Child>>>>,
}

/// Per-path worktree cache held at the `GitCli` level, *outside* of the
/// single-slot `Session`. Multi-root compares iterate across repo paths and
/// each call swaps `session` to the new path — if the cache lived inside
/// Session it would be dropped on every swap, defeating the purpose. Keeping
/// the cache + watcher per path means each repo's cache survives unrelated
/// session swaps and stays valid until the watcher signals a real change.
struct WorktreeCacheEntry {
    cache: Option<WorktreeCache>,
    /// Set to true by the notify watcher whenever something inside the
    /// watched path (or its `.git/`) changes. Read by the worktree_files
    /// cache fast path.
    cache_invalid: Arc<AtomicBool>,
    /// Cache for `list_repo_files` — the blame picker's file union — keyed
    /// on the same FS watcher. Has its own invalid flag so worktree_files
    /// and list_repo_files don't clobber each other when both pre-clear the
    /// flag at scan start.
    repo_files: Option<Vec<String>>,
    repo_files_invalid: Arc<AtomicBool>,
    /// FS watcher. Held alive by the HashMap entry; dropped when the entry
    /// is evicted. The field name is `_watcher` because it's never read
    /// directly — its existence is what keeps the underlying ReadDirectory
    /// loop running.
    _watcher: Option<RecommendedWatcher>,
}

struct WorktreeCache {
    files: Vec<ChangedFile>,
    ignore_whitespace: bool,
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
        // in-flight child held in a streaming slot is owned by an Arc
        // shared with the streaming task — dropping our Arc reference
        // alone won't kill it.
        for slot in [self.diff_files_child.take(), self.blame_child.take()] {
            if let Some(arc) = slot {
                if let Some(mut child) = arc.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
        if let Some(arc) = self.worktree_files_child.take() {
            for mut child in std::mem::take(&mut *arc.lock().unwrap()) {
                let _ = child.kill();
                let _ = child.wait();
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
            worktree_caches: Mutex::new(HashMap::new()),
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

    /// Drop the cached session so its batch processes respawn against fresh repo
    /// state. Called after operations that move HEAD (checkout) — the long-lived
    /// cat-file processes would otherwise keep resolving `HEAD:path` against the
    /// previous tip.
    fn drop_session(&self) {
        self.session.lock().unwrap().take();
    }

    /// Like `run`, but writes `input` to the child's stdin (then closes it so
    /// the command sees EOF). Used to feed a patch to `git apply`.
    fn run_stdin(&self, path: &Path, args: &[&str], input: &[u8]) -> Result<Vec<u8>, GitError> {
        let mut child = git_command()
            .arg("-C")
            .arg(path)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        {
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| GitError::CommandFailed("stdin not piped".into()))?;
            stdin.write_all(input)?;
            // stdin dropped here → EOF.
        }
        let output = child.wait_with_output()?;
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

/// Parse `git log -z COMMIT_LOG_FORMAT` output into commits. Split out from the
/// command so it can be unit-tested without a real repo. Records are NUL-
/// separated; fields within a record are \x1f-separated in the order declared
/// by `COMMIT_LOG_FORMAT`.
fn parse_commit_log(text: &str) -> Vec<Commit> {
    let mut commits = Vec::new();
    for rec in text.split('\0') {
        if rec.is_empty() {
            continue;
        }
        let mut f = rec.splitn(7, '\x1f');
        let sha = f.next().unwrap_or("").to_string();
        let short_sha = f.next().unwrap_or("").to_string();
        let parents_raw = f.next().unwrap_or("");
        let author = f.next().unwrap_or("").to_string();
        let time = f.next().unwrap_or("").trim().parse::<i64>().unwrap_or(0);
        let summary = f.next().unwrap_or("").to_string();
        let refs_raw = f.next().unwrap_or("");
        if sha.is_empty() {
            continue;
        }
        let parents = parents_raw
            .split_whitespace()
            .map(str::to_string)
            .collect();
        let refs = refs_raw
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        commits.push(Commit {
            sha,
            short_sha,
            parents,
            author,
            time,
            summary,
            refs,
        });
    }
    commits
}

/// Parse `git status --porcelain=v2 --branch -z` output. Records are NUL-
/// separated; a rename/copy (type `2`) entry is followed by a *second* NUL
/// field holding the original path. Header lines (`# branch.*`) carry the
/// current branch, upstream, and ahead/behind. Split out so it can be unit-
/// tested without a real repo.
fn parse_status(text: &str) -> RepoStatus {
    let tokens: Vec<&str> = text.split('\0').collect();
    let mut entries = Vec::new();
    let mut branch = None;
    let mut upstream = None;
    let mut ahead = 0i64;
    let mut behind = 0i64;

    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        i += 1;
        let Some(first) = tok.as_bytes().first() else {
            continue; // empty token (e.g. the trailing NUL)
        };
        match first {
            b'#' => {
                // "# branch.head <name>|(detached)" / ".upstream <name>" /
                // ".ab +<ahead> -<behind>". Other headers (.oid) are ignored.
                if let Some(rest) = tok.strip_prefix("# branch.") {
                    if let Some(v) = rest.strip_prefix("head ") {
                        branch = (v != "(detached)").then(|| v.to_string());
                    } else if let Some(v) = rest.strip_prefix("upstream ") {
                        upstream = Some(v.to_string());
                    } else if let Some(v) = rest.strip_prefix("ab ") {
                        for part in v.split_whitespace() {
                            if let Some(n) = part.strip_prefix('+') {
                                ahead = n.parse().unwrap_or(0);
                            } else if let Some(n) = part.strip_prefix('-') {
                                behind = n.parse().unwrap_or(0);
                            }
                        }
                    }
                }
            }
            // "1 XY <sub> <mH> <mI> <mW> <hH> <hI> <path>" — path is field 9.
            b'1' => {
                if let (Some((x, y)), Some(path)) = (status_xy(tok), status_path(tok, 8)) {
                    entries.push(StatusEntry {
                        path,
                        orig_path: None,
                        index_status: x,
                        worktree_status: y,
                    });
                }
            }
            // "2 XY ... <Xscore> <path>" followed by a second NUL token = orig path.
            b'2' => {
                let orig = tokens.get(i).map(|s| s.to_string());
                i += 1; // consume the original-path token
                if let (Some((x, y)), Some(path)) = (status_xy(tok), status_path(tok, 9)) {
                    entries.push(StatusEntry {
                        path,
                        orig_path: orig,
                        index_status: x,
                        worktree_status: y,
                    });
                }
            }
            // Unmerged: "u XY <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>".
            b'u' => {
                if let (Some((x, y)), Some(path)) = (status_xy(tok), status_path(tok, 10)) {
                    entries.push(StatusEntry {
                        path,
                        orig_path: None,
                        index_status: x,
                        worktree_status: y,
                    });
                }
            }
            // "? <path>" — untracked. Mark both sides '?'.
            b'?' => {
                entries.push(StatusEntry {
                    path: tok[2..].to_string(),
                    orig_path: None,
                    index_status: "?".to_string(),
                    worktree_status: "?".to_string(),
                });
            }
            // '!' ignored files (only present with --ignored) and anything
            // unrecognized are skipped.
            _ => {}
        }
    }

    RepoStatus {
        entries,
        branch,
        upstream,
        ahead,
        behind,
    }
}

/// Extract the porcelain-v2 XY status pair from an entry token like `"1 MM ..."`:
/// the two characters at byte offsets 2 and 3.
fn status_xy(tok: &str) -> Option<(String, String)> {
    let x = tok.get(2..3)?.to_string();
    let y = tok.get(3..4)?.to_string();
    Some((x, y))
}

/// The path field of a space-delimited porcelain-v2 entry: everything after the
/// first `n` spaces. The path is the final field and may itself contain spaces,
/// so it's taken as the remainder.
fn status_path(tok: &str, n: usize) -> Option<String> {
    tok.splitn(n + 1, ' ').nth(n).map(|s| s.to_string())
}

/// Build the `git diff` args for one file's textual patch. `staged` adds
/// `--cached` (HEAD↔index); otherwise it's the worktree↔index diff.
fn diff_args(staged: bool, file_path: &str) -> Vec<&str> {
    let mut args = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(file_path);
    args
}

/// Split a single-file unified diff into `(header, hunks)`. The header is every
/// line up to the first `@@` (the `diff --git` / `---` / `+++` preamble); each
/// hunk is a `@@` line plus its body up to the next `@@` (or EOF). Lines keep
/// their trailing newline so a sub-patch reassembles byte-for-byte. Split out
/// for unit testing. Hunk header lines start with `@@` at column 0; diff body
/// lines are prefixed by a space/`+`/`-`/`\`, so they never false-match.
fn split_diff(text: &str) -> (String, Vec<String>) {
    let mut header = String::new();
    let mut hunks: Vec<String> = Vec::new();
    for line in text.split_inclusive('\n') {
        if line.starts_with("@@") {
            hunks.push(line.to_string());
        } else if let Some(last) = hunks.last_mut() {
            last.push_str(line);
        } else {
            header.push_str(line);
        }
    }
    (header, hunks)
}

/// Parse a single-file unified diff into display hunks (header line + added /
/// removed line counts).
fn parse_hunks(text: &str) -> Vec<Hunk> {
    let (_, blocks) = split_diff(text);
    blocks
        .iter()
        .map(|b| {
            let header = b.lines().next().unwrap_or("").to_string();
            let mut added = 0;
            let mut removed = 0;
            for l in b.lines().skip(1) {
                match l.as_bytes().first() {
                    Some(b'+') => added += 1,
                    Some(b'-') => removed += 1,
                    _ => {}
                }
            }
            Hunk {
                header,
                added,
                removed,
            }
        })
        .collect()
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

/// Fetch a blob's working-tree-smudged content for `spec` (`<ref>:<path>`),
/// resolving Git LFS pointers to real bytes via `git cat-file --filters`.
/// Unreal `.uasset` files are typically LFS-tracked, so the plain
/// `cat-file --batch` blob is just the pointer text. Returns `None` when the
/// object is missing or the command fails.
fn cat_file_filtered(repo: &Path, spec: &str) -> Option<Vec<u8>> {
    let output = git_command()
        .arg("-C")
        .arg(repo)
        .args(["cat-file", "--filters", spec])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(output.stdout)
}

/// Read a blob's bytes for `spec` via a one-shot `git cat-file`, bypassing the
/// long-lived session batch. Required for index specs (`:path`): the batch
/// process snapshots the index at startup and never sees `git add` / `restore`
/// / `apply --cached`, so a Changes diff must read the index fresh each time.
/// Returns `None` when the object is missing (e.g. `HEAD:path` for a new file).
fn cat_file_oneshot(repo: &Path, spec: &str) -> Option<Vec<u8>> {
    let out = git_command()
        .arg("-C")
        .arg(repo)
        .args(["cat-file", "blob", spec])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    out.status.success().then_some(out.stdout)
}

/// Resolve a gitlink/commit spec to its SHA via one-shot `git rev-parse`
/// (`HEAD:sub`, `:sub`, or `HEAD` inside the submodule). Returns None when the
/// spec doesn't resolve.
fn gitlink_sha(repo: &Path, spec: &str) -> Option<String> {
    let out = git_command()
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", "--verify", "--quiet", spec])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
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

    fn commit_log(
        &self,
        path: &Path,
        start_ref: &str,
        all: bool,
        limit: u32,
        skip: u32,
    ) -> Result<Vec<Commit>, GitError> {
        let limit_s = limit.to_string();
        let skip_s = skip.to_string();
        let mut args = vec![
            "log",
            "-z",
            COMMIT_LOG_FORMAT,
            "-n",
            &limit_s,
            "--skip",
            &skip_s,
        ];
        if all {
            // Every ref, chronological — the default "all branches" graph.
            args.push("--all");
            args.push("--date-order");
        } else {
            // Empty ref means HEAD. Reuse the leading-dash guard so a crafted
            // ref can't smuggle flags.
            args.push(if start_ref.is_empty() {
                "HEAD"
            } else {
                validate_ref(start_ref)?
            });
        }
        let stdout = self.run(path, &args)?;
        Ok(parse_commit_log(&String::from_utf8_lossy(&stdout)))
    }

    fn status(&self, path: &Path) -> Result<RepoStatus, GitError> {
        let stdout = self.run(path, &["status", "--porcelain=v2", "--branch", "-z"])?;
        Ok(parse_status(&String::from_utf8_lossy(&stdout)))
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
        uasset_cfg: &uasset::Config,
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

        // Unreal asset preview bypasses the raw too-large gate (the .uasset
        // header is small; bulk lives in .uexp) but keeps its own safety cap.
        let derive_uasset = uasset_cfg.enabled && uasset::is_uasset_path(file_path);
        let max_side = old_size.unwrap_or(0).max(new_size.unwrap_or(0));
        if !force && !derive_uasset && max_side > LARGE_FILE_BYTES {
            return Ok(FileDiff::TooLarge {
                old_size: old_size.unwrap_or(0),
                new_size: new_size.unwrap_or(0),
            });
        }
        if derive_uasset && !force && max_side > uasset::UASSET_MAX_BYTES {
            return Ok(FileDiff::Binary {
                old_size: old_size.unwrap_or(0),
                new_size: new_size.unwrap_or(0),
                note: Some("Unreal asset header too large to preview.".to_string()),
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

        if derive_uasset {
            // Re-fetch through the smudge filter so LFS-tracked assets resolve
            // to real bytes (the batch blobs above are LFS pointers).
            let old_asset = cat_file_filtered(path, &old_spec).unwrap_or_default();
            let new_asset = cat_file_filtered(path, &new_spec).unwrap_or_default();
            let old_uexp = uasset::sibling_uexp(old_target)
                .and_then(|sp| cat_file_filtered(path, &format!("{old_ref}:{sp}")));
            let new_uexp = uasset::sibling_uexp(file_path)
                .and_then(|sp| cat_file_filtered(path, &format!("{new_ref}:{sp}")));
            return Ok(uasset::derive_filediff(
                uasset_cfg,
                file_path,
                &old_asset,
                old_uexp.as_deref(),
                &new_asset,
                new_uexp.as_deref(),
                old_size.unwrap_or(0),
                new_size.unwrap_or(0),
            ));
        }

        if is_binary(&old_bytes) || is_binary(&new_bytes) {
            return Ok(FileDiff::Binary {
                old_size: old_size.unwrap_or(0),
                new_size: new_size.unwrap_or(0),
                note: None,
            });
        }

        let old_content = diff::normalize_eol(&String::from_utf8_lossy(&old_bytes));
        let new_content = diff::normalize_eol(&String::from_utf8_lossy(&new_bytes));
        let changes = diff::compute_changes(&old_content, &new_content);
        Ok(FileDiff::Text {
            old_content,
            new_content,
            old_size: old_size.unwrap_or(0),
            new_size: new_size.unwrap_or(0),
            derived_label: None,
            ue_version: None,
            changes,
        })
    }

    fn worktree_files(
        &self,
        path: &Path,
        ignore_whitespace: bool,
        on_file: &mut (dyn FnMut(ChangedFile) -> Result<(), GitError> + Send),
    ) -> Result<(), GitError> {
        // Fast path: serve from the per-path cache if the FS watcher hasn't
        // seen any change since last scan AND the `-w` flag matches.
        // Replaying is O(files) memcpy — for a typical worktree this
        // finishes inside one animation frame, eliminating the per-toggle
        // git startup cost. We hold the lock only long enough to clone the
        // Vec so other repos' caches stay accessible.
        let cached: Option<Vec<ChangedFile>> = {
            let guard = self.worktree_caches.lock().unwrap();
            guard.get(path).and_then(|entry| {
                if entry.cache_invalid.load(Ordering::Relaxed) {
                    return None;
                }
                let cache = entry.cache.as_ref()?;
                if cache.ignore_whitespace != ignore_whitespace {
                    return None;
                }
                Some(cache.files.clone())
            })
        };
        if let Some(files) = cached {
            for f in files {
                on_file(f)?;
            }
            return Ok(());
        }
        // Ensure a watcher exists for this path before we run the scan, so
        // any FS changes that land between now and our cache write are
        // recorded. Idempotent — repeated calls for the same path reuse the
        // existing entry. Pre-clear the flag so we can detect events that
        // fire *during* the scan: if it's still false at the end, our
        // accumulated data is consistent with the FS state we just observed
        // and is safe to cache; if it flipped to true mid-scan, something
        // changed under us and we leave it stale.
        let flags = self.ensure_worktree_watcher(path);
        flags.worktree.store(false, Ordering::Relaxed);

        // Single kill slot holding *both* in-flight children. A newer call
        // swaps the slot to cancel us — Drop / clear_worktree_slot_if_ours
        // kills whichever children we left behind.
        let kill_slot: Arc<Mutex<Vec<Child>>> = Arc::new(Mutex::new(Vec::new()));
        {
            let mut guard = self.session.lock().unwrap();
            ensure_session(&mut guard, path)?;
            let session = guard.as_mut().expect("ensure_session populated guard");
            let prev = session.worktree_files_child.replace(kill_slot.clone());
            drop(guard);
            if let Some(prev) = prev {
                for mut c in std::mem::take(&mut *prev.lock().unwrap()) {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
        }

        // Spawn both passes concurrently. Phase 1: tracked changes via
        // `git diff HEAD --name-status -z --find-renames [-w]`. Phase 2:
        // untracked files via `git ls-files --others --exclude-standard -z`.
        // Running them in parallel halves the wall-clock latency that the
        // user feels when toggling into worktree mode (two cold git starts
        // collapse into one).
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

        kill_slot.lock().unwrap().extend([diff_child, ls_child]);

        // Accumulate every emitted file so we can populate the cache once
        // the scan finishes. The user's `on_file` callback also receives
        // each file as before — caching is a side-channel.
        let accumulator: Mutex<Vec<ChangedFile>> = Mutex::new(Vec::new());
        // Two threads, one per stream, share `on_file` through a Mutex so
        // emitted files don't interleave mid-record. Using std::thread::scope
        // means we can borrow `on_file` directly without 'static or Arc.
        let on_file_mutex: Mutex<&mut (dyn FnMut(ChangedFile) -> Result<(), GitError> + Send)> =
            Mutex::new(on_file);

        let (parse_diff, parse_ls) = std::thread::scope(|s| {
            let diff_handle = s.spawn(|| {
                let mut reader = BufReader::new(diff_stdout);
                stream_parse_name_status(&mut reader, &mut |f| {
                    accumulator.lock().unwrap().push(f.clone());
                    on_file_mutex.lock().unwrap()(f)
                })
            });
            let ls_handle = s.spawn(|| {
                let mut reader = BufReader::new(ls_stdout);
                stream_parse_ls_files(&mut reader, &mut |f| {
                    accumulator.lock().unwrap().push(f.clone());
                    on_file_mutex.lock().unwrap()(f)
                })
            });
            (
                diff_handle.join().unwrap_or_else(|_| {
                    Err(GitError::CommandFailed("worktree diff thread panicked".into()))
                }),
                ls_handle.join().unwrap_or_else(|_| {
                    Err(GitError::CommandFailed("worktree ls-files thread panicked".into()))
                }),
            )
        });

        // Reap whichever children are still ours. A newer call may have
        // already drained the slot and killed them — that's fine.
        for mut c in std::mem::take(&mut *kill_slot.lock().unwrap()) {
            let _ = c.wait();
        }
        clear_worktree_slot_if_ours(&self.session, &kill_slot);

        // Surface the diff error first if both failed — the tracked diff is
        // the primary signal; an ls-files failure on top is usually noise.
        let result = parse_diff.and(parse_ls);

        // Cache the successful result. We only cache if BOTH passes ran
        // cleanly AND no FS events fired between the pre-scan flag clear
        // and now — otherwise the accumulated Vec doesn't match the latest
        // FS state and we'd serve stale data on the next toggle.
        if result.is_ok() && !flags.worktree.load(Ordering::Relaxed) {
            let mut guard = self.worktree_caches.lock().unwrap();
            if let Some(entry) = guard.get_mut(path) {
                entry.cache = Some(WorktreeCache {
                    files: accumulator.into_inner().unwrap(),
                    ignore_whitespace,
                });
            }
        }

        result
    }

    fn worktree_file_diff(
        &self,
        path: &Path,
        file_path: &str,
        old_path: Option<&str>,
        status: FileStatus,
        force: bool,
        uasset_cfg: &uasset::Config,
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

        let derive_uasset = uasset_cfg.enabled && uasset::is_uasset_path(file_path);
        let max_side = old_size.unwrap_or(0).max(new_size.unwrap_or(0));
        if !force && !derive_uasset && max_side > LARGE_FILE_BYTES {
            return Ok(FileDiff::TooLarge {
                old_size: old_size.unwrap_or(0),
                new_size: new_size.unwrap_or(0),
            });
        }
        if derive_uasset && !force && max_side > uasset::UASSET_MAX_BYTES {
            return Ok(FileDiff::Binary {
                old_size: old_size.unwrap_or(0),
                new_size: new_size.unwrap_or(0),
                note: Some("Unreal asset header too large to preview.".to_string()),
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

        if derive_uasset {
            // Old side from HEAD through the smudge filter (LFS → real bytes);
            // new side is the working-tree file, already smudged on disk.
            let old_asset = if needs_head {
                cat_file_filtered(path, &head_spec).unwrap_or_default()
            } else {
                Vec::new()
            };
            let old_uexp = uasset::sibling_uexp(head_target)
                .and_then(|sp| cat_file_filtered(path, &format!("HEAD:{sp}")));
            let new_uexp =
                uasset::sibling_uexp(file_path).and_then(|sp| fs::read(path.join(sp)).ok());
            return Ok(uasset::derive_filediff(
                uasset_cfg,
                file_path,
                &old_asset,
                old_uexp.as_deref(),
                &new_bytes,
                new_uexp.as_deref(),
                old_size.unwrap_or(0),
                new_size.unwrap_or(0),
            ));
        }

        if is_binary(&old_bytes) || is_binary(&new_bytes) {
            return Ok(FileDiff::Binary {
                old_size: old_size.unwrap_or(0),
                new_size: new_size.unwrap_or(0),
                note: None,
            });
        }

        let old_content = diff::normalize_eol(&String::from_utf8_lossy(&old_bytes));
        let new_content = diff::normalize_eol(&String::from_utf8_lossy(&new_bytes));
        let changes = diff::compute_changes(&old_content, &new_content);
        Ok(FileDiff::Text {
            old_content,
            new_content,
            old_size: old_size.unwrap_or(0),
            new_size: new_size.unwrap_or(0),
            derived_label: None,
            ue_version: None,
            changes,
        })
    }

    fn changes_file_diff(
        &self,
        path: &Path,
        file_path: &str,
        old_path: Option<&str>,
        status: FileStatus,
        staged: bool,
        force: bool,
    ) -> Result<FileDiff, GitError> {
        validate_path(file_path)?;
        if let Some(p) = old_path {
            validate_path(p)?;
        }

        let needs_old = !matches!(status, FileStatus::Added);
        let needs_new = !matches!(status, FileStatus::Deleted);

        // Old side is always a blob: HEAD for the staged gap, the index for the
        // unstaged gap. Renames diff against the pre-rename path. Read fresh via
        // one-shot cat-file — the session batch snapshots the index at startup,
        // so it would serve stale `:path` content after a stage/unstage/apply.
        let old_target = old_path.unwrap_or(file_path);
        let old_spec = if staged {
            format!("HEAD:{old_target}")
        } else {
            format!(":{old_target}")
        };

        // Submodule gitlink: the working-tree entry is a nested repo directory,
        // not a file. Reading it as bytes fails (EACCES on Windows), so show the
        // commit-pointer change like `git diff` does instead.
        let fs_path = path.join(file_path);
        if fs_path.is_dir() {
            let old_sha = gitlink_sha(path, &old_spec);
            let new_sha = if staged {
                gitlink_sha(path, &format!(":{file_path}"))
            } else {
                // The parent's worktree gitlink is the submodule's checked-out HEAD.
                gitlink_sha(&fs_path, "HEAD")
            };
            let to_text = |s: &Option<String>| {
                s.as_deref()
                    .map(|sha| format!("Subproject commit {sha}\n"))
                    .unwrap_or_default()
            };
            let old_content = to_text(&old_sha);
            let new_content = to_text(&new_sha);
            let changes = diff::compute_changes(&old_content, &new_content);
            return Ok(FileDiff::Text {
                old_content,
                new_content,
                old_size: 0,
                new_size: 0,
                // Not a derived (uasset) view — `derived_label` is wired to the
                // UE-version dropdown in DiffView, so leave it None.
                derived_label: None,
                ue_version: None,
                changes,
            });
        }

        let old_bytes = if needs_old {
            cat_file_oneshot(path, &old_spec).unwrap_or_default()
        } else {
            Vec::new()
        };

        // New side: the index blob (staged gap, fresh cat-file) or the
        // working-tree file on disk. Disk files are unbounded, so guard their
        // size before reading; git blobs are bounded by repo content.
        let (new_bytes, new_size) = if !needs_new {
            (Vec::new(), 0u64)
        } else if staged {
            let b = cat_file_oneshot(path, &format!(":{file_path}")).unwrap_or_default();
            let n = b.len() as u64;
            (b, n)
        } else {
            let disk_size = fs::metadata(&fs_path).map(|m| m.len()).unwrap_or(0);
            if !force && disk_size.max(old_bytes.len() as u64) > LARGE_FILE_BYTES {
                return Ok(FileDiff::TooLarge {
                    old_size: old_bytes.len() as u64,
                    new_size: disk_size,
                });
            }
            match fs::read(&fs_path) {
                Ok(b) => {
                    let n = b.len() as u64;
                    (b, n)
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Vec::new(), 0),
                Err(e) => return Err(GitError::Io(e)),
            }
        };

        let old_size = old_bytes.len() as u64;
        if !force && old_size.max(new_size) > LARGE_FILE_BYTES {
            return Ok(FileDiff::TooLarge { old_size, new_size });
        }
        if is_binary(&old_bytes) || is_binary(&new_bytes) {
            return Ok(FileDiff::Binary {
                old_size,
                new_size,
                note: None,
            });
        }

        let old_content = diff::normalize_eol(&String::from_utf8_lossy(&old_bytes));
        let new_content = diff::normalize_eol(&String::from_utf8_lossy(&new_bytes));
        let changes = diff::compute_changes(&old_content, &new_content);
        Ok(FileDiff::Text {
            old_content,
            new_content,
            old_size,
            new_size,
            derived_label: None,
            ue_version: None,
            changes,
        })
    }

    fn stage(&self, path: &Path, files: Option<&[String]>) -> Result<(), GitError> {
        match files {
            None => {
                self.run(path, &["add", "-A"])?;
            }
            Some(files) => {
                for f in files {
                    validate_path(f)?;
                }
                let mut args: Vec<&str> = vec!["add", "--"];
                args.extend(files.iter().map(String::as_str));
                self.run(path, &args)?;
            }
        }
        Ok(())
    }

    fn unstage(&self, path: &Path, files: Option<&[String]>) -> Result<(), GitError> {
        match files {
            None => {
                self.run(path, &["restore", "--staged", "--", "."])?;
            }
            Some(files) => {
                for f in files {
                    validate_path(f)?;
                }
                let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
                args.extend(files.iter().map(String::as_str));
                self.run(path, &args)?;
            }
        }
        Ok(())
    }

    fn commit(
        &self,
        path: &Path,
        subject: &str,
        body: &str,
        amend: bool,
        signoff: bool,
        coauthors: &[String],
    ) -> Result<(), GitError> {
        if subject.trim().is_empty() {
            return Err(GitError::CommandFailed("commit subject is empty".into()));
        }
        // Owned trailer strings, borrowed into `args` below.
        let trailers: Vec<String> = coauthors
            .iter()
            .filter(|c| !c.trim().is_empty())
            .map(|c| format!("Co-authored-by: {}", c.trim()))
            .collect();

        let mut args: Vec<&str> = vec!["commit"];
        if amend {
            args.push("--amend");
        }
        if signoff {
            args.push("-s");
        }
        // `-m subject -m body` → git joins them with a blank line, matching the
        // subject/body convention. Values are message text (not flags), so a
        // leading dash in the subject is safe.
        args.push("-m");
        args.push(subject);
        if !body.trim().is_empty() {
            args.push("-m");
            args.push(body);
        }
        for t in &trailers {
            args.push("--trailer");
            args.push(t);
        }
        self.run(path, &args)?;
        Ok(())
    }

    fn head_commit_message(&self, path: &Path) -> Result<String, GitError> {
        let out = self.run(path, &["log", "-1", "--format=%B"])?;
        Ok(String::from_utf8_lossy(&out).trim_end().to_string())
    }

    fn file_hunks(&self, path: &Path, file_path: &str, staged: bool) -> Result<Vec<Hunk>, GitError> {
        validate_path(file_path)?;
        let out = self.run(path, &diff_args(staged, file_path))?;
        Ok(parse_hunks(&String::from_utf8_lossy(&out)))
    }

    fn apply_hunks(
        &self,
        path: &Path,
        file_path: &str,
        staged: bool,
        hunks: &[u32],
    ) -> Result<(), GitError> {
        validate_path(file_path)?;
        if hunks.is_empty() {
            return Ok(());
        }
        // Re-diff now so the patch matches the *current* file state and indices
        // line up with what the user clicked (drift guard below).
        let out = self.run(path, &diff_args(staged, file_path))?;
        let text = String::from_utf8_lossy(&out);
        let (header, blocks) = split_diff(&text);
        if header.is_empty() || blocks.is_empty() {
            return Err(GitError::CommandFailed(
                "no diff to apply (file may have changed)".into(),
            ));
        }
        let mut patch = header;
        for &i in hunks {
            let block = blocks.get(i as usize).ok_or_else(|| {
                GitError::CommandFailed("file changed since hunks were listed; refresh".into())
            })?;
            patch.push_str(block);
        }
        // Apply to the index: forward stages the hunk, reverse unstages it.
        let mut args = vec!["apply", "--cached"];
        if staged {
            args.push("--reverse");
        }
        self.run_stdin(path, &args, patch.as_bytes())?;
        Ok(())
    }

    fn create_branch(
        &self,
        path: &Path,
        name: &str,
        start_point: Option<&str>,
        checkout: bool,
    ) -> Result<(), GitError> {
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

    fn checkout(&self, path: &Path, ref_name: &str) -> Result<(), GitError> {
        validate_ref(ref_name)?;
        self.run(path, &["checkout", ref_name])?;
        self.drop_session();
        Ok(())
    }

    fn rename_branch(&self, path: &Path, old: &str, new: &str) -> Result<(), GitError> {
        validate_ref(old)?;
        validate_ref(new)?;
        self.run(path, &["branch", "-m", old, new])?;
        Ok(())
    }

    fn delete_branch(&self, path: &Path, name: &str, force: bool) -> Result<(), GitError> {
        validate_ref(name)?;
        let flag = if force { "-D" } else { "-d" };
        self.run(path, &["branch", flag, name])?;
        Ok(())
    }

    fn set_upstream(&self, path: &Path, branch: &str, upstream: &str) -> Result<(), GitError> {
        validate_ref(branch)?;
        validate_ref(upstream)?;
        let arg = format!("--set-upstream-to={upstream}");
        self.run(path, &["branch", &arg, branch])?;
        Ok(())
    }

    fn create_tag(&self, path: &Path, name: &str, target: &str) -> Result<(), GitError> {
        validate_ref(name)?;
        validate_ref(target)?;
        self.run(path, &["tag", name, target])?;
        Ok(())
    }

    fn reset(&self, path: &Path, target: &str, mode: &str) -> Result<(), GitError> {
        validate_ref(target)?;
        let flag = match mode {
            "soft" => "--soft",
            "hard" => "--hard",
            _ => "--mixed",
        };
        self.run(path, &["reset", flag, target])?;
        self.drop_session();
        Ok(())
    }

    fn cherry_pick(&self, path: &Path, target: &str) -> Result<(), GitError> {
        validate_ref(target)?;
        self.run(path, &["cherry-pick", target])?;
        self.drop_session();
        Ok(())
    }

    fn revert(&self, path: &Path, target: &str) -> Result<(), GitError> {
        validate_ref(target)?;
        self.run(path, &["revert", "--no-edit", target])?;
        self.drop_session();
        Ok(())
    }

    fn rebase(&self, path: &Path, onto: &str) -> Result<(), GitError> {
        validate_ref(onto)?;
        self.run(path, &["rebase", onto])?;
        self.drop_session();
        Ok(())
    }

    fn list_repo_files(&self, path: &Path) -> Result<Vec<String>, GitError> {
        // Fast path: clone the cached Vec under the map lock and return.
        // Same FS-watcher mechanism as worktree_files — any change in the
        // repo (including .git/) flips the flag.
        let cached: Option<Vec<String>> = {
            let guard = self.worktree_caches.lock().unwrap();
            guard.get(path).and_then(|entry| {
                if entry.repo_files_invalid.load(Ordering::Relaxed) {
                    return None;
                }
                entry.repo_files.clone()
            })
        };
        if let Some(files) = cached {
            return Ok(files);
        }
        // Cache miss: register/reuse the watcher and pre-clear the flag so
        // events fired during the scan are observed at the end.
        let flags = self.ensure_worktree_watcher(path);
        flags.repo_files.store(false, Ordering::Relaxed);
        let stdout = self.run(path, &["ls-files", "-s", "-z"])?;
        let files = parse_ls_files_stage(&stdout)?;
        if !flags.repo_files.load(Ordering::Relaxed) {
            let mut guard = self.worktree_caches.lock().unwrap();
            if let Some(entry) = guard.get_mut(path) {
                entry.repo_files = Some(files.clone());
            }
        }
        Ok(files)
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

/// Spawn a recursive filesystem watcher rooted at the repo. Each event
/// flips *every* invalidation flag to `true` so the next cached call
/// refuses the cached result and recomputes. We intentionally *don't* try
/// to filter `.git/` traffic — index/HEAD/refs updates change what
/// `git diff HEAD` (and `git ls-files`) would return, so they're load-
/// bearing for cache correctness. Spurious busy events just cause the
/// next call to recompute, which is what happened pre-cache anyway.
fn spawn_worktree_watcher(
    repo: &Path,
    invalidation_flags: Vec<Arc<AtomicBool>>,
) -> Result<RecommendedWatcher, notify::Error> {
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            for flag in &invalidation_flags {
                flag.store(true, Ordering::Relaxed);
            }
        }
    })?;
    watcher.watch(repo, RecursiveMode::Recursive)?;
    Ok(watcher)
}

/// References to the invalidation flags for a single watched path. Both
/// caches share the same watcher but each tracks its own staleness so a
/// concurrent scan in one cache can pre-clear its flag without disturbing
/// the other.
struct WatcherFlags {
    worktree: Arc<AtomicBool>,
    repo_files: Arc<AtomicBool>,
}

impl GitCli {
    /// Get-or-create the cache entry for `path` and return references to
    /// its invalidation flags. Lazily spawns the FS watcher on first call;
    /// subsequent calls reuse the existing one. The returned Arcs let the
    /// scan body track "did anything change while we were scanning?"
    /// without re-locking the map.
    fn ensure_worktree_watcher(&self, path: &Path) -> WatcherFlags {
        let mut guard = self.worktree_caches.lock().unwrap();
        let entry = guard.entry(path.to_path_buf()).or_insert_with(|| {
            let cache_invalid = Arc::new(AtomicBool::new(true));
            let repo_files_invalid = Arc::new(AtomicBool::new(true));
            let watcher = spawn_worktree_watcher(
                path,
                vec![cache_invalid.clone(), repo_files_invalid.clone()],
            )
            .ok();
            WorktreeCacheEntry {
                cache: None,
                cache_invalid,
                repo_files: None,
                repo_files_invalid,
                _watcher: watcher,
            }
        });
        WatcherFlags {
            worktree: entry.cache_invalid.clone(),
            repo_files: entry.repo_files_invalid.clone(),
        }
    }
}

fn clear_worktree_slot_if_ours(
    session: &Mutex<Option<Session>>,
    kill_slot: &Arc<Mutex<Vec<Child>>>,
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

    // Field separator \x1f, record separator \0 — mirrors COMMIT_LOG_FORMAT.
    fn log_record(
        sha: &str,
        short: &str,
        parents: &str,
        author: &str,
        time: &str,
        subject: &str,
        refs: &str,
    ) -> String {
        format!("{sha}\u{1f}{short}\u{1f}{parents}\u{1f}{author}\u{1f}{time}\u{1f}{subject}\u{1f}{refs}\0")
    }

    #[test]
    fn parse_commit_log_basic() {
        let input = format!(
            "{}{}",
            log_record(
                "a1b2c3d", "a1b2c3d", "f00ba12 c0ffee0", "Jane", "1700000000",
                "merge: feature into main", "HEAD -> main, origin/main",
            ),
            log_record("f00ba12", "f00ba12", "", "Bob", "1699990000", "init", ""),
        );
        let out = parse_commit_log(&input);
        assert_eq!(out.len(), 2);

        assert_eq!(out[0].sha, "a1b2c3d");
        assert_eq!(out[0].short_sha, "a1b2c3d");
        assert_eq!(out[0].parents, vec!["f00ba12", "c0ffee0"]);
        assert_eq!(out[0].author, "Jane");
        assert_eq!(out[0].time, 1700000000);
        assert_eq!(out[0].summary, "merge: feature into main");
        assert_eq!(out[0].refs, vec!["HEAD -> main", "origin/main"]);

        // Root commit: no parents, no refs.
        assert!(out[1].parents.is_empty());
        assert!(out[1].refs.is_empty());
        assert_eq!(out[1].summary, "init");
    }

    #[test]
    fn parse_commit_log_empty() {
        assert!(parse_commit_log("").is_empty());
    }

    #[test]
    fn parse_commit_log_subject_with_separators_in_text() {
        // A subject containing commas must not be mistaken for ref delimiters,
        // and an unparsable time degrades to 0 rather than dropping the commit.
        let input = log_record(
            "deadbee", "deadbee", "abc1234", "A, B & C", "notanumber",
            "fix: a, b, c", "tag: v1.0",
        );
        let out = parse_commit_log(&input);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].author, "A, B & C");
        assert_eq!(out[0].time, 0);
        assert_eq!(out[0].summary, "fix: a, b, c");
        assert_eq!(out[0].refs, vec!["tag: v1.0"]);
    }

    #[test]
    fn parse_status_basic() {
        // Mirrors real `git status --porcelain=v2 --branch -z`: two headers, a
        // staged add (A.), a staged rename (R., two NUL fields), a staged +
        // unstaged modify (MM), and an untracked file (?).
        let input = [
            "# branch.oid 607d018f8459fcf20ee3bf5fb99d0c7be3394f06",
            "# branch.head master",
            "1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 133064328add2ba3a254ca3d562f604627daf2fe added.txt",
            "2 R. N... 100644 100644 100644 3367afdbbf91e638efe983616377c60477cc6612 3367afdbbf91e638efe983616377c60477cc6612 R100 renamed.txt",
            "torename.txt",
            "1 MM N... 100644 100644 100644 de980441c3ab03a8c07dda1ad27b8a11f39deb1e 7be73ce3c1b1cdaea86e8168dfee8575175953bf tracked.txt",
            "? untracked.txt",
        ]
        .join("\0")
            + "\0";
        let st = parse_status(&input);

        assert_eq!(st.branch.as_deref(), Some("master"));
        assert_eq!(st.upstream, None);
        assert_eq!(st.ahead, 0);
        assert_eq!(st.behind, 0);
        assert_eq!(st.entries.len(), 4);

        assert_eq!(st.entries[0].path, "added.txt");
        assert_eq!(st.entries[0].index_status, "A");
        assert_eq!(st.entries[0].worktree_status, ".");
        assert_eq!(st.entries[0].orig_path, None);

        // Rename carries the original path from the second NUL field.
        assert_eq!(st.entries[1].path, "renamed.txt");
        assert_eq!(st.entries[1].orig_path.as_deref(), Some("torename.txt"));
        assert_eq!(st.entries[1].index_status, "R");
        assert_eq!(st.entries[1].worktree_status, ".");

        // A file modified in both index and worktree shows on both sides.
        assert_eq!(st.entries[2].path, "tracked.txt");
        assert_eq!(st.entries[2].index_status, "M");
        assert_eq!(st.entries[2].worktree_status, "M");

        assert_eq!(st.entries[3].path, "untracked.txt");
        assert_eq!(st.entries[3].index_status, "?");
        assert_eq!(st.entries[3].worktree_status, "?");
    }

    #[test]
    fn parse_status_branch_ab() {
        let input = ["# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -3"]
            .join("\0")
            + "\0";
        let st = parse_status(&input);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!(st.ahead, 2);
        assert_eq!(st.behind, 3);
        assert!(st.entries.is_empty());
    }

    #[test]
    fn parse_status_detached_and_empty() {
        let st = parse_status("# branch.head (detached)\0");
        assert_eq!(st.branch, None);
        assert!(parse_status("").entries.is_empty());
    }

    #[test]
    fn parse_status_path_with_spaces() {
        // The path is the trailing remainder, so embedded spaces survive.
        let input = "1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb my file.txt\0";
        let st = parse_status(input);
        assert_eq!(st.entries.len(), 1);
        assert_eq!(st.entries[0].path, "my file.txt");
        assert_eq!(st.entries[0].index_status, ".");
        assert_eq!(st.entries[0].worktree_status, "M");
    }

    const SAMPLE_DIFF: &str = "diff --git a/f.txt b/f.txt\n\
index 111..222 100644\n\
--- a/f.txt\n\
+++ b/f.txt\n\
@@ -1,3 +1,3 @@\n \
a\n\
-b\n\
+B\n \
c\n\
@@ -10,2 +10,3 @@ fn foo()\n \
x\n\
+y\n \
z\n";

    #[test]
    fn split_diff_separates_header_and_hunks() {
        let (header, hunks) = split_diff(SAMPLE_DIFF);
        assert!(header.starts_with("diff --git a/f.txt b/f.txt\n"));
        assert!(header.ends_with("+++ b/f.txt\n"));
        assert!(!header.contains("@@"));
        assert_eq!(hunks.len(), 2);
        assert!(hunks[0].starts_with("@@ -1,3 +1,3 @@\n"));
        assert!(hunks[1].starts_with("@@ -10,2 +10,3 @@ fn foo()\n"));
        // A sub-patch of header + one hunk reassembles byte-for-byte.
        assert_eq!(format!("{header}{}", hunks[1]).contains("+y\n"), true);
    }

    #[test]
    fn parse_hunks_counts_added_removed() {
        let hunks = parse_hunks(SAMPLE_DIFF);
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0].header, "@@ -1,3 +1,3 @@");
        assert_eq!((hunks[0].added, hunks[0].removed), (1, 1));
        assert_eq!(hunks[1].header, "@@ -10,2 +10,3 @@ fn foo()");
        assert_eq!((hunks[1].added, hunks[1].removed), (1, 0));
    }

    #[test]
    fn parse_hunks_empty_diff() {
        assert!(parse_hunks("").is_empty());
        // Binary diffs carry no @@ hunks.
        let bin = "diff --git a/x.bin b/x.bin\nBinary files a/x.bin and b/x.bin differ\n";
        assert!(parse_hunks(bin).is_empty());
    }
}
