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
    Branch, BranchKind, ChangedFile, Commit, Containment, ContainmentDetail, ConflictVersions,
    DiffMode, FileDiff, FileStatus, GitError, GitLayer, Hunk, RepoStatus, Stash, StatusEntry,
    SubmoduleInfo,
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
    /// Serializes index/ref-mutating git invocations. Commands run off the main
    /// thread (async) now, so writes the main thread used to serialize implicitly
    /// can otherwise overlap and collide on `.git/index.lock`. Read-only commands
    /// (log/diff/blame/status) don't take this lock, so the UI stays responsive.
    write_lock: Mutex<()>,
}

struct Session {
    repo_path: PathBuf,
    batch_check: BatchProcess,
    batch: BatchProcess,
    merge_base_cache: HashMap<(String, String), String>,
    /// The currently in-flight `git diff` child for streaming diff_files.
    /// Replacing this slot is how we cancel an outstanding stream.
    diff_files_child: Option<Arc<Mutex<Option<Child>>>>,
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
    /// Cache for `list_repo_files` — the blame picker's file union — keyed
    /// on the FS watcher. Set stale by the watcher whenever anything inside
    /// the watched path (or its `.git/`) changes.
    repo_files: Option<Vec<String>>,
    repo_files_invalid: Arc<AtomicBool>,
    /// FS watcher. Held alive by the HashMap entry; dropped when the entry
    /// is evicted. The field name is `_watcher` because it's never read
    /// directly — its existence is what keeps the underlying ReadDirectory
    /// loop running.
    _watcher: Option<RecommendedWatcher>,
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
            write_lock: Mutex::new(()),
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

