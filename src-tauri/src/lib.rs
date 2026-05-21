pub mod diff;
pub mod git;
pub mod store;

use std::path::Path;

use git::{Branch, ChangedFile, DiffMode, FileDiff, GitCli, GitError, GitLayer};
use store::{PersistedState, StoreError};

#[tauri::command]
fn validate_repo(path: String) -> Result<(), GitError> {
    GitCli::new().validate_repo(Path::new(&path))
}

#[tauri::command]
fn list_refs(path: String) -> Result<Vec<Branch>, GitError> {
    GitCli::new().list_refs(Path::new(&path))
}

#[tauri::command]
fn diff_files(
    path: String,
    start: String,
    target: String,
    mode: DiffMode,
    ignore_whitespace: bool,
) -> Result<Vec<ChangedFile>, GitError> {
    GitCli::new().diff_files(Path::new(&path), &start, &target, mode, ignore_whitespace)
}

#[tauri::command]
fn file_diff(
    path: String,
    start: String,
    target: String,
    mode: DiffMode,
    file_path: String,
    old_path: Option<String>,
    force: bool,
) -> Result<FileDiff, GitError> {
    GitCli::new().file_diff(
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            validate_repo,
            list_refs,
            diff_files,
            file_diff,
            load_state,
            add_recent_repo,
            remove_recent_repo,
            set_theme,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
