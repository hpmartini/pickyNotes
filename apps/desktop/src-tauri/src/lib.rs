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

/// Plain-file second copy of every queued capture, so a lost IndexedDB cannot lose a note. One file per clientId, 0600.
fn outbox_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("outbox"))
}

/// The clientId becomes a file name: only [A-Za-z0-9_-]{1,64}, so it can never walk out of the outbox folder.
fn outbox_file(dir: &Path, client_id: &str) -> Result<std::path::PathBuf, String> {
    let ok = (1..=64).contains(&client_id.len()) && client_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok { Ok(dir.join(format!("{client_id}.json"))) } else { Err("invalid clientId".to_string()) }
}

/// Temp file with mode 0600, then rename: a crash leaves the old file or the new one, never half of it.
fn outbox_write_at(dir: &Path, client_id: &str, json: &str) -> Result<(), String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let target = outbox_file(dir, client_id)?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{client_id}.tmp"));
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).map_err(|e| e.to_string())?;
    f.write_all(json.as_bytes()).and_then(|_| f.sync_all()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())
}

/// Contents of every `<id>.json`; a missing folder is an empty outbox.
fn outbox_list_at(dir: &Path) -> Result<Vec<String>, String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(vec![]) };
    Ok(entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .collect())
}

/// Deleting a file that is already gone is fine.
fn outbox_delete_at(dir: &Path, client_id: &str) -> Result<(), String> {
    match std::fs::remove_file(outbox_file(dir, client_id)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[tauri::command]
fn outbox_write(app: AppHandle, client_id: String, json: String) -> Result<(), String> {
    outbox_write_at(&outbox_dir(&app)?, &client_id, &json)
}

#[tauri::command]
fn outbox_list(app: AppHandle) -> Result<Vec<String>, String> {
    outbox_list_at(&outbox_dir(&app)?)
}

#[tauri::command]
fn outbox_delete(app: AppHandle, client_id: String) -> Result<(), String> {
    outbox_delete_at(&outbox_dir(&app)?, &client_id)
}

/// Opens the outbox folder in Finder (created first, so the button works on an empty outbox).
#[tauri::command]
fn outbox_reveal(app: AppHandle) -> Result<(), String> {
    let dir = outbox_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let status = std::process::Command::new("open").arg(&dir).status().map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("open: {status}")) }
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
        prepare_overlay(&w);
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
    if let Some(w) = app.get_webview_window("main") {
        prepare_overlay(&w); // the activation policy change can reset the window's Space behavior
    }
    save_prefs(&app, ShellPrefs { dock: visible, ..load_prefs(&app) })
}

#[tauri::command]
fn set_tray_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    apply_tray(&app, visible).map_err(|e| e.to_string())?;
    save_prefs(&app, ShellPrefs { tray: visible, ..load_prefs(&app) })
}

/// Collection behavior that lets the window sit on any Space, including another app's fullscreen Space.
/// CanJoinAllSpaces and MoveToActiveSpace exclude each other, and FullScreenAuxiliary excludes FullScreenPrimary/None, so those are cleared first.
#[cfg(target_os = "macos")]
fn overlay_behavior(current: objc2_app_kit::NSWindowCollectionBehavior) -> objc2_app_kit::NSWindowCollectionBehavior {
    use objc2_app_kit::NSWindowCollectionBehavior as B;
    (current - B::MoveToActiveSpace - B::FullScreenPrimary - B::FullScreenNone) | B::CanJoinAllSpaces | B::FullScreenAuxiliary
}

/// Turns tao's NSWindow into a non-activating NSPanel in place. A plain NSWindow of a Regular (Dock) app is not shown over another app's
/// fullscreen Space even with FullScreenAuxiliary (measured: Accessory window shows, Regular window does not, Regular NSPanel does).
/// NSPanel and NSWindow have the same instance size (520 bytes), so swapping the class of the live object is safe; the new class keeps
/// tao's `focusable` ivar so tao's later ivar access still finds it. Idempotent.
#[cfg(target_os = "macos")]
fn make_panel(ns: &objc2_app_kit::NSWindow) -> &objc2_app_kit::NSPanel {
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, NSObjectProtocol, Sel};
    use objc2::{ClassType, sel};
    use objc2_app_kit::{NSPanel, NSWindowStyleMask};
    use std::sync::OnceLock;
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    unsafe extern "C-unwind" fn yes(_: &AnyObject, _: Sel) -> Bool {
        Bool::YES
    }
    let class = *CLASS.get_or_init(|| {
        let mut b = ClassBuilder::new(c"PickyPanel", NSPanel::class()).expect("PickyPanel registered twice");
        b.add_ivar::<Bool>(c"focusable");
        // SAFETY: the signatures match canBecomeKeyWindow/canBecomeMainWindow (-> BOOL).
        unsafe {
            b.add_method(sel!(canBecomeKeyWindow), yes as unsafe extern "C-unwind" fn(_, _) -> _);
            b.add_method(sel!(canBecomeMainWindow), yes as unsafe extern "C-unwind" fn(_, _) -> _);
        }
        b.register()
    });
    let obj = ns as *const _ as *mut AnyObject;
    // SAFETY: same instance size as the original class (see above); the object stays alive and is only touched on the main thread.
    unsafe {
        if !ns.isKindOfClass(class) {
            objc2::ffi::object_setClass(obj, class as *const AnyClass);
        }
        ns.setStyleMask(ns.styleMask() | NSWindowStyleMask::NonactivatingPanel);
        &*(obj as *const NSPanel)
    }
}