    /// Like `run`, but for network commands (fetch/pull/push): disables git's
    /// terminal credential prompt so a GUI launch never hangs waiting on stdin.
    /// The user's credential helper (e.g. Git Credential Manager) still supplies
    /// cached creds or pops its own dialog; otherwise the command fails fast.
    fn run_network(&self, path: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
        let output = git_command()
            .arg("-C")
            .arg(path)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()?;
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

/// Whether `p` exists in HEAD's tree (`git cat-file -e HEAD:p`, exit 0). False
/// on an unborn branch or any error — callers treat that as a new file.
fn path_in_head(repo: &Path, p: &str) -> bool {
    git_command()
        .arg("-C")
        .arg(repo)
        .args(["cat-file", "-e", &format!("HEAD:{p}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
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

/// Parse `git cherry <upstream> <head>` output into the SHAs whose patch is
/// already present upstream — lines starting with `- ` (a `+ ` line means no
/// equivalent upstream, handled separately by the rev-list `--not` set). Split
/// out for unit testing.
fn parse_cherry_equivalent(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| l.strip_prefix("- "))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Parse `git rev-list --left-right --count A...B` ("<left>\t<right>") into
/// `(left, right)`. With `A = target`, `B = source`: left = behind, right =
/// ahead. Split out for unit testing.
fn parse_ahead_behind(text: &str) -> (i64, i64) {
    let mut it = text.split_whitespace();
    let left = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let right = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (left, right)
}

/// Parse `git rev-list`/`for-each-ref` newline output into trimmed, non-empty
/// lines.
fn nonempty_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
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
            // Body = everything after the `@@` header line. The header carries
            // line numbers that shift as the file changes, so the id hashes only
            // the body (the +/-/context lines), keeping it stable across edits.
            let body = b.splitn(2, '\n').nth(1).unwrap_or("");
            let mut added = 0;
            let mut removed = 0;
            for l in body.lines() {
                match l.as_bytes().first() {
                    Some(b'+') => added += 1,
                    Some(b'-') => removed += 1,
                    _ => {}
                }
            }
            Hunk {
                id: hunk_id(body),
                header,
                added,
                removed,
            }
        })
        .collect()
}

/// Content signature of a hunk body — a hash of its +/-/context lines. Stable
/// for the same content within a process, enough to track a hunk's changelist
/// assignment across re-diffs (only compared within one session).
fn hunk_id(body: &str) -> String {
    use std::hash::Hasher;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    h.write(body.as_bytes());
    format!("{:016x}", h.finish())
}

/// Parse `git stash list --format=%gd%x1f%s` output: one stash per line, the
/// `stash@{N}` selector and the subject separated by \x1f.
fn parse_stash_list(text: &str) -> Vec<Stash> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(2, '\x1f');
            let gd = parts.next()?;
            let message = parts.next().unwrap_or("").to_string();
            let index = gd
                .strip_prefix("stash@{")?
                .strip_suffix('}')?
                .parse::<u32>()
                .ok()?;
            Some(Stash { index, message })
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

/// Path to this repo's changelist store, inside the resolved git dir (handles
/// worktrees / submodules where `.git` may be a file).
fn changelists_file(cli: &GitCli, path: &Path) -> Result<PathBuf, GitError> {
    let out = cli.run(path, &["rev-parse", "--git-dir"])?;
    let gitdir = path.join(String::from_utf8_lossy(&out).trim());
    Ok(gitdir.join("riff-changelists.json"))
}

fn is_binary(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(BINARY_SNIFF_BYTES)];
    head.contains(&0)
}

/// Max bytes (per side) we'll inline as base64 for an image preview. Above this
/// the file falls back to the size-only binary view.
const IMAGE_MAX_BYTES: u64 = 20_000_000;

/// Browser-renderable raster image, by extension. SVG is text (diffed normally);
/// formats CodeMirror/`<img>` can't show (tga, dds, psd) are left as binary.
fn is_image_path(p: &str) -> bool {
    let lower = p.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif"]
        .iter()
        .any(|e| lower.ends_with(e))
}

fn image_mime(p: &str) -> &'static str {
    let lower = p.to_ascii_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else if lower.ends_with(".ico") {
        "image/x-icon"
    } else if lower.ends_with(".avif") {
        "image/avif"
    } else {
        "application/octet-stream"
    }
}

/// Standard base64 (RFC 4648) encode — small enough to vendor instead of taking
/// a crate dependency. Used to inline image bytes for the data-URL preview.
fn base64_encode(bytes: &[u8]) -> String {
    const TBL: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = ((chunk[0] as u32) << 16)
            | ((*chunk.get(1).unwrap_or(&0) as u32) << 8)
            | (*chunk.get(2).unwrap_or(&0) as u32);
        out.push(TBL[((n >> 18) & 63) as usize] as char);
        out.push(TBL[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TBL[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TBL[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
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

/// The submodule gitlink SHA at `tree_ish:file_path`, or None when the path
/// isn't a gitlink (mode 160000) there. Unlike `gitlink_sha` (a bare rev-parse,
/// which also resolves regular blobs), this confirms the entry is a submodule
/// pointer via `ls-tree`, so a normal file never false-matches.
fn ls_tree_gitlink(repo: &Path, tree_ish: &str, file_path: &str) -> Option<String> {
    let out = git_command()
        .arg("-C")
        .arg(repo)
        .args(["ls-tree", tree_ish, "--", file_path])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_gitlink_sha(&out.stdout).ok().flatten()
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
        // `--no-optional-locks` so a background-refresh status never grabs
        // `index.lock` and races a concurrent write (stage/commit/checkout).
        let stdout = self.run(
            path,
            &["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z"],
        )?;
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

        // A submodule gitlink at either side: `<ref>:<path>` points at the
        // submodule's commit oid, which isn't in this repo's object store, so
        // both sides come back Missing and a normal diff would render blank.
        // Show the pointer move like `git show` — "Subproject commit <old>" →
        // "<new>". Gated on both-missing so regular files skip the ls-tree.
        if old_size.is_none() && new_size.is_none() {
            let old_link = ls_tree_gitlink(path, &old_ref, old_target);
            let new_link = ls_tree_gitlink(path, &new_ref, file_path);
            if old_link.is_some() || new_link.is_some() {
                let to_text = |s: &Option<String>| {
                    s.as_deref()
                        .map(|sha| format!("Subproject commit {sha}\n"))
                        .unwrap_or_default()
                };
                let old_content = to_text(&old_link);
                let new_content = to_text(&new_link);
                let changes = diff::compute_changes(&old_content, &new_content);
                return Ok(FileDiff::Text {
                    old_content,
                    new_content,
                    old_size: 0,
                    new_size: 0,
                    derived_label: None,
                    ue_version: None,
                    changes,
                });
            }
        }

        // Unreal asset / image previews bypass the raw too-large gate (each
        // keeps its own cap): the .uasset header is small, and images render
        // their own way regardless of byte count.
        let derive_uasset = uasset_cfg.enabled && uasset::is_uasset_path(file_path);
        let is_image = is_image_path(file_path);
        let max_side = old_size.unwrap_or(0).max(new_size.unwrap_or(0));
        if !force && !derive_uasset && !is_image && max_side > LARGE_FILE_BYTES {
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

        if is_image {
            // Smudge-filter both sides so LFS-tracked images resolve to real
            // bytes, then inline as base64 for the <img> preview.
            let old_img = if old_size.is_some() {
                cat_file_filtered(path, &old_spec).unwrap_or_default()
            } else {
                Vec::new()
            };
            let new_img = if new_size.is_some() {
                cat_file_filtered(path, &new_spec).unwrap_or_default()
            } else {
                Vec::new()
            };
            let os = old_img.len() as u64;
            let ns = new_img.len() as u64;
            if !force && os.max(ns) > IMAGE_MAX_BYTES {
                return Ok(FileDiff::Binary {
                    old_size: os,
                    new_size: ns,
                    note: Some("Image too large to preview.".to_string()),
                });
            }
            return Ok(FileDiff::Image {
                old_b64: base64_encode(&old_img),
                new_b64: base64_encode(&new_img),
                mime: image_mime(file_path).to_string(),
                old_size: os,
                new_size: ns,
            });
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
        uasset_cfg: &uasset::Config,
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

        // Unreal asset → property view. Read both sides through the smudge
        // filter so LFS pointers resolve to real bytes (the new side, when it's
        // the working-tree file, is already smudged on disk). Sizes come from
        // the filtered content so the too-large guard sees the real asset, not
        // an LFS pointer.
        if uasset_cfg.enabled && uasset::is_uasset_path(file_path) {
            let old_asset = if needs_old {
                cat_file_filtered(path, &old_spec).unwrap_or_default()
            } else {
                Vec::new()
            };
            let new_asset = if !needs_new {
                Vec::new()
            } else if staged {
                cat_file_filtered(path, &format!(":{file_path}")).unwrap_or_default()
            } else {
                fs::read(&fs_path).unwrap_or_default()
            };
            let old_size = old_asset.len() as u64;
            let new_size = new_asset.len() as u64;
            if !force && old_size.max(new_size) > uasset::UASSET_MAX_BYTES {
                return Ok(FileDiff::Binary {
                    old_size,
                    new_size,
                    note: Some("Unreal asset too large to preview.".into()),
                });
            }
            let old_uexp = if needs_old {
                uasset::sibling_uexp(old_target).and_then(|sp| {
                    let spec = if staged {
                        format!("HEAD:{sp}")
                    } else {
                        format!(":{sp}")
                    };
                    cat_file_filtered(path, &spec)
                })
            } else {
                None
            };
            let new_uexp = if !needs_new {
                None
            } else if staged {
                uasset::sibling_uexp(file_path)
                    .and_then(|sp| cat_file_filtered(path, &format!(":{sp}")))
            } else {
                uasset::sibling_uexp(file_path).and_then(|sp| fs::read(path.join(sp)).ok())
            };
            return Ok(uasset::derive_filediff(
                uasset_cfg,
                file_path,
                &old_asset,
                old_uexp.as_deref(),
                &new_asset,
                new_uexp.as_deref(),
                old_size,
                new_size,
            ));
        }

        if is_image_path(file_path) {
            // Smudge-filter the blob sides (LFS → real bytes); the working-tree
            // side is already smudged on disk. Inline as base64 for <img>.
            let old_img = if needs_old {
                cat_file_filtered(path, &old_spec).unwrap_or_default()
            } else {
                Vec::new()
            };
            let new_img = if !needs_new {
                Vec::new()
            } else if staged {
                cat_file_filtered(path, &format!(":{file_path}")).unwrap_or_default()
            } else {
                fs::read(&fs_path).unwrap_or_default()
            };
            let os = old_img.len() as u64;
            let ns = new_img.len() as u64;
            if !force && os.max(ns) > IMAGE_MAX_BYTES {
                return Ok(FileDiff::Binary {
                    old_size: os,
                    new_size: ns,
                    note: Some("Image too large to preview.".to_string()),
                });
            }
            return Ok(FileDiff::Image {
                old_b64: base64_encode(&old_img),
                new_b64: base64_encode(&new_img),
                mime: image_mime(file_path).to_string(),
                old_size: os,
                new_size: ns,
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
        let _w = self.write_lock.lock().unwrap();
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
        let _w = self.write_lock.lock().unwrap();
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

    fn discard_paths(&self, path: &Path, paths: &[String]) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        for p in paths {
            validate_path(p)?;
        }
        for p in paths {
            if path_in_head(path, p) {
                // Tracked in HEAD → revert index + worktree to HEAD.
                self.run(
                    path,
                    &["restore", "--source=HEAD", "--staged", "--worktree", "--", p],
                )?;
            } else {
                // New (staged-added or untracked) → drop from the index (no-op
                // if it isn't staged), then remove the untracked working copy.
                let _ = self.run(path, &["rm", "-f", "--cached", "--ignore-unmatch", "--", p]);
                self.run(path, &["clean", "-f", "--", p])?;
            }
        }
        // Index/worktree moved out from under the cat-file batch — respawn it.
        self.drop_session();
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
        let _w = self.write_lock.lock().unwrap();
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

    fn commit_paths(
        &self,
        path: &Path,
        paths: &[String],
        subject: &str,
        body: &str,
        signoff: bool,
        coauthors: &[String],
    ) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        if subject.trim().is_empty() {
            return Err(GitError::CommandFailed("commit subject is empty".into()));
        }
        if paths.is_empty() {
            return Err(GitError::CommandFailed("no files to commit".into()));
        }
        for p in paths {
            validate_path(p)?;
        }
        // Stage the listed paths so untracked files become committable; `git
        // add` also records deletions.
        let mut add_args: Vec<&str> = vec!["add", "--"];
        add_args.extend(paths.iter().map(String::as_str));
        self.run(path, &add_args)?;

        let trailers: Vec<String> = coauthors
            .iter()
            .filter(|c| !c.trim().is_empty())
            .map(|c| format!("Co-authored-by: {}", c.trim()))
            .collect();
        // `git commit -- <paths>` does a path-limited commit (working-tree
        // content of just those paths), leaving everything else untouched.
        let mut args: Vec<&str> = vec!["commit"];
        if signoff {
            args.push("-s");
        }
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
        args.push("--");
        args.extend(paths.iter().map(String::as_str));
        self.run(path, &args)?;
        self.drop_session();
        Ok(())
    }

    fn load_changelists(&self, path: &Path) -> Result<String, GitError> {
        Ok(fs::read_to_string(changelists_file(self, path)?).unwrap_or_default())
    }

    fn save_changelists(&self, path: &Path, data: &str) -> Result<(), GitError> {
        fs::write(changelists_file(self, path)?, data).map_err(GitError::Io)
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
        let _w = self.write_lock.lock().unwrap();
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

    fn discard_hunks(&self, path: &Path, file_path: &str, hunks: &[u32]) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_path(file_path)?;
        if hunks.is_empty() {
            return Ok(());
        }
        // Re-diff the *unstaged* changes now so the patch matches the current
        // worktree and indices line up with what the user clicked.
        let out = self.run(path, &diff_args(false, file_path))?;
        let text = String::from_utf8_lossy(&out);
        let (header, blocks) = split_diff(&text);
        if header.is_empty() || blocks.is_empty() {
            return Err(GitError::CommandFailed(
                "no diff to discard (file may have changed)".into(),
            ));
        }
        let mut patch = header;
        for &i in hunks {
            let block = blocks.get(i as usize).ok_or_else(|| {
                GitError::CommandFailed("file changed since hunks were listed; refresh".into())
            })?;
            patch.push_str(block);
        }
        // Reverse-apply to the worktree only (no --cached): drops the selected
        // unstaged change, reverting that region to the index.
        self.run_stdin(path, &["apply", "--reverse"], patch.as_bytes())?;
        Ok(())
    }

    fn create_branch(
        &self,
        path: &Path,
        name: &str,
        start_point: Option<&str>,
        checkout: bool,
    ) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
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
        let _w = self.write_lock.lock().unwrap();
        validate_ref(ref_name)?;
        self.run(path, &["checkout", ref_name])?;
        self.drop_session();
        Ok(())
    }

    fn force_checkout(&self, path: &Path, ref_name: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(ref_name)?;
        self.run(path, &["checkout", "-f", ref_name])?;
        self.drop_session();
        Ok(())
    }

    fn fast_forward(&self, path: &Path, ref_name: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(ref_name)?;
        self.run(path, &["merge", "--ff-only", ref_name])?;
        self.drop_session();
        Ok(())
    }

    fn stash_checkout(&self, path: &Path, ref_name: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(ref_name)?;
        // Stash everything (tracked + untracked) so the tree is clean to switch.
        let msg = format!("riff: auto-stash before checkout {ref_name}");
        self.run(path, &["stash", "push", "--include-untracked", "-m", &msg])?;
        // Switch. If it fails, restore the stash before surfacing the error so
        // the user's changes aren't left stranded on the stash stack.
        if let Err(e) = self.run(path, &["checkout", ref_name]) {
            let _ = self.run(path, &["stash", "pop"]);
            self.drop_session();
            return Err(e);
        }
        // Reapply. On conflict `git stash pop` exits non-zero but keeps the
        // stash and writes conflict markers — propagate so the UI can report it.
        let reapply = self.run(path, &["stash", "pop"]);
        self.drop_session();
        reapply.map(|_| ())
    }

    fn conflict_versions(
        &self,
        path: &Path,
        file_path: &str,
    ) -> Result<ConflictVersions, GitError> {
        validate_path(file_path)?;
        // Index stages: 1 = merge base, 2 = ours (HEAD), 3 = theirs. Any stage
        // can be absent (e.g. add/add has no base, delete/modify drops a side);
        // cat-file fails for those and we surface an empty string.
        let stage = |n: u8| {
            cat_file_oneshot(path, &format!(":{n}:{file_path}"))
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .unwrap_or_default()
        };
        // The working copy carries git's <<<<<<< markers — the editor's starting
        // point. Read raw so binary detection sees real bytes.
        let merged_bytes = fs::read(path.join(file_path)).unwrap_or_default();
        Ok(ConflictVersions {
            base: stage(1),
            ours: stage(2),
            theirs: stage(3),
            binary: is_binary(&merged_bytes),
            merged: String::from_utf8_lossy(&merged_bytes).into_owned(),
        })
    }

    fn resolve_conflict(
        &self,
        path: &Path,
        file_path: &str,
        content: &str,
    ) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_path(file_path)?;
        fs::write(path.join(file_path), content).map_err(GitError::Io)?;
        // Staging a path with no conflict markers marks it resolved for the op.
        self.run(path, &["add", "--", file_path])?;
        self.drop_session();
        Ok(())
    }

    fn checkout_conflict_side(
        &self,
        path: &Path,
        file_path: &str,
        side: &str,
    ) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_path(file_path)?;
        let flag = match side {
            "ours" => "--ours",
            "theirs" => "--theirs",
            _ => return Err(GitError::CommandFailed("invalid conflict side".into())),
        };
        self.run(path, &["checkout", flag, "--", file_path])?;
        self.run(path, &["add", "--", file_path])?;
        self.drop_session();
        Ok(())
    }

    fn rename_branch(&self, path: &Path, old: &str, new: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(old)?;
        validate_ref(new)?;
        self.run(path, &["branch", "-m", old, new])?;
        Ok(())
    }

    fn delete_branch(&self, path: &Path, name: &str, force: bool) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(name)?;
        let flag = if force { "-D" } else { "-d" };
        self.run(path, &["branch", flag, name])?;
        Ok(())
    }

    fn set_upstream(&self, path: &Path, branch: &str, upstream: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(branch)?;
        validate_ref(upstream)?;
        let arg = format!("--set-upstream-to={upstream}");
        self.run(path, &["branch", &arg, branch])?;
        Ok(())
    }

    fn create_tag(&self, path: &Path, name: &str, target: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(name)?;
        validate_ref(target)?;
        self.run(path, &["tag", name, target])?;
        Ok(())
    }

    fn reset(&self, path: &Path, target: &str, mode: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
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
        let _w = self.write_lock.lock().unwrap();
        validate_ref(target)?;
        self.run(path, &["cherry-pick", target])?;
        self.drop_session();
        Ok(())
    }

    fn revert(&self, path: &Path, target: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(target)?;
        self.run(path, &["revert", "--no-edit", target])?;
        self.drop_session();
        Ok(())
    }

    fn rebase(&self, path: &Path, onto: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(onto)?;
        self.run(path, &["rebase", onto])?;
        self.drop_session();
        Ok(())
    }

    fn fetch(&self, path: &Path) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        self.run_network(path, &["fetch", "--all", "--prune"])?;
        // Newly-fetched objects/refs won't be visible to the cached batch.
        self.drop_session();
        Ok(())
    }

    fn pull(&self, path: &Path, rebase: bool) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        let mut args = vec!["pull"];
        if rebase {
            args.push("--rebase");
        }
        self.run_network(path, &args)?;
        self.drop_session();
        Ok(())
    }

    fn push(
        &self,
        path: &Path,
        set_upstream_branch: Option<&str>,
        force: bool,
    ) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        let mut args = vec!["push"];
        if force {
            args.push("--force-with-lease");
        }
        if let Some(branch) = set_upstream_branch {
            validate_ref(branch)?;
            args.push("--set-upstream");
            args.push("origin");
            args.push(branch);
        }
        self.run_network(path, &args)?;
        Ok(())
    }

    fn stash_list(&self, path: &Path) -> Result<Vec<Stash>, GitError> {
        let out = self.run(path, &["stash", "list", "--format=%gd%x1f%s"])?;
        Ok(parse_stash_list(&String::from_utf8_lossy(&out)))
    }

    fn stash_save(
        &self,
        path: &Path,
        message: Option<&str>,
        include_untracked: bool,
    ) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        let mut args = vec!["stash", "push"];
        if include_untracked {
            args.push("--include-untracked");
        }
        if let Some(m) = message {
            if !m.trim().is_empty() {
                args.push("-m");
                args.push(m);
            }
        }
        self.run(path, &args)?;
        self.drop_session();
        Ok(())
    }

    fn stash_apply(&self, path: &Path, index: u32, pop: bool) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        let sel = format!("stash@{{{index}}}");
        let sub = if pop { "pop" } else { "apply" };
        self.run(path, &["stash", sub, &sel])?;
        self.drop_session();
        Ok(())
    }

    fn stash_drop(&self, path: &Path, index: u32) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        let sel = format!("stash@{{{index}}}");
        self.run(path, &["stash", "drop", &sel])?;
        Ok(())
    }

