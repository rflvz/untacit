//! Persisted shell settings: the graph repo the user picked and the MRU list
//! behind the welcome screen and the tray menu. Stored as JSON under the OS
//! per-user config dir (`%APPDATA%\dev.untacit.app\shell.json` on Windows),
//! so the choice survives restarts and the env var stops being required.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Entries kept in the most-recently-used repo list.
const MAX_RECENT: usize = 8;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ShellConfig {
    /// Graph repo opened at startup (None until the user picks one).
    pub repo: Option<PathBuf>,
    /// Most-recently-used graph repos, newest first.
    #[serde(default)]
    pub recent: Vec<PathBuf>,
}

fn config_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("shell.json"))
}

pub fn load(app: &AppHandle) -> ShellConfig {
    let Some(file) = config_file(app) else {
        return ShellConfig::default();
    };
    match fs::read_to_string(&file) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => ShellConfig::default(),
    }
}

pub fn save(app: &AppHandle, config: &ShellConfig) {
    let Some(file) = config_file(app) else { return };
    if let Some(dir) = file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(raw) = serde_json::to_string_pretty(config) {
        if let Err(err) = fs::write(&file, raw) {
            eprintln!("[untacit] could not persist {}: {err}", file.display());
        }
    }
}

/// Make `repo` the current one and move it to the front of the MRU list.
pub fn remember(config: &mut ShellConfig, repo: PathBuf) {
    config.recent.retain(|p| p != &repo);
    config.recent.insert(0, repo.clone());
    config.recent.truncate(MAX_RECENT);
    config.repo = Some(repo);
}
