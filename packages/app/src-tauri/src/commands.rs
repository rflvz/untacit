//! Tauri commands invoked from the frontend (src/shell.ts) plus the shared
//! "apply this repo" path also used by the tray menu. Picking a folder,
//! switching repos and reopening the current one all funnel through
//! `apply_repo`, which persists the choice, restarts the sidecar and emits
//! `untacit://repo-changed` so the UI refreshes.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::config;
use crate::shell::{self, Shell};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellStateDto {
    pub repo: Option<String>,
    pub recent: Vec<String>,
    pub node_ok: bool,
    pub dev_mode: bool,
    pub sidecar_running: bool,
}

pub fn current_state(app: &AppHandle) -> ShellStateDto {
    let state = app.state::<Shell>();
    let (repo, recent) = {
        let config = state.config.lock().expect("config mutex poisoned");
        (
            config.repo.as_ref().map(|p| p.display().to_string()),
            config.recent.iter().map(|p| p.display().to_string()).collect(),
        )
    };
    let sidecar_running = {
        let mut guard = state.sidecar.lock().expect("sidecar mutex poisoned");
        match guard.as_mut() {
            // try_wait: Some(status) means the child already exited.
            Some(child) => child.try_wait().map(|s| s.is_none()).unwrap_or(false),
            None => false,
        }
    };
    ShellStateDto {
        repo,
        recent,
        node_ok: state.node.is_some(),
        dev_mode: cfg!(debug_assertions),
        sidecar_running,
    }
}

/// Persist `repo`, restart the sidecar against it and notify the frontend.
pub fn apply_repo(app: &AppHandle, repo: PathBuf) -> Result<(), String> {
    if !shell::looks_like_directory(&repo) {
        return Err(format!("no existe la carpeta {}", repo.display()));
    }
    {
        let state = app.state::<Shell>();
        let mut config = state.config.lock().expect("config mutex poisoned");
        config::remember(&mut config, repo.clone());
        config::save(app, &config);
    }
    shell::start_sidecar(app, &repo);
    shell::apply_repo_to_window(app, Some(&repo));
    let _ = app.emit("untacit://repo-changed", current_state(app));
    Ok(())
}

/// Tray entry point: non-blocking native folder picker (the tray handler
/// runs on the main thread, so the blocking variant is off-limits here).
pub fn pick_repo_from_tray(app: &AppHandle) {
    let handle = app.clone();
    app.dialog()
        .file()
        .set_title("Selecciona la carpeta del repo del grafo")
        .pick_folder(move |folder| {
            let Some(folder) = folder else { return };
            match folder.into_path() {
                Ok(path) => {
                    if let Err(err) = apply_repo(&handle, path) {
                        eprintln!("[untacit] pick from tray failed: {err}");
                    }
                }
                Err(err) => eprintln!("[untacit] unusable picked path: {err}"),
            }
        });
}

/// Reveal the current graph repo in the OS file manager.
pub fn open_current_repo(app: &AppHandle) -> Result<(), String> {
    let repo = {
        let state = app.state::<Shell>();
        let config = state.config.lock().expect("config mutex poisoned");
        config.repo.clone()
    };
    let repo = repo.ok_or_else(|| "no hay carpeta de grafo configurada".to_string())?;
    app.opener()
        .open_path(repo.display().to_string(), None::<&str>)
        .map_err(|err| err.to_string())
}

// ---- commands (frontend) ----

#[tauri::command]
pub fn shell_state(app: AppHandle) -> ShellStateDto {
    current_state(&app)
}

/// Async so the blocking folder picker runs off the main thread.
#[tauri::command]
pub async fn pick_repo(app: AppHandle) -> Result<Option<ShellStateDto>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Selecciona la carpeta del repo del grafo")
        .blocking_pick_folder();
    let Some(folder) = picked else { return Ok(None) };
    let path = folder.into_path().map_err(|err| err.to_string())?;
    apply_repo(&app, path)?;
    Ok(Some(current_state(&app)))
}

/// Switch to a known path (the "recientes" list of the welcome screen).
#[tauri::command]
pub fn set_repo(app: AppHandle, path: String) -> Result<ShellStateDto, String> {
    apply_repo(&app, PathBuf::from(path))?;
    Ok(current_state(&app))
}

#[tauri::command]
pub fn open_repo_folder(app: AppHandle) -> Result<(), String> {
    open_current_repo(&app)
}
