#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use tauri::menu::MenuBuilder;
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_TOOLTIP: &str = "Agent Hotline: idle";
const OPEN_PANEL: &str = "open-panel";
const READ_LATEST: &str = "read-latest";
const PAUSE_RESUME: &str = "pause-resume";
const STOP: &str = "stop";
const REPLAY: &str = "replay";
const MUTE_UNMUTE: &str = "mute-unmute";
const SETTINGS: &str = "settings";
const QUIT: &str = "quit";

#[derive(serde::Serialize)]
struct BackendStatus {
    reachable: bool,
    detail: String,
}

#[derive(Clone, serde::Serialize)]
struct TrayActionPayload {
    action: &'static str,
}

#[tauri::command]
fn backend_status(url: String) -> BackendStatus {
    match parse_local_backend(&url) {
        Ok((host, port)) => {
            let address = if host.contains(':') {
                format!("[{host}]:{port}")
            } else {
                format!("{host}:{port}")
            };
            match address.to_socket_addrs() {
                Ok(mut addresses) => {
                    let Some(socket_address) = addresses.next() else {
                        return BackendStatus {
                            reachable: false,
                            detail: format!("No socket address resolved for {address}."),
                        };
                    };

                    match TcpStream::connect_timeout(&socket_address, Duration::from_millis(700)) {
                        Ok(_) => BackendStatus {
                            reachable: true,
                            detail: format!(
                                "Connected to {address}. Queue health endpoints are available."
                            ),
                        },
                        Err(error) => BackendStatus {
                            reachable: false,
                            detail: format!("Start the backend with npm run dev:backend. {error}"),
                        },
                    }
                }
                Err(error) => BackendStatus {
                    reachable: false,
                    detail: format!("Could not resolve {address}: {error}"),
                },
            }
        }
        Err(error) => BackendStatus {
            reachable: false,
            detail: error,
        },
    }
}

fn parse_local_backend(url: &str) -> Result<(String, u16), String> {
    let without_scheme = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .ok_or_else(|| "AGENT_HOTLINE_URL must start with http:// or https://.".to_string())?;
    let authority = without_scheme.split('/').next().unwrap_or_default();
    let (host, port_text) = authority
        .rsplit_once(':')
        .ok_or_else(|| "AGENT_HOTLINE_URL must include an explicit port.".to_string())?;

    if !matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
        return Err("Desktop backend checks are restricted to localhost targets.".to_string());
    }

    let port = port_text
        .parse::<u16>()
        .map_err(|_| "AGENT_HOTLINE_URL port must be a number.".to_string())?;

    Ok((host.trim_matches(['[', ']']).to_string(), port))
}

fn open_panel(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    let _ = window.unminimize();
    let _ = window.show();
}

fn emit_placeholder_action(app: &tauri::AppHandle, action: &'static str) {
    let _ = app.emit("agent-hotline://tray-action", TrayActionPayload { action });
}

fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let menu = MenuBuilder::new(app)
        .text(OPEN_PANEL, "Open Panel")
        .separator()
        .text(READ_LATEST, "Read Latest")
        .text(PAUSE_RESUME, "Pause/Resume")
        .text(STOP, "Stop")
        .text(REPLAY, "Replay")
        .text(MUTE_UNMUTE, "Mute/Unmute")
        .separator()
        .text(SETTINGS, "Settings")
        .separator()
        .text(QUIT, "Quit")
        .build()?;

    TrayIconBuilder::with_id("agent-hotline")
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("default app icon"),
        )
        .tooltip(TRAY_TOOLTIP)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_PANEL | SETTINGS => open_panel(app),
            READ_LATEST => emit_placeholder_action(app, READ_LATEST),
            PAUSE_RESUME => emit_placeholder_action(app, PAUSE_RESUME),
            STOP => emit_placeholder_action(app, STOP),
            REPLAY => emit_placeholder_action(app, REPLAY),
            MUTE_UNMUTE => emit_placeholder_action(app, MUTE_UNMUTE),
            QUIT => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .setup(setup_tray)
        .invoke_handler(tauri::generate_handler![backend_status])
        .build(tauri::generate_context!())
        .expect("error while building Agent Hotline desktop");

    app.run(|app, event| {
        if let RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } = event
        {
            if label == MAIN_WINDOW_LABEL {
                api.prevent_close();
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = window.hide();
                }
            }
        }
    });
}
