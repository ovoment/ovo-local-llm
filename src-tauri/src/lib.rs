use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_sql::{Migration, MigrationKind};

mod mcp;
mod sidecar;

use mcp::McpState;
use sidecar::{SidecarState, SidecarStatus};

// [START] Phase R — chats.sqlite migrations registered via tauri-plugin-sql.
// The DB lives in the Tauri app data dir ($APPDATA/com.ovoment.ovo/chats.sqlite)
// and is owned by the frontend (sessions/messages/model_context_overrides).
fn chats_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "init: sessions + messages + model_context_overrides",
            sql: include_str!("../migrations/001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "wiki: wiki_pages + FTS5 index for persistent knowledge",
            sql: include_str!("../migrations/002_wiki.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "wiki: add tier column for Note / Casebook / Canonical",
            sql: include_str!("../migrations/003_wiki_tier.sql"),
            kind: MigrationKind::Up,
        },
    ]
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

// [START] Phase 6.2c — npm_search: proxy fetch to registry.npmjs.org through
// Rust so webview CORS doesn't block the MCP package search. Returns the raw
// JSON body as a string; the caller parses.
#[tauri::command]
async fn npm_search(query: String, size: Option<u32>) -> Result<String, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err("empty query".into());
    }
    let n = size.unwrap_or(20).min(100);
    let mut url = reqwest::Url::parse("https://registry.npmjs.org/-/v1/search")
        .map_err(|e| format!("bad npm url: {e}"))?;
    url.query_pairs_mut()
        .append_pair("text", trimmed)
        .append_pair("size", &n.to_string());
    let resp = reqwest::Client::new()
        .get(url)
        .header("User-Agent", "OVO/0.0.1 (mcp search)")
        .send()
        .await
        .map_err(|e| format!("npm fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("npm returned status {}", resp.status()));
    }
    resp.text().await.map_err(|e| format!("npm body read failed: {e}"))
}
// [END]

// [START] Phase 6.1b — read_md_dir: list all *.md / *.markdown files in a
// folder (non-recursive) and return their contents. Lets users add a whole
// folder of notes as project context in one click.
#[derive(Serialize)]
struct MdDirFile {
    name: String,
    path: String,
    content: String,
    size_bytes: u64,
}

#[derive(Serialize)]
struct MdDirResult {
    files: Vec<MdDirFile>,
}

#[tauri::command]
fn read_md_dir(path: String) -> Result<MdDirResult, String> {
    use std::fs;
    use std::path::Path;

    let p = Path::new(&path);
    if !p.is_dir() {
        return Err(format!("not a directory: {path}"));
    }

    let mut files: Vec<MdDirFile> = Vec::new();
    let entries = fs::read_dir(p).map_err(|e| format!("readdir {path}: {e}"))?;
    for entry in entries.flatten() {
        let entry_path = entry.path();
        if !entry_path.is_file() {
            continue;
        }
        let ext = entry_path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase());
        if !matches!(ext.as_deref(), Some("md") | Some("markdown")) {
            continue;
        }
        let name = entry_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let meta = match fs::metadata(&entry_path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size_bytes = meta.len();
        let content = if size_bytes > CONTEXT_MAX_BYTES {
            match fs::read(&entry_path) {
                Ok(bytes) => String::from_utf8_lossy(&bytes[..CONTEXT_MAX_BYTES as usize])
                    .into_owned(),
                Err(_) => continue,
            }
        } else {
            match fs::read_to_string(&entry_path) {
                Ok(s) => s,
                Err(_) => continue,
            }
        };
        files.push(MdDirFile {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            content,
            size_bytes,
        });
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(MdDirResult { files })
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:chats.sqlite", chats_migrations())
                .build(),
        )
        .setup(|app| {
            sidecar::setup(&app.handle().clone());
            // [START] Phase 6.2a — MCP state registration
            app.manage(McpState::new());
            // [END]
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
            read_md_file,
            read_md_dir,
            npm_search,
            // [START] Phase 6.2a — MCP commands
            mcp::mcp_start,
            mcp::mcp_call,
            mcp::mcp_stop,
            mcp::mcp_list
            // [END]
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
