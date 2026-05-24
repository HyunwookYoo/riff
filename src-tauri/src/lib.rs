pub mod diff;
pub mod git;
pub mod store;

use std::path::Path;

use git::{Branch, ChangedFile, DiffMode, FileDiff, FileStatus, GitCli, GitError, GitLayer};
use store::{PersistedState, StoreError};

#[tauri::command]
fn validate_repo(state: tauri::State<GitCli>, path: String) -> Result<(), GitError> {
    state.validate_repo(Path::new(&path))
}

#[tauri::command]
fn list_refs(state: tauri::State<GitCli>, path: String) -> Result<Vec<Branch>, GitError> {
    state.list_refs(Path::new(&path))
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
    state: tauri::State<GitCli>,
    path: String,
    start: String,
    target: String,
    mode: DiffMode,
    file_path: String,
    old_path: Option<String>,
    force: bool,
) -> Result<FileDiff, GitError> {
    state.file_diff(
        Path::new(&path),
        &start,
        &target,
        mode,
        &file_path,
        old_path.as_deref(),
        force,
    )
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
    state: tauri::State<GitCli>,
    path: String,
    file_path: String,
    old_path: Option<String>,
    status: FileStatus,
    force: bool,
) -> Result<FileDiff, GitError> {
    state.worktree_file_diff(
        Path::new(&path),
        &file_path,
        old_path.as_deref(),
        status,
        force,
    )
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
            diff_files,
            file_diff,
            worktree_files,
            worktree_file_diff,
            load_state,
            add_recent_repo,
            remove_recent_repo,
            set_theme,
            set_font_size,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
