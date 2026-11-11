//! A shallow bare clone of Roblox's public API reference
//! (`github.com/Roblox/creator-docs`) in the app data folder. riff — not the
//! AI — reads reference files from it and hands them to the Roblox parity
//! pass as prompt text, so the AI guard stays as is.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

use crate::git::{GitCli, GitError};

pub const DOCS_URL: &str = "https://github.com/Roblox/creator-docs.git";
pub const DIR_NAME: &str = "roblox-docs.git";

const BRANCH_REF: &str = "refs/heads/main";
const REFERENCE_ROOT: &str = "content/en-us/reference/engine/";
/// Lookup order for a name's class part; `Enum.X` goes to `enums/` only.
/// `globals/` holds just LuaGlobals.yaml and RobloxGlobals.yaml.
const KINDS: [&str; 5] = ["classes", "datatypes", "libraries", "enums", "globals"];
/// Top-level keys whose list items (`  - name: BasePart.Touched`) are members.
const MEMBER_KEYS: [&str; 6] = ["properties", "methods", "events", "callbacks", "constructors", "functions"];
/// Top-level blocks the header leaves out: sample ids and the subclass list.
const NOT_IN_HEADER: [&str; 2] = ["code_samples", "descendants"];
/// Starts each member index line riff adds; src/lib/review/ai/roblox.ts
/// strips these lines (and `[truncated]`) before checking quotes.
const INDEX_MARK: &str = "[riff index] ";
/// Files, not members: the asked members of these files count toward the
/// char budget only.
const MAX_DOCS: usize = 12;
const MAX_FILE_CHARS: usize = 60_000;
const MAX_TOTAL_CHARS: usize = 150_000;
/// git aborts an HTTP transfer slower than 1 KB/s for 60 s, so a stalled
/// fetch can't hold up a review run forever.
const STALL_GUARD: [&str; 4] = ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60"];
/// With `git -C <dir>`: the docs repo named explicitly, so git never searches
/// upward from a `dir` that is not a repo into a parent one (say a dotfiles
/// repo in the home folder) and fetches into its `main`. An explicit git dir
/// also works under `safe.bareRepository=explicit`; the `-c` (command-line
/// config is protected config, and `all` is git's default) keeps that true
/// whatever the user set.
const DOCS_GIT: [&str; 3] = ["--git-dir=.", "-c", "safe.bareRepository=all"];
const RENAME_RETRIES: u32 = 5;
const RENAME_RETRY_DELAY: Duration = Duration::from_millis(200);
/// A partial clone untouched this long belongs to a process that is gone.
const STALE_PARTIAL_AGE: Duration = Duration::from_secs(60 * 60);

