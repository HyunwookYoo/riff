pub mod ai;
pub mod diff;
pub mod git;
pub mod github;
pub mod store;
pub mod watch;

use std::path::Path;

use git::{
    Blame, Branch, BranchStatus, ChangedFile, Commit, CommitFind, Containment, ContainmentDetail,
    ConflictVersions, DiffMode, FileDiff, FileStatus, GitCli, GitError, GitLayer, RebaseCheck,
    RebaseStep, ReflogEntry, RepoStatus, SquashCheck, SubmoduleInfo,
};
use store::{PersistedState, StoreError};
use tauri::Manager;

/// Ids of rebase checks the frontend has asked to stop. A running check polls
/// (and consumes) its own id between replay steps.
#[derive(Default)]
struct RebaseChecks(std::sync::Mutex<std::collections::HashSet<u32>>);

/// Ids of gh logins the frontend has asked to stop; same protocol as
/// `RebaseChecks` (the running login polls and kills gh).
#[derive(Default)]
struct GhLogins(std::sync::Mutex<std::collections::HashSet<u32>>);

/// Ids of AI runs the frontend has asked to stop; same protocol as
/// `RebaseChecks` (the running run polls and kills claude).
#[derive(Default)]
struct AiRuns(std::sync::Mutex<std::collections::HashSet<u32>>);

#[derive(Clone, serde::Serialize)]
struct RebaseCheckProgress {
    done: u32,
    total: u32,
}

#[tauri::command]
async fn validate_repo(state: tauri::State<'_, GitCli>, path: String) -> Result<String, GitError> {
    state.validate_repo(Path::new(&path))
}

#[tauri::command]
async fn list_refs(state: tauri::State<'_, GitCli>, path: String) -> Result<Vec<Branch>, GitError> {
    state.list_refs(Path::new(&path))
}

#[tauri::command]
async fn commit_log(
    state: tauri::State<'_, GitCli>,
    path: String,
    start_ref: String,
    all: bool,
    limit: u32,
    skip: u32,
) -> Result<Vec<Commit>, GitError> {
    state.commit_log(Path::new(&path), &start_ref, all, limit, skip)
}

#[tauri::command]
async fn status(state: tauri::State<'_, GitCli>, path: String) -> Result<RepoStatus, GitError> {
    state.status(Path::new(&path))
}

#[tauri::command]
async fn diff_files(
    state: tauri::State<'_, GitCli>,
    path: String,
    start: String,
    target: String,
    mode: DiffMode,
    ignore_whitespace: bool,
    on_file: tauri::ipc::Channel<ChangedFile>,
) -> Result<(), GitError> {
    state.diff_files(
        Path::new(&path),
        &start,
        &target,
        mode,
        ignore_whitespace,
        &mut |f| {
            on_file
                .send(f)
                .map_err(|e| GitError::CommandFailed(e.to_string()))
        },
    )
}

#[tauri::command]
async fn file_diff(
    app: tauri::AppHandle,
    state: tauri::State<'_, GitCli>,
    path: String,
    start: String,
    target: String,
    mode: DiffMode,
    file_path: String,
    old_path: Option<String>,
    force: bool,
    ue_version: Option<String>,
) -> Result<FileDiff, GitError> {
    let cfg = uasset_config(&app, ue_version);
    state.file_diff(
        Path::new(&path),
        &start,
        &target,
        mode,
        &file_path,
        old_path.as_deref(),
        force,
        &cfg,
    )
}

/// Assemble the Unreal-asset derive config from persisted settings plus the
/// frontend's per-repo engine-version choice. Falls back to a recent default
/// version when none is provided.
fn uasset_config(app: &tauri::AppHandle, ue_version: Option<String>) -> git::uasset::Config {
    let state = store::load(app).unwrap_or_default();
    // A user-set path wins (power users / custom installs); otherwise use the
    // self-contained UAssetGUI bundled with the app so end users need zero
    // setup.
    let (uassetgui_path, uassetgui_bundled) = match state.uassetgui_path {
        Some(p) => (Some(p), false),
        None => (bundled_uassetgui_path(app), true),
    };
    git::uasset::Config {
        enabled: state.parse_unreal_assets,
        uassetgui_path,
        uassetgui_bundled,
        engine_version: ue_version
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "5.5".to_string()),
    }
}

