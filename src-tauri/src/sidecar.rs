use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

pub const STATUS_EVENT: &str = "sidecar://status";

/// Three FastAPI ports served by the Python sidecar.
/// Must stay in sync with `sidecar/src/ovo_sidecar/config.py` defaults.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct SidecarPorts {
    pub ollama: u16,
    pub openai: u16,
    pub native: u16,
}

impl Default for SidecarPorts {
    fn default() -> Self {
        Self {
            ollama: 11435,
            openai: 11436,
            native: 11437,
        }
    }
}

#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SidecarHealth {
    Stopped,
    Starting,
    Healthy,
    Failed,
}

#[derive(Clone, Serialize, Debug)]
pub struct SidecarStatus {
    pub health: SidecarHealth,
    pub ports: SidecarPorts,
    pub pid: Option<u32>,
    pub message: Option<String>,
    pub healthy_apis: Vec<String>,
}

pub struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    status: Mutex<SidecarStatus>,
    // Incremented every time a new child is spawned. Log-pump and health-loop
    // tasks capture the generation they were started with and bail out if it
    // no longer matches the current one — prevents a stale Terminated event
    // from a killed child clobbering the freshly-spawned child's status.
    generation: AtomicU64,
}

impl SidecarState {
    fn new(ports: SidecarPorts) -> Self {
        Self {
            child: Mutex::new(None),
            status: Mutex::new(SidecarStatus {
                health: SidecarHealth::Stopped,
                ports,
                pid: None,
                message: None,
                healthy_apis: vec![],
            }),
            generation: AtomicU64::new(0),
        }
    }

    pub fn snapshot(&self) -> SidecarStatus {
        self.status.lock().unwrap().clone()
    }
}

// [START] managed sidecar lifecycle — spawn, health monitor, kill on exit
pub fn setup(app: &AppHandle) {
    app.manage(SidecarState::new(SidecarPorts::default()));
    spawn(app.clone());
}

