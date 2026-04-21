use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_sql::{Migration, MigrationKind};

mod code_fs;
mod git_ops;
mod mcp;
mod pty;
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
        Migration {
            version: 4,
            description: "wiki: embeddings cache for semantic search",
            sql: include_str!("../migrations/004_embeddings.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "wiki: archive flag + project_path namespace",
            sql: include_str!("../migrations/005_wiki_archive_namespace.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "code: IDE sessions + agent messages",
            sql: include_str!("../migrations/006_code_sessions.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "sessions: parent_session_id + parent_message_id for forks",
            sql: include_str!("../migrations/007_message_branching.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "ping pong sessions + messages",
            sql: include_str!("../migrations/008_pingpong.sql"),
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

// [START] Phase R — user-initiated runtime reinstall.
// Removes the user venv under $APPDATA/runtime/sidecar-venv and re-triggers
// the bootstrap flow. Exposed to the frontend for the Settings button.
#[tauri::command]
async fn sidecar_reinstall_runtime(app: AppHandle) -> Result<(), String> {
    sidecar::reinstall_runtime(app).await
}
// [END]

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

    // [START] Security — restrict to .md / .markdown extensions to prevent
    // arbitrary file reads (e.g. /etc/passwd) from a compromised webview.
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase());
    if !matches!(ext.as_deref(), Some("md") | Some("markdown")) {
        return Err("only .md / .markdown files are permitted".into());
    }
    // [END]

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

// [START] Phase 8 — write_md_file / delete_md_file
// Companion writes to read_md_file. Scope-locked to paths containing a
// `/.ovo/` segment so a compromised webview cannot clobber arbitrary files.
// Required by md-backed stores (personas, skills, future wiki import).
#[tauri::command]
fn write_md_file(path: String, content: String) -> Result<(), String> {
    use std::fs;
    use std::path::Path;

    let p = Path::new(&path);

    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase());
    if !matches!(ext.as_deref(), Some("md") | Some("markdown")) {
        return Err("only .md / .markdown files are permitted".into());
    }

    let path_str = p.to_string_lossy();
    if !path_str.contains("/.ovo/") && !path_str.contains("\\.ovo\\") {
        return Err("writes restricted to .ovo/** paths".into());
    }

    if content.len() > CONTEXT_MAX_BYTES as usize {
        return Err(format!("content too large (>{CONTEXT_MAX_BYTES} bytes)"));
    }

    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir -p {}: {}", parent.display(), e))?;
    }

    fs::write(p, content).map_err(|e| format!("write {path}: {e}"))?;
    Ok(())
}

#[tauri::command]
fn delete_md_file(path: String) -> Result<(), String> {
    use std::fs;
    use std::path::Path;

    let p = Path::new(&path);

    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase());
    if !matches!(ext.as_deref(), Some("md") | Some("markdown")) {
        return Err("only .md / .markdown files are permitted".into());
    }

    let path_str = p.to_string_lossy();
    if !path_str.contains("/.ovo/") && !path_str.contains("\\.ovo\\") {
        return Err("deletes restricted to .ovo/** paths".into());
    }

    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }

    fs::remove_file(p).map_err(|e| format!("remove {path}: {e}"))?;
    Ok(())
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
    let win = app
        .get_webview_window("pet")
        .ok_or_else(|| "pet window not found".to_string())?;
    // Restore last saved position BEFORE showing so the user never sees the
    // window flash at the default (centered) location and then jump.
    if let Some((x, y)) = read_pet_position(&app) {
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    }
    win.show().map_err(|e| e.to_string())
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

// [START] Phase 5 — safe `open -a "<App>" "<url>"` via argv (no shell).
// Front-end already validates app / url against strict allowlists; we add
// a second server-side check so a compromised renderer can't pass unsafe
// values through. Only http/https with localhost + 127.0.0.1 hosts are
// accepted, and the app name must match /^[\w .&-]+$/.
#[tauri::command]
fn browser_open_with_app(app: String, url: String) -> Result<(), String> {
    // Re-validate inputs server-side.
    if app.is_empty() || app.len() > 64 {
        return Err("app name rejected".into());
    }
    if !app.chars().all(|c| c.is_alphanumeric() || " .&-_".contains(c)) {
        return Err("app name contains disallowed characters".into());
    }
    let url_ok = (url.starts_with("http://localhost")
        || url.starts_with("http://127.0.0.1")
        || url.starts_with("https://localhost")
        || url.starts_with("https://127.0.0.1"))
        && !url.contains('\n')
        && !url.contains('\r')
        && !url.contains('`')
        && !url.contains('$')
        && !url.contains('"')
        && !url.contains('\\');
    if !url_ok {
        return Err("url rejected (only http(s)://localhost* accepted)".into());
    }
    let status = std::process::Command::new("open")
        .arg("-a")
        .arg(&app)
        .arg(&url)
        .status()
        .map_err(|e| format!("spawn failed: {e}"))?;
    if !status.success() {
        return Err(format!("open exited with {status}"));
    }
    Ok(())
}
// [END]

// [START] Phase 5 fix — pet position persistence in a Rust-managed JSON file
// under the app data dir. We previously tried localStorage inside PetApp, but
// the pet window's WebView context is not guaranteed to share localStorage
// across cold starts on every macOS version — users saw the pet re-spawn at
// the default position after every restart. Storing from Rust sidesteps the
// WebView entirely and survives app quits.
fn pet_position_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("pet_position.json"))
}