/// Path to the UAssetGUI executable bundled as a Tauri resource, if present.
/// Bundled via `bundle.resources` (see tauri.conf.json) and produced by the
/// release CI. Absent in plain `tauri dev` builds — there the settings
/// override is used instead.
fn bundled_uassetgui_path(app: &tauri::AppHandle) -> Option<String> {
    let dir = app.path().resource_dir().ok()?;
    let exe = dir
        .join("resources")
        .join("uassetgui")
        .join("UAssetGUI.exe");
    exe.is_file().then(|| exe.to_string_lossy().into_owned())
}

/// The gh bundled as a Tauri resource by the release CI (absent in dev
/// builds, which use the system gh).
fn bundled_gh_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    let exe = dir.join("resources").join("gh").join("gh.exe");
    exe.is_file().then_some(exe)
}

#[tauri::command]
async fn changes_file_diff(
    app: tauri::AppHandle,
    state: tauri::State<'_, GitCli>,
    path: String,
    file_path: String,
    old_path: Option<String>,
    status: FileStatus,
    force: bool,
    ue_version: Option<String>,
) -> Result<FileDiff, GitError> {
    let cfg = uasset_config(&app, ue_version);
    state.changes_file_diff(
        Path::new(&path),
        &file_path,
        old_path.as_deref(),
        status,
        force,
        &cfg,
    )
}

#[tauri::command]
async fn create_branch(
    state: tauri::State<'_, GitCli>,
    path: String,
    name: String,
    start_point: Option<String>,
    checkout: bool,
) -> Result<(), GitError> {
    state.create_branch(Path::new(&path), &name, start_point.as_deref(), checkout)
}

#[tauri::command]
async fn checkout(state: tauri::State<'_, GitCli>, path: String, ref_name: String) -> Result<(), GitError> {
    state.checkout(Path::new(&path), &ref_name)
}

#[tauri::command]
async fn fast_forward(
    state: tauri::State<'_, GitCli>,
    path: String,
    ref_name: String,
) -> Result<(), GitError> {
    state.fast_forward(Path::new(&path), &ref_name)
}

#[tauri::command]
async fn conflict_versions(
    state: tauri::State<'_, GitCli>,
    path: String,
    file_path: String,
) -> Result<ConflictVersions, GitError> {
    state.conflict_versions(Path::new(&path), &file_path)
}

#[tauri::command]
async fn resolve_conflict(
    state: tauri::State<'_, GitCli>,
    path: String,
    file_path: String,
    content: String,
) -> Result<(), GitError> {
    state.resolve_conflict(Path::new(&path), &file_path, &content)
}

#[tauri::command]
async fn checkout_conflict_side(
    state: tauri::State<'_, GitCli>,
    path: String,
    file_path: String,
    side: String,
) -> Result<(), GitError> {
    state.checkout_conflict_side(Path::new(&path), &file_path, &side)
}

#[tauri::command]
async fn rename_branch(
    state: tauri::State<'_, GitCli>,
    path: String,
    old: String,
    new: String,
) -> Result<(), GitError> {
    state.rename_branch(Path::new(&path), &old, &new)
}

#[tauri::command]
async fn delete_branch(
    state: tauri::State<'_, GitCli>,
    path: String,
    name: String,
    force: bool,
) -> Result<(), GitError> {
    state.delete_branch(Path::new(&path), &name, force)
}

#[tauri::command]
async fn reflog(
    state: tauri::State<'_, GitCli>,
    path: String,
) -> Result<Vec<ReflogEntry>, GitError> {
    state.reflog(Path::new(&path))
}

