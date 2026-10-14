use base64::{engine::general_purpose::STANDARD, Engine};
use tauri::{Manager, WindowEvent};

const KEYCHAIN_SERVICE: &str = "de.martinilabs.pickynotes";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, "device-token").map_err(|e| e.to_string())
}

/// Device token lives in the macOS keychain, never in a file or localStorage.
#[tauri::command]
fn keychain_get() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn keychain_set(value: String) -> Result<(), String> {
    entry()?.set_password(&value).map_err(|e| e.to_string())
}

/// Interactive region/window capture via the system `screencapture`.
/// Needs the Screen Recording permission on first use. Returns base64 PNG, or None if cancelled.
#[tauri::command]
fn screenshot() -> Result<Option<String>, String> {
    let path = std::env::temp_dir().join(format!("pickynotes-{}.png", std::process::id()));
    let status = std::process::Command::new("screencapture")
        .args(["-i", "-x"])
        .arg(&path)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() || !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&path);
    Ok(Some(STANDARD.encode(bytes)))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![keychain_get, keychain_set, screenshot])
        .on_window_event(|window, event| {
            // Keep running in the background so the global hotkey can bring the window back.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running pickyNotes");
}