    fn merge(&self, path: &Path, branch: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(branch)?;
        self.run(path, &["merge", branch])?;
        self.drop_session();
        Ok(())
    }

    fn pending_op(&self, path: &Path) -> Result<String, GitError> {
        let out = self.run(path, &["rev-parse", "--git-dir"])?;
        // `--git-dir` is relative to `path` (or absolute). join() handles both.
        let base = path.join(String::from_utf8_lossy(&out).trim());
        let has = |p: &str| base.join(p).exists();
        let op = if has("rebase-merge") || has("rebase-apply") {
            "rebase"
        } else if has("MERGE_HEAD") {
            "merge"
        } else if has("CHERRY_PICK_HEAD") {
            "cherry-pick"
        } else if has("REVERT_HEAD") {
            "revert"
        } else {
            "none"
        };
        Ok(op.to_string())
    }

    fn op_abort(&self, path: &Path, op: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        let sub = match op {
            "merge" | "rebase" | "cherry-pick" | "revert" => op,
            _ => return Err(GitError::CommandFailed("no operation in progress".into())),
        };
        self.run(path, &[sub, "--abort"])?;
        self.drop_session();
        Ok(())
    }

    fn op_continue(&self, path: &Path, op: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        // For merge, complete the commit (--continue would open an editor);
        // for the sequencer ops, --continue with the editor suppressed.
        let args: &[&str] = match op {
            "merge" => &["commit", "--no-edit"],
            "rebase" => &["rebase", "--continue"],
            "cherry-pick" => &["cherry-pick", "--continue"],
            "revert" => &["revert", "--continue"],
            _ => return Err(GitError::CommandFailed("no operation in progress".into())),
        };
        let output = git_command()
            .arg("-C")
            .arg(path)
            .args(args)
            .env("GIT_EDITOR", "true")
            .env("GIT_SEQUENCE_EDITOR", "true")
            .output()?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(GitError::CommandFailed(stderr));
        }
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

