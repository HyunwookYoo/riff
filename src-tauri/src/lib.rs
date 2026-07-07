pub mod diff;
pub mod git;
pub mod store;
pub mod watch;

use std::path::Path;

use git::{
    Blame, Branch, ChangedFile, Commit, Containment, ContainmentDetail, ConflictVersions, DiffMode,
    FileDiff, FileStatus, GitCli, GitError, GitLayer, Hunk, RepoStatus, Stash, SubmoduleInfo,
};
use store::{PersistedState, StoreError};
use tauri::Manager;

#[tauri::command]
async fn validate_repo(state: tauri::State<'_, GitCli>, path: String) -> Result<(), GitError> {
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
    let uassetgui_path = state
        .uassetgui_path
        .or_else(|| bundled_uassetgui_path(app));
    git::uasset::Config {
        enabled: state.parse_unreal_assets,
        uassetgui_path,
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

#[tauri::command]
async fn changes_file_diff(
    app: tauri::AppHandle,
    state: tauri::State<'_, GitCli>,
    path: String,
    file_path: String,
    old_path: Option<String>,
    status: FileStatus,
    staged: bool,
    force: bool,
    ue_version: Option<String>,
) -> Result<FileDiff, GitError> {
    let cfg = uasset_config(&app, ue_version);
    state.changes_file_diff(
        Path::new(&path),
        &file_path,
        old_path.as_deref(),
        status,
        staged,
        force,
        &cfg,
    )
}

#[tauri::command]
async fn stage(
    state: tauri::State<'_, GitCli>,
    path: String,
    files: Option<Vec<String>>,
) -> Result<(), GitError> {
    state.stage(Path::new(&path), files.as_deref())
}

#[tauri::command]
async fn unstage(
    state: tauri::State<'_, GitCli>,
    path: String,
    files: Option<Vec<String>>,
) -> Result<(), GitError> {
    state.unstage(Path::new(&path), files.as_deref())
}

#[tauri::command]
async fn discard_paths(
    state: tauri::State<'_, GitCli>,
    path: String,
    paths: Vec<String>,
) -> Result<(), GitError> {
    state.discard_paths(Path::new(&path), &paths)
}

#[tauri::command]
async fn commit(
    state: tauri::State<'_, GitCli>,
    path: String,
    subject: String,
    body: String,
    amend: bool,
    signoff: bool,
    coauthors: Vec<String>,
) -> Result<(), GitError> {
    state.commit(
        Path::new(&path),
        &subject,
        &body,
        amend,
        signoff,
        &coauthors,
    )
}

#[tauri::command]
async fn head_commit_message(state: tauri::State<'_, GitCli>, path: String) -> Result<String, GitError> {
    state.head_commit_message(Path::new(&path))
}

#[tauri::command]
async fn commit_paths(
    state: tauri::State<'_, GitCli>,
    path: String,
    paths: Vec<String>,
    subject: String,
    body: String,
    signoff: bool,
    coauthors: Vec<String>,
) -> Result<(), GitError> {
    state.commit_paths(Path::new(&path), &paths, &subject, &body, signoff, &coauthors)
}

#[tauri::command]
async fn load_changelists(state: tauri::State<'_, GitCli>, path: String) -> Result<String, GitError> {
    state.load_changelists(Path::new(&path))
}

#[tauri::command]
async fn save_changelists(
    state: tauri::State<'_, GitCli>,
    path: String,
    data: String,
) -> Result<(), GitError> {
    state.save_changelists(Path::new(&path), &data)
}

#[tauri::command]
async fn file_hunks(
    state: tauri::State<'_, GitCli>,
    path: String,
    file_path: String,
    staged: bool,
) -> Result<Vec<Hunk>, GitError> {
    state.file_hunks(Path::new(&path), &file_path, staged)
}

#[tauri::command]
async fn apply_hunks(
    state: tauri::State<'_, GitCli>,
    path: String,
    file_path: String,
    staged: bool,
    hunks: Vec<u32>,
) -> Result<(), GitError> {
    state.apply_hunks(Path::new(&path), &file_path, staged, &hunks)
}

#[tauri::command]
async fn discard_hunks(
    state: tauri::State<'_, GitCli>,
    path: String,
    file_path: String,
    hunks: Vec<u32>,
) -> Result<(), GitError> {
    state.discard_hunks(Path::new(&path), &file_path, &hunks)
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
async fn force_checkout(
    state: tauri::State<'_, GitCli>,
    path: String,
    ref_name: String,
) -> Result<(), GitError> {
    state.force_checkout(Path::new(&path), &ref_name)
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
async fn stash_checkout(
    state: tauri::State<'_, GitCli>,
    path: String,
    ref_name: String,
) -> Result<(), GitError> {
    state.stash_checkout(Path::new(&path), &ref_name)
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
async fn set_upstream(
    state: tauri::State<'_, GitCli>,
    path: String,
    branch: String,
    upstream: String,
) -> Result<(), GitError> {
    state.set_upstream(Path::new(&path), &branch, &upstream)
}

#[tauri::command]
async fn create_tag(
    state: tauri::State<'_, GitCli>,
    path: String,
    name: String,
    target: String,
) -> Result<(), GitError> {
    state.create_tag(Path::new(&path), &name, &target)
}

#[tauri::command]
async fn reset(
    state: tauri::State<'_, GitCli>,
    path: String,
    target: String,
    mode: String,
) -> Result<(), GitError> {
    state.reset(Path::new(&path), &target, &mode)
}

#[tauri::command]
async fn cherry_pick(
    state: tauri::State<'_, GitCli>,
    path: String,
    target: String,
) -> Result<(), GitError> {
    state.cherry_pick(Path::new(&path), &target)
}

#[tauri::command]
async fn revert(state: tauri::State<'_, GitCli>, path: String, target: String) -> Result<(), GitError> {
    state.revert(Path::new(&path), &target)
}

#[tauri::command]
async fn rebase(state: tauri::State<'_, GitCli>, path: String, onto: String) -> Result<(), GitError> {
    state.rebase(Path::new(&path), &onto)
}

#[tauri::command]
async fn stash_rebase(state: tauri::State<'_, GitCli>, path: String, onto: String) -> Result<(), GitError> {
    state.stash_rebase(Path::new(&path), &onto)
}

#[tauri::command]
async fn fetch(state: tauri::State<'_, GitCli>, path: String) -> Result<(), GitError> {
    state.fetch(Path::new(&path))
}

#[tauri::command]
async fn pull(state: tauri::State<'_, GitCli>, path: String, rebase: bool) -> Result<(), GitError> {
    state.pull(Path::new(&path), rebase)
}

#[tauri::command]
async fn push(
    state: tauri::State<'_, GitCli>,
    path: String,
    set_upstream_branch: Option<String>,
    force: bool,
) -> Result<(), GitError> {
    state.push(Path::new(&path), set_upstream_branch.as_deref(), force)
}

#[tauri::command]
async fn merge(state: tauri::State<'_, GitCli>, path: String, branch: String) -> Result<(), GitError> {
    state.merge(Path::new(&path), &branch)
}

#[tauri::command]
async fn stash_list(state: tauri::State<'_, GitCli>, path: String) -> Result<Vec<Stash>, GitError> {
    state.stash_list(Path::new(&path))
}

#[tauri::command]
async fn stash_save(
    state: tauri::State<'_, GitCli>,
    path: String,
    message: Option<String>,
    include_untracked: bool,
) -> Result<(), GitError> {
    state.stash_save(Path::new(&path), message.as_deref(), include_untracked)
}

#[tauri::command]
async fn stash_apply(
    state: tauri::State<'_, GitCli>,
    path: String,
    index: u32,
    pop: bool,
) -> Result<(), GitError> {
    state.stash_apply(Path::new(&path), index, pop)
}

#[tauri::command]
async fn stash_drop(state: tauri::State<'_, GitCli>, path: String, index: u32) -> Result<(), GitError> {
    state.stash_drop(Path::new(&path), index)
}

#[tauri::command]
async fn pending_op(state: tauri::State<'_, GitCli>, path: String) -> Result<String, GitError> {
    state.pending_op(Path::new(&path))
}

#[tauri::command]
async fn op_abort(state: tauri::State<'_, GitCli>, path: String, op: String) -> Result<(), GitError> {
    state.op_abort(Path::new(&path), &op)
}

#[tauri::command]
async fn op_continue(state: tauri::State<'_, GitCli>, path: String, op: String) -> Result<(), GitError> {
    state.op_continue(Path::new(&path), &op)
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
        .manage(GitCli::new())
        .manage(watch::RepoWatch::new())
        .setup(|app| {
            // The watcher needs an AppHandle to emit events; it only exists now.
            app.state::<watch::RepoWatch>()
                .set_app(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            validate_repo,
            list_refs,
            commit_log,
            status,
            diff_files,
            file_diff,
            changes_file_diff,
            stage,
            unstage,
            discard_paths,
            commit,
            head_commit_message,
            commit_paths,
            load_changelists,
            save_changelists,
            file_hunks,
            apply_hunks,
            discard_hunks,
            create_branch,
            checkout,
            force_checkout,
            fast_forward,
            stash_checkout,
            conflict_versions,
            resolve_conflict,
            checkout_conflict_side,
            rename_branch,
            delete_branch,
            set_upstream,
            create_tag,
            reset,
            cherry_pick,
            revert,
            rebase,
            stash_rebase,
            fetch,
            pull,
            push,
            merge,
            pending_op,
            op_abort,
            op_continue,
            stash_list,
            stash_save,
            stash_apply,
            stash_drop,
            blame_file,
            file_revisions,
            timelapse_frame,
            list_repo_files,
            read_repo_file,
            list_submodules,
            submodule_sha_at,
            containment,
            commit_log_excluding,
            commit_containment_detail,
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
            set_watched_repos,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
