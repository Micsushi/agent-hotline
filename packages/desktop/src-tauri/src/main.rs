#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, PhysicalPosition, RunEvent, WindowEvent};
use tauri_plugin_window_state::StateFlags;

// The Node backend, owned by the app: spawned on launch, killed on exit so the
// port is never left occupied after Agent Hotline quits.
struct BackendProcess(Mutex<Option<Child>>);

// Name of the bundled self-contained backend, placed next to the app binary by
// Tauri's externalBin (target triple stripped at install time).
#[cfg(target_os = "windows")]
const BACKEND_BIN: &str = "agent-hotline-backend.exe";
#[cfg(not(target_os = "windows"))]
const BACKEND_BIN: &str = "agent-hotline-backend";

fn spawn_backend() -> Option<Child> {
    // Debug builds run the backend source with the system Node (dev layout).
    // Release builds run the bundled self-contained backend next to the app exe,
    // so no Node install is required. If a backend is already running, ours hits
    // EADDRINUSE and exits cleanly (see server.js), so spawning is always safe.
    let mut command = if cfg!(debug_assertions) {
        let server = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../backend/src/server.js");
        let mut node = Command::new("node");
        node.arg(server);
        node
    } else {
        let sidecar = std::env::current_exe().ok()?.parent()?.join(BACKEND_BIN);
        Command::new(sidecar)
    };

    command.spawn().ok()
}

fn kill_backend(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<BackendProcess>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}

const MAIN_WINDOW_LABEL: &str = "main";
const MINI_WINDOW_LABEL: &str = "mini";
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
                            detail: format!("Restart Agent Hotline with npm run restart. {error}"),
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
    let _ = window.maximize();
    let _ = window.show();
    let _ = window.set_focus();
    // Force the panel to pull the freshest queue the moment it appears, so it
    // never shows stale state while the poll loop catches up.
    let _ = app.emit_to(MAIN_WINDOW_LABEL, "agent-hotline://show", ());
}

fn hide_mini(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MINI_WINDOW_LABEL) {
        let _ = window.hide();
    }
}

// Pop the compact controls up near the tray icon on a left click and force a
// refresh so the latest reply and its read controls are immediately usable.
fn show_mini(app: &tauri::AppHandle, click: PhysicalPosition<f64>) {
    let Some(window) = app.get_webview_window(MINI_WINDOW_LABEL) else {
        return;
    };

    let size = window
        .outer_size()
        .map(|s| (s.width as f64, s.height as f64))
        .unwrap_or((340.0, 210.0));
    // Anchor the popup just above-left of the cursor (tray sits bottom-right on
    // a default Windows taskbar). Clamp so it never lands off the top/left edge.
    let x = (click.x - size.0).max(8.0);
    let y = (click.y - size.1 - 12.0).max(8.0);

    let _ = window.set_position(PhysicalPosition::new(x, y));
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit_to(MINI_WINDOW_LABEL, "agent-hotline://show", ());
}

#[tauri::command]
fn show_main_panel(app: tauri::AppHandle) {
    hide_mini(&app);
    open_panel(&app);
}

// Open the mini popup without a tray cursor position (e.g. from a notification
// click): anchor it bottom-right above the taskbar on its monitor.
#[tauri::command]
fn show_mini_panel(app: tauri::AppHandle) {
    let Some(window) = app.get_webview_window(MINI_WINDOW_LABEL) else {
        return;
    };

    let size = window
        .outer_size()
        .map(|s| (s.width as f64, s.height as f64))
        .unwrap_or((340.0, 268.0));

    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let m = monitor.size();
        let x = (m.width as f64) - size.0 - 16.0;
        let y = (m.height as f64) - size.1 - 56.0;
        let _ = window.set_position(PhysicalPosition::new(x.max(8.0), y.max(8.0)));
    }

    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit_to(MINI_WINDOW_LABEL, "agent-hotline://show", ());
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
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                position,
                ..
            } = event
            {
                show_mini(tray.app_handle(), position);
            }
        })
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
        // Must be registered first: a second launch focuses the existing window
        // instead of starting another instance.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            hide_mini(app);
            open_panel(app);
        }))
        // Remember the main window's monitor + position across restarts (so
        // "Open Panel" reopens on the last-used screen). Position/size only, so
        // windows still start hidden (tray-resident). Mini is positioned live.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::POSITION | StateFlags::SIZE)
                .with_denylist(&[MINI_WINDOW_LABEL])
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            if let Some(child) = spawn_backend() {
                app.manage(BackendProcess(Mutex::new(Some(child))));
            }
            setup_tray(app)?;
            open_panel(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_status,
            show_main_panel,
            show_mini_panel
        ])
        .build(tauri::generate_context!())
        .expect("error while building Agent Hotline desktop");

    app.run(|app, event| match event {
        RunEvent::WindowEvent { label, event, .. } => match event {
            // Keep the app tray-resident: closing a window just hides it.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.hide();
                }
            }
            // Dismiss the tray popup as soon as the user clicks elsewhere.
            WindowEvent::Focused(false) if label == MINI_WINDOW_LABEL => {
                hide_mini(app);
            }
            _ => {}
        },
        // App is quitting (tray Quit / exit): stop the backend so :4777 frees.
        RunEvent::Exit => kill_backend(app),
        _ => {}
    });
}
