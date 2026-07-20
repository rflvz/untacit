//! Node.js runtime discovery. The sidecar is a Node bundle, so the installed
//! app depends on a system Node ≥ 20 (docs/08). Instead of failing with a
//! bare "program not found", look through PATH and the usual Windows install
//! locations, and when nothing turns up show a dialog that links to the
//! download page.

use std::env;
use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

pub const NODE_DOWNLOAD_URL: &str = "https://nodejs.org/es/download";

fn node_binary() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

/// Locate a Node.js runtime: `UNTACIT_NODE` override, then PATH, then the
/// usual Windows install locations (installer default, per-user installer,
/// nvm-windows symlink) — a GUI app on Windows often runs with a PATH that
/// predates the Node install.
pub fn find_node() -> Option<PathBuf> {
    if let Ok(explicit) = env::var("UNTACIT_NODE") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }
    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            let candidate = dir.join(node_binary());
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    windows_candidates().into_iter().find(|p| p.is_file())
}

fn windows_candidates() -> Vec<PathBuf> {
    if !cfg!(windows) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(base) = env::var(var) {
            out.push(Path::new(&base).join("nodejs").join("node.exe"));
        }
    }
    if let Ok(base) = env::var("LOCALAPPDATA") {
        out.push(Path::new(&base).join("Programs").join("nodejs").join("node.exe"));
    }
    // nvm-windows publishes the active version through NVM_SYMLINK.
    if let Ok(symlink) = env::var("NVM_SYMLINK") {
        out.push(Path::new(&symlink).join("node.exe"));
    }
    out
}

/// Non-blocking warning dialog with a shortcut to the Node.js download page.
pub fn warn_node_missing(app: &AppHandle) {
    let handle = app.clone();
    app.dialog()
        .message(
            "untacit necesita Node.js 20 o superior para arrancar su motor local \
             (el sidecar que lee el grafo).\n\n\
             Instala la versión LTS desde nodejs.org y vuelve a abrir untacit.",
        )
        .title("Falta Node.js")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Abrir nodejs.org".to_string(),
            "Cerrar".to_string(),
        ))
        .show(move |open_download| {
            if open_download {
                let _ = handle.opener().open_url(NODE_DOWNLOAD_URL, None::<&str>);
            }
        });
}