pub fn spawn(app: AppHandle) {
    let Some(state) = app.try_state::<SidecarState>() else {
        log::error!("SidecarState not managed — setup() must run first");
        return;
    };
    let ports = state.snapshot().ports;

    let Some(command) = resolve_command(&app) else {
        update_status(&app, |s| {
            s.health = SidecarHealth::Failed;
            s.message = Some("sidecar command not found (no bundle, no dev script)".into());
        });
        return;
    };

    update_status(&app, |s| {
        s.health = SidecarHealth::Starting;
        s.message = None;
        s.healthy_apis.clear();
    });

    let (mut rx, child) = match command.spawn() {
        Ok(r) => r,
        Err(e) => {
            update_status(&app, |s| {
                s.health = SidecarHealth::Failed;
                s.message = Some(format!("spawn failed: {e}"));
            });
            return;
        }
    };

    let pid = child.pid();
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut guard = state.child.lock().unwrap();
        *guard = Some(child);
    }
    update_status(&app, |s| s.pid = Some(pid));

    // Log pump
    let app_logs = app.clone();
    let gen_logs = generation;
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    log::info!(target: "sidecar", "{}", String::from_utf8_lossy(&line).trim_end());
                }
                CommandEvent::Stderr(line) => {
                    log::warn!(target: "sidecar", "{}", String::from_utf8_lossy(&line).trim_end());
                }
                CommandEvent::Error(e) => {
                    log::error!(target: "sidecar", "{e}");
                }
                CommandEvent::Terminated(payload) => {
                    log::error!(target: "sidecar", "terminated gen={gen_logs}: {payload:?}");
                    let still_current = app_logs
                        .try_state::<SidecarState>()
                        .map(|s| s.generation.load(Ordering::SeqCst) == gen_logs)
                        .unwrap_or(false);
                    if still_current {
                        update_status(&app_logs, |s| {
                            s.health = SidecarHealth::Stopped;
                            s.pid = None;
                            s.healthy_apis.clear();
                            s.message = Some(format!("terminated (code {:?})", payload.code));
                        });
                        if let Some(state) = app_logs.try_state::<SidecarState>() {
                            state.child.lock().unwrap().take();
                        }
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    // Health monitor
    let app_hc = app.clone();
    let gen_hc = generation;
    tauri::async_runtime::spawn(async move {
        health_loop(app_hc, ports, gen_hc).await;
    });
}

pub fn kill(app: &AppHandle) {
    if let Some(state) = app.try_state::<SidecarState>() {
        let ports = state.snapshot().ports;
        if let Some(child) = state.child.lock().unwrap().take() {
            let _ = child.kill();
        }
        // [START] Port-level cleanup — uvicorn spawns 3 worker tasks inside a
        // single Python asyncio loop. If one task crashes uncaught (e.g. the
        // MLX worker thread fault we've hit before) the other two keep running
        // and continue to hold their ports. child.kill() only signals the
        // parent process it originally spawned; orphaned children keep the
        // ports bound. `lsof -ti:<port> | xargs kill -9` guarantees a clean
        // slate before the next spawn.
        for p in [ports.ollama, ports.openai, ports.native] {
            kill_port(p);
        }
        // [END]
        update_status(app, |s| {
            s.health = SidecarHealth::Stopped;
            s.pid = None;
            s.healthy_apis.clear();
            s.message = None;
        });
    }
}

pub async fn restart(app: AppHandle) {
    kill(&app);
    // 800ms gives the OS time to release the freed ports before rebinding.
    tokio::time::sleep(Duration::from_millis(800)).await;
    spawn(app);
}

// [START] kill_port — macOS helper. Uses lsof + kill -9 shelled out via
// std::process so we don't introduce a nix / libc dependency. Errors are
// swallowed (best-effort cleanup).
fn kill_port(port: u16) {
    use std::process::{Command, Stdio};

    let output = match Command::new("/usr/sbin/lsof")
        .args(["-ti", &format!(":{port}")])
        .stderr(Stdio::null())
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            log::warn!("lsof for port {port} failed: {e}");
            return;
        }
    };
    if !output.status.success() {
        return; // no process holds the port
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for pid_str in stdout.split_whitespace() {
        let Ok(pid) = pid_str.parse::<u32>() else { continue };
        let _ = Command::new("/bin/kill")
            .args(["-9", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        log::info!("killed orphaned sidecar process pid={pid} on port {port}");
    }
}
// [END]

fn update_status<F: FnOnce(&mut SidecarStatus)>(app: &AppHandle, f: F) {
    let Some(state) = app.try_state::<SidecarState>() else { return };
    let snapshot = {
        let mut guard = state.status.lock().unwrap();
        f(&mut guard);
        guard.clone()
    };
    if let Err(e) = app.emit(STATUS_EVENT, snapshot) {
        log::warn!("emit {STATUS_EVENT} failed: {e}");
    }
}

async fn health_loop(app: AppHandle, ports: SidecarPorts, generation: u64) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::error!("reqwest client build: {e}");
            return;
        }
    };
    let endpoints: [(&str, u16); 3] = [
        ("ollama", ports.ollama),
        ("openai", ports.openai),
        ("native", ports.native),
    ];

    let started = Instant::now();
    let startup_grace = Duration::from_secs(45);
    let mut last_healthy: Vec<String> = vec![];
    let mut last_health = SidecarHealth::Starting;

    loop {
        let Some(state) = app.try_state::<SidecarState>() else {
            break;
        };
        if state.generation.load(Ordering::SeqCst) != generation {
            break;
        }
        let child_alive = state.child.lock().unwrap().is_some();
        if !child_alive {
            break;
        }

        let mut healthy: Vec<String> = vec![];
        for (name, port) in endpoints {
            let url = format!("http://127.0.0.1:{port}/healthz");
            if let Ok(resp) = client.get(&url).send().await {
                if resp.status().is_success() {
                    healthy.push(name.to_string());
                }
            }
        }

        let new_health = if healthy.len() == 3 {
            SidecarHealth::Healthy
        } else if started.elapsed() > startup_grace {
            SidecarHealth::Failed
        } else {
            SidecarHealth::Starting
        };

        if new_health != last_health || healthy != last_healthy {
            let captured_health = new_health.clone();
            let captured_healthy = healthy.clone();
            update_status(&app, |s| {
                s.health = captured_health;
                s.healthy_apis = captured_healthy;
                if s.health != SidecarHealth::Failed {
                    s.message = None;
                } else {
                    s.message = Some(format!(
                        "only {}/3 APIs healthy after {}s",
                        healthy.len(),
                        startup_grace.as_secs()
                    ));
                }
            });
            last_health = new_health;
            last_healthy = healthy;
        }

        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
}

fn resolve_command(app: &AppHandle) -> Option<tauri_plugin_shell::process::Command> {
    let shell = app.shell();

    if let Ok(resource_dir) = app.path().resource_dir() {
        let bin = resource_dir.join("sidecar").join("ovo-sidecar");
        if bin.exists() {
            log::info!("using bundled sidecar at {}", bin.display());
            return Some(shell.command(bin.to_string_lossy().to_string()));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        if let Some(script) = find_dev_script(&cwd) {
            log::info!("using dev sidecar via {}", script.display());
            return Some(
                shell
                    .command("/usr/bin/env")
                    .args(["bash", script.to_string_lossy().as_ref()]),
            );
        }
    }

    None
}

fn find_dev_script(start: &Path) -> Option<PathBuf> {
    let mut cur = start.to_path_buf();
    for _ in 0..6 {
        let candidate = cur.join("sidecar").join("scripts").join("dev.sh");
        if candidate.exists() {
            return Some(candidate);
        }
        cur = cur.parent()?.to_path_buf();
    }
    None
}
// [END]
