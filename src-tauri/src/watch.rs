//! Filesystem watcher that tells the frontend when a watched repo *actually*
//! changes — replacing focus-based polling (which re-scanned on every window
//! refocus regardless of whether anything moved).
//!
//! Each watched root is observed recursively. Watching the main repo root also
//! covers its submodules: their worktrees are subdirectories, and their git
//! state lives under `<main>/.git/modules/<name>/`. Events are filtered to the
//! things that change what git would report — git-state files (HEAD / refs /
//! index / merge-state) and non-ignored worktree files — so object/log/lock
//! churn and build-artifact trees (UE `Saved/`, `Intermediate/`, DDC, …) don't
//! spam refreshes. Bursts are debounced into a single `repo-changed` event.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Emit once no relevant event has arrived for this long (burst settled).
const DEBOUNCE_QUIET: Duration = Duration::from_millis(300);
/// Under continuous relevant churn, still emit at least this often so the UI
/// doesn't go stale during a long-running operation.
const DEBOUNCE_MAX: Duration = Duration::from_millis(1500);

#[derive(Clone, Serialize)]
struct RepoChanged {
    /// The watched root that changed (the frontend refreshes its active view).
    path: String,
}

#[derive(Default)]
struct Inner {
    app: Option<AppHandle>,
    /// One recursive watcher per watched root. Dropping it stops the OS watch
    /// and disconnects the debounce thread's channel, so that thread exits.
    watching: HashMap<PathBuf, RecommendedWatcher>,
}

/// Managed Tauri state. The frontend declares which repo roots to watch via
/// `set_repos`; this owns the live watchers and their debounce threads.
#[derive(Default)]
pub struct RepoWatch {
    inner: Mutex<Inner>,
}

impl RepoWatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record the app handle (only available after Tauri `setup`) used to emit
    /// `repo-changed`. Until it's set, `set_repos` no-ops — there'd be nothing
    /// to emit to.
    pub fn set_app(&self, app: AppHandle) {
        self.inner.lock().unwrap().app = Some(app);
    }

    /// Make the live watcher set exactly `paths`: drop watchers no longer
    /// wanted (stops their threads), start one for each new root. Idempotent —
    /// the frontend calls this whenever its repo list changes.
    pub fn set_repos(&self, paths: Vec<PathBuf>) {
        let mut st = self.inner.lock().unwrap();
        let Some(app) = st.app.clone() else {
            return;
        };
        let wanted: HashSet<PathBuf> = paths.into_iter().collect();
        st.watching.retain(|p, _| wanted.contains(p));
        for p in wanted {
            if st.watching.contains_key(&p) {
                continue;
            }
            if let Some(w) = start_watch(&p, app.clone()) {
                st.watching.insert(p, w);
            }
        }
    }
}

/// Start a recursive watch on `repo`, spawning the debounce thread that emits
/// `repo-changed` for it. The returned watcher's lifetime gates the watch.
fn start_watch(repo: &Path, app: AppHandle) -> Option<RecommendedWatcher> {
    if !repo.is_dir() {
        return None;
    }
    let root = repo.to_path_buf();
    let gi = build_gitignore(&root);
    let (tx, rx) = mpsc::channel::<()>();
    let filter_root = root.clone();
    let mut watcher =
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else {
                return;
            };
            if ev.paths.iter().any(|p| is_relevant(p, &filter_root, &gi)) {
                let _ = tx.send(());
            }
        })
        .ok()?;
    watcher.watch(repo, RecursiveMode::Recursive).ok()?;

    let path_str = root.to_string_lossy().to_string();
    thread::spawn(move || debounce_loop(rx, app, path_str));
    Some(watcher)
}