/// Serializes updates in this process: two runs starting together must not
/// both clone into the same partial dir.
static UPDATE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DocsInfo {
    pub sha: String,
    /// Committer date of the docs commit, ISO 8601.
    pub date: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ApiDoc {
    /// The file's name as first asked for (`BasePart`, also for
    /// `BasePart.Touched`; `Enum.HumanoidStateType`).
    pub name: String,
    /// `<kind>/<Name>.yaml` under the reference root, e.g. `classes/BasePart.yaml`.
    pub path: String,
    pub text: String,
}

/// Clone `url`'s `main` into `dir` when absent, else fetch it; then `info`.
/// The first clone goes to a per-process partial dir renamed into place on
/// success, so a failed or interrupted clone never leaves a `dir` that looks
/// downloaded. A `dir` that exists but is not a downloaded copy is replaced.
pub fn update(git: &GitCli, dir: &Path, url: &str) -> Result<DocsInfo, GitError> {
    let _guard = UPDATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if downloaded(dir) {
        let mut args = DOCS_GIT.to_vec();
        args.extend(STALL_GUARD);
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
        clone(git, dir, url)?;
    }
    info(git, dir)?.ok_or_else(|| GitError::CommandFailed("Roblox docs missing after update".into()))
}

fn clone(git: &GitCli, dir: &Path, url: &str) -> Result<(), GitError> {
    let parent = dir
        .parent()
        .ok_or_else(|| GitError::CommandFailed("docs dir has no parent".into()))?;
    fs::create_dir_all(parent)?;
    if dir.exists() {
        fs::remove_dir_all(dir).or_else(|_| fs::remove_file(dir))?;
    }
    remove_stale_partials(dir, STALE_PARTIAL_AGE);
    let partial = partial_dir(dir, std::process::id());
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
    if let Err(e) = rename_retrying(&partial, dir) {
        let _ = fs::remove_dir_all(&partial);
        // Another riff process may have finished its clone first.
        if !downloaded(dir) {
            return Err(e.into());
        }
    }
    Ok(())
}

/// Whether `dir` holds a downloaded copy: a git dir always has a HEAD file.
fn downloaded(dir: &Path) -> bool {
    dir.join("HEAD").is_file()
}

/// `<dir>.partial-<pid>`: each process clones into its own, so two riff
/// processes never delete each other's clone in progress.
fn partial_dir(dir: &Path, pid: u32) -> PathBuf {
    dir.with_file_name(format!("{}{pid}", partial_prefix(dir)))
}

fn partial_prefix(dir: &Path) -> String {
    let name = dir.file_name().unwrap_or_default().to_string_lossy();
    format!("{name}.partial-")
}

/// Removes `dir`'s partial clones (`partial_dir` names only) untouched for
/// `max_age`: left by a riff process that crashed or was killed mid-clone.
fn remove_stale_partials(dir: &Path, max_age: Duration) {
    let (Some(parent), prefix) = (dir.parent(), partial_prefix(dir)) else { return };
    let Ok(entries) = fs::read_dir(parent) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|n| n.strip_prefix(&prefix)) else { continue };
        if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|t| t.elapsed().is_ok_and(|age| age >= max_age));
        if stale {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// `fs::rename`, retried a few times while `to` is still absent: on Windows
/// an indexer or virus scanner briefly holding a file of a fresh clone makes
/// renaming its folder fail.
fn rename_retrying(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut retries = 0;
    loop {
        match fs::rename(from, to) {
            Err(_) if retries < RENAME_RETRIES && !to.exists() => {
                retries += 1;
                std::thread::sleep(RENAME_RETRY_DELAY);
            }
            r => return r,
        }
    }
}

/// The downloaded docs commit, or None when nothing was downloaded yet.
pub fn info(git: &GitCli, dir: &Path) -> Result<Option<DocsInfo>, GitError> {
    if !downloaded(dir) {
        return Ok(None);
    }
    let out = git.run(dir, &docs_args(&["log", "-1", "--format=%H%n%cI", BRANCH_REF, "--"]))?;
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

/// `DOCS_GIT` then `rest`, for `git.run(dir, …)`.
fn docs_args<'a>(rest: &[&'a str]) -> Vec<&'a str> {
    DOCS_GIT.iter().chain(rest).copied().collect()
}

/// The reference files for `names` (`Class`, `Class.Member` or
/// `Class:Member`, `Enum.X`) at docs commit `sha`, one per file, each as
/// `doc_text` makes it. Invalid and unknown names are skipped; at most
/// `MAX_DOCS` files; text capped per file and in total.
pub fn read_apis(git: &GitCli, dir: &Path, sha: &str, names: &[String]) -> Result<Vec<ApiDoc>, GitError> {
    let is_oid = matches!(sha.len(), 40 | 64)
        && sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !is_oid {
        return Err(GitError::InvalidRef(sha.to_string()));
    }
    let mut ls = docs_args(&["ls-tree", "-r", "-z", "--name-only", sha, "--"]);
    let specs: Vec<String> = KINDS.iter().map(|k| format!("{REFERENCE_ROOT}{k}/")).collect();
    ls.extend(specs.iter().map(String::as_str));
    let listing = git.run(dir, &ls)?;
    let listing = String::from_utf8_lossy(&listing);
    let present: HashSet<&str> = listing
        .split('\0')
        .filter_map(|p| p.strip_prefix(REFERENCE_ROOT))
        .collect();

    // (name, path, asked members) per file, in the order first asked.
    let mut wants: Vec<(&str, String, Vec<&str>)> = Vec::new();
    for name in names {
        let Some((file, path, member)) = resolve(name, &present) else { continue };
        let i = match wants.iter().position(|w| w.1 == path) {
            Some(i) => i,
            None if wants.len() < MAX_DOCS => {
                wants.push((file, path, Vec::new()));
                wants.len() - 1
            }
            None => continue,
        };
        if let Some(m) = member.filter(|m| !wants[i].2.contains(m)) {
            wants[i].2.push(m);
        }
    }

    let mut docs = Vec::new();
    let mut budget = MAX_TOTAL_CHARS;
    for (name, path, members) in wants {
        if budget == 0 {
            break;
        }
        let spec = format!("{sha}:{REFERENCE_ROOT}{path}");
        let blob = git.run(dir, &docs_args(&["cat-file", "blob", &spec]))?;
        let (text, used) = doc_text(&String::from_utf8_lossy(&blob), &members, MAX_FILE_CHARS.min(budget));
        budget -= used;
        docs.push(ApiDoc { name: name.to_string(), path, text });
    }
    Ok(docs)
}

