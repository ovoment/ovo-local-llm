use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_sql::{Migration, MigrationKind};

mod sidecar;

use sidecar::{SidecarState, SidecarStatus};

// [START] Phase R — chats.sqlite migrations registered via tauri-plugin-sql.
// The DB lives in the Tauri app data dir ($APPDATA/com.ovoment.ovo/chats.sqlite)
// and is owned by the frontend (sessions/messages/model_context_overrides).
fn chats_migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "init: sessions + messages + model_context_overrides",
        sql: include_str!("../migrations/001_init.sql"),
        kind: MigrationKind::Up,
    }]
}
// [END]

#[derive(Serialize)]
struct AppInfo {
    name: &'static str,
    version: &'static str,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: "OVO",
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[tauri::command]
fn sidecar_status(app: AppHandle) -> SidecarStatus {
    app.state::<SidecarState>().snapshot()
}

#[tauri::command]
async fn sidecar_restart(app: AppHandle) -> Result<(), String> {
    sidecar::restart(app).await;
    Ok(())
}

// [START] Phase 6.1 — read project context files (CLAUDE.md / AGENTS.md / GEMINI.md)
// Runs on the Rust side so no JS FS permission gymnastics are needed.
const CONTEXT_FILENAMES: &[&str] = &["CLAUDE.md", "AGENTS.md", "GEMINI.md"];
const CONTEXT_MAX_BYTES: u64 = 200_000;

// [START] Phase 6.2 — default_project_path: returns user home dir as absolute path
#[tauri::command]
fn default_project_path() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "HOME directory not found".to_string())
}
// [END]

// [START] Phase 6.2 — read_md_file: reads any absolute path (200KB cap, utf8_lossy)
#[derive(Serialize)]
struct MdFileResult {
    name: String,
    content: String,
    size_bytes: u64,
}

#[tauri::command]
fn read_md_file(path: String) -> Result<MdFileResult, String> {
    use std::fs;
    use std::path::Path;

    let p = Path::new(&path);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());

    let meta = fs::metadata(p).map_err(|e| format!("Cannot stat {path}: {e}"))?;
    let size_bytes = meta.len();

    let content = if size_bytes > CONTEXT_MAX_BYTES {
        let bytes = fs::read(p).map_err(|e| format!("Cannot read {path}: {e}"))?;
        String::from_utf8_lossy(&bytes[..CONTEXT_MAX_BYTES as usize]).into_owned()
    } else {
        fs::read_to_string(p).map_err(|e| format!("Cannot read {path}: {e}"))?
    };

    Ok(MdFileResult { name, content, size_bytes })
}
// [END]

#[derive(Serialize)]
struct ProjectContextFile {
    name: String,
    content: String,
    size_bytes: u64,
}

#[derive(Serialize)]
struct ProjectContextResult {
    files: Vec<ProjectContextFile>,
}

#[tauri::command]
fn read_project_context(project_path: String) -> Result<ProjectContextResult, String> {
    use std::fs;
    use std::path::Path;

    let base = Path::new(&project_path);
    let mut files: Vec<ProjectContextFile> = Vec::new();

    for name in CONTEXT_FILENAMES {
        let path = base.join(name);
        match fs::metadata(&path) {
            Ok(meta) => {
                let size_bytes = meta.len();
                if size_bytes > CONTEXT_MAX_BYTES {
                    // Cap: read only the first CONTEXT_MAX_BYTES bytes to prevent runaway
                    match fs::read(&path) {
                        Ok(bytes) => {
                            let truncated = &bytes[..CONTEXT_MAX_BYTES as usize];
                            let content = String::from_utf8_lossy(truncated).into_owned();
                            files.push(ProjectContextFile {
                                name: name.to_string(),
                                content,
                                size_bytes,
                            });
                        }
                        Err(_) => continue,
                    }
                } else {
                    match fs::read_to_string(&path) {
                        Ok(content) => {
                            files.push(ProjectContextFile {
                                name: name.to_string(),
                                content,
                                size_bytes,
                            });
                        }
                        Err(_) => continue, // unreadable — skip silently
                    }
                }
            }
            Err(_) => continue, // file not found — skip silently
        }
    }

    Ok(ProjectContextResult { files })
}
// [END]

// [START] Phase 7 — pet window lifecycle commands
#[tauri::command]
fn pet_show(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("pet")
        .ok_or_else(|| "pet window not found".to_string())?
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn pet_hide(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("pet")
        .ok_or_else(|| "pet window not found".to_string())?
        .hide()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn focus_main_window(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?
        .set_focus()
        .map_err(|e| e.to_string())
}
// [END]

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:chats.sqlite", chats_migrations())
                .build(),
        )
        .setup(|app| {
            sidecar::setup(&app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            sidecar_status,
            sidecar_restart,
            pet_show,
            pet_hide,
            focus_main_window,
            read_project_context,
            default_project_path,
            read_md_file
        ])
        .build(tauri::generate_context!())
        .expect("error while building OVO");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            sidecar::kill(app_handle);
        }
        _ => {}
    });
}