#[tauri::command]
async fn fetch(state: tauri::State<'_, GitCli>, path: String) -> Result<(), GitError> {
    state.fetch(Path::new(&path))
}

#[tauri::command]
async fn pull(state: tauri::State<'_, GitCli>, path: String) -> Result<(), GitError> {
    state.pull(Path::new(&path))
}

#[tauri::command]
async fn branch_status(
    state: tauri::State<'_, GitCli>,
    path: String,
) -> Result<BranchStatus, GitError> {
    state.branch_status(Path::new(&path))
}

#[tauri::command]
async fn push(
    state: tauri::State<'_, GitCli>,
    path: String,
    branch: String,
    force: bool,
) -> Result<(), GitError> {
    state.push(Path::new(&path), &branch, force)
}

#[tauri::command]
async fn rebase_plan(
    state: tauri::State<'_, GitCli>,
    path: String,
    upstream: String,
    branch: String,
) -> Result<Vec<Commit>, GitError> {
    state.rebase_plan(Path::new(&path), &upstream, &branch)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn rebase_check(
    state: tauri::State<'_, GitCli>,
    checks: tauri::State<'_, RebaseChecks>,
    path: String,
    upstream: String,
    branch: String,
    steps: Option<Vec<RebaseStep>>,
    id: u32,
    on_progress: tauri::ipc::Channel<RebaseCheckProgress>,
) -> Result<RebaseCheck, GitError> {
    let result = state.rebase_check(
        Path::new(&path),
        &upstream,
        &branch,
        steps.as_deref(),
        &mut |done, total| {
            let _ = on_progress.send(RebaseCheckProgress { done, total });
            !checks.0.lock().unwrap().remove(&id)
        },
    );
    checks.0.lock().unwrap().remove(&id);
    result
}

#[tauri::command]
fn cancel_rebase_check(checks: tauri::State<'_, RebaseChecks>, id: u32) {
    checks.0.lock().unwrap().insert(id);
}

#[tauri::command]
async fn rebase(
    state: tauri::State<'_, GitCli>,
    path: String,
    upstream: String,
    branch: Option<String>,
) -> Result<bool, GitError> {
    state.rebase(Path::new(&path), &upstream, branch.as_deref())
}

#[tauri::command]
async fn rebase_interactive(
    state: tauri::State<'_, GitCli>,
    path: String,
    upstream: String,
    branch: Option<String>,
    steps: Vec<RebaseStep>,
) -> Result<bool, GitError> {
    state.rebase_interactive(Path::new(&path), &upstream, branch.as_deref(), &steps)
}

#[tauri::command]
async fn pending_op(state: tauri::State<'_, GitCli>, path: String) -> Result<String, GitError> {
    state.pending_op(Path::new(&path))
}

#[tauri::command]
async fn op_abort(state: tauri::State<'_, GitCli>, path: String, op: String) -> Result<bool, GitError> {
    state.op_abort(Path::new(&path), &op)
}

#[tauri::command]
async fn op_continue(state: tauri::State<'_, GitCli>, path: String, op: String) -> Result<bool, GitError> {
    state.op_continue(Path::new(&path), &op)
}

#[tauri::command]
async fn op_skip(state: tauri::State<'_, GitCli>, path: String, op: String) -> Result<bool, GitError> {
    state.op_skip(Path::new(&path), &op)
}

#[tauri::command]
async fn list_repo_files(state: tauri::State<'_, GitCli>, path: String) -> Result<Vec<String>, GitError> {
    state.list_repo_files(Path::new(&path))
}

/// Read a tracked file's working-tree contents for the blame view. Path safety
/// is enforced here (no absolute paths, no `..` traversal) because this
/// bypasses git's index — it reads straight from disk.
#[tauri::command]
async fn read_repo_file(path: String, file_path: String) -> Result<String, GitError> {
    use std::fs;
    use std::path::Component;

    if file_path.is_empty() {
        return Err(GitError::CommandFailed("empty file path".into()));
    }
    let rel = Path::new(&file_path);
    if rel.is_absolute() {
        return Err(GitError::CommandFailed("absolute path not allowed".into()));
    }
    if rel
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir))
    {
        return Err(GitError::CommandFailed(
            "invalid path component in file path".into(),
        ));
    }

    let full = Path::new(&path).join(rel);
    // Report the resolved path on failure: a bare "os error 3" (path not found)
    // gives no clue that, e.g., a submodule file was resolved against the wrong
    // repo root.
    let meta = fs::metadata(&full)
        .map_err(|e| GitError::CommandFailed(format!("cannot read {}: {e}", full.display())))?;
    // Hard cap so a stray binary or huge log file can't lock up the editor.
    const BLAME_READ_CAP: u64 = 2_000_000;
    if meta.len() > BLAME_READ_CAP {
        return Err(GitError::CommandFailed(format!(
            "file too large for blame view ({} bytes)",
            meta.len()
        )));
    }
    let bytes = fs::read(&full)
        .map_err(|e| GitError::CommandFailed(format!("cannot read {}: {e}", full.display())))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
