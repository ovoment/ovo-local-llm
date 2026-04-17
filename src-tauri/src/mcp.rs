// [START] Phase 6.2a — MCP (Model Context Protocol) runtime.
// Manages stdio MCP server subprocesses spawned via std::process::Command.
// Each server communicates over JSON-RPC 2.0 (newline-delimited on stdin/stdout).
// No tauri-plugin-shell is used here — direct std::process gives us raw pipe handles
// without requiring shell:allow-spawn capability entries.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::oneshot;

// ── Public types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolInfo {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpServerStatus {
    pub server_id: String,
    pub command: String,
    pub running: bool,
    pub tools: Vec<McpToolInfo>,
    pub error: Option<String>,
}

// ── Internal per-server state ─────────────────────────────────────────────────

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct McpServer {
    command: String,
    stdin: Arc<Mutex<ChildStdin>>,
    // Child kept alive so the process is not reaped until mcp_stop.
    _child: Arc<Mutex<Child>>,
    tools: Vec<McpToolInfo>,
    next_id: u64,
    pending: PendingMap,
    error: Option<String>,
}

// ── Managed state ─────────────────────────────────────────────────────────────

pub struct McpState {
    servers: Mutex<HashMap<String, McpServer>>,
}

impl McpState {
    pub fn new() -> Self {
        Self {
            servers: Mutex::new(HashMap::new()),
        }
    }
}

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

fn make_request(id: u64, method: &str, params: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
}

fn make_notification(method: &str, params: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    })
}

/// Write one JSON-RPC message to stdin (newline-delimited).
fn send_message(stdin: &Arc<Mutex<ChildStdin>>, msg: &Value) -> Result<(), String> {
    let line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    let mut guard = stdin.lock().unwrap();
    writeln!(guard, "{line}").map_err(|e| e.to_string())?;
    guard.flush().map_err(|e| e.to_string())
}

// ── Stdout reader task ────────────────────────────────────────────────────────
// [START] stdout-reader-loop
// Runs in a dedicated blocking thread. Reads newline-delimited JSON from the
// child's stdout and resolves pending oneshot senders by JSON-RPC id.
// Partial-line / backpressure: BufReader handles buffering internally; if a
// line is split across TCP frames the OS buffer reunites it before read_line
// returns. On child death (EOF on stdout) read_line returns Ok(0) and the loop
// exits cleanly — all remaining pending senders are dropped, which propagates
// RecvError to the awaiting callers.
fn spawn_reader(stdout: std::process::ChildStdout, pending: PendingMap) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line_result in reader.lines() {
            let line = match line_result {
                Ok(l) => l,
                Err(e) => {
                    log::warn!("mcp stdout read error: {e}");
                    break;
                }
            };
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }

            let msg: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("mcp: invalid JSON from server: {e} — {line}");
                    continue;
                }
            };

            // Notifications (no "id") — log and ignore for now.
            let id = match msg.get("id").and_then(|v| v.as_u64()) {
                Some(id) => id,
                None => {
                    log::debug!("mcp notification: {line}");
                    continue;
                }
            };

            let sender = {
                let mut map = pending.lock().unwrap();
                map.remove(&id)
            };

            if let Some(tx) = sender {
                if let Some(err) = msg.get("error") {
                    let msg_str = err
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("unknown error")
                        .to_string();
                    let _ = tx.send(Err(msg_str));
                } else {
                    let result = msg.get("result").cloned().unwrap_or(Value::Null);
                    let _ = tx.send(Ok(result));
                }
            }
        }
        log::info!("mcp stdout reader exited");
    });
}
// [END]

