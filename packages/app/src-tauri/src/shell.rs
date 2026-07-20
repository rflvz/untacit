//! Shared shell state and the sidecar lifecycle.
//!
//! The core runs as a Node sidecar (sidecar/server.ts) exposing the local
//! HTTP API on port 4823; the webview frontend talks to it directly
//! (src/api.ts switches to the absolute origin when it detects Tauri).
//!
//! - `tauri dev`: beforeDevCommand (`pnpm dev`) already runs sidecar + vite,
//!   so the shell spawns nothing (`cfg!(debug_assertions)` gate).
//! - release build: the shell spawns `node sidecar/server.mjs` (the staged
//!   bundle produced by `pnpm bundle:sidecar`, shipped as a Tauri resource)
//!   with UNTACIT_REPO set to the folder the user picked, restarts it when
//!   the folder changes, and kills it on exit.

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::{env, fs};

use tauri::{AppHandle, Manager};

use crate::config::ShellConfig;
use crate::nodejs;

/// Managed state: persisted config + sidecar child + resolved Node runtime.
pub struct Shell {
    pub config: Mutex<ShellConfig>,
    pub sidecar: Mutex<Option<Child>>,
    pub node: Option<PathBuf>,
    /// Whether the tray icon built; without it, closing the window must quit
    /// (otherwise the app would become unreachable).
    tray_active: AtomicBool,
}

impl Shell {
    pub fn new(config: ShellConfig, node: Option<PathBuf>) -> Self {
        Shell {
            config: Mutex::new(config),
            sidecar: Mutex::new(None),
            node,
            tray_active: AtomicBool::new(false),
        }
    }

    pub fn set_tray_active(&self, active: bool) {
        self.tray_active.store(active, Ordering::Relaxed);
    }

    pub fn tray_active(&self) -> bool {
        self.tray_active.load(Ordering::Relaxed)
    }
}

/// Locate the staged sidecar entry point: UNTACIT_SIDECAR env override, the
/// Tauri resource dir (installed layout), next to the executable, then the
/// workspace layout as a dev fallback.
fn sidecar_entry(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(explicit) = env::var("UNTACIT_SIDECAR") {
        return Some(PathBuf::from(explicit));
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("sidecar/server.mjs"));
        // Resource paths with `../` components are materialized under `_up_`.
        candidates.push(resources.join("_up_/sidecar/dist/server.mjs"));
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("sidecar/server.mjs"));
            // target/{debug,release} -> src-tauri -> packages/app
            candidates.push(dir.join("../../../sidecar/dist/server.mjs"));
        }
    }
    candidates.push(PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../sidecar/dist/server.mjs"
    )));
    candidates.into_iter().find(|p| p.exists())
}

/// (Re)start the sidecar against `repo`. In dev builds this is a no-op:
/// `pnpm dev` owns the sidecar there.
pub fn start_sidecar(app: &AppHandle, repo: &Path) {
    if cfg!(debug_assertions) {
        return;
    }
    let state = app.state::<Shell>();
    let mut guard = state.sidecar.lock().expect("sidecar mutex poisoned");
    if let Some(mut old) = guard.take() {
        let _ = old.kill();
        let _ = old.wait();
    }
    let Some(node) = state.node.clone() else {
        nodejs::warn_node_missing(app);
        return;
    };
    let Some(entry) = sidecar_entry(app) else {
        eprintln!(
            "[untacit] sidecar bundle not found; run `pnpm bundle:sidecar` \
             or set UNTACIT_SIDECAR to the server.mjs path"
        );
        return;
    };
    // UNTACIT_PORT / UNTACIT_OPEN_CMD pass through the inherited environment;
    // the sidecar applies its own defaults.
    let mut cmd = Command::new(&node);
    cmd.arg(&entry).env("UNTACIT_REPO", repo);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: don't flash a console window behind the app.
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    match cmd.spawn() {
        Ok(child) => {
            eprintln!(
                "[untacit] sidecar started: {} {} (repo {})",
                node.display(),
                entry.display(),
                repo.display()
            );
            *guard = Some(child);
        }
        Err(err) => eprintln!("[untacit] failed to start sidecar: {err}"),
    }
}

/// Kill the sidecar (RunEvent::Exit).
pub fn stop_sidecar(app: &AppHandle) {
    let taken = app
        .state::<Shell>()
        .sidecar
        .lock()
        .expect("sidecar mutex poisoned")
        .take();
    if let Some(mut child) = taken {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Show + focus the main window (tray click, second app launch).
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Reflect the active repo in the window title ("untacit — <folder>").
pub fn apply_repo_to_window(app: &AppHandle, repo: Option<&Path>) {
    if let Some(window) = app.get_webview_window("main") {
        let title = match repo.and_then(|p| p.file_name()).and_then(|n| n.to_str()) {
            Some(name) => format!("untacit — {name}"),
            None => "untacit".to_string(),
        };
        let _ = window.set_title(&title);
    }
}

/// Best-effort sanity check used before opening a folder as graph repo: an
/// initialized repo has a `graph/` dir (docs/02); an empty folder is allowed
/// (the sidecar reports it), but a file path is not.
pub fn looks_like_directory(path: &Path) -> bool {
    fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false)
}
