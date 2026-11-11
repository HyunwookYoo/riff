//! Persistent state stored in `<app_config_dir>/state.json`.
//! Keeps the recent-repo list and user-set theme preference.

pub mod review;
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
    /// Per-main-repo tab order: the ordered list of non-main repo paths as the
    /// user arranged them by dragging tabs. Main is always pinned at index 0 and
    /// is not stored. Applied on top of the default workspace order; unknown
    /// paths (new submodule / manual) fall to the end.
    #[serde(default)]
    pub tab_order_by_main: HashMap<String, Vec<String>>,
    /// Workspace layout choice (§14.5 #13): "unified" (default) shows all
    /// repos in one grouped picker; "tabs" shows one repo at a time via a
    /// Fork-style tab bar. Global, applies to every workspace.
    #[serde(default = "default_workspace_layout")]
    pub workspace_layout: String,
    /// Width (px) of the blame view's left file-picker panel. User-resizable
    /// via drag handle, clamped at write time to [MIN_PICKER_WIDTH,
    /// MAX_PICKER_WIDTH].
    #[serde(default = "default_blame_picker_width")]
    pub blame_picker_width: u32,
    /// File list rendering mode (§ working-tree UX): "tree" (default) nests
    /// files by directory; "flat" lists full paths. Global. Validated to one
    /// of those two at write time.
    #[serde(default = "default_file_view_mode")]
    pub file_view_mode: String,
    /// Commit-graph row height in px — a density control for the graph view.
    /// Global, clamped at write time to [MIN_GRAPH_ROW_H, MAX_GRAPH_ROW_H].
    #[serde(default = "default_graph_row_height")]
    pub graph_row_height: u32,
    /// Master toggle for deriving Unreal asset (.uasset/.umap) property
    /// previews. Defaults on.
    #[serde(default = "default_true")]
    pub parse_unreal_assets: bool,
    /// Absolute path to `UAssetGUI.exe`, used to derive Unreal asset previews.
    /// Global (one tool install per machine). Empty/absent disables previews.
    #[serde(default)]
    pub uassetgui_path: Option<String>,
    /// Per-main-repo Unreal Engine version string (e.g. "5.3") passed to
    /// UAssetGUI. Keyed by repo path. A repo's assets are usually one engine
    /// version, so this is stored per-repo rather than globally.
    #[serde(default)]
    pub ue_version_by_repo: HashMap<String, String>,
    /// Claude Code `--model` / `--effort` for AI review and re-review. None
    /// leaves the CLI's own setting. Checked on save and again in `ai::run`.
    #[serde(default)]
    pub ai_model: Option<String>,
    #[serde(default)]
    pub ai_effort: Option<String>,
    /// GitHub repos (`host/owner/name`) whose AI review also checks Roblox
    /// parity. Validated on save.
    #[serde(default)]
    pub roblox_parity_repos: Vec<String>,
}

const MIN_PICKER_WIDTH: u32 = 200;
const MAX_PICKER_WIDTH: u32 = 600;
const MIN_GRAPH_ROW_H: u32 = 28;
const MAX_GRAPH_ROW_H: u32 = 72;

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

fn default_blame_picker_width() -> u32 {
    300
}

fn default_file_view_mode() -> String {
    "tree".into()
}

fn default_graph_row_height() -> u32 {
    40
}

fn default_true() -> bool {
    true
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            recent_repos: Vec::new(),
            theme: default_theme(),
            font_size: default_font_size(),
            compare_mode: default_compare_mode(),
            manual_repos_by_main: HashMap::new(),
            tab_order_by_main: HashMap::new(),
            workspace_layout: default_workspace_layout(),
            blame_picker_width: default_blame_picker_width(),
            file_view_mode: default_file_view_mode(),
            graph_row_height: default_graph_row_height(),
            parse_unreal_assets: default_true(),
            uassetgui_path: None,
            ue_version_by_repo: HashMap::new(),
            ai_model: None,
            ai_effort: None,
            roblox_parity_repos: Vec::new(),
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

    #[error("{0}")]
    Invalid(&'static str),
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

pub fn set_blame_picker_width(app: &AppHandle, width: u32) -> Result<(), StoreError> {
    let mut state = load(app)?;
    state.blame_picker_width = width.clamp(MIN_PICKER_WIDTH, MAX_PICKER_WIDTH);
    save(app, &state)
}

pub fn set_file_view_mode(app: &AppHandle, mode: String) -> Result<(), StoreError> {
    let mut state = load(app)?;
    // Validate: ignore anything that isn't a known mode so a malformed call
    // can't poison the stored state.
    state.file_view_mode = match mode.as_str() {
        "flat" => "flat".into(),
        _ => "tree".into(),
    };
    save(app, &state)
}

pub fn set_graph_row_height(app: &AppHandle, height: u32) -> Result<(), StoreError> {
    let mut state = load(app)?;
    state.graph_row_height = height.clamp(MIN_GRAPH_ROW_H, MAX_GRAPH_ROW_H);
    save(app, &state)
}

pub fn set_parse_unreal_assets(app: &AppHandle, enabled: bool) -> Result<(), StoreError> {
    let mut state = load(app)?;
    state.parse_unreal_assets = enabled;
    save(app, &state)
}

pub fn set_uassetgui_path(app: &AppHandle, path: Option<String>) -> Result<(), StoreError> {
    let mut state = load(app)?;
    // Normalize empty to None so the frontend can clear it.
    state.uassetgui_path = path.filter(|p| !p.trim().is_empty());
    save(app, &state)
}

pub fn set_ai_model(app: &AppHandle, model: Option<String>) -> Result<(), StoreError> {
    let mut state = load(app)?;
    state.ai_model = ai_value(model, crate::ai::model_ok)?;
    save(app, &state)
}

pub fn set_ai_effort(app: &AppHandle, effort: Option<String>) -> Result<(), StoreError> {
    let mut state = load(app)?;
    state.ai_effort = ai_value(effort, crate::ai::effort_ok)?;
    save(app, &state)
}

/// Trimmed; empty means unset; refused unless `ok`, so junk never lands in
/// the state file.
fn ai_value(v: Option<String>, ok: fn(&str) -> bool) -> Result<Option<String>, StoreError> {
    match v.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) if ok(s) => Ok(Some(s.to_string())),
        Some(_) => Err(StoreError::Invalid(crate::ai::INVALID_CHOICE)),
    }
}