/// Makes the window able to appear over fullscreen apps (panel + collection behavior + floating level). Call it every time the window
/// is shown and after the activation policy changed: macOS drops or ignores these settings across hide/show and Regular/Accessory
/// switches, so setting them once at launch was not enough. Runs on the main thread, as AppKit requires.
fn prepare_overlay(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSFloatingWindowLevel, NSWindow};
        let w = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(ptr) = w.ns_window() {
                // SAFETY: ns_window() is the live NSWindow of this webview window and we are on the main thread.
                let ns = unsafe { &*(ptr as *const NSWindow) };
                let panel = make_panel(ns);
                panel.setFloatingPanel(true);
                panel.setHidesOnDeactivate(false);
                panel.setBecomesKeyOnlyIfNeeded(false);
                ns.setCollectionBehavior(overlay_behavior(ns.collectionBehavior()));
                ns.setLevel(NSFloatingWindowLevel);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

/// Shows, unminimizes and focuses the main window with the overlay settings re-applied (the JS hotkey handlers call this instead of the window API).
#[tauri::command]
fn show_main_window(app: AppHandle) {
    show_main(&app);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![keychain_get, keychain_set, screenshot, whisperstorm, set_dock_visible, set_tray_visible, show_main_window, outbox_write, outbox_list, outbox_delete, outbox_reveal])
        .on_window_event(|window, event| {
            // Keep running in the background so the global hotkey can bring the window back.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let prefs = load_prefs(app.handle());
            // A failed dock/tray apply must not stop the app from starting.
            if let Err(e) = apply_dock(app.handle(), prefs.dock) {
                eprintln!("dock: {e}");
            }
            // After apply_dock: the activation policy comes first, then the window settings.
            if let Some(w) = app.get_webview_window("main") {
                prepare_overlay(&w);
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

    fn temp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("picky-outbox-{}-{name}", std::process::id()))
    }

    #[test]
    fn outbox_round_trip_with_mode_0600_and_no_temp_leftovers() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("rt");
        outbox_write_at(&dir, "abc-123_X", r#"{"input":{}}"#).unwrap();
        outbox_write_at(&dir, "abc-123_X", r#"{"input":{"v":2}}"#).unwrap(); // overwrite
        assert_eq!(outbox_list_at(&dir).unwrap(), vec![r#"{"input":{"v":2}}"#.to_string()]);
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir.join("abc-123_X.json")), 0o600);
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        outbox_delete_at(&dir, "abc-123_X").unwrap();
        assert!(outbox_list_at(&dir).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn outbox_rejects_client_ids_that_could_leave_the_folder() {
        let dir = temp_dir("bad");
        for bad in ["", "../x", "a/b", "a.b", "a b", "ä", &"a".repeat(65)] {
            assert!(outbox_write_at(&dir, bad, "{}").is_err(), "{bad:?}");
            assert!(outbox_delete_at(&dir, bad).is_err(), "{bad:?}");
        }
        assert!(!dir.exists());
        assert!(outbox_write_at(&dir, &"a".repeat(64), "{}").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn outbox_missing_folder_lists_empty_and_deleting_a_missing_file_is_ok() {
        let dir = temp_dir("none");
        assert!(outbox_list_at(&dir).unwrap().is_empty());
        assert!(outbox_delete_at(&dir, "nope").is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn overlay_behavior_joins_all_spaces_as_fullscreen_auxiliary_and_keeps_unrelated_bits() {
        use objc2_app_kit::NSWindowCollectionBehavior as B;
        let start = B::MoveToActiveSpace | B::FullScreenPrimary | B::FullScreenNone | B::IgnoresCycle;
        let got = overlay_behavior(start);
        assert!(got.contains(B::CanJoinAllSpaces | B::FullScreenAuxiliary | B::IgnoresCycle));
        assert!(!got.intersects(B::MoveToActiveSpace | B::FullScreenPrimary | B::FullScreenNone));
        assert_eq!(overlay_behavior(got), got, "idempotent: safe to reapply on every show");
        assert_eq!(overlay_behavior(B::empty()), B::CanJoinAllSpaces | B::FullScreenAuxiliary);
    }
}
