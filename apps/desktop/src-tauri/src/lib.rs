use base64::{engine::general_purpose::STANDARD, Engine};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;
use tauri::{Manager, WindowEvent};

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

/// The socket exchange behind the command, with the path as a parameter so tests can use a fake listener.
fn whisperstorm_at(path: &Path, cmd: &str) -> Result<WhisperReply, String> {
    let timeout = if cmd == "stop" { Duration::from_secs(120) } else { Duration::from_secs(5) };
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![keychain_get, keychain_set, screenshot, whisperstorm])
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
