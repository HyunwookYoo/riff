//! A shallow bare clone of Roblox's public API reference
//! (`github.com/Roblox/creator-docs`) in the app data folder. riff — not the
//! AI — reads reference files from it and hands them to the Roblox parity
//! pass as prompt text, so the AI guard stays as is.

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;

use crate::git::{GitCli, GitError};

pub const DOCS_URL: &str = "https://github.com/Roblox/creator-docs.git";
pub const DIR_NAME: &str = "roblox-docs.git";

const BRANCH_REF: &str = "refs/heads/main";
const REFERENCE_ROOT: &str = "content/en-us/reference/engine/";
/// Lookup order for a bare name; `Enum.X` goes to `enums/` only.
const KINDS: [&str; 4] = ["classes", "datatypes", "globals", "libraries"];
const MAX_DOCS: usize = 12;
const MAX_FILE_CHARS: usize = 60_000;
const MAX_TOTAL_CHARS: usize = 150_000;
/// git aborts an HTTP transfer slower than 1 KB/s for 60 s, so a stalled
/// fetch can't hold up a review run forever.
const STALL_GUARD: [&str; 4] = ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60"];

/// Serializes updates in this process: two runs starting together must not
/// both clone into the same temp dir.
static UPDATE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DocsInfo {
    pub sha: String,
    /// Committer date of the docs commit, ISO 8601.
    pub date: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ApiDoc {
    /// The name as asked for (`BasePart`, `Enum.HumanoidStateType`).
    pub name: String,
    /// `<kind>/<Name>.yaml` under the reference root, e.g. `classes/BasePart.yaml`.
    pub path: String,
    pub text: String,
}

/// Clone `url`'s `main` into `dir` when absent, else fetch it; then `info`.
/// The first clone goes to a temp dir renamed into place on success, so a
/// failed or interrupted clone never leaves a `dir` that looks downloaded.
pub fn update(git: &GitCli, dir: &Path, url: &str) -> Result<DocsInfo, GitError> {
    let _guard = UPDATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if dir.exists() {
        let mut args = STALL_GUARD.to_vec();
        args.extend([
            "fetch",
            "--depth",
            "1",
            "--no-tags",
            "--no-write-fetch-head",
            url,
            "+refs/heads/main:refs/heads/main",
        ]);
        git.run_network(dir, &args)?;
    } else {
        let parent = dir
            .parent()
            .ok_or_else(|| GitError::CommandFailed("docs dir has no parent".into()))?;
        fs::create_dir_all(parent)?;
        let partial = dir.with_extension("git.partial");
        let _ = fs::remove_dir_all(&partial);
        let partial_arg = partial.to_string_lossy();
        let mut args = STALL_GUARD.to_vec();
        args.extend([
            "clone",
            "--bare",
            "--depth",
            "1",
            "--single-branch",
            "--branch",
            "main",
            "--no-tags",
            "--",
            url,
            &partial_arg,
        ]);
        if let Err(e) = git.run_network(parent, &args) {
            let _ = fs::remove_dir_all(&partial);
            return Err(e);
        }
        if let Err(e) = fs::rename(&partial, dir) {
            let _ = fs::remove_dir_all(&partial);
            // Another riff process may have finished its clone first.
            if !dir.exists() {
                return Err(e.into());
            }
        }
    }
    info(git, dir)?.ok_or_else(|| GitError::CommandFailed("Roblox docs missing after update".into()))
}

/// The downloaded docs commit, or None when nothing was downloaded yet.
pub fn info(git: &GitCli, dir: &Path) -> Result<Option<DocsInfo>, GitError> {
    if !dir.exists() {
        return Ok(None);
    }
    let out = git.run(dir, &["log", "-1", "--format=%H%n%cI", BRANCH_REF, "--"])?;
    let text = String::from_utf8_lossy(&out);
    let mut lines = text.lines();
    match (lines.next(), lines.next()) {
        (Some(sha), Some(date)) if !sha.is_empty() => Ok(Some(DocsInfo {
            sha: sha.to_string(),
            date: date.to_string(),
        })),
        _ => Err(GitError::Parse(format!("unexpected docs log output: {text}"))),
    }
}

/// The reference files for `names` at docs commit `sha`. Invalid, repeated
/// and unknown names are skipped; at most `MAX_DOCS` files; text capped per
/// file and in total, cut text ending in a `[truncated]` line.
pub fn read_apis(git: &GitCli, dir: &Path, sha: &str, names: &[String]) -> Result<Vec<ApiDoc>, GitError> {
    let is_oid = matches!(sha.len(), 40 | 64)
        && sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !is_oid {
        return Err(GitError::InvalidRef(sha.to_string()));
    }
    let mut ls = vec!["ls-tree", "-r", "-z", "--name-only", sha, "--"];
    let specs: Vec<String> = KINDS
        .iter()
        .chain(&["enums"])
        .map(|k| format!("{REFERENCE_ROOT}{k}/"))
        .collect();
    ls.extend(specs.iter().map(String::as_str));
    let listing = git.run(dir, &ls)?;
    let listing = String::from_utf8_lossy(&listing);
    let present: HashSet<&str> = listing
        .split('\0')
        .filter_map(|p| p.strip_prefix(REFERENCE_ROOT))
        .collect();

    let mut seen = HashSet::new();
    let mut docs = Vec::new();
    let mut budget = MAX_TOTAL_CHARS;
    for name in names {
        if docs.len() == MAX_DOCS || budget == 0 {
            break;
        }
        let Some(path) = doc_path(name, &present) else { continue };
        if !seen.insert(path.clone()) {
            continue;
        }
        let blob = git.run(dir, &["cat-file", "blob", &format!("{sha}:{REFERENCE_ROOT}{path}")])?;
        let (text, used) = cap_chars(&String::from_utf8_lossy(&blob), MAX_FILE_CHARS.min(budget));
        budget -= used;
        docs.push(ApiDoc { name: name.clone(), path, text });
    }
    Ok(docs)
}

/// `<kind>/<Name>.yaml` for a valid name that exists in `present`.
fn doc_path(name: &str, present: &HashSet<&str>) -> Option<String> {
    let valid = |s: &str| {
        (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    };
    let candidates: Vec<String> = match name.strip_prefix("Enum.") {
        Some(e) if valid(e) => vec![format!("enums/{e}.yaml")],
        Some(_) => return None,
        None if valid(name) => KINDS.iter().map(|k| format!("{k}/{name}.yaml")).collect(),
        None => return None,
    };
    candidates.into_iter().find(|c| present.contains(c.as_str()))
}

/// `s` cut to `max` chars plus a `[truncated]` line when longer; and the
/// number of chars of `s` kept.
fn cap_chars(s: &str, max: usize) -> (String, usize) {
    match s.char_indices().nth(max) {
        Some((i, _)) => (format!("{}\n[truncated]", &s[..i]), max),
        None => (s.to_string(), s.chars().count()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::git_command;
    use std::path::PathBuf;

    fn git_in(dir: &Path, args: &[&str]) -> String {
        let out = git_command().arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("riff-roblox-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A work-tree repo on `main` with the creator-docs reference layout.
    fn docs_source(root: &Path, files: &[(&str, &str)]) -> PathBuf {
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        git_in(&src, &["init", "-q"]);
        git_in(&src, &["config", "user.email", "t@example.com"]);
        git_in(&src, &["config", "user.name", "riff test"]);
        git_in(&src, &["checkout", "-q", "-b", "main"]);
        write_files(&src, files);
        src
    }

    fn write_files(src: &Path, files: &[(&str, &str)]) {
        for (rel, text) in files {
            let p = src.join(REFERENCE_ROOT).join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, text).unwrap();
        }
        git_in(src, &["add", "-A"]);
        git_in(src, &["commit", "-qm", "docs"]);
    }

    /// `file://` so the clone and fetch really go shallow (a plain local path
    /// ignores `--depth`).
    fn file_url(p: &Path) -> String {
        let s = p.to_string_lossy().replace('\\', "/");
        if s.starts_with('/') {
            format!("file://{s}")
        } else {
            format!("file:///{s}")
        }
    }

    const FIXTURE: [(&str, &str); 6] = [
        ("classes/BasePart.yaml", "name: BasePart\n"),
        ("classes/Shared.yaml", "name: Shared class\n"),
        ("datatypes/Shared.yaml", "name: Shared datatype\n"),
        ("datatypes/Vector3.yaml", "name: Vector3\n"),
        ("enums/HumanoidStateType.yaml", "name: HumanoidStateType\n"),
        ("libraries/math.yaml", "name: math\n"),
    ];

    #[test]
    fn info_is_none_before_download() {
        let root = scratch("info-none");
        assert_eq!(info(&GitCli::new(), &root.join(DIR_NAME)).unwrap(), None);
    }

    #[test]
    fn update_clones_then_fetches_new_commits() {
        let root = scratch("update");
        let src = docs_source(&root, &FIXTURE);
        let url = file_url(&src);
        let dir = root.join("data").join(DIR_NAME);
        let git = GitCli::new();

        let first = update(&git, &dir, &url).unwrap();
        assert_eq!(first.sha, git_in(&src, &["rev-parse", "HEAD"]));
        assert_eq!(first.date, git_in(&src, &["log", "-1", "--format=%cI"]));
        assert_eq!(info(&git, &dir).unwrap(), Some(first.clone()));
        assert!(dir.join("shallow").exists(), "clone is not shallow");
        assert!(!dir.with_extension("git.partial").exists());

        write_files(&src, &[("classes/Humanoid.yaml", "name: Humanoid\n")]);
        let second = update(&git, &dir, &url).unwrap();
        assert_eq!(second.sha, git_in(&src, &["rev-parse", "HEAD"]));
        assert_ne!(second.sha, first.sha);
        let docs = read_apis(&git, &dir, &second.sha, &["Humanoid".into()]).unwrap();
        assert_eq!(docs[0].path, "classes/Humanoid.yaml");
    }

    #[test]
    fn failed_clone_leaves_nothing_behind() {
        let root = scratch("clone-fail");
        let dir = root.join("data").join(DIR_NAME);
        let git = GitCli::new();
        let missing = file_url(&root.join("no-such-repo"));
        assert!(update(&git, &dir, &missing).is_err());
        assert!(!dir.exists());
        assert!(!dir.with_extension("git.partial").exists());
        assert_eq!(info(&git, &dir).unwrap(), None);
    }

    #[test]
    fn failed_fetch_keeps_the_last_copy() {
        let root = scratch("fetch-fail");
        let src = docs_source(&root, &FIXTURE);
        let dir = root.join("data").join(DIR_NAME);
        let git = GitCli::new();
        let first = update(&git, &dir, &file_url(&src)).unwrap();
        assert!(update(&git, &dir, &file_url(&root.join("gone"))).is_err());
        assert_eq!(info(&git, &dir).unwrap(), Some(first));
    }

    #[test]
    fn read_apis_resolves_kinds_and_skips_bad_names() {
        let root = scratch("read");
        let src = docs_source(&root, &FIXTURE);
        let dir = root.join("data").join(DIR_NAME);
        let git = GitCli::new();
        let sha = update(&git, &dir, &file_url(&src)).unwrap().sha;
        let names: Vec<String> = [
            "BasePart",
            "Enum.HumanoidStateType",
            "Shared",
            "math",
            "Vector3",
            "BasePart",
            "Nope",
            "HumanoidStateType",
            "Enum.",
            "Enum.Nope",
            "../BasePart",
            "Base Part",
            "--output=x",
            "classes/BasePart",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let docs = read_apis(&git, &dir, &sha, &names).unwrap();
        let got: Vec<(&str, &str, &str)> =
            docs.iter().map(|d| (d.name.as_str(), d.path.as_str(), d.text.as_str())).collect();
        assert_eq!(
            got,
            vec![
                ("BasePart", "classes/BasePart.yaml", "name: BasePart\n"),
                ("Enum.HumanoidStateType", "enums/HumanoidStateType.yaml", "name: HumanoidStateType\n"),
                ("Shared", "classes/Shared.yaml", "name: Shared class\n"),
                ("math", "libraries/math.yaml", "name: math\n"),
                ("Vector3", "datatypes/Vector3.yaml", "name: Vector3\n"),
            ]
        );
    }

    #[test]
    fn read_apis_rejects_a_non_hex_sha() {
        let root = scratch("read-sha");
        let git = GitCli::new();
        for sha in ["main", "HEAD", "--all", &"A".repeat(40), &"a".repeat(39)] {
            assert!(
                matches!(read_apis(&git, &root, sha, &[]), Err(GitError::InvalidRef(_))),
                "{sha}"
            );
        }
    }

    #[test]
    fn read_apis_caps_count_and_size() {
        let root = scratch("read-caps");
        let big = "x".repeat(MAX_FILE_CHARS + 10);
        let names: Vec<String> = (0..15).map(|i| format!("C{i}")).collect();
        let paths: Vec<String> = names.iter().map(|n| format!("classes/{n}.yaml")).collect();
        let mut files: Vec<(&str, &str)> = paths.iter().map(|p| (p.as_str(), "small\n")).collect();
        files[0].1 = &big;
        files[1].1 = &big;
        files[2].1 = &big;
        let src = docs_source(&root, &files);
        let dir = root.join("data").join(DIR_NAME);
        let git = GitCli::new();
        let sha = update(&git, &dir, &file_url(&src)).unwrap().sha;

        // Three big files: 60k + 60k + 30k fill the total budget.
        let docs = read_apis(&git, &dir, &sha, &names).unwrap();
        assert_eq!(docs.len(), 3);
        let truncated = format!("{}\n[truncated]", "x".repeat(MAX_FILE_CHARS));
        assert_eq!(docs[0].text, truncated);
        assert_eq!(docs[1].text, truncated);
        let rest = MAX_TOTAL_CHARS - 2 * MAX_FILE_CHARS;
        assert_eq!(docs[2].text, format!("{}\n[truncated]", "x".repeat(rest)));

        // Small files stop at the count cap.
        let docs = read_apis(&git, &dir, &sha, &names[3..]).unwrap();
        assert_eq!(docs.len(), MAX_DOCS);
        assert_eq!(docs[0].text, "small\n");
    }

    #[test]
    fn cap_chars_counts_chars_not_bytes() {
        assert_eq!(cap_chars("héllo", 2), ("hé\n[truncated]".to_string(), 2));
        assert_eq!(cap_chars("héllo", 5), ("héllo".to_string(), 5));
    }
}
