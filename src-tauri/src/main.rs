// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use rand::Rng;
use serde::Serialize;
use tauri::menu::{Menu, MenuItem, MenuItemKind};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

mod native_browser;

const KEYRING_SERVICE: &str = "ai.factory.droid-control";
const KEYRING_USER: &str = "factory_api_key";

#[derive(Clone, Serialize)]
struct BridgeInfo {
    port: u16,
    token: String,
}

struct AppState {
    bridge: BridgeInfo,
    sidecar: Mutex<Option<Child>>,
}

fn generate_token() -> String {
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| format!("{:x}", rng.gen_range(0..16)))
        .collect()
}

// Resolve the sidecar entry. Override with SIDECAR_ENTRY, otherwise use the
// bundled build next to the Cargo manifest during development.
fn sidecar_entry() -> PathBuf {
    if let Ok(custom) = std::env::var("SIDECAR_ENTRY") {
        return PathBuf::from(custom);
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .map(|p| p.join("sidecar/dist/sidecar.mjs"))
        .unwrap_or_else(|| PathBuf::from("sidecar/dist/sidecar.mjs"))
}

fn app_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn node_bin() -> String {
    if let Ok(custom) = std::env::var("NODE_BIN") {
        return custom;
    }
    let homebrew = PathBuf::from("/opt/homebrew/bin/node");
    if homebrew.exists() {
        return homebrew.to_string_lossy().to_string();
    }
    "node".to_string()
}

fn spawn_sidecar(bridge: &BridgeInfo) -> Option<Child> {
    let entry = sidecar_entry();
    let node = node_bin();
    let mut command = Command::new(node);
    command
        .arg(entry)
        .current_dir(app_root())
        .env("BRIDGE_PORT", bridge.port.to_string())
        .env("BRIDGE_TOKEN", &bridge.token)
        .env("BRIDGE_EXIT_ON_STDIN_CLOSE", "0")
        .stdin(Stdio::null());
    if cfg!(debug_assertions) {
        command.env("BRIDGE_ALLOW_LOCAL_NO_TOKEN", "1");
    }
    match command.stdout(Stdio::inherit()).stderr(Stdio::inherit()).spawn() {
        Ok(child) => Some(child),
        Err(err) => {
            eprintln!("failed to spawn sidecar: {err}");
            None
        }
    }
}

fn ensure_sidecar(state: &AppState) {
    let Ok(mut guard) = state.sidecar.lock() else {
        return;
    };
    let needs_spawn = match guard.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(Some(status)) => {
                eprintln!("sidecar exited with status: {status}");
                true
            }
            Ok(None) => false,
            Err(err) => {
                eprintln!("failed to check sidecar status: {err}");
                true
            }
        },
        None => true,
    };
    if needs_spawn {
        *guard = spawn_sidecar(&state.bridge);
    }
}

#[tauri::command]
fn bridge_info(state: State<AppState>) -> BridgeInfo {
    ensure_sidecar(&state);
    state.bridge.clone()
}

#[tauri::command]
async fn pick_directory(app: AppHandle) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    rx.recv()
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_api_key() -> Option<String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()?;
    entry.get_password().ok()
}

#[tauri::command]
fn has_api_key() -> bool {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .and_then(|e| e.get_password())
        .is_ok()
}

#[tauri::command]
fn set_api_key(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
    entry.set_password(&key).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_api_key() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn list_files(dir: String) -> Result<Vec<String>, String> {
    const SKIP: &[&str] = &[
        "node_modules",
        ".git",
        "dist",
        "build",
        "target",
        ".next",
        ".cache",
        "out",
    ];
    const MAX_FILES: usize = 6000;

    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err("not a directory".to_string());
    }

    let mut out: Vec<String> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.clone()];

    while let Some(current) = stack.pop() {
        if out.len() >= MAX_FILES {
            break;
        }
        let entries = match std::fs::read_dir(&current) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                if name.starts_with('.') || SKIP.contains(&name.as_str()) {
                    continue;
                }
                stack.push(path);
            } else if file_type.is_file() {
                if let Ok(rel) = path.strip_prefix(&root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                    if out.len() >= MAX_FILES {
                        break;
                    }
                }
            }
        }
    }

    out.sort();
    Ok(out)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let expanded = if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs_home() {
            home.join(rest).to_string_lossy().to_string()
        } else {
            path.clone()
        }
    } else {
        path.clone()
    };
    std::fs::read_to_string(&expanded).map_err(|e| e.to_string())
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn main() {
    let port: u16 = std::env::var("BRIDGE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8765);
    let bridge = BridgeInfo {
        port,
        token: generate_token(),
    };
    let sidecar = spawn_sidecar(&bridge);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .menu(|handle| {
            let menu = Menu::default(handle)?;
            let refresh = MenuItem::with_id(handle, "refresh", "Refresh", true, Some("CmdOrCtrl+R"))?;
            if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
                let _ = app_menu.insert(&refresh, 1);
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id() == "refresh" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.location.reload()");
                }
            }
        })
        .manage(AppState {
            bridge,
            sidecar: Mutex::new(sidecar),
        })
        .manage(native_browser::NativeBrowserState::default())
        .invoke_handler(tauri::generate_handler![
            bridge_info,
            pick_directory,
            notify,
            get_api_key,
            has_api_key,
            set_api_key,
            clear_api_key,
            list_files,
            read_file,
            native_browser::native_browser_open,
            native_browser::native_browser_set_bounds,
            native_browser::native_browser_close,
            native_browser::native_browser_set_design_mode,
            native_browser::native_browser_set_sketch_mode,
            native_browser::native_browser_reload
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    if let Ok(mut guard) = state.sidecar.lock() {
                        if let Some(child) = guard.as_mut() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
