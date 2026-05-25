use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::GitError;

/// One commit referenced by the blame result. The SHA is the 8-char short form
/// the frontend displays; the full SHA is not preserved because nothing else in
/// the app uses it (drill-in builds `<short>^..<short>`, which git resolves).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlameCommit {
    pub sha: String,
    pub author: String,
    pub author_time: i64,
    pub summary: String,
}

/// Result of `blame_file`. `commits` is deduplicated; `line_commit[i]` is the
/// index into `commits` for the (1-based) line `i+1` of the blamed file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Blame {
    pub commits: Vec<BlameCommit>,
    pub line_commit: Vec<usize>,
}

/// The zero SHA git emits for working-copy lines that have no commit yet.
pub const UNCOMMITTED_SHA: &str = "0000000000000000000000000000000000000000";

/// Short SHA the frontend gets for "Not Committed Yet" lines. Stable so the
/// frontend can compare against a known sentinel for special rendering.
pub const UNCOMMITTED_SHORT: &str = "00000000";

/// Parse `git blame --porcelain` output.
///
/// Porcelain format (per group):
///
/// ```text
/// <40-sha> <orig-line> <final-line> <num-lines-in-group>
/// author <name>
/// author-mail <email>
/// author-time <unix>
/// author-tz <tz>
/// committer <name>
/// ... (committer-mail/time/tz)
/// summary <subject>
/// previous <sha> <path>            # optional
/// filename <path>
/// \t<content line>
/// <40-sha> <orig> <final>          # subsequent lines in same group: header only
/// \t<content>
/// ```
///
/// A commit's metadata appears only the first time its SHA is seen; later
/// occurrences emit only the `<sha> <orig> <final>` header before `\t`.
pub fn parse_porcelain(input: &[u8]) -> Result<Blame, GitError> {
    let text = std::str::from_utf8(input)
        .map_err(|_| GitError::Parse("blame output not utf-8".into()))?;

    let mut commits: Vec<BlameCommit> = Vec::new();
    let mut sha_to_idx: HashMap<String, usize> = HashMap::new();
    let mut line_commit: Vec<usize> = Vec::new();

    let mut cur_sha: Option<String> = None;
    let mut cur_final_line: Option<usize> = None;
    let mut cur_author: Option<String> = None;
    let mut cur_author_time: Option<i64> = None;
    let mut cur_summary: Option<String> = None;

    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }

        if let Some(content_tail) = line.strip_prefix('\t') {
            let _ = content_tail;
            let sha = cur_sha
                .take()
                .ok_or_else(|| GitError::Parse("blame: content line with no sha".into()))?;
            let final_line = cur_final_line
                .take()
                .ok_or_else(|| GitError::Parse("blame: content line with no final-line".into()))?;

            let idx = if let Some(&existing) = sha_to_idx.get(&sha) {
                existing
            } else {
                let short_sha = if sha == UNCOMMITTED_SHA {
                    UNCOMMITTED_SHORT.to_string()
                } else {
                    sha.chars().take(8).collect()
                };
                let commit = BlameCommit {
                    sha: short_sha,
                    author: cur_author.take().unwrap_or_default(),
                    author_time: cur_author_time.take().unwrap_or(0),
                    summary: cur_summary.take().unwrap_or_default(),
                };
                commits.push(commit);
                let i = commits.len() - 1;
                sha_to_idx.insert(sha, i);
                i
            };

            if final_line == 0 {
                return Err(GitError::Parse("blame: final-line is 0".into()));
            }
            let arr_idx = final_line - 1;
            if line_commit.len() <= arr_idx {
                line_commit.resize(arr_idx + 1, 0);
            }
            line_commit[arr_idx] = idx;

            cur_author = None;
            cur_author_time = None;
            cur_summary = None;
            continue;
        }

        if is_header_line(line) {
            let mut parts = line.splitn(4, ' ');
            let sha = parts.next().unwrap_or("").to_string();
            let _orig = parts.next();
            let final_line: usize = parts
                .next()
                .and_then(|s| s.parse().ok())
                .ok_or_else(|| GitError::Parse(format!("blame: bad header: {line}")))?;
            cur_sha = Some(sha);
            cur_final_line = Some(final_line);
            cur_author = None;
            cur_author_time = None;
            cur_summary = None;
            continue;
        }

        if let Some(rest) = line.strip_prefix("author ") {
            cur_author = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("author-time ") {
            cur_author_time = rest.parse().ok();
        } else if let Some(rest) = line.strip_prefix("summary ") {
            cur_summary = Some(rest.to_string());
        }
    }

    Ok(Blame { commits, line_commit })
}