pub fn set_roblox_parity(app: &AppHandle, repo: String, on: bool) -> Result<(), StoreError> {
    if !repo_key_ok(&repo) {
        return Err(StoreError::Invalid("invalid repo key (expected host/owner/name)"));
    }
    let mut state = load(app)?;
    state.roblox_parity_repos.retain(|r| r != &repo);
    if on {
        state.roblox_parity_repos.push(repo);
    }
    save(app, &state)
}

/// `host/owner/name`: three non-empty segments of `[A-Za-z0-9._-]`.
fn repo_key_ok(key: &str) -> bool {
    let segments: Vec<&str> = key.split('/').collect();
    segments.len() == 3
        && segments.iter().all(|s| {
            !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
}

pub fn set_ue_version_for_repo(
    app: &AppHandle,
    repo: String,
    version: String,
) -> Result<(), StoreError> {
    let mut state = load(app)?;
    if version.trim().is_empty() {
        state.ue_version_by_repo.remove(&repo);
    } else {
        state.ue_version_by_repo.insert(repo, version);
    }
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

/// Save the user-arranged tab order (non-main repo paths) for `main_repo`. An
/// empty list removes the entry so state.json stays tidy.
pub fn set_tab_order(
    app: &AppHandle,
    main_repo: String,
    order: Vec<String>,
) -> Result<(), StoreError> {
    let mut state = load(app)?;
    if order.is_empty() {
        state.tab_order_by_main.remove(&main_repo);
    } else {
        state.tab_order_by_main.insert(main_repo, order);
    }
    save(app, &state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai_model_and_effort_default_to_unset() {
        let old: PersistedState = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert_eq!((old.ai_model, old.ai_effort), (None, None));
        let set: PersistedState =
            serde_json::from_str(r#"{"ai_model":"opus","ai_effort":"high"}"#).unwrap();
        assert_eq!(
            (set.ai_model.as_deref(), set.ai_effort.as_deref()),
            (Some("opus"), Some("high"))
        );
    }

    #[test]
    fn ai_value_trims_unsets_blank_and_rejects_invalid() {
        let model = |v: Option<&str>| ai_value(v.map(String::from), crate::ai::model_ok).ok();
        assert_eq!(model(Some(" opus ")), Some(Some("opus".into())));
        assert_eq!(
            model(Some("claude-opus-5-5[1m]")),
            Some(Some("claude-opus-5-5[1m]".into()))
        );
        assert_eq!(model(Some("  ")), Some(None));
        assert_eq!(model(None), Some(None));
        assert_eq!(model(Some("bad model")), None);
        assert_eq!(model(Some("--x")), None);
        let effort = |v: &str| ai_value(Some(v.into()), crate::ai::effort_ok).ok();
        assert_eq!(effort("high"), Some(Some("high".into())));
        assert_eq!(effort("extreme"), None);
        assert_eq!(
            ai_value(Some("x y".into()), crate::ai::model_ok)
                .unwrap_err()
                .to_string(),
            crate::ai::INVALID_CHOICE
        );
    }

    #[test]
    fn roblox_parity_repos_default_to_empty() {
        let old: PersistedState = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert!(old.roblox_parity_repos.is_empty());
        let set: PersistedState =
            serde_json::from_str(r#"{"roblox_parity_repos":["github.com/o/n"]}"#).unwrap();
        assert_eq!(set.roblox_parity_repos, vec!["github.com/o/n"]);
    }

    #[test]
    fn repo_key_needs_three_plain_segments() {
        for ok in ["github.com/owner/name", "ghe.example.com/my-org/repo_1.x"] {
            assert!(repo_key_ok(ok), "{ok}");
        }
        for bad in [
            "",
            "owner/name",
            "github.com/owner/name/extra",
            "github.com//name",
            "github.com/owner/",
            "github.com/own er/name",
            "github.com/owner/na:me",
            r"github.com\owner\name",
        ] {
            assert!(!repo_key_ok(bad), "{bad}");
        }
    }
}
