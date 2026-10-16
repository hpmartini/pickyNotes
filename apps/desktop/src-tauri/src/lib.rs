use base64::{engine::general_purpose::STANDARD, Engine};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

const KEYCHAIN_SERVICE: &str = "de.martinilabs.pickynotes";
// shortcut: resolved at runtime via std::env::var("HOME") so the same build runs on any machine; the socket lives at ~/Library/Application Support/WhisperStorm/control.sock, which WhisperStorm creates on launch with 0600.
fn whisperstorm_socket_path() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    format!("{home}/Library/Application Support/WhisperStorm/control.sock")
}

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

/// Reply shape from `whisperstorm(cmd)`. The TypeScript wrapper turns this into the typed `WhisperReply`.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct WhisperReply {
    ok: bool,
    phase: Option<String>,
    text: Option<String>,
    error: Option<String>,
}

/// Sends one JSON request to the WhisperStorm control socket and returns the parsed reply.
/// `stop` may take seconds while the transcript is computed, so the read timeout is generous.
/// A missing socket or refused connection answers with `{ ok: false, error: "WhisperStorm läuft nicht" }` so the UI can show a clear message.
/// Async + spawn_blocking: `stop` can block up to 120 s and must not occupy the main thread.
#[tauri::command]
async fn whisperstorm(cmd: String) -> Result<WhisperReply, String> {
    tauri::async_runtime::spawn_blocking(move || whisperstorm_at(Path::new(&whisperstorm_socket_path()), &cmd))
        .await
        .map_err(|e| e.to_string())?
}

/// Client read deadline per command. `start` must outlast WhisperStorm's own 30 s start wait (ControlSocketServer.swift) plus margin.
fn read_timeout(cmd: &str) -> Duration {
    Duration::from_secs(match cmd {
        "stop" => 120,
        "start" => 40,
        _ => 5,
    })
}

/// The socket exchange behind the command, with the path as a parameter so tests can use a fake listener.
fn whisperstorm_at(path: &Path, cmd: &str) -> Result<WhisperReply, String> {
    let timeout = read_timeout(cmd);
    let mut stream = match UnixStream::connect(path) {
        Ok(s) => s,
        Err(_) => return Ok(WhisperReply { ok: false, phase: None, text: None, error: Some("WhisperStorm läuft nicht".to_string()) }),
    };
    stream.set_read_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    let req = format!("{}\n", serde_json::json!({ "cmd": cmd }));
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    // Replies are newline-terminated; read one line instead of waiting for EOF.
    let mut buf = String::new();
    BufReader::new(&stream).read_line(&mut buf).map_err(|e| e.to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(&buf).map_err(|e| e.to_string())?;
    Ok(WhisperReply {
        ok: parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
        phase: parsed.get("phase").and_then(|v| v.as_str()).map(|s| s.to_string()),
        text: parsed.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()),
        error: parsed.get("error").and_then(|v| v.as_str()).map(|s| s.to_string()),
    })
}

/// Dock / menu-bar choices. Rust reads them at launch (the webview is not up yet), so they live in a small JSON file, not localStorage.
#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Clone, Copy)]
#[serde(default)]
struct ShellPrefs {
    dock: bool,
    tray: bool,
}

impl Default for ShellPrefs {
    fn default() -> Self {
        Self { dock: true, tray: false }
    }
}

/// A missing field takes its default; unreadable JSON falls back to all defaults.
fn parse_prefs(raw: &str) -> ShellPrefs {
    serde_json::from_str(raw).unwrap_or_default()
}

fn prefs_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("shell-prefs.json"))
}

fn load_prefs(app: &AppHandle) -> ShellPrefs {
    prefs_path(app).ok().and_then(|p| std::fs::read_to_string(p).ok()).map(|s| parse_prefs(&s)).unwrap_or_default()
}

fn save_prefs(app: &AppHandle, prefs: ShellPrefs) -> Result<(), String> {
    let path = prefs_path(app)?;
    std::fs::create_dir_all(path.parent().ok_or("no config dir")?).map_err(|e| e.to_string())?;
    std::fs::write(path, serde_json::to_string(&prefs).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Dock off = Accessory policy: no Dock icon and gone from Cmd+Tab. macOS only.
fn apply_dock(app: &AppHandle, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    app.set_activation_policy(if visible { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory }).map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let _ = (app, visible);
    Ok(())
}

const TRAY_ID: &str = "main-tray";

#[derive(Debug, PartialEq)]
enum MenuAction {
    Toggle,
    Settings,
    Quit,
}

fn menu_action(id: &str) -> Option<MenuAction> {
    match id {
        "toggle" => Some(MenuAction::Toggle),
        "settings" => Some(MenuAction::Settings),
        "quit" => Some(MenuAction::Quit),
        _ => None,
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Hide when visible and focused, otherwise bring to the front (same rule as the show/hide hotkey).
fn toggle_main(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(w) if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) => {
            let _ = w.hide();
        }
        _ => show_main(app),
    }
}

fn apply_tray(app: &AppHandle, visible: bool) -> tauri::Result<()> {
    // One tray for the whole run, only shown/hidden: building it again would register the menu handlers again.
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        return tray.set_visible(visible);
    }
    if !visible {
        return Ok(());
    }
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "toggle", "Anzeigen/Verbergen", true, None::<&str>)?,
            &MenuItem::with_id(app, "settings", "Einstellungen", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?,
        ],
    )?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match menu_action(e.id.as_ref()) {
            Some(MenuAction::Toggle) => toggle_main(app),
            Some(MenuAction::Settings) => {
                show_main(app);
                let _ = app.emit("picky:open-settings", ());
            }
            Some(MenuAction::Quit) => app.exit(0),
            None => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                toggle_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[tauri::command]
fn set_dock_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    apply_dock(&app, visible)?;
    save_prefs(&app, ShellPrefs { dock: visible, ..load_prefs(&app) })
}