/// For a valid name whose file is in `present`: the file part as asked
/// (`BasePart`, `Enum.Material`), `<kind>/<Name>.yaml`, and the member asked.
fn resolve<'a>(name: &'a str, present: &HashSet<&str>) -> Option<(&'a str, String, Option<&'a str>)> {
    let valid = |s: &str| {
        (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    };
    if let Some(e) = name.strip_prefix("Enum.") {
        let path = format!("enums/{e}.yaml");
        return (valid(e) && present.contains(path.as_str())).then_some((name, path, None));
    }
    let (class, member) = match name.split_once(['.', ':']) {
        Some((c, m)) => (c, Some(m)),
        None => (name, None),
    };
    if !valid(class) || !member.is_none_or(valid) {
        return None;
    }
    let path = KINDS
        .iter()
        .map(|k| format!("{k}/{class}.yaml"))
        .find(|p| present.contains(p.as_str()))?;
    Some((class, path, member))
}

/// What riff sends of the reference file `yaml` for the asked `members`
/// (short names). With none asked, the file without `code_samples` when that
/// fits `limit`. Otherwise its header (the blocks that are not member
/// sections, `code_samples` or `descendants`), an index line per member
/// section, then the asked members' entries under their section key. Capped
/// to `limit` chars, see `cap_chars`.
fn doc_text(yaml: &str, members: &[&str], limit: usize) -> (String, usize) {
    let blocks = top_blocks(yaml);
    if members.is_empty() {
        let whole: String = blocks.iter().filter(|b| b.0 != "code_samples").map(|b| b.1).collect();
        if whole.chars().count() <= limit {
            return cap_chars(&whole, limit);
        }
    }
    let mut out = String::new();
    for (key, text) in &blocks {
        if !MEMBER_KEYS.contains(key) && !NOT_IN_HEADER.contains(key) {
            push_lines(&mut out, text);
        }
    }
    let sections: Vec<(&str, Vec<(&str, &str)>)> = blocks
        .iter()
        .filter(|b| MEMBER_KEYS.contains(&b.0))
        .map(|&(key, text)| (key, member_items(text)))
        .collect();
    for (key, items) in &sections {
        let mut names: Vec<&str> = Vec::new();
        for (n, _) in items {
            if !names.contains(n) {
                names.push(n);
            }
        }
        if !names.is_empty() {
            push_lines(&mut out, &format!("{INDEX_MARK}{key}: {}", names.join(", ")));
        }
    }
    for (key, items) in &sections {
        let asked = |n: &str| members.iter().any(|m| m.eq_ignore_ascii_case(n));
        let mut entries = items.iter().filter(|(n, _)| asked(n)).peekable();
        if entries.peek().is_none() {
            continue;
        }
        push_lines(&mut out, &format!("{key}:"));
        for (_, text) in entries {
            push_lines(&mut out, text);
        }
    }
    cap_chars(&out, limit)
}

/// Appends `text`, ending it with a newline if it lacks one.
fn push_lines(out: &mut String, text: &str) {
    out.push_str(text);
    if !text.ends_with('\n') {
        out.push('\n');
    }
}

/// `yaml` split into top-level blocks, each starting at a key in column 0
/// and running to the next one: (key, block text). Text before the first key
/// is a block with key "".
fn top_blocks(yaml: &str) -> Vec<(&str, &str)> {
    let mut blocks = Vec::new();
    let (mut start, mut key, mut pos) = (0, "", 0);
    for line in yaml.split_inclusive('\n') {
        let first = line.bytes().next().unwrap_or(b' ');
        if first.is_ascii_alphabetic() || first == b'_' {
            if let Some((k, _)) = line.split_once(':') {
                if pos > start {
                    blocks.push((key, &yaml[start..pos]));
                }
                (start, key) = (pos, k.trim());
            }
        }
        pos += line.len();
    }
    if pos > start {
        blocks.push((key, &yaml[start..]));
    }
    blocks
}

/// The entries of a member section block: each one's short name (the part
/// after the last `.` or `:` of `BasePart.Touched`, `Humanoid:TakeDamage`)
/// and its text, from its `- name:` line to the next one. Nested lists
/// (parameters) are indented deeper, so only an entry starts a line with
/// `  - name:`.
fn member_items(block: &str) -> Vec<(&str, &str)> {
    let mut items = Vec::new();
    let mut current: Option<(usize, &str)> = None;
    let mut pos = 0;
    for line in block.split_inclusive('\n') {
        if let Some(rest) = line.strip_prefix("  - name:").or_else(|| line.strip_prefix("- name:")) {
            if let Some((start, name)) = current {
                items.push((name, &block[start..pos]));
            }
            let full = rest.trim().trim_matches(['"', '\'']);
            current = Some((pos, full.rsplit(['.', ':']).next().unwrap_or(full)));
        }
        pos += line.len();
    }
    if let Some((start, name)) = current {
        items.push((name, &block[start..]));
    }
    items
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

    /// Same-named files in several kinds check the lookup order: classes,
    /// datatypes, libraries, enums, globals.
    const FIXTURE: [(&str, &str); 9] = [
        ("classes/BasePart.yaml", "name: BasePart\n"),
        ("classes/Shared.yaml", "name: Shared class\n"),
        ("datatypes/Shared.yaml", "name: Shared datatype\n"),
        ("datatypes/Vector3.yaml", "name: Vector3\n"),
        ("libraries/Vector3.yaml", "name: Vector3 library\n"),
        ("enums/HumanoidStateType.yaml", "name: HumanoidStateType\n"),
        ("enums/math.yaml", "name: math enum\n"),
        ("libraries/math.yaml", "name: math\n"),
        ("globals/LuaGlobals.yaml", LUA_GLOBALS),
    ];

    const LUA_GLOBALS: &str = "name: LuaGlobals\ntype: global\nfunctions:\n  - name: print\n    summary: Prints.\n  - name: pairs\n    summary: Iterates.\n";

    /// A class file laid out like creator-docs' BasePart.yaml (120 KB, its
    /// events near the end): far bigger than `MAX_FILE_CHARS`.
    fn big_class() -> String {
        let mut s = String::from(BIG_HEADER_FULL);
        s += "properties:\n";
        for i in 0..80 {
            let filler = "filler ".repeat(130);
            s += &format!(
                "  - name: BasePart.Prop{i}\n    summary: |\n      {filler}\n    code_samples:\n      - sample-{i}\n    type: float\n"
            );
        }
        s += BIG_METHODS;
        s += "events:\n";
        s += TOUCHED;
        s += TOUCH_ENDED;
        s
    }

    const BIG_HEADER_FULL: &str = "name: BasePart\ntype: class\nsummary: |\n  The base class for parts.\ndescription: |\n  Parts are physical.\n\n  They collide.\ncode_samples:\n  - sample-anchored\ninherits:\n  - PVInstance\ndescendants:\n  - Part\n  - WedgePart\ntags:\n  - NotCreatable\ndeprecation_message: ''\n";
    /// `BIG_HEADER_FULL` without `code_samples` and `descendants`.
    const BIG_HEADER: &str = "name: BasePart\ntype: class\nsummary: |\n  The base class for parts.\ndescription: |\n  Parts are physical.\n\n  They collide.\ninherits:\n  - PVInstance\ntags:\n  - NotCreatable\ndeprecation_message: ''\n";
    const BIG_METHODS: &str = "methods:\n  - name: BasePart:ApplyImpulse\n    summary: |\n      Applies an impulse.\n    parameters:\n      - name: impulse\n        type: Vector3\n";
    const TOUCHED: &str = "  - name: BasePart.Touched\n    summary: |\n      Fires when a part comes in contact with another part.\n    parameters:\n      - name: otherPart\n        type: BasePart\n";
    const TOUCH_ENDED: &str = "  - name: BasePart.TouchEnded\n    summary: |\n      Fires when a part stops touching another part.\n";

    fn big_index() -> String {
        let props: Vec<String> = (0..80).map(|i| format!("Prop{i}")).collect();
        format!(
            "[riff index] properties: {}\n[riff index] methods: ApplyImpulse\n[riff index] events: Touched, TouchEnded\n",
            props.join(", ")
        )
    }

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
        assert!(!partial_dir(&dir, std::process::id()).exists());

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
        assert!(!partial_dir(&dir, std::process::id()).exists());
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
    fn a_dir_that_is_not_a_copy_never_reaches_a_parent_repo() {
        let root = scratch("not-a-copy");
        // A repo above the data folder, like a dotfiles repo in the home folder.
        let home = docs_source(&root, &[("classes/Home.yaml", "name: Home
")]);
        let home_main = git_in(&home, &["rev-parse", "main"]);
        let dir = home.join("data").join(DIR_NAME);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("junk"), "x").unwrap();
        let git = GitCli::new();

        assert_eq!(info(&git, &dir).unwrap(), None);
        assert!(read_apis(&git, &dir, &home_main, &["Home".into()]).is_err());

        let src = docs_source(&root.join("upstream"), &FIXTURE);
        let got = update(&git, &dir, &file_url(&src)).unwrap();
        assert_eq!(got.sha, git_in(&src, &["rev-parse", "HEAD"]));
        assert!(!dir.join("junk").exists(), "the invalid dir was not replaced");
        assert_eq!(git_in(&home, &["rev-parse", "main"]), home_main);
        assert_eq!(info(&git, &dir).unwrap(), Some(got));
    }

    #[test]
    fn stale_partials_of_this_naming_only_are_removed() {
        let root = scratch("partials");
        let dir = root.join(DIR_NAME);
        let names = [
            "roblox-docs.git.partial-1",
            "roblox-docs.git.partial-2x",
            "roblox-docs.git.partial-",
            "roblox-docs.git.partial",
            "other.git.partial-3",
            DIR_NAME,
        ];
        for n in names {
            fs::create_dir_all(root.join(n)).unwrap();
        }
        assert_eq!(partial_dir(&dir, 1), root.join(names[0]));

        remove_stale_partials(&dir, STALE_PARTIAL_AGE);
        assert!(names.iter().all(|n| root.join(n).exists()), "a fresh partial was removed");

        remove_stale_partials(&dir, Duration::ZERO);
        assert!(!root.join(names[0]).exists());
        assert!(names[1..].iter().all(|n| root.join(n).exists()));
    }

    #[test]
    fn rename_retrying_waits_out_a_brief_lock() {
        let root = scratch("rename");
        let from = root.join("from");
        fs::create_dir_all(&from).unwrap();
        // On Windows an open file inside a folder makes renaming the folder fail.
        let held = fs::File::create(from.join("pack")).unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(held);
        });
        rename_retrying(&from, &root.join("to")).unwrap();
        release.join().unwrap();
        assert!(root.join("to").join("pack").exists());

        // A target that appeared (another process won) ends the retries at once.
        fs::create_dir_all(root.join("from2").join("x")).unwrap();
        fs::create_dir_all(root.join("to").join("y")).unwrap();
        let start = std::time::Instant::now();
        assert!(rename_retrying(&root.join("from2"), &root.join("to")).is_err());
        // Retrying would take RENAME_RETRIES delays.
        assert!(start.elapsed() < RENAME_RETRY_DELAY * RENAME_RETRIES);
    }

    #[test]
    fn read_apis_sends_the_asked_members_of_a_big_class() {
        let root = scratch("members");
        let big = big_class();
        assert!(big.len() > MAX_FILE_CHARS + 10_000);
        let src = docs_source(&root, &[("classes/BasePart.yaml", &big)]);
        let dir = root.join("data").join(DIR_NAME);
        let git = GitCli::new();
        let sha = update(&git, &dir, &file_url(&src)).unwrap().sha;
        let read = |names: &[&str]| {
            let names: Vec<String> = names.iter().map(|s| s.to_string()).collect();
            read_apis(&git, &dir, &sha, &names).unwrap()
        };

        // Header, index, then the asked entries under their section, in file
        // order; one doc for the file. Touched lies past the old 60k cut.
        let docs = read(&["BasePart.Touched", "BasePart", "BasePart:ApplyImpulse", "BasePart.touched"]);
        assert_eq!(docs.len(), 1);
        assert_eq!((docs[0].name.as_str(), docs[0].path.as_str()), ("BasePart", "classes/BasePart.yaml"));
        let want = format!("{BIG_HEADER}{}{BIG_METHODS}events:\n{TOUCHED}", big_index());
        assert_eq!(docs[0].text, want);

        // The class alone, too big to send whole: header and index only.
        assert_eq!(read(&["BasePart"])[0].text, format!("{BIG_HEADER}{}", big_index()));
        // An unknown member: the same, so the AI sees what exists.
        assert_eq!(read(&["BasePart.Nope"])[0].text, format!("{BIG_HEADER}{}", big_index()));
    }

    #[test]
    fn doc_text_sends_a_small_class_whole_unless_members_are_asked() {
        let small = format!("{BIG_HEADER_FULL}{BIG_METHODS}events:\n{TOUCHED}");
        let whole = small.replace("code_samples:\n  - sample-anchored\n", "");
        assert_eq!(doc_text(&small, &[], MAX_FILE_CHARS), (whole.clone(), whole.chars().count()));
        let index = "[riff index] methods: ApplyImpulse\n[riff index] events: Touched\n";
        assert_eq!(
            doc_text(&small, &["Touched"], MAX_FILE_CHARS).0,
            format!("{BIG_HEADER}{index}events:\n{TOUCHED}")
        );
        // Too big for the limit: header and index, cut.
        let (text, used) = doc_text(&small, &[], 50);
        assert_eq!(used, 50);
        assert_eq!(text, format!("{}\n[truncated]", &BIG_HEADER[..50]));
    }

    #[test]
    fn read_apis_resolves_bare_enums_and_globals_members() {
        let root = scratch("bare");
        let src = docs_source(&root, &FIXTURE);
        let dir = root.join("data").join(DIR_NAME);
        let git = GitCli::new();
        let sha = update(&git, &dir, &file_url(&src)).unwrap().sha;
        let names: Vec<String> = [
            "HumanoidStateType",
            "wait",
            "LuaGlobals.print",
            "Enum.HumanoidStateType.Running",
            "BasePart.Touched.X",
            "BasePart.",
            ".Touched",
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
                ("HumanoidStateType", "enums/HumanoidStateType.yaml", "name: HumanoidStateType\n"),
                (
                    "LuaGlobals",
                    "globals/LuaGlobals.yaml",
                    "name: LuaGlobals\ntype: global\n[riff index] functions: print, pairs\nfunctions:\n  - name: print\n    summary: Prints.\n"
                ),
            ]
        );
    }

    #[test]
    fn members_count_toward_the_budget_not_the_file_limit() {
        let root = scratch("member-caps");
        let texts: Vec<String> = (0..13)
            .map(|i| format!("name: C{i}\nevents:\n  - name: C{i}.Foo\n    summary: foo\n"))
            .collect();
        let paths: Vec<String> = (0..13).map(|i| format!("classes/C{i}.yaml")).collect();
        let files: Vec<(&str, &str)> = paths.iter().map(String::as_str).zip(texts.iter().map(String::as_str)).collect();
        let src = docs_source(&root, &files);
        let dir = root.join("data").join(DIR_NAME);
        let git = GitCli::new();
        let sha = update(&git, &dir, &file_url(&src)).unwrap().sha;
        let mut names: Vec<String> = (0..13).map(|i| format!("C{i}")).collect();
        names.push("C0.Foo".into());
        names.push("C12.Foo".into());
        let docs = read_apis(&git, &dir, &sha, &names).unwrap();
        assert_eq!(docs.len(), MAX_DOCS);
        assert_eq!(
            docs[0].text,
            "name: C0\n[riff index] events: Foo\nevents:\n  - name: C0.Foo\n    summary: foo\n"
        );
        assert_eq!(docs[1].text, texts[1]);
        assert!(docs.iter().all(|d| d.name != "C12"));

        // A big member eats the budget like any text.
        let (text, used) = doc_text(&big_class(), &["Prop0"], 100);
        assert_eq!(used, 100);
        assert!(text.ends_with("\n[truncated]"));
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
