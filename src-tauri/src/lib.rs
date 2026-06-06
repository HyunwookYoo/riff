pub mod diff;
pub mod git;
pub mod store;

use std::path::Path;

use git::{
    Blame, Branch, ChangedFile, Commit, DiffMode, FileDiff, FileStatus, GitCli, GitError, GitLayer,
    RepoStatus, SubmoduleInfo,
};
use store::{PersistedState, StoreError};
use tauri::Manager;

#[tauri::command]
fn validate_repo(state: tauri::State<GitCli>, path: String) -> Result<(), GitError> {
    state.validate_repo(Path::new(&path))
}

#[tauri::command]
fn list_refs(state: tauri::State<GitCli>, path: String) -> Result<Vec<Branch>, GitError> {
    state.list_refs(Path::new(&path))
}

#[tauri::command]
fn commit_log(
    state: tauri::State<GitCli>,
    path: String,
    start_ref: String,
    limit: u32,
    skip: u32,
) -> Result<Vec<Commit>, GitError> {
    state.commit_log(Path::new(&path), &start_ref, limit, skip)
}

#[tauri::command]
fn status(state: tauri::State<GitCli>, path: String) -> Result<RepoStatus, GitError> {
    state.status(Path::new(&path))
}

#[tauri::command]
fn diff_files(
    state: tauri::State<GitCli>,
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
fn file_diff(
    app: tauri::AppHandle,
    state: tauri::State<GitCli>,
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
fn worktree_files(
    state: tauri::State<GitCli>,
    path: String,
    ignore_whitespace: bool,
    on_file: tauri::ipc::Channel<ChangedFile>,
) -> Result<(), GitError> {
    state.worktree_files(Path::new(&path), ignore_whitespace, &mut |f| {
        on_file
            .send(f)
            .map_err(|e| GitError::CommandFailed(e.to_string()))
    })
}

#[tauri::command]
fn worktree_file_diff(
    app: tauri::AppHandle,
    state: tauri::State<GitCli>,
    path: String,
    file_path: String,
    old_path: Option<String>,
    status: FileStatus,
    force: bool,
    ue_version: Option<String>,
) -> Result<FileDiff, GitError> {
    let cfg = uasset_config(&app, ue_version);
    state.worktree_file_diff(
        Path::new(&path),
        &file_path,
        old_path.as_deref(),
        status,
        force,
        &cfg,
    )
}

#[tauri::command]
fn changes_file_diff(
    state: tauri::State<GitCli>,
    path: String,
    file_path: String,
    old_path: Option<String>,
    status: FileStatus,
    staged: bool,
    force: bool,
) -> Result<FileDiff, GitError> {
    state.changes_file_diff(
        Path::new(&path),
        &file_path,
        old_path.as_deref(),
        status,
        staged,
        force,
    )
}

#[tauri::command]
fn stage(
    state: tauri::State<GitCli>,
    path: String,
    files: Option<Vec<String>>,
) -> Result<(), GitError> {
    state.stage(Path::new(&path), files.as_deref())
}

#[tauri::command]
fn unstage(
    state: tauri::State<GitCli>,
    path: String,
    files: Option<Vec<String>>,
) -> Result<(), GitError> {
    state.unstage(Path::new(&path), files.as_deref())
}

#[tauri::command]
fn commit(
    state: tauri::State<GitCli>,
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
fn head_commit_message(state: tauri::State<GitCli>, path: String) -> Result<String, GitError> {
    state.head_commit_message(Path::new(&path))
}

#[tauri::command]
fn list_repo_files(state: tauri::State<GitCli>, path: String) -> Result<Vec<String>, GitError> {
    state.list_repo_files(Path::new(&path))
}

/// Read a tracked file's working-tree contents for the blame view. Path safety
/// is enforced here (no absolute paths, no `..` traversal) because this
/// bypasses git's index — it reads straight from disk.
#[tauri::command]
fn read_repo_file(path: String, file_path: String) -> Result<String, GitError> {
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
    let meta = fs::metadata(&full).map_err(GitError::Io)?;
    // Hard cap so a stray binary or huge log file can't lock up the editor.
    const BLAME_READ_CAP: u64 = 2_000_000;
    if meta.len() > BLAME_READ_CAP {
        return Err(GitError::CommandFailed(format!(
            "file too large for blame view ({} bytes)",
            meta.len()
        )));
    }
    let bytes = fs::read(&full).map_err(GitError::Io)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
fn blame_file(
    state: tauri::State<GitCli>,
    path: String,
    file_path: String,
    rev: String,
    use_contents: bool,
) -> Result<Blame, GitError> {
    state.blame_file(Path::new(&path), &file_path, &rev, use_contents)
}

#[tauri::command]
fn list_submodules(
    state: tauri::State<GitCli>,
    path: String,
) -> Result<Vec<SubmoduleInfo>, GitError> {
    state.list_submodules(Path::new(&path))
}

#[tauri::command]
fn submodule_sha_at(
    state: tauri::State<GitCli>,
    path: String,
    tree_ish: String,
    submodule_path: String,
) -> Result<Option<String>, GitError> {
    state.submodule_sha_at(Path::new(&path), &tree_ish, &submodule_path)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(GitCli::new())
        .invoke_handler(tauri::generate_handler![
            validate_repo,
            list_refs,
            commit_log,
            status,
            diff_files,
            file_diff,
            worktree_files,
            worktree_file_diff,
            changes_file_diff,
            stage,
            unstage,
            commit,
            head_commit_message,
            blame_file,
            list_repo_files,
            read_repo_file,
            list_submodules,
            submodule_sha_at,
            load_state,
            add_recent_repo,
            remove_recent_repo,
            set_theme,
            set_font_size,
            set_compare_mode,
            set_workspace_layout,
            set_blame_picker_width,
            set_file_view_mode,
            set_parse_unreal_assets,
            set_uassetgui_path,
            set_ue_version_for_repo,
            add_manual_repo,
            remove_manual_repo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