#[tauri::command]
fn set_tray_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    apply_tray(&app, visible).map_err(|e| e.to_string())?;
    save_prefs(&app, ShellPrefs { tray: visible, ..load_prefs(&app) })
}

/// Show the window on every Space, including over another app's fullscreen Space (main thread only: called from setup).
#[cfg(target_os = "macos")]
fn float_over_fullscreen(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    if let Ok(ptr) = window.ns_window() {
        // SAFETY: ns_window() is the live NSWindow of this webview window; setup runs on the main thread.
        let ns = unsafe { &*(ptr as *const NSWindow) };
        ns.setCollectionBehavior(ns.collectionBehavior() | NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::FullScreenAuxiliary);
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![keychain_get, keychain_set, screenshot, whisperstorm, set_dock_visible, set_tray_visible])
        .on_window_event(|window, event| {
            // Keep running in the background so the global hotkey can bring the window back.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            if let Some(w) = app.get_webview_window("main") {
                float_over_fullscreen(&w);
            }
            let prefs = load_prefs(app.handle());
            // A failed dock/tray apply must not stop the app from starting.
            if let Err(e) = apply_dock(app.handle(), prefs.dock) {
                eprintln!("dock: {e}");
            }
            if let Err(e) = apply_tray(app.handle(), prefs.tray) {
                eprintln!("tray: {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running pickyNotes");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    fn temp_sock(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("picky-ws-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("c.sock")
    }

    /// A fake WhisperStorm: records the request line it receives and answers with `reply`.
    fn fake_server(sock: &Path, reply: &str) -> std::thread::JoinHandle<String> {
        let listener = UnixListener::bind(sock).unwrap();
        let reply = reply.to_string();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut line = String::new();
            BufReader::new(s.try_clone().unwrap()).read_line(&mut line).unwrap();
            writeln!(s, "{reply}").unwrap();
            line
        })
    }

    #[test]
    fn shell_prefs_default_when_missing_corrupt_or_partial() {
        assert_eq!(ShellPrefs::default(), ShellPrefs { dock: true, tray: false });
        assert_eq!(parse_prefs(""), ShellPrefs::default());
        assert_eq!(parse_prefs("{not json"), ShellPrefs::default());
        assert_eq!(parse_prefs(r#"{"tray":true}"#), ShellPrefs { dock: true, tray: true });
        assert_eq!(parse_prefs(r#"{"dock":false}"#), ShellPrefs { dock: false, tray: false });
    }

    #[test]
    fn shell_prefs_round_trip() {
        let p = ShellPrefs { dock: false, tray: true };
        assert_eq!(parse_prefs(&serde_json::to_string(&p).unwrap()), p);
    }

    #[test]
    fn tray_menu_ids_map_to_actions() {
        assert_eq!(menu_action("toggle"), Some(MenuAction::Toggle));
        assert_eq!(menu_action("settings"), Some(MenuAction::Settings));
        assert_eq!(menu_action("quit"), Some(MenuAction::Quit));
        assert_eq!(menu_action("other"), None);
    }

    #[test]
    fn start_deadline_outlasts_the_30s_swift_start_wait() {
        assert!(read_timeout("start") > Duration::from_secs(30));
        assert!(read_timeout("stop") > read_timeout("start"));
        assert_eq!(read_timeout("status"), Duration::from_secs(5));
    }

    #[test]
    fn whisperstorm_at_sends_the_request_line_and_parses_the_reply() {
        let sock = temp_sock("roundtrip");
        let server = fake_server(&sock, r#"{"ok":true,"phase":"success","text":"Hallo Welt"}"#);
        let reply = whisperstorm_at(&sock, "stop").unwrap();
        assert_eq!(server.join().unwrap(), "{\"cmd\":\"stop\"}\n");
        assert_eq!(reply, WhisperReply { ok: true, phase: Some("success".into()), text: Some("Hallo Welt".into()), error: None });
        let _ = std::fs::remove_dir_all(sock.parent().unwrap());
    }

    #[test]
    fn whisperstorm_at_returns_on_the_newline_without_waiting_for_eof() {
        let sock = temp_sock("newline");
        let listener = UnixListener::bind(&sock).unwrap();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(s.try_clone().unwrap()).read_line(&mut line).unwrap();
            s.write_all(b"{\"ok\":true,\"phase\":\"idle\"}\n").unwrap();
            // Keep the connection open: the client must not depend on EOF.
            std::thread::sleep(Duration::from_secs(3));
        });
        let started = std::time::Instant::now();
        let reply = whisperstorm_at(&sock, "status").unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(reply, WhisperReply { ok: true, phase: Some("idle".into()), text: None, error: None });
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(sock.parent().unwrap());
    }

    #[test]
    fn whisperstorm_at_missing_socket_answers_with_the_user_facing_error() {
        let reply = whisperstorm_at(Path::new("/tmp/picky-ws-no-such-socket-xyz"), "status").unwrap();
        assert_eq!(reply, WhisperReply { ok: false, phase: None, text: None, error: Some("WhisperStorm läuft nicht".into()) });
    }
}