/// Coalesce a burst of relevant events into a single `repo-changed` emit.
/// Returns when the channel is dropped (the watcher was removed).
fn debounce_loop(rx: mpsc::Receiver<()>, app: AppHandle, path: String) {
    loop {
        // Block until the first event of a new burst (Err = channel dropped).
        if rx.recv().is_err() {
            return;
        }
        let started = Instant::now();
        loop {
            match rx.recv_timeout(DEBOUNCE_QUIET) {
                Ok(()) => {
                    if started.elapsed() >= DEBOUNCE_MAX {
                        break; // continuous churn — emit periodically
                    }
                }
                Err(RecvTimeoutError::Timeout) => break, // settled
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        let _ = app.emit("repo-changed", RepoChanged { path: path.clone() });
    }
}

/// Build a gitignore matcher from the repo's root `.gitignore` + `info/exclude`.
/// Nested per-directory `.gitignore`s aren't loaded — the root rules already
/// cover the big build-artifact trees that cause churn; an unreadable file is
/// simply skipped.
fn build_gitignore(root: &Path) -> Gitignore {
    let mut b = GitignoreBuilder::new(root);
    let _ = b.add(root.join(".gitignore"));
    let _ = b.add(root.join(".git").join("info").join("exclude"));
    b.build().unwrap_or_else(|_| Gitignore::empty())
}

/// Whether an FS event at `path` should trigger a refresh. Git-internal paths
/// are whitelisted to the state files that change what git reports; worktree
/// paths pass unless git-ignored.
fn is_relevant(path: &Path, root: &Path, gi: &Gitignore) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return true; // outside the watched root (shouldn't happen) — be safe
    };
    if rel.as_os_str().is_empty() {
        return true; // the root itself
    }
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    match git_internal_relevant(&rel_str) {
        Some(relevant) => relevant,
        None => !gi
            .matched_path_or_any_parents(rel, path.is_dir())
            .is_ignore(),
    }
}

/// For a path inside any `.git/` directory, whether it's a load-bearing state
/// file. `None` means the path isn't git-internal (caller applies gitignore).
fn git_internal_relevant(rel_str: &str) -> Option<bool> {
    let segs: Vec<&str> = rel_str.split('/').collect();
    if !segs.iter().any(|s| *s == ".git") {
        return None;
    }
    if rel_str.ends_with(".lock") {
        return Some(false);
    }
    // Pure noise: object store, reflogs, LFS objects, hook scripts.
    if segs
        .iter()
        .any(|s| matches!(*s, "objects" | "logs" | "lfs" | "hooks"))
    {
        return Some(false);
    }
    let base = *segs.last().unwrap_or(&"");
    if matches!(base, "COMMIT_EDITMSG" | "FETCH_HEAD") {
        return Some(false);
    }
    // Refs (incl. packed-refs), HEAD family, the index, and in-progress
    // operation state are what move the graph / status / conflict banner.
    let relevant = segs
        .iter()
        .any(|s| matches!(*s, "refs" | "rebase-merge" | "rebase-apply" | "sequencer"))
        || matches!(
            base,
            "HEAD"
                | "ORIG_HEAD"
                | "MERGE_HEAD"
                | "CHERRY_PICK_HEAD"
                | "REVERT_HEAD"
                | "packed-refs"
                | "index"
        );
    Some(relevant)
}

#[cfg(test)]
mod tests {
    use super::git_internal_relevant;

    #[test]
    fn git_state_files_are_relevant() {
        for p in [
            ".git/HEAD",
            ".git/packed-refs",
            ".git/index",
            ".git/refs/heads/main",
            ".git/MERGE_HEAD",
            ".git/rebase-merge/done",
            ".git/modules/sub/refs/heads/x", // submodule git state
        ] {
            assert_eq!(git_internal_relevant(p), Some(true), "{p}");
        }
    }

    #[test]
    fn git_noise_is_filtered() {
        for p in [
            ".git/objects/ab/cdef",
            ".git/logs/HEAD",
            ".git/index.lock",
            ".git/refs/heads/main.lock",
            ".git/COMMIT_EDITMSG",
            ".git/FETCH_HEAD",
        ] {
            assert_eq!(git_internal_relevant(p), Some(false), "{p}");
        }
    }

    #[test]
    fn worktree_paths_are_not_git_internal() {
        assert_eq!(git_internal_relevant("src/main.rs"), None);
        assert_eq!(git_internal_relevant("Saved/Logs/foo.log"), None);
    }
}
