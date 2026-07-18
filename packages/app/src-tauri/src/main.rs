// untacit desktop shell (docs/03 §7, docs/04 Fase 2).
//
// The core runs as a Node sidecar (sidecar/server.ts) exposing the local HTTP
// API on port 4823; the webview frontend talks to it directly (src/api.ts
// switches to the absolute origin when it detects Tauri).
//
// Process lifecycle:
//   - `tauri dev`: beforeDevCommand (`pnpm dev`) already runs sidecar + vite,
//     so the shell spawns nothing (debug_assertions gate below).
//   - release build: the shell spawns `node sidecar/dist/server.mjs` (the
//     esbuild bundle produced by `pnpm bundle:sidecar`) and kills it on exit.
//     The graph repo comes from UNTACIT_REPO, like the plain sidecar.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::{Manager, RunEvent};

/// Handle of the spawned sidecar process, killed on RunEvent::Exit.
struct Sidecar(Mutex<Option<Child>>);

/// Locate the bundled sidecar entry point:
/// UNTACIT_SIDECAR env override, then next to the executable (installed
/// layout / cargo target dir), then the workspace layout as a last resort.
fn sidecar_entry() -> Option<PathBuf> {
    if let Ok(explicit) = env::var("UNTACIT_SIDECAR") {
        return Some(PathBuf::from(explicit));
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
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

fn spawn_sidecar() -> Option<Child> {
    let entry = match sidecar_entry() {
        Some(entry) => entry,
        None => {
            eprintln!(
                "[untacit] sidecar bundle not found; run `pnpm bundle:sidecar` \
                 or set UNTACIT_SIDECAR to the server.mjs path"
            );
            return None;
        }
    };
    // UNTACIT_REPO / UNTACIT_PORT / UNTACIT_OPEN_CMD pass through the
    // inherited environment; the sidecar applies its own defaults.
    match Command::new("node").arg(&entry).spawn() {
        Ok(child) => {
            eprintln!("[untacit] sidecar started: node {}", entry.display());
            Some(child)
        }
        Err(err) => {
            eprintln!("[untacit] failed to start sidecar (is node installed?): {err}");
            None
        }
    }
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let child = if cfg!(debug_assertions) {
                None // `pnpm dev` (beforeDevCommand) already runs the sidecar.
            } else {
                spawn_sidecar()
            };
            app.manage(Sidecar(Mutex::new(child)));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building untacit");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            let taken = app_handle
                .state::<Sidecar>()
                .0
                .lock()
                .expect("sidecar mutex poisoned")
                .take();
            if let Some(mut child) = taken {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });
}