// ── send_request — write + await response ─────────────────────────────────────
// [START] send-request
// Sends a JSON-RPC request and awaits the paired response via a oneshot channel.
// The channel is inserted into `pending` before writing to stdin to avoid a
// race where the server responds before we register the sender.
async fn send_request(
    stdin: &Arc<Mutex<ChildStdin>>,
    pending: &PendingMap,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let (tx, rx) = oneshot::channel::<Result<Value, String>>();
    {
        let mut map = pending.lock().unwrap();
        map.insert(id, tx);
    }

    let msg = make_request(id, method, params);
    if let Err(e) = send_message(stdin, &msg) {
        // Clean up the dangling sender before returning.
        pending.lock().unwrap().remove(&id);
        return Err(e);
    }

    rx.await.map_err(|_| "server closed before responding".to_string())?
}
// [END]

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Spawn an MCP server subprocess, run the initialize + tools/list handshake,
/// and return the discovered tool list.
#[tauri::command]
pub async fn mcp_start(
    server_id: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    state: tauri::State<'_, McpState>,
) -> Result<Vec<McpToolInfo>, String> {
    // [START] spawn subprocess
    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .envs(&env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null()); // MCP servers may write diagnostics to stderr

    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    // [END]

    let stdin = Arc::new(Mutex::new(stdin));
    let child = Arc::new(Mutex::new(child));
    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));

    spawn_reader(stdout, Arc::clone(&pending));

    // [START] MCP initialize handshake
    // Protocol version must match the server's supported version.
    // Capabilities left empty — we only use tools discovery for now.
    let init_params = json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {
            "name": "ovo",
            "version": "0.0.1"
        }
    });

    let result = send_request(&stdin, &pending, 1, "initialize", init_params).await?;

    // After initialize response, send the required initialized notification.
    let notif = make_notification("notifications/initialized", json!({}));
    send_message(&stdin, &notif)?;

    log::info!("mcp: server {server_id} initialized — protocol {:?}", result.get("protocolVersion"));
    // [END]

    // [START] tools/list
    let tools_result = send_request(&stdin, &pending, 2, "tools/list", json!({})).await?;

    let tools: Vec<McpToolInfo> = tools_result
        .get("tools")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    let name = t.get("name")?.as_str()?.to_string();
                    let description = t
                        .get("description")
                        .and_then(|d| d.as_str())
                        .map(|s| s.to_string());
                    let input_schema = t
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    Some(McpToolInfo { name, description, input_schema })
                })
                .collect()
        })
        .unwrap_or_default();
    // [END]

    let server = McpServer {
        command: command.clone(),
        stdin,
        _child: child,
        tools: tools.clone(),
        next_id: 3,
        pending,
        error: None,
    };

    state.servers.lock().unwrap().insert(server_id, server);
    Ok(tools)
}

/// Call a tool on a running MCP server. Returns the `content` field of the response.
#[tauri::command]
pub async fn mcp_call(
    server_id: String,
    tool: String,
    arguments: Value,
    state: tauri::State<'_, McpState>,
) -> Result<Value, String> {
    // [START] mcp_call — extract handles then drop the lock before awaiting
    let (stdin, pending, id) = {
        let mut servers = state.servers.lock().unwrap();
        let server = servers
            .get_mut(&server_id)
            .ok_or_else(|| format!("server not found: {server_id}"))?;
        let id = server.next_id;
        server.next_id += 1;
        (Arc::clone(&server.stdin), Arc::clone(&server.pending), id)
    };

    let params = json!({ "name": tool, "arguments": arguments });
    let result = send_request(&stdin, &pending, id, "tools/call", params).await?;

    // MCP tools/call response: { content: [...], isError?: bool }
    let content = result.get("content").cloned().unwrap_or(result);
    Ok(content)
    // [END]
}

/// Kill the MCP server process and remove it from the pool.
#[tauri::command]
pub async fn mcp_stop(
    server_id: String,
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    let server = state.servers.lock().unwrap().remove(&server_id);
    if let Some(srv) = server {
        // Kill the child. If it already exited, ignore the error.
        let _ = srv._child.lock().unwrap().kill();
        log::info!("mcp: stopped server {server_id}");
    }
    Ok(())
}

/// Return runtime status for all tracked MCP servers.
#[tauri::command]
pub fn mcp_list(state: tauri::State<'_, McpState>) -> Vec<McpServerStatus> {
    let servers = state.servers.lock().unwrap();
    servers
        .iter()
        .map(|(id, srv)| {
            // [START] running check — try_wait on the child; None means still alive
            let running = srv
                ._child
                .lock()
                .unwrap()
                .try_wait()
                .map(|status| status.is_none())
                .unwrap_or(false);
            // [END]
            McpServerStatus {
                server_id: id.clone(),
                command: srv.command.clone(),
                running,
                tools: srv.tools.clone(),
                error: srv.error.clone(),
            }
        })
        .collect()
}
// [END] Phase 6.2a
