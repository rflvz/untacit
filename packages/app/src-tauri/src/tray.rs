//! System-tray icon (docs/08 §uso): the app lives in the notification area,
//! closing the window hides it there, and the tray menu offers the common
//! actions without touching the window. Left click shows the window
//! (Windows convention); the menu hangs off right click.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

use crate::{commands, shell};

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Mostrar untacit", true, None::<&str>)?;
    let change = MenuItem::with_id(
        app,
        "change-repo",
        "Cambiar carpeta del grafo…",
        true,
        None::<&str>,
    )?;
    let reveal = MenuItem::with_id(
        app,
        "open-folder",
        "Abrir carpeta del grafo",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Salir de untacit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&show, &change, &reveal, &PredefinedMenuItem::separator(app)?, &quit],
    )?;

    let mut tray = TrayIconBuilder::with_id("untacit-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("untacit")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => shell::show_main_window(app),
            "change-repo" => commands::pick_repo_from_tray(app),
            "open-folder" => {
                if let Err(err) = commands::open_current_repo(app) {
                    eprintln!("[untacit] open folder from tray failed: {err}");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                shell::show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