async fn blame_file(
    state: tauri::State<'_, GitCli>,
    path: String,
    file_path: String,
    rev: String,
    use_contents: bool,
) -> Result<Blame, GitError> {
    state.blame_file(Path::new(&path), &file_path, &rev, use_contents)
}

#[tauri::command]
async fn file_revisions(
    state: tauri::State<'_, GitCli>,
    path: String,
    file_path: String,
) -> Result<Vec<Commit>, GitError> {
    state.file_revisions(Path::new(&path), &file_path)
}

#[tauri::command]
async fn timelapse_frame(
    state: tauri::State<'_, GitCli>,
    path: String,
    sha: String,
    prev_sha: Option<String>,
    file_path: String,
) -> Result<FileDiff, GitError> {
    state.timelapse_frame(Path::new(&path), &sha, prev_sha.as_deref(), &file_path)
}

#[tauri::command]
async fn list_submodules(
    state: tauri::State<'_, GitCli>,
    path: String,
) -> Result<Vec<SubmoduleInfo>, GitError> {
    state.list_submodules(Path::new(&path))
}

#[tauri::command]
async fn submodule_sha_at(
    state: tauri::State<'_, GitCli>,
    path: String,
    tree_ish: String,
    submodule_path: String,
) -> Result<Option<String>, GitError> {
    state.submodule_sha_at(Path::new(&path), &tree_ish, &submodule_path)
}

#[tauri::command]
async fn has_commit(
    state: tauri::State<'_, GitCli>,
    path: String,
    rev: String,
) -> Result<bool, GitError> {
    state.has_commit(Path::new(&path), &rev)
}

#[tauri::command]
async fn git_remotes(
    state: tauri::State<'_, GitCli>,
    path: String,
) -> Result<Vec<git::Remote>, GitError> {
    state.remote_urls(Path::new(&path))
}

#[tauri::command]
async fn fetch_pr(
    state: tauri::State<'_, GitCli>,
    path: String,
    remote: String,
    number: u32,
    base_ref: String,
    base_sha: String,
) -> Result<String, GitError> {
    state.fetch_pr(Path::new(&path), &remote, number, &base_ref, &base_sha)
}

#[tauri::command]
async fn gh_status(host: String) -> github::GhStatus {
    github::status(&host)
}

