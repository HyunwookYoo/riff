//! Persistent state stored in `<app_config_dir>/state.json`.
//! Keeps the recent-repo list and user-set theme preference.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use thiserror::Error;

const STATE_FILE: &str = "state.json";
const MAX_RECENT: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedState {
    #[serde(default)]
    pub recent_repos: Vec<String>,
    #[serde(default = "default_theme")]
    pub theme: String,
}

fn default_theme() -> String {
    "system".into()
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            recent_repos: Vec::new(),
            theme: default_theme(),
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
