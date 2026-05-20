pub mod diff;
pub mod git;
pub mod store;

use std::path::Path;

use git::{Branch, ChangedFile, DiffMode, GitCli, GitError, GitLayer};

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
) -> Result<Vec<ChangedFile>, GitError> {
    GitCli::new().diff_files(Path::new(&path), &start, &target, mode)
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