    fn file_revisions(&self, path: &Path, file_path: &str) -> Result<Vec<Commit>, GitError> {
        validate_path(file_path)?;
        let out = self.run(path, &["log", "-z", COMMIT_LOG_FORMAT, "--", file_path])?;
        Ok(parse_commit_log(&String::from_utf8_lossy(&out)))
    }

    fn timelapse_frame(
        &self,
        path: &Path,
        sha: &str,
        prev_sha: Option<&str>,
        file_path: &str,
    ) -> Result<FileDiff, GitError> {
        validate_path(file_path)?;
        validate_ref(sha)?;
        if let Some(p) = prev_sha {
            validate_ref(p)?;
        }
        // Content at this revision; missing blob (e.g. a deletion frame) → empty.
        let new_bytes =
            cat_file_oneshot(path, &format!("{sha}:{file_path}")).unwrap_or_default();
        let old_bytes = prev_sha
            .and_then(|p| cat_file_oneshot(path, &format!("{p}:{file_path}")))
            .unwrap_or_default();
        let old_size = old_bytes.len() as u64;
        let new_size = new_bytes.len() as u64;

        if new_size > LARGE_FILE_BYTES || old_size > LARGE_FILE_BYTES {
            return Ok(FileDiff::TooLarge { old_size, new_size });
        }
        if is_binary(&new_bytes) || is_binary(&old_bytes) {
            return Ok(FileDiff::Binary { old_size, new_size, note: None });
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

    fn containment(
        &self,
        path: &Path,
        source: &str,
        target: &str,
    ) -> Result<Containment, GitError> {
        let target = validate_ref(target)?;
        let source_is_branch = !source.is_empty();
        if source_is_branch {
            validate_ref(source)?;
        }

        // ● set: commits reachable from `source` (or every ref) but not target.
        let mut rl_args: Vec<&str> = vec!["rev-list"];
        if source_is_branch {
            rl_args.push(source);
        } else {
            rl_args.push("--all");
        }
        rl_args.push("--not");
        rl_args.push(target);
        let not_in_target = nonempty_lines(&String::from_utf8_lossy(&self.run(path, &rl_args)?));

        // Patch-equivalence (rebase/cherry-pick) + ahead/behind only make sense
        // for a single-ref source.
        let mut equivalent = Vec::new();
        let mut ahead = 0;
        let mut behind = 0;
        if source_is_branch {
            let cherry = self.run(path, &["cherry", target, source])?;
            equivalent = parse_cherry_equivalent(&String::from_utf8_lossy(&cherry));
            let spec = format!("{target}...{source}");
            let counts = self.run(path, &["rev-list", "--left-right", "--count", &spec])?;
            let (b, a) = parse_ahead_behind(&String::from_utf8_lossy(&counts));
            behind = b;
            ahead = a;
        }

        Ok(Containment {
            not_in_target,
            equivalent,
            ahead,
            behind,
            source_is_branch,
        })
    }

    fn commit_log_excluding(
        &self,
        path: &Path,
        source: &str,
        target: &str,
        limit: u32,
        skip: u32,
    ) -> Result<Vec<Commit>, GitError> {
        let target = validate_ref(target)?;
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
            "--date-order",
        ];
        if source.is_empty() {
            args.push("--all");
        } else {
            args.push(validate_ref(source)?);
        }
        args.push("--not");
        args.push(target);
        let stdout = self.run(path, &args)?;
        Ok(parse_commit_log(&String::from_utf8_lossy(&stdout)))
    }

    fn commit_containment_detail(
        &self,
        path: &Path,
        sha: &str,
        target: &str,
    ) -> Result<ContainmentDetail, GitError> {
        let sha = validate_ref(sha)?;
        let target = validate_ref(target)?;

        // Is the commit an ancestor of target? (exit 0 = yes). Use the raw
        // command so a non-zero exit is "no", not an error.
        let in_target = git_command()
            .arg("-C")
            .arg(path)
            .args(["merge-base", "--is-ancestor", sha, target])
            .output()?
            .status
            .success();

        // The merge that introduced it into target: the oldest merge on the
        // ancestry path sha..target (last line). Empty → fast-forwarded /
        // committed directly.
        let mut introduced_by = None;
        if in_target {
            let range = format!("{sha}..{target}");
            let merges =
                self.run(path, &["rev-list", "--ancestry-path", "--merges", &range])?;
            if let Some(merge_sha) = nonempty_lines(&String::from_utf8_lossy(&merges)).pop() {
                let one = self.run(path, &["log", "-1", "-z", COMMIT_LOG_FORMAT, &merge_sha])?;
                introduced_by = parse_commit_log(&String::from_utf8_lossy(&one))
                    .into_iter()
                    .next();
            }
        }

        Ok(ContainmentDetail {
            in_target,
            introduced_by,
        })
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

/// Reference to the invalidation flag for a single watched path's
/// `list_repo_files` cache. The scan body pre-clears it so it can detect
/// events that fire mid-scan.
struct WatcherFlags {
    repo_files: Arc<AtomicBool>,
}

impl GitCli {
    /// Get-or-create the cache entry for `path` and return a reference to
    /// its `repo_files` invalidation flag. Lazily spawns the FS watcher on
    /// first call; subsequent calls reuse the existing one. The returned Arc
    /// lets the scan body track "did anything change while we were scanning?"
    /// without re-locking the map.
    fn ensure_worktree_watcher(&self, path: &Path) -> WatcherFlags {
        let mut guard = self.worktree_caches.lock().unwrap();
        let entry = guard.entry(path.to_path_buf()).or_insert_with(|| {
            let repo_files_invalid = Arc::new(AtomicBool::new(true));
            let watcher =
                spawn_worktree_watcher(path, vec![repo_files_invalid.clone()]).ok();
            WorktreeCacheEntry {
                repo_files: None,
                repo_files_invalid,
                _watcher: watcher,
            }
        });
        WatcherFlags {
            repo_files: entry.repo_files_invalid.clone(),
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
    fn cherry_keeps_only_equivalent() {
        // `- sha` = patch already upstream (equivalent); `+ sha` = absent.
        let input = "- aaa111\n+ bbb222\n- ccc333\n";
        assert_eq!(parse_cherry_equivalent(input), vec!["aaa111", "ccc333"]);
    }

    #[test]
    fn cherry_empty_is_empty() {
        assert!(parse_cherry_equivalent("").is_empty());
        assert!(parse_cherry_equivalent("+ only222\n").is_empty());
    }

    #[test]
    fn ahead_behind_parses_left_right() {
        // "<behind>\t<ahead>" with A=target, B=source.
        assert_eq!(parse_ahead_behind("2\t5\n"), (2, 5));
        assert_eq!(parse_ahead_behind("0 0"), (0, 0));
        assert_eq!(parse_ahead_behind(""), (0, 0));
    }

    #[test]
    fn nonempty_lines_trims_and_filters() {
        assert_eq!(
            nonempty_lines("  a \n\n b\nc\n"),
            vec!["a", "b", "c"]
        );
        assert!(nonempty_lines("\n  \n").is_empty());
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
    fn parse_stash_list_basic() {
        let input = "stash@{0}\u{1f}WIP on main: a1b2 fix\nstash@{1}\u{1f}On dev: wip\n";
        let s = parse_stash_list(input);
        assert_eq!(s.len(), 2);
        assert_eq!((s[0].index, s[0].message.as_str()), (0, "WIP on main: a1b2 fix"));
        assert_eq!((s[1].index, s[1].message.as_str()), (1, "On dev: wip"));
        assert!(parse_stash_list("").is_empty());
    }

    #[test]
    fn parse_hunks_empty_diff() {
        assert!(parse_hunks("").is_empty());
        // Binary diffs carry no @@ hunks.
        let bin = "diff --git a/x.bin b/x.bin\nBinary files a/x.bin and b/x.bin differ\n";
        assert!(parse_hunks(bin).is_empty());
    }

    #[test]
    fn hunk_ids_distinct_and_stable() {
        let hunks = parse_hunks(SAMPLE_DIFF);
        assert_eq!(hunks.len(), 2);
        // Same body → same id (re-parse); different bodies → different ids.
        assert_eq!(hunks[0].id, parse_hunks(SAMPLE_DIFF)[0].id);
        assert_ne!(hunks[0].id, hunks[1].id);
        assert!(!hunks[0].id.is_empty());
    }
}
