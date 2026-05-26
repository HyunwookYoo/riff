//! Persistent state stored in `<app_config_dir>/state.json`.
//! Keeps the recent-repo list and user-set theme preference.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use thiserror::Error;

const STATE_FILE: &str = "state.json";
const MAX_RECENT: usize = 10;
const MIN_FONT_SIZE: u8 = 8;
const MAX_FONT_SIZE: u8 = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedState {
    #[serde(default)]
    pub recent_repos: Vec<String>,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_font_size")]
    pub font_size: u8,
    #[serde(default = "default_compare_mode")]
    pub compare_mode: String,
    /// Multi-root workspace (§13.3 #5): per-main-repo list of manually added
    /// extra repos. Submodules are auto-discovered and not stored here.
    #[serde(default)]
    pub manual_repos_by_main: HashMap<String, Vec<String>>,
    /// Workspace layout choice (§14.5 #13): "unified" (default) shows all
    /// repos in one grouped picker; "tabs" shows one repo at a time via a
    /// Fork-style tab bar. Global, applies to every workspace.
    #[serde(default = "default_workspace_layout")]
    pub workspace_layout: String,
}

fn default_theme() -> String {
    "system".into()
}

fn default_font_size() -> u8 {
    13
}

fn default_compare_mode() -> String {
    "branch".into()
}

fn default_workspace_layout() -> String {
    "unified".into()
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            recent_repos: Vec::new(),
            theme: default_theme(),
            font_size: default_font_size(),
            compare_mode: default_compare_mode(),
            manual_repos_by_main: HashMap::new(),
            workspace_layout: default_workspace_layout(),
        }
    }
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("config path error: {0}")]
    Path(String),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

impl serde::Serialize for StoreError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

fn state_path(app: &AppHandle) -> Result<PathBuf, StoreError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| StoreError::Path(e.to_string()))?;
    Ok(dir.join(STATE_FILE))
}

pub fn load(app: &AppHandle) -> Result<PersistedState, StoreError> {
    let path = state_path(app)?;
    if !path.exists() {
        return Ok(PersistedState::default());
    }
    let text = fs::read_to_string(&path)?;
    // Treat malformed state as a fresh start rather than a fatal error.
    Ok(serde_json::from_str(&text).unwrap_or_default())
}

fn save(app: &AppHandle, state: &PersistedState) -> Result<(), StoreError> {
    let path = state_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(state)?;
    fs::write(&path, text)?;
    Ok(())
}

pub fn add_recent_repo(app: &AppHandle, repo: String) -> Result<Vec<String>, StoreError> {
    let mut state = load(app)?;
    state.recent_repos.retain(|p| p != &repo);
    state.recent_repos.insert(0, repo);
    state.recent_repos.truncate(MAX_RECENT);
    save(app, &state)?;
    Ok(state.recent_repos)
}

pub fn remove_recent_repo(app: &AppHandle, repo: String) -> Result<Vec<String>, StoreError> {
    let mut state = load(app)?;
    state.recent_repos.retain(|p| p != &repo);
    save(app, &state)?;
    Ok(state.recent_repos)
}

pub fn set_theme(app: &AppHandle, theme: String) -> Result<(), StoreError> {
    let mut state = load(app)?;
    state.theme = theme;
    save(app, &state)
}

pub fn set_font_size(app: &AppHandle, size: u8) -> Result<(), StoreError> {
    let mut state = load(app)?;
    state.font_size = size.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE);
    save(app, &state)
}

pub fn set_compare_mode(app: &AppHandle, mode: String) -> Result<(), StoreError> {
    let mut state = load(app)?;
    state.compare_mode = mode;
    save(app, &state)
}

pub fn set_workspace_layout(app: &AppHandle, layout: String) -> Result<(), StoreError> {
    let mut state = load(app)?;
    state.workspace_layout = layout;
    save(app, &state)
}

/// Append `repo` to the manual-repo list for `main_repo`. Skips duplicates.
/// Returns the resulting list.
pub fn add_manual_repo(
    app: &AppHandle,
    main_repo: String,
    repo: String,
) -> Result<Vec<String>, StoreError> {
    let mut state = load(app)?;
    let list = state.manual_repos_by_main.entry(main_repo).or_default();
    if !list.iter().any(|p| p == &repo) {
        list.push(repo);
    }
    let result = list.clone();
    save(app, &state)?;
    Ok(result)
}

pub fn remove_manual_repo(
    app: &AppHandle,
    main_repo: String,
    repo: String,
) -> Result<Vec<String>, StoreError> {
    let mut state = load(app)?;
    let entry = state.manual_repos_by_main.entry(main_repo.clone()).or_default();
    entry.retain(|p| p != &repo);
    let result = entry.clone();
    // Don't leave behind an empty mapping — keeps state.json tidy.
    if result.is_empty() {
        state.manual_repos_by_main.remove(&main_repo);
    }
    save(app, &state)?;
    Ok(result)
}
