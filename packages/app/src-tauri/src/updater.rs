//! Update check + one-click install (docs/08 §actualizar). The desktop app
//! ships as an NSIS installer attached to GitHub Releases, so "update" is:
//! ask the GitHub API for the latest published release, compare versions,
//! and — on Windows — download the new installer and launch it (per-user
//! NSIS reinstalls in place). On other platforms, or if the release has no
//! installer asset, the release page opens in the browser instead.
//!
//! Two entry points share the same core: the tray menu item (dialogs, for a
//! user-initiated check) and a silent startup check that only emits
//! `untacit://update-available` to the webview when there is something new.

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

const RELEASES_API: &str = "https://api.github.com/repos/rflvz/untacit/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/rflvz/untacit/releases/latest";
/// Hard cap when downloading the installer (the NSIS bundle is ~100 MB at
/// most); anything larger means something is off upstream.
#[cfg(windows)]
const MAX_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;

pub const UPDATE_AVAILABLE_EVENT: &str = "untacit://update-available";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// Version of the running app (Cargo/tauri.conf version).
    pub current: String,
    /// Latest published release, without the leading `v`.
    pub latest: String,
    pub update_available: bool,
    /// Release page (fallback install path on every platform).
    pub page_url: String,
    /// Direct download of the Windows NSIS installer, when the release has one.
    pub installer_url: Option<String>,
}

/// `"v1.2.3"` / `"1.2.3-beta"` → `(1, 2, 3)`. Missing trailing components
/// count as 0; a tag with no leading number is unparseable (None).
fn parse_version(raw: &str) -> Option<(u64, u64, u64)> {
    let mut parts = raw.trim().trim_start_matches(['v', 'V']).splitn(3, '.');
    let mut component = |required: bool| -> Option<u64> {
        match parts.next() {
            Some(p) => {
                let digits: String = p.chars().take_while(char::is_ascii_digit).collect();
                if digits.is_empty() {
                    if required { None } else { Some(0) }
                } else {
                    digits.parse().ok()
                }
            }
            None => {
                if required {
                    None
                } else {
                    Some(0)
                }
            }
        }
    };
    Some((component(true)?, component(false)?, component(false)?))
}

/// Query the latest published GitHub release and compare it with the
/// running version. Blocking (network) — call it off the main thread.
pub fn check(app: &AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let release: serde_json::Value = ureq::get(RELEASES_API)
        .set("User-Agent", "untacit-desktop")
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|err| format!("no se pudo consultar GitHub Releases: {err}"))?
        .into_json()
        .map_err(|err| format!("respuesta ilegible de GitHub Releases: {err}"))?;

    let tag = release["tag_name"].as_str().unwrap_or_default();
    let latest = tag.trim_start_matches(['v', 'V']).to_string();
    let update_available = match (parse_version(&current), parse_version(tag)) {
        (Some(cur), Some(new)) => new > cur,
        _ => false,
    };
    let installer_url = release["assets"].as_array().and_then(|assets| {
        assets.iter().find_map(|asset| {
            let name = asset["name"].as_str()?;
            if name.to_ascii_lowercase().ends_with(".exe") {
                asset["browser_download_url"].as_str().map(str::to_string)
            } else {
                None
            }
        })
    });
    let page_url = release["html_url"]
        .as_str()
        .unwrap_or(RELEASES_PAGE)
        .to_string();

    Ok(UpdateInfo {
        current,
        latest,
        update_available,
        page_url,
        installer_url,
    })
}

/// Apply an available update the most convenient way the platform allows:
/// Windows downloads and launches the NSIS installer (the app quits so the
/// installer can replace it); everything else opens the release page.
pub fn install(app: &AppHandle, info: &UpdateInfo) -> Result<(), String> {
    #[cfg(windows)]
    if let Some(url) = info.installer_url.as_deref() {
        let path = download_installer(url)?;
        std::process::Command::new(&path)
            .spawn()
            .map_err(|err| format!("no se pudo lanzar el instalador: {err}"))?;
        app.exit(0);
        return Ok(());
    }
    app.opener()
        .open_url(info.page_url.clone(), None::<&str>)
        .map_err(|err| err.to_string())
}

#[cfg(windows)]
fn download_installer(url: &str) -> Result<std::path::PathBuf, String> {
    use std::io::Read;

    let name = url.rsplit('/').next().unwrap_or("untacit-setup.exe");
    let path = std::env::temp_dir().join(name);
    let response = ureq::get(url)
        .set("User-Agent", "untacit-desktop")
        .call()
        .map_err(|err| format!("no se pudo descargar el instalador: {err}"))?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_INSTALLER_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("descarga interrumpida: {err}"))?;
    std::fs::write(&path, bytes).map_err(|err| format!("no se pudo guardar {}: {err}", path.display()))?;
    Ok(path)
}

/// Tray entry point: check in a background thread and talk to the user
/// through native dialogs (the tray handler must not block the main thread).
pub fn check_from_tray(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || match check(&app) {
        Err(err) => {
            app.dialog()
                .message(err)
                .title("untacit — buscar actualizaciones")
                .kind(MessageDialogKind::Error)
                .blocking_show();
        }
        Ok(info) if !info.update_available => {
            app.dialog()
                .message(format!("untacit {} está al día.", info.current))
                .title("untacit — buscar actualizaciones")
                .kind(MessageDialogKind::Info)
                .blocking_show();
        }
        Ok(info) => {
            let question = if cfg!(windows) && info.installer_url.is_some() {
                format!(
                    "Hay una versión nueva: {} (tienes {}).\n\n¿Descargar e instalar ahora? untacit se cerrará para ejecutar el instalador.",
                    info.latest, info.current
                )
            } else {
                format!(
                    "Hay una versión nueva: {} (tienes {}).\n\n¿Abrir la página de descarga?",
                    info.latest, info.current
                )
            };
            let confirmed = app
                .dialog()
                .message(question)
                .title("untacit — actualización disponible")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Actualizar".into(),
                    "Ahora no".into(),
                ))
                .blocking_show();
            if confirmed {
                if let Err(err) = install(&app, &info) {
                    app.dialog()
                        .message(err)
                        .title("untacit — actualización")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                }
            }
        }
    });
}

/// Silent startup check: emit the update event only when there is one —
/// network errors are irrelevant at startup and stay out of the user's way.
pub fn check_on_startup(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Ok(info) = check(&app) {
            if info.update_available {
                let _ = app.emit(UPDATE_AVAILABLE_EVENT, info);
            }
        }
    });
}

// ---- commands (frontend) ----

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || check(&app))
        .await
        .map_err(|err| err.to_string())?
}

/// Re-checks before installing so the download URL is fresh even if the
/// webview has kept an old `UpdateInfo` around.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let info = check(&app)?;
        if !info.update_available {
            return Err(format!("untacit {} ya está al día", info.current));
        }
        install(&app, &info)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::parse_version;

    #[test]
    fn parses_plain_and_tagged_versions() {
        assert_eq!(parse_version("0.1.0"), Some((0, 1, 0)));
        assert_eq!(parse_version("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("v0.2.0-beta.1"), Some((0, 2, 0)));
        assert_eq!(parse_version("v2"), Some((2, 0, 0)));
        assert_eq!(parse_version("not-a-version"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn newer_release_compares_greater() {
        assert!(parse_version("v0.2.0") > parse_version("0.1.0"));
        assert!(parse_version("v0.1.0") == parse_version("0.1.0"));
        assert!(parse_version("v0.1.0") < parse_version("0.1.1"));
    }
}