fn read_pet_position(app: &AppHandle) -> Option<(i32, i32)> {
    let p = pet_position_path(app)?;
    let raw = std::fs::read_to_string(&p).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let x = v.get("x")?.as_i64()? as i32;
    let y = v.get("y")?.as_i64()? as i32;
    Some((x, y))
}

#[tauri::command]
fn pet_get_position(app: AppHandle) -> Result<Option<(i32, i32)>, String> {
    Ok(read_pet_position(&app))
}

#[tauri::command]
fn pet_save_position(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    let p = pet_position_path(&app).ok_or_else(|| "app_data_dir unavailable".to_string())?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let payload = serde_json::json!({ "x": x, "y": y });
    std::fs::write(&p, payload.to_string()).map_err(|e| e.to_string())
}
// [END]
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
            // [START] Phase 8.2 — PTY state registration
            app.manage(pty::PtyState::new());
            // [END]
            // [START] Phase 5 — attachment whitelist registration.
            // Used by code_fs_read_external_file to enforce that only
            // user-attached paths can be read outside the project scope.
            app.manage(code_fs::AttachmentWhitelist::new());
            // [END]
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            sidecar_status,
            sidecar_restart,
            sidecar_reinstall_runtime,
            pet_show,
            pet_hide,
            pet_get_position,
            pet_save_position,
            focus_main_window,
            browser_open_with_app,
            read_project_context,
            default_project_path,
            read_md_file,
            read_md_dir,
            write_md_file,
            delete_md_file,
            npm_search,
            // [START] Phase 6.2a — MCP commands
            mcp::mcp_start,
            mcp::mcp_call,
            mcp::mcp_stop,
            mcp::mcp_list,
            // [END]
            // [START] Phase 8 — Code IDE file system commands
            code_fs::code_fs_list_tree,
            code_fs::code_fs_read_file,
            code_fs::code_fs_read_external_file,
            code_fs::attachment_whitelist_register,
            code_fs::attachment_whitelist_clear,
            code_fs::code_fs_write_file,
            code_fs::code_fs_create_file,
            code_fs::code_fs_rename,
            code_fs::code_fs_delete,
            code_fs::code_fs_mkdir,
            code_fs::code_fs_search,
            code_fs::code_fs_exec,
            code_fs::code_fs_reveal,
            // [END]
            // [START] Phase 8.2 — PTY commands
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            // [END]
            // [START] Phase 8.2 — Git commands
            git_ops::git_status,
            git_ops::git_diff,
            git_ops::git_log,
            git_ops::git_commit,
            git_ops::git_branch_list,
            git_ops::git_checkout,
            git_ops::git_stage,
            git_ops::git_unstage,
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