#[tauri::command]
async fn gh_api(
    host: String,
    method: String,
    endpoint: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, github::GhError> {
    github::api(&host, &method, &endpoint, body.as_ref())
}

#[tauri::command]
async fn gh_login(
    logins: tauri::State<'_, GhLogins>,
    host: String,
    on_event: tauri::ipc::Channel<github::LoginEvent>,
    id: u32,
) -> Result<(), github::GhError> {
    let result = github::login(
        &host,
        &mut |ev| {
            let _ = on_event.send(ev);
        },
        &mut || logins.0.lock().unwrap().remove(&id),
    );
    logins.0.lock().unwrap().remove(&id);
    result
}

#[tauri::command]
fn cancel_gh_login(logins: tauri::State<'_, GhLogins>, id: u32) {
    logins.0.lock().unwrap().insert(id);
}

/// A run takes minutes, so it gets a blocking-pool thread rather than one of
/// the async runtime's workers.
#[tauri::command]
async fn ai_run(
    app: tauri::AppHandle,
    path: String,
    prompt: String,
    schema: String,
    model: Option<String>,
    id: u32,
    on_event: tauri::ipc::Channel<ai::AiEvent>,
) -> Result<serde_json::Value, ai::AiError> {
    tauri::async_runtime::spawn_blocking(move || {
        let runs = app.state::<AiRuns>();
        let result = ai::run(
            Path::new(&path),
            &prompt,
            &schema,
            model.as_deref(),
            &mut |ev| {
                let _ = on_event.send(ev);
            },
            &|| runs.0.lock().unwrap().remove(&id),
        );
        runs.0.lock().unwrap().remove(&id);
        result
    })
    .await
    .map_err(|e| ai::AiError::Failed(e.to_string()))?
}

#[tauri::command]
fn cancel_ai_run(runs: tauri::State<'_, AiRuns>, id: u32) {
    runs.0.lock().unwrap().insert(id);
}

#[tauri::command]
async fn pr_hunks(
    state: tauri::State<'_, GitCli>,
    path: String,
    base: String,
    head: String,
) -> Result<git::PrHunks, GitError> {
    state.pr_hunks(Path::new(&path), &base, &head)
}

#[tauri::command]
async fn pr_diff_text(
    state: tauri::State<'_, GitCli>,
    path: String,
    merge_base: String,
    head: String,
) -> Result<String, GitError> {
    state.pr_diff_text(Path::new(&path), &merge_base, &head)
}

#[tauri::command]
async fn pr_commit_subjects(
    state: tauri::State<'_, GitCli>,
    path: String,
    merge_base: String,
    head: String,
) -> Result<Vec<String>, GitError> {
    state.pr_commit_subjects(Path::new(&path), &merge_base, &head)
}

#[tauri::command]
async fn pr_changed_files(
    state: tauri::State<'_, GitCli>,
    path: String,
    base: String,
    old_head: String,
    new_head: String,
) -> Result<Vec<String>, GitError> {
    state.pr_changed_files(Path::new(&path), &base, &old_head, &new_head)
}

#[tauri::command]
async fn mark_pr_seen(
    state: tauri::State<'_, GitCli>,
    path: String,
    number: u32,
    sha: String,
) -> Result<(), GitError> {
    state.mark_pr_seen(Path::new(&path), number, &sha)
}

#[tauri::command]
async fn read_file_at(
    state: tauri::State<'_, GitCli>,
    path: String,
    rev: String,
    file_path: String,
) -> Result<String, GitError> {
    state.read_file_at(Path::new(&path), &rev, &file_path)
}

#[tauri::command]
async fn containment(
    state: tauri::State<'_, GitCli>,
    path: String,
    source: String,
    target: String,
) -> Result<Containment, GitError> {
    state.containment(Path::new(&path), &source, &target)
}

#[tauri::command]
async fn commit_log_excluding(
    state: tauri::State<'_, GitCli>,
    path: String,
    source: String,
    target: String,
    limit: u32,
    skip: u32,
) -> Result<Vec<Commit>, GitError> {
    state.commit_log_excluding(Path::new(&path), &source, &target, limit, skip)
}

#[tauri::command]
async fn commit_containment_detail(
    state: tauri::State<'_, GitCli>,
    path: String,
    sha: String,
    target: String,
) -> Result<ContainmentDetail, GitError> {
    state.commit_containment_detail(Path::new(&path), &sha, &target)
}

#[tauri::command]
async fn find_commit(
    state: tauri::State<'_, GitCli>,
    path: String,
    prefix: String,
    source: String,
    target: String,
    list_exclude: Option<String>,
) -> Result<CommitFind, GitError> {
    state.find_commit(Path::new(&path), &prefix, &source, &target, list_exclude.as_deref())
}

#[tauri::command]
async fn squash_check(
    state: tauri::State<'_, GitCli>,
    path: String,
    source: String,
    target: String,
) -> Result<SquashCheck, GitError> {
    state.squash_check(Path::new(&path), &source, &target)
}

#[tauri::command]
fn load_state(app: tauri::AppHandle) -> Result<PersistedState, StoreError> {
    store::load(&app)
}

#[tauri::command]
fn add_recent_repo(app: tauri::AppHandle, path: String) -> Result<Vec<String>, StoreError> {
    store::add_recent_repo(&app, path)
}

#[tauri::command]
fn remove_recent_repo(app: tauri::AppHandle, path: String) -> Result<Vec<String>, StoreError> {
    store::remove_recent_repo(&app, path)
}

#[tauri::command]
fn set_theme(app: tauri::AppHandle, theme: String) -> Result<(), StoreError> {
    store::set_theme(&app, theme)
}

#[tauri::command]
fn set_font_size(app: tauri::AppHandle, size: u8) -> Result<(), StoreError> {
    store::set_font_size(&app, size)
}

#[tauri::command]
fn set_compare_mode(app: tauri::AppHandle, mode: String) -> Result<(), StoreError> {
    store::set_compare_mode(&app, mode)
}

#[tauri::command]
fn set_workspace_layout(app: tauri::AppHandle, layout: String) -> Result<(), StoreError> {
    store::set_workspace_layout(&app, layout)
}

#[tauri::command]
fn set_blame_picker_width(app: tauri::AppHandle, width: u32) -> Result<(), StoreError> {
    store::set_blame_picker_width(&app, width)
}

#[tauri::command]
fn set_file_view_mode(app: tauri::AppHandle, mode: String) -> Result<(), StoreError> {
    store::set_file_view_mode(&app, mode)
}

#[tauri::command]
fn set_graph_row_height(app: tauri::AppHandle, height: u32) -> Result<(), StoreError> {
    store::set_graph_row_height(&app, height)
}

#[tauri::command]
fn set_parse_unreal_assets(app: tauri::AppHandle, enabled: bool) -> Result<(), StoreError> {
    store::set_parse_unreal_assets(&app, enabled)
}

#[tauri::command]
fn set_uassetgui_path(app: tauri::AppHandle, path: Option<String>) -> Result<(), StoreError> {
    store::set_uassetgui_path(&app, path)
}

#[tauri::command]
fn set_ue_version_for_repo(
    app: tauri::AppHandle,
    repo: String,
    version: String,
) -> Result<(), StoreError> {
    store::set_ue_version_for_repo(&app, repo, version)
}

#[tauri::command]
fn add_manual_repo(
    app: tauri::AppHandle,
    main_repo: String,
    repo: String,
) -> Result<Vec<String>, StoreError> {
    store::add_manual_repo(&app, main_repo, repo)
}

#[tauri::command]
fn remove_manual_repo(
    app: tauri::AppHandle,
    main_repo: String,
    repo: String,
) -> Result<Vec<String>, StoreError> {
    store::remove_manual_repo(&app, main_repo, repo)
}

#[tauri::command]
fn set_tab_order(
    app: tauri::AppHandle,
    main_repo: String,
    order: Vec<String>,
) -> Result<(), StoreError> {
    store::set_tab_order(&app, main_repo, order)
}

#[tauri::command]
fn load_review(app: tauri::AppHandle, key: String) -> Result<Option<serde_json::Value>, StoreError> {
    store::review::load(&app, &key)
}

#[tauri::command]
fn save_review(
    app: tauri::AppHandle,
    key: String,
    value: serde_json::Value,
) -> Result<(), StoreError> {
    store::review::save(&app, &key, &value)
}

#[tauri::command]
fn delete_review(app: tauri::AppHandle, key: String) -> Result<(), StoreError> {
    store::review::delete(&app, &key)
}

#[tauri::command]
fn list_reviews(app: tauri::AppHandle) -> Result<Vec<String>, StoreError> {
    store::review::list(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Declare which repo roots the filesystem watcher should observe (main repo +
/// any manual repos; submodules are covered by the main root's recursive watch).
/// The watcher emits `repo-changed` so the UI refreshes on real changes instead
/// of polling on every window refocus.
#[tauri::command]
fn set_watched_repos(watch: tauri::State<watch::RepoWatch>, paths: Vec<String>) {
    watch.set_repos(paths.into_iter().map(std::path::PathBuf::from).collect());
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(GitCli::new())
        .manage(watch::RepoWatch::new())
        .manage(RebaseChecks::default())
        .manage(GhLogins::default())
        .manage(AiRuns::default())
        .setup(|app| {
            // The watcher needs an AppHandle to emit events; it only exists now.
            app.state::<watch::RepoWatch>()
                .set_app(app.handle().clone());
            if let Some(gh) = bundled_gh_path(app.handle()) {
                github::set_bundled_gh(gh);
            }
            Ok(())
        })
        // The PR Review drafts window can't work alone (the main window owns
        // submit): closing the main window closes it too, through a normal
        // close request so its close handler saves typed text first. The app
        // then quits as its last window closes; the timer only backs up a
        // drafts window that never finishes closing.
        .on_window_event(|window, event| {
            if window.label() != "main" || !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }
            let app = window.app_handle().clone();
            match app.get_webview_window("review-drafts") {
                Some(drafts) => {
                    let _ = drafts.close();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(5));
                        app.exit(0);
                    });
                }
                None => app.exit(0),
            }
        })
        .invoke_handler(tauri::generate_handler![
            validate_repo,
            list_refs,
            commit_log,
            status,
            diff_files,
            file_diff,
            changes_file_diff,
            create_branch,
            checkout,
            fast_forward,
            conflict_versions,
            resolve_conflict,
            checkout_conflict_side,
            rename_branch,
            delete_branch,
            reflog,
            fetch,
            pull,
            branch_status,
            push,
            rebase_plan,
            rebase_check,
            cancel_rebase_check,
            rebase,
            rebase_interactive,
            pending_op,
            op_abort,
            op_continue,
            op_skip,
            blame_file,
            file_revisions,
            timelapse_frame,
            list_repo_files,
            read_repo_file,
            list_submodules,
            submodule_sha_at,
            has_commit,
            git_remotes,
            fetch_pr,
            gh_status,
            gh_api,
            gh_login,
            cancel_gh_login,
            ai_run,
            cancel_ai_run,
            pr_hunks,
            pr_diff_text,
            pr_commit_subjects,
            pr_changed_files,
            mark_pr_seen,
            read_file_at,
            containment,
            commit_log_excluding,
            commit_containment_detail,
            find_commit,
            squash_check,
            load_state,
            add_recent_repo,
            remove_recent_repo,
            set_theme,
            set_font_size,
            set_compare_mode,
            set_workspace_layout,
            set_blame_picker_width,
            set_file_view_mode,
            set_graph_row_height,
            set_parse_unreal_assets,
            set_uassetgui_path,
            set_ue_version_for_repo,
            add_manual_repo,
            remove_manual_repo,
            set_tab_order,
            load_review,
            save_review,
            delete_review,
            list_reviews,
            set_watched_repos,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
