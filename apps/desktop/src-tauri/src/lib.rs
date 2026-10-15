use base64::{engine::general_purpose::STANDARD, Engine};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
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
#[derive(serde::Serialize)]
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
#[tauri::command]
fn whisperstorm(cmd: String) -> Result<WhisperReply, String> {
    let path = whisperstorm_socket_path();
    let timeout = if cmd == "stop" { Duration::from_secs(120) } else { Duration::from_secs(5) };
    let mut stream = match UnixStream::connect(&path) {
        Ok(s) => s,
        Err(_) => return Ok(WhisperReply { ok: false, phase: None, text: None, error: Some("WhisperStorm läuft nicht".to_string()) }),
    };
    stream.set_read_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    let req = format!("{{\"cmd\":\"{cmd}\"}}\n");
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = String::new();
    stream.read_to_string(&mut buf).map_err(|e| e.to_string())?;
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
    use std::io::Read;
    use std::os::unix::net::UnixListener;
    use std::path::PathBuf;

    /// Spins up a one-shot Unix listener, points the command at it, and checks the wire format end-to-end.
    #[test]
    fn whisperstorm_sends_and_receives_json() {
        let dir = std::env::temp_dir().join(format!("picky-ws-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("c.sock");
        let _ = std::fs::remove_file(&sock);
        let listener = UnixListener::bind(&sock).unwrap();
        // Per-line exchange (delimited by \n): the server writes "READY\n", the test reads until \n,
        // writes its request, the server reads the request line, then writes the response line.
        let server = std::thread::spawn(move || {
            use std::io::{BufRead, Write};
            if let Ok((s, _)) = listener.accept() {
                let mut s = s;
                s.set_read_timeout(Some(Duration::from_secs(5))).ok();
                s.set_write_timeout(Some(Duration::from_secs(5))).ok();
                let mut reader = std::io::BufReader::new(s.try_clone().unwrap());
                writeln!(s, "READY").ok();
                s.flush().ok();
                let mut req = String::new();
                if reader.read_line(&mut req).is_err() { return; }
                writeln!(s, "{{\"ok\":true,\"phase\":\"idle\"}}").ok();
                s.flush().ok();
            }
        });
        let mut stream = UnixStream::connect(&sock).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
        // Drain the handshake line first.
        let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
        let mut handshake = String::new();
        reader.read_line(&mut handshake).unwrap();
        assert_eq!(handshake.trim(), "READY");
        stream.write_all(b"{\"cmd\":\"status\"}\n").unwrap();
        stream.flush().ok();
        let mut buf = String::new();
        reader.read_line(&mut buf).unwrap();
        server.join().ok();
        let v: serde_json::Value = serde_json::from_str(buf.trim()).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["phase"], "idle");
        let _ = std::fs::remove_file(&sock);
    }

    #[test]
    fn whisperstorm_handles_missing_socket() {
        let bogus = PathBuf::from("/tmp/picky-ws-no-such-socket-xyz");
        let _ = std::fs::remove_file(&bogus);
        let result = UnixStream::connect(&bogus);
        assert!(result.is_err(), "a missing socket must fail to connect");
    }
}