/// True if `line` starts with a 40-char hex SHA followed by a space — i.e.,
/// the first line of a blame group.
fn is_header_line(line: &str) -> bool {
    let bytes = line.as_bytes();
    if bytes.len() < 41 {
        return false;
    }
    if bytes[40] != b' ' {
        return false;
    }
    bytes[..40].iter().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_empty() {
        let b = parse_porcelain(b"").unwrap();
        assert!(b.commits.is_empty());
        assert!(b.line_commit.is_empty());
    }

    #[test]
    fn parse_single_line() {
        let input = b"abcdef0123456789abcdef0123456789abcdef01 1 1 1
author Alice
author-mail <alice@example.com>
author-time 1700000000
author-tz +0000
committer Alice
committer-mail <alice@example.com>
committer-time 1700000000
committer-tz +0000
summary initial commit
filename src/main.rs
\tfn main() {}
";
        let b = parse_porcelain(input).unwrap();
        assert_eq!(b.commits.len(), 1);
        assert_eq!(b.commits[0].sha, "abcdef01");
        assert_eq!(b.commits[0].author, "Alice");
        assert_eq!(b.commits[0].author_time, 1700000000);
        assert_eq!(b.commits[0].summary, "initial commit");
        assert_eq!(b.line_commit, vec![0]);
    }

    #[test]
    fn parse_same_commit_multiple_lines_dedups() {
        // 3 lines, all from same commit. Porcelain emits full metadata only on
        // the first occurrence.
        let input = b"aaaa111122223333444455556666777788889999 1 1 3
author Alice
author-mail <a@x>
author-time 100
author-tz +0000
committer Alice
committer-mail <a@x>
committer-time 100
committer-tz +0000
summary commit A
filename f.rs
\tline 1
aaaa111122223333444455556666777788889999 2 2
\tline 2
aaaa111122223333444455556666777788889999 3 3
\tline 3
";
        let b = parse_porcelain(input).unwrap();
        assert_eq!(b.commits.len(), 1);
        assert_eq!(b.commits[0].sha, "aaaa1111");
        assert_eq!(b.line_commit, vec![0, 0, 0]);
    }

    #[test]
    fn parse_two_commits_interleaved() {
        let input = b"aaaa111122223333444455556666777788889999 1 1 1
author Alice
author-mail <a@x>
author-time 100
author-tz +0000
committer Alice
committer-mail <a@x>
committer-time 100
committer-tz +0000
summary A
filename f.rs
\tline 1
bbbb222233334444555566667777888899990000 2 2 1
author Bob
author-mail <b@x>
author-time 200
author-tz +0000
committer Bob
committer-mail <b@x>
committer-time 200
committer-tz +0000
summary B
filename f.rs
\tline 2
aaaa111122223333444455556666777788889999 3 3
\tline 3
";
        let b = parse_porcelain(input).unwrap();
        assert_eq!(b.commits.len(), 2);
        assert_eq!(b.commits[0].sha, "aaaa1111");
        assert_eq!(b.commits[0].author, "Alice");
        assert_eq!(b.commits[1].sha, "bbbb2222");
        assert_eq!(b.commits[1].author, "Bob");
        assert_eq!(b.line_commit, vec![0, 1, 0]);
    }

    #[test]
    fn parse_uncommitted_yields_zero_short() {
        let input = b"0000000000000000000000000000000000000000 1 1 1
author Not Committed Yet
author-mail <not.committed.yet>
author-time 1700000000
author-tz +0000
committer Not Committed Yet
committer-mail <not.committed.yet>
committer-time 1700000000
committer-tz +0000
summary Version of f.rs from f.rs
filename f.rs
\tnew uncommitted line
";
        let b = parse_porcelain(input).unwrap();
        assert_eq!(b.commits.len(), 1);
        assert_eq!(b.commits[0].sha, UNCOMMITTED_SHORT);
        assert_eq!(b.commits[0].author, "Not Committed Yet");
    }

    #[test]
    fn parse_ignores_previous_filename_committer_fields() {
        let input = b"abcdef0123456789abcdef0123456789abcdef01 1 1 1
author Alice
author-mail <a@x>
author-time 100
author-tz +0000
committer Bob
committer-mail <b@x>
committer-time 200
committer-tz +0000
summary moved file
previous deadbeef00000000000000000000000000000000 old.rs
filename new.rs
\tcontent
";
        let b = parse_porcelain(input).unwrap();
        assert_eq!(b.commits.len(), 1);
        assert_eq!(b.commits[0].author, "Alice");
        assert_eq!(b.commits[0].summary, "moved file");
    }

    #[test]
    fn header_recognition() {
        assert!(is_header_line(
            "abcdef0123456789abcdef0123456789abcdef01 1 1 1"
        ));
        assert!(is_header_line(
            "0000000000000000000000000000000000000000 1 1"
        ));
        assert!(!is_header_line("author Alice"));
        assert!(!is_header_line("\tcontent"));
        assert!(!is_header_line("too short"));
        // 40 chars but with non-hex
        assert!(!is_header_line(
            "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz 1 1 1"
        ));
    }
}
