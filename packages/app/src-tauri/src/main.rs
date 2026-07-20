// untacit desktop shell (docs/03 §7, docs/08 guía de escritorio).
//
// Wiring only — the behavior lives in the modules:
//   config.rs   persisted repo choice + MRU list
//   nodejs.rs   Node runtime discovery + missing-Node dialog
//   shell.rs    managed state + sidecar lifecycle + window helpers
//   tray.rs     system-tray icon and its menu
//   commands.rs frontend-facing commands (shell_state / pick_repo / …)

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod nodejs;
mod shell;
mod tray;

use std::env;
use std::path::PathBuf;

use tauri::{Manager, RunEvent};

use shell::Shell;

fn main() {
    let app = tauri::Builder::default()
        // A second launch (shortcut, taskbar pin) focuses the existing
        // window instead of starting another shell + sidecar pair.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            shell::show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::shell_state,
            commands::pick_repo,
            commands::set_repo,
            commands::open_repo_folder,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let persisted = config::load(&handle);
            let node = nodejs::find_node();
            let node_missing = node.is_none();
            app.manage(Shell::new(persisted, node));

            let tray_ok = match tray::setup(&handle) {
                Ok(()) => true,
                Err(err) => {
                    eprintln!("[untacit] tray unavailable: {err}");
                    false
                }
            };
            app.state::<Shell>().set_tray_active(tray_ok);

            // Startup repo: the persisted choice wins; UNTACIT_REPO stays as
            // an override for first runs / scripted launches. No repo → the
            // frontend shows the welcome screen and no sidecar is spawned.
            let repo = {
                let state = app.state::<Shell>();
                let config = state.config.lock().expect("config mutex poisoned");
                config.repo.clone()
            }
            .or_else(|| env::var("UNTACIT_REPO").ok().map(PathBuf::from));
            if let Some(repo) = repo {
                shell::start_sidecar(&handle, &repo);
                shell::apply_repo_to_window(&handle, Some(&repo));
            }
            if node_missing && !cfg!(debug_assertions) {
                nodejs::warn_node_missing(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Close = hide to tray; "Salir" lives in the tray menu. If
                // the tray failed to build, fall through to a normal close.
                if window.app_handle().state::<Shell>().tray_active() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building untacit");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            shell::stop_sidecar(app_handle);
        }
    });
}
