//! Engine manager — runs the Python engine for the packaged app.
//!
//! Release builds (the installed app):
//!   1. The installer ships the engine *source* (`<resources>/engine`), `uv.exe` and `ffmpeg.exe` (`<resources>/bin`).
//!   2. First launch (or after an update that changed the engine): copy the source to `<data>/engine-src` and run
//!      `uv sync` there. uv downloads Python 3.12 and every package (incl. ~2 GB of CUDA wheels) into `<data>` —
//!      once. Every output line is sent to the UI as an `engine-setup` event.
//!   3. Start `<data>/env/Scripts/holos.exe serve --port <free> --token <random>` hidden, wait for `/api/health`.
//!   4. Kill it when the app exits (plus a Windows Job Object as a safety net, see `winproc.rs`).
//!
//! `<data>` is `app_local_data_dir()` = `%LOCALAPPDATA%\com.brainfromukraine.holos`.
//! Everything uv and the engine print also goes to `<data>/engine.log` (rewritten on every start).
//!
//! Debug builds (`tauri dev`): nothing is managed. The developer runs `uv run holos serve --dev` by hand and the
//! UI talks to http://127.0.0.1:8765 without a token, exactly as before.
//!
//! The UI reads the state with the `engine_info` command and listens to `engine-state` events.

use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::winproc::{self, KillOnClose};

/// Where the hand-started dev engine listens (`uv run holos serve --dev`).
pub const DEV_URL: &str = "http://127.0.0.1:8765";
/// Optional dependency groups installed by `uv sync` (see engine/pyproject.toml).
const EXTRAS: &[&str] = &["asr", "gpu", "video"];
/// Lines kept for the UI (setup log / engine stderr).
const LOG_LINES: usize = 200;
/// `uv sync` runs again after moving a file another program holds open (see `move_aside`), at most this often.
const SYNC_ATTEMPTS: usize = 8;
/// Suffix of files moved aside during setup; the next setup deletes them.
const MOVED_SUFFIX: &str = ".holos-old";
/// The first start after setup imports numpy/scipy/ctranslate2 from a cold disk — be patient.
const START_TIMEOUT: Duration = Duration::from_secs(180);

pub const EVENT_STATE: &str = "engine-state";
pub const EVENT_SETUP: &str = "engine-setup";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// Debug build: engine started by hand on DEV_URL, no token.
    Dev,
    /// Creating the Python environment (first run / engine update).
    Setup,
    /// Environment ready, engine process starting.
    Starting,
    /// Engine answers on `url` with `token`.
    Ready,
    /// Something failed; `error` and `log_tail` say what. `engine_restart` retries.
    Error,
}

/// Payload of `engine_info` and of the `engine-state` event.
#[derive(Clone, Debug, Serialize)]
pub struct EngineInfo {
    pub state: Phase,
    pub url: String,
    pub token: String,
    pub error: Option<String>,
    pub log_tail: Vec<String>,
}

/// Payload of the `engine-setup` event (one line of uv output).
#[derive(Clone, Serialize)]
struct SetupLine {
    line: String,
}

struct Inner {
    phase: Phase,
    url: String,
    token: String,
    error: Option<String>,
    log: VecDeque<String>,
    /// The process we are currently waiting on: `uv sync` during setup, then the engine.
    child: Option<Child>,
    /// Bumped by restart / shutdown. A worker thread started for an older generation stops quietly.
    generation: u64,
    shutting_down: bool,
    /// `<data>/engine.log`: the same lines as `log`, kept on disk for support (rewritten on every start).
    log_file: Option<fs::File>,
    /// Output of the current `uv sync` run, to find a file it could not replace.
    sync_lines: Vec<String>,
}

#[derive(Clone)]
pub struct EngineManager {
    dev: bool,
    inner: Arc<Mutex<Inner>>,
    job: Arc<Option<KillOnClose>>,
}

/// Paths of one installation.
struct Paths {
    /// Bundled, read-only engine source (pyproject.toml, uv.lock, src/…).
    bundled_src: PathBuf,
    uv: PathBuf,
    ffmpeg: PathBuf,
    /// Per-user data folder.
    data: PathBuf,
}

impl Paths {
    fn resolve(app: &AppHandle) -> Result<Self, String> {
        let res = app.path().resource_dir().map_err(|e| format!("resource_dir: {e}"))?;
        let data = app.path().app_local_data_dir().map_err(|e| format!("app_local_data_dir: {e}"))?;
        Ok(Self {
            bundled_src: res.join("engine"),
            uv: res.join("bin").join(exe("uv")),
            ffmpeg: res.join("bin").join(exe("ffmpeg")),
            data,
        })
    }
    fn src(&self) -> PathBuf {
        self.data.join("engine-src")
    }
    fn env(&self) -> PathBuf {
        self.data.join("env")
    }
    fn holos(&self) -> PathBuf {
        venv_script(&self.env(), "holos")
    }
    /// The environment's Python. Claude Desktop runs `python -m holos mcp` with it: uv never rewrites it on an
    /// engine update (it does rewrite the `holos` launcher, which Windows will not replace while it runs).
    fn python(&self) -> PathBuf {
        venv_script(&self.env(), "python")
    }
    fn marker(&self) -> PathBuf {
        self.data.join("engine-setup.json")
    }
}

impl EngineManager {
    pub fn new(dev: bool) -> Self {
        let (phase, url) = if dev { (Phase::Dev, DEV_URL.to_string()) } else { (Phase::Starting, String::new()) };
        Self {
            dev,
            inner: Arc::new(Mutex::new(Inner {
                phase,
                url,
                token: String::new(),
                error: None,
                log: VecDeque::new(),
                child: None,
                generation: 0,
                shutting_down: false,
                log_file: None,
                sync_lines: Vec::new(),
            })),
            job: Arc::new(if dev { None } else { KillOnClose::new() }),
        }
    }

    fn job(&self) -> Option<&KillOnClose> {
        (*self.job).as_ref()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panicked worker must not take the whole app down with a poisoned mutex.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn info(&self) -> EngineInfo {
        info_of(&self.lock())
    }

    /// Start (or restart) bringing the engine up on a background thread. No-op in dev builds.
    pub fn start(&self, app: AppHandle) {
        if self.dev {
            return;
        }
        let generation = {
            let mut g = self.lock();
            if g.shutting_down {
                return;
            }
            g.generation += 1;
            if let Some(mut child) = g.child.take() {
                winproc::kill(self.job(), &mut child);
            }
            g.phase = Phase::Starting;
            g.url.clear();
            g.token.clear();
            g.error = None;
            g.log.clear();
            g.log_file = None;
            g.generation
        };
        self.emit_state(&app);
        let me = self.clone();
        thread::spawn(move || {
            if let Err(e) = me.bring_up(&app, generation) {
                me.line(&app, generation, format!("ERROR: {e}"), false);
                me.update(&app, generation, |g| {
                    g.phase = Phase::Error;
                    g.error = Some(e);
                });
            }
        });
    }

    /// Kill the engine (or a running `uv sync`). Called on app exit and window close.
    pub fn shutdown(&self) {
        let mut g = self.lock();
        g.shutting_down = true;
        g.generation += 1;
        if let Some(mut child) = g.child.take() {
            winproc::kill(self.job(), &mut child);
        } else if let Some(job) = self.job() {
            job.terminate_all();
        }
    }

    // ---- worker -------------------------------------------------------------------------------------------------

    fn bring_up(&self, app: &AppHandle, generation: u64) -> Result<(), String> {
        let p = Paths::resolve(app)?;
        fs::create_dir_all(&p.data).map_err(|e| format!("Could not create the data folder ({}: {e})", show(&p.data)))?;
        if let Ok(file) = fs::File::create(p.data.join("engine.log")) {
            let mut g = self.lock();
            if g.generation == generation {
                g.log_file = Some(file);
            }
        }
        if !p.bundled_src.join("pyproject.toml").is_file() {
            return Err(format!("The installation is missing the engine code. Reinstall Holos Studio. ({})", show(&p.bundled_src)));
        }

        let hash = hash_dir(&p.bundled_src).map_err(|e| format!("Could not read the engine code ({e})"))?;
        if read_marker(&p) != Some(hash.clone()) || !p.holos().is_file() {
            self.setup(app, generation, &p, &hash)?;
        }
        if p.python().is_file() {
            for msg in fix_claude_configs(&p.holos(), &p.python()) {
                self.line(app, generation, msg, false);
            }
        }
        self.run_engine(app, generation, &p)
    }

    /// Copy the engine source and create the Python environment with uv.
    fn setup(&self, app: &AppHandle, generation: u64, p: &Paths, hash: &str) -> Result<(), String> {
        self.update(app, generation, |g| g.phase = Phase::Setup);
        if !p.uv.is_file() {
            return Err(format!("uv not found. Reinstall Holos Studio. ({})", show(&p.uv)));
        }
        self.line(app, generation, format!("Holos engine {} → {}", &hash[..12], show(&p.data)), true);

        // Old marker goes first: if setup is interrupted, the next launch retries it.
        let _ = fs::remove_file(p.marker());
        copy_dir(&p.bundled_src, &p.src()).map_err(|e| format!("Could not copy the engine code ({e})"))?;

        remove_moved(&p.env());

        // Claude Desktop keeps `holos.exe mcp` from this environment running, so uv may find a file it has to
        // replace in use ("os error 32"). Windows will not delete a running program but does let it be renamed:
        // move it aside and run uv again. The running program is not disturbed; the next setup deletes the old file.
        let mut attempt = 0;
        let mut stopped = false;
        loop {
            attempt += 1;
            self.lock().sync_lines.clear();
            let status = self.run_to_end(app, generation, sync_command(p), true)?;
            if status.success() {
                break;
            }
            let locked = {
                let g = self.lock();
                g.sync_lines.iter().rev().find_map(|l| locked_path(l))
            };
            match locked {
                Some(file) if attempt < SYNC_ATTEMPTS && file.starts_with(normalize(Path::new(&plain(&p.env())))) => {
                    if move_aside(&file).is_ok() {
                        self.line(app, generation, format!("In use by another program, moved aside: {}", show(&file)), true);
                    } else if !stopped {
                        // The holos.exe launcher keeps its own file open, so it cannot even be renamed. Stop what runs
                        // from our data folder (Claude Desktop's Holos connection — our engine is not running yet).
                        stopped = true;
                        let names = stop_processes_under(&p.data);
                        self.line(
                            app,
                            generation,
                            format!(
                                "{} was in use by Claude Desktop's Holos connection; stopped it ({names}). Restart Claude Desktop to reconnect.",
                                show(&file)
                            ),
                            true,
                        );
                        thread::sleep(Duration::from_millis(1500));
                    } else {
                        return Err(format!(
                            "A file of the engine is in use by another program and could not be replaced. Quit Claude Desktop \
                             (including its tray icon) and press Try again. ({})",
                            show(&file)
                        ));
                    }
                }
                Some(file) => {
                    return Err(format!(
                        "A file of the engine is in use by another program. Quit Claude Desktop (including its tray icon) \
                         and press Try again. ({})",
                        show(&file)
                    ))
                }
                None => {
                    return Err(format!(
                        "Could not prepare the engine. Check the internet connection and free disk space. (uv sync exit code {}; about 5 GB is needed)",
                        code(status)
                    ))
                }
            }
        }
        if !p.holos().is_file() {
            return Err(format!("Setup finished but the engine was not created. ({})", show(&p.holos())));
        }
        fs::write(p.marker(), serde_json::json!({ "hash": hash }).to_string())
            .map_err(|e| format!("Could not write the setup marker ({}: {e})", show(&p.marker())))?;
        self.line(app, generation, "Done.".into(), true);
        Ok(())
    }

    /// Start `holos serve`, wait for /api/health, then watch the process until it exits or we restart.
    fn run_engine(&self, app: &AppHandle, generation: u64, p: &Paths) -> Result<(), String> {
        self.update(app, generation, |g| g.phase = Phase::Starting);
        let port = free_port().map_err(|e| format!("No free port on 127.0.0.1 ({e})"))?;
        let token = random_token()?;

        let mut cmd = Command::new(p.holos());
        cmd.args(["serve", "--port", &port.to_string(), "--token", &token])
            .current_dir(&p.data)
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONUTF8", "1")
            .env_remove("VIRTUAL_ENV");
        if p.ffmpeg.is_file() {
            cmd.env("HOLOS_FFMPEG", plain(&p.ffmpeg));
        }
        self.spawn(generation, cmd, app.clone(), false)?;

        let deadline = Instant::now() + START_TIMEOUT;
        loop {
            if let Some(status) = self.poll_exit(generation)? {
                return Err(format!("The engine stopped while starting. (exit code {})", code(status)));
            }
            if health_ok(port) {
                break;
            }
            if Instant::now() > deadline {
                return Err("The engine did not respond within 3 minutes.".into());
            }
            thread::sleep(Duration::from_millis(300));
        }
        self.update(app, generation, |g| {
            g.phase = Phase::Ready;
            g.url = format!("http://127.0.0.1:{port}");
            g.token = token.clone();
        });

        // Watch: an engine that dies later is reported, the UI offers a restart.
        loop {
            thread::sleep(Duration::from_secs(1));
            if let Some(status) = self.poll_exit(generation)? {
                return Err(format!("The engine stopped unexpectedly. (exit code {})", code(status)));
            }
        }
    }

    // ---- process plumbing ---------------------------------------------------------------------------------------

    /// Spawn `cmd` hidden, with stdout/stderr read line by line into the log (and, for setup, `engine-setup` events).
    /// The child is stored in `Inner::child` so restart/shutdown can kill it.
    fn spawn(&self, generation: u64, mut cmd: Command, app: AppHandle, setup: bool) -> Result<Vec<thread::JoinHandle<()>>, String> {
        winproc::hide_window(&mut cmd);
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let program = show(Path::new(cmd.get_program()));
        let mut child = cmd.spawn().map_err(|e| format!("Could not start the engine ({program}: {e})"))?;
        if let Some(job) = self.job() {
            job.assign(&child);
        }

        let mut readers = Vec::new();
        let out: Option<Box<dyn Read + Send>> = child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>);
        let err: Option<Box<dyn Read + Send>> = child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>);
        for stream in [out, err].into_iter().flatten() {
            let me = self.clone();
            let app = app.clone();
            readers.push(thread::spawn(move || {
                let mut reader = BufReader::new(stream);
                let mut buf = Vec::new();
                loop {
                    buf.clear();
                    match reader.read_until(b'\n', &mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                            if !line.is_empty() {
                                me.line(&app, generation, line, setup);
                            }
                        }
                    }
                }
            }));
        }

        let mut g = self.lock();
        if g.generation != generation {
            // Restarted or shutting down while we were spawning.
            drop(g);
            winproc::kill(self.job(), &mut child);
            return Err("cancelled".into());
        }
        g.child = Some(child);
        Ok(readers)
    }

    /// Spawn and wait for the process to finish (used for `uv sync`).
    fn run_to_end(&self, app: &AppHandle, generation: u64, cmd: Command, setup: bool) -> Result<ExitStatus, String> {
        let readers = self.spawn(generation, cmd, app.clone(), setup)?;
        loop {
            if let Some(status) = self.poll_exit(generation)? {
                for r in readers {
                    let _ = r.join(); // collect the last lines
                }
                return Ok(status);
            }
            thread::sleep(Duration::from_millis(200));
        }
    }

    /// `Ok(Some(status))` once the current child exited (it is then dropped), `Err` if this generation is stale.
    fn poll_exit(&self, generation: u64) -> Result<Option<ExitStatus>, String> {
        let mut g = self.lock();
        if g.generation != generation {
            return Err("cancelled".into());
        }
        let Some(child) = g.child.as_mut() else { return Err("cancelled".into()) };
        match child.try_wait() {
            Ok(Some(status)) => {
                g.child = None;
                Ok(Some(status))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(format!("try_wait: {e}")),
        }
    }

    // ---- state ------------------------------------------------------------------------------------------------

    /// Change state if `generation` is still current, then emit `engine-state`.
    fn update(&self, app: &AppHandle, generation: u64, f: impl FnOnce(&mut Inner)) {
        let info = {
            let mut g = self.lock();
            if g.generation != generation {
                return;
            }
            f(&mut g);
            info_of(&g)
        };
        let _ = app.emit(EVENT_STATE, info);
    }

    fn emit_state(&self, app: &AppHandle) {
        let _ = app.emit(EVENT_STATE, self.info());
    }

    fn line(&self, app: &AppHandle, generation: u64, line: String, setup: bool) {
        // `holos serve` prints its token; keep it out of the log the user may copy into a bug report.
        let line = if line.starts_with("HOLOS_TOKEN=") { "HOLOS_TOKEN=…".to_string() } else { line };
        {
            let mut g = self.lock();
            if g.generation != generation {
                return;
            }
            if g.log.len() >= LOG_LINES {
                g.log.pop_front();
            }
            g.log.push_back(line.clone());
            if setup {
                g.sync_lines.push(line.clone());
            }
            if let Some(f) = g.log_file.as_mut() {
                let _ = writeln!(f, "{line}");
            }
        }
        if setup {
            let _ = app.emit(EVENT_SETUP, SetupLine { line });
        }
    }

    /// Claude Desktop `claude_desktop_config.json` snippet for this installation.
    pub fn mcp_config(&self, app: &AppHandle) -> Result<String, String> {
        let server = if self.dev {
            // Dev: the repository's engine through uv, like docs/MCP.md.
            let engine = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("engine");
            let engine = engine.canonicalize().unwrap_or(engine);
            serde_json::json!({
                "command": "uv",
                "args": ["--directory", plain(&engine), "run", "holos", "mcp"],
            })
        } else {
            let p = Paths::resolve(app)?;
            serde_json::json!({
                "command": plain(&p.python()),
                "args": ["-m", "holos", "mcp"],
                "env": { "HOLOS_FFMPEG": plain(&p.ffmpeg) },
            })
        };
        let cfg = serde_json::json!({ "mcpServers": { "holos-studio": server } });
        serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())
    }
}

fn info_of(g: &Inner) -> EngineInfo {
    EngineInfo {
        state: g.phase,
        url: g.url.clone(),
        token: g.token.clone(),
        error: g.error.clone(),
        log_tail: g.log.iter().cloned().collect(),
    }
}

// ---- Tauri commands ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn engine_info(engine: State<'_, EngineManager>) -> EngineInfo {
    engine.info()
}

#[tauri::command]
pub fn engine_restart(app: AppHandle, engine: State<'_, EngineManager>) -> EngineInfo {
    engine.start(app);
    engine.info()
}

#[tauri::command]
pub fn mcp_config(app: AppHandle, engine: State<'_, EngineManager>) -> Result<String, String> {
    engine.mcp_config(&app)
}

// ---- helpers ----------------------------------------------------------------------------------------------------

/// Claude Desktop config files that may exist on this machine (regular and Microsoft Store installs).
fn claude_config_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        out.push(PathBuf::from(appdata).join("Claude").join("claude_desktop_config.json"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        if let Ok(entries) = fs::read_dir(PathBuf::from(local).join("Packages")) {
            for e in entries.flatten() {
                if e.file_name().to_string_lossy().starts_with("Claude_") {
                    out.push(e.path().join("LocalCache").join("Roaming").join("Claude").join("claude_desktop_config.json"));
                }
            }
        }
    }
    out.into_iter().filter(|p| p.is_file()).collect()
}

/// Rewrite Claude Desktop entries that start this installation's `holos.exe mcp` to `python -m holos mcp`.
/// Only such entries change (everything else in the file stays as it is); a backup is written first.
/// Returns log lines.
fn fix_claude_configs(holos: &Path, python: &Path) -> Vec<String> {
    let mut log = Vec::new();
    for cfg in claude_config_paths() {
        let Ok(text) = fs::read_to_string(&cfg) else { continue };
        let Some(new) = rewrite_claude_config(&text, holos, python) else { continue };
        let backup = cfg.with_extension("json.holos-backup");
        let res = fs::copy(&cfg, &backup).and_then(|_| fs::write(&cfg, new));
        log.push(match res {
            Ok(()) => format!(
                "Claude Desktop config updated: Holos now starts as `python -m holos mcp`, so engine updates work while Claude Desktop runs ({}; backup {}). Restart Claude Desktop once.",
                show(&cfg),
                show(&backup)
            ),
            Err(e) => format!("Could not update the Claude Desktop config ({}: {e})", show(&cfg)),
        });
    }
    log
}

/// The new config text if any `mcpServers` entry runs `holos` with args `["mcp"]`, else None.
fn rewrite_claude_config(text: &str, holos: &Path, python: &Path) -> Option<String> {
    let mut cfg: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let same = |a: &str, b: &Path| a.replace('/', "\\").eq_ignore_ascii_case(&plain(b).replace('/', "\\"));
    let mut changed = false;
    for (_, server) in cfg.get_mut("mcpServers")?.as_object_mut()?.iter_mut() {
        let Some(obj) = server.as_object_mut() else { continue };
        let runs_holos = obj.get("command").and_then(|c| c.as_str()).is_some_and(|c| same(c, holos));
        let args_mcp = obj.get("args").and_then(|a| a.as_array()).is_some_and(|a| a.len() == 1 && a[0] == "mcp");
        if runs_holos && args_mcp {
            obj.insert("command".into(), serde_json::Value::String(plain(python)));
            obj.insert("args".into(), serde_json::json!(["-m", "holos", "mcp"]));
            changed = true;
        }
    }
    if !changed {
        return None;
    }
    serde_json::to_string_pretty(&cfg).ok().map(|t| t + "\n")
}

/// Stop every process whose program lives in `dir` (Windows). Returns their names for the log.
fn stop_processes_under(dir: &Path) -> String {
    if !cfg!(windows) {
        return String::new();
    }
    let mut d = plain(dir);
    if !d.ends_with('\\') {
        d.push('\\');
    }
    let script = format!(
        "$d='{}'; Get-CimInstance Win32_Process | Where-Object {{ $_.ExecutablePath -and $_.ExecutablePath.StartsWith($d, [StringComparison]::OrdinalIgnoreCase) }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.Name }}",
        d.replace('\'', "''")
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    winproc::hide_window(&mut cmd);
    match cmd.output() {
        Ok(o) => {
            let names: Vec<String> = String::from_utf8_lossy(&o.stdout).lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
            if names.is_empty() { "nothing found".into() } else { names.join(", ") }
        }
        Err(e) => format!("powershell: {e}"),
    }
}

/// `uv sync` of the bundled engine into `<data>/env`.
fn sync_command(p: &Paths) -> Command {
    let mut cmd = Command::new(&p.uv);
    cmd.args(["sync", "--frozen", "--no-dev", "--compile-bytecode", "--color", "never"]);
    for extra in EXTRAS {
        cmd.args(["--extra", extra]);
    }
    cmd.current_dir(p.src())
        .env("UV_PROJECT_ENVIRONMENT", plain(&p.env()))
        .env("UV_PYTHON_INSTALL_DIR", plain(&p.data.join("python")))
        .env("UV_CACHE_DIR", plain(&p.data.join("uv-cache")))
        // Always our own Python in <data>: a system Python the user may later remove must not be used.
        .env("UV_PYTHON_PREFERENCE", "only-managed")
        // Ignore any uv.toml the user may have; the big CUDA wheels need a lenient timeout.
        .env("UV_NO_CONFIG", "1")
        .env("UV_HTTP_TIMEOUT", "300")
        .env_remove("VIRTUAL_ENV");
    cmd
}

/// The file uv could not replace because another program has it open, from a line of uv's output. Seen on Windows:
/// ``failed to remove file `C:\…\site-packages\../../Scripts/holos.exe`: … being used by another process. (os error 32)``
/// and ``Failed to persist temporary file to C:\…\site-packages\..\..\Scripts\holos.exe: … Access is denied. (os error 5)``.
fn locked_path(line: &str) -> Option<PathBuf> {
    const BUSY: [&str; 4] = ["(os error 32)", "(os error 5)", "being used by another process", "Access is denied"];
    if !BUSY.iter().any(|m| line.contains(m)) {
        return None;
    }
    path_in(line).map(|p| normalize(Path::new(p)))
}

/// The first file path in an error line: `quoted`, or a Windows path from its drive letter up to the next ": ".
fn path_in(line: &str) -> Option<&str> {
    if let Some(a) = line.find('`') {
        if let Some(b) = line[a + 1..].find('`') {
            return Some(&line[a + 1..a + 1 + b]);
        }
    }
    let bytes = line.as_bytes();
    for i in 0..bytes.len().saturating_sub(2) {
        let starts = bytes[i].is_ascii_alphabetic() && bytes[i + 1] == b':' && (bytes[i + 2] == b'\\' || bytes[i + 2] == b'/');
        if starts && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric()) {
            let rest = &line[i..];
            return Some(rest[..rest.find(": ").unwrap_or(rest.len())].trim_end());
        }
    }
    None
}

/// Resolve `.` and `..` without touching the disk (uv prints paths like `site-packages\../../Scripts/holos.exe`).
fn normalize(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Rename `file` to `<name>.<n>.holos-old` next to it, so uv can write a new one.
fn move_aside(file: &Path) -> std::io::Result<PathBuf> {
    let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    for n in 0..1000 {
        let dst = file.with_file_name(format!("{name}.{n}{MOVED_SUFFIX}"));
        if !dst.exists() {
            fs::rename(file, &dst)?;
            return Ok(dst);
        }
    }
    Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "too many old copies"))
}

/// Delete files moved aside by earlier setups (those still in use stay until next time).
fn remove_moved(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(t) if t.is_dir() => remove_moved(&path),
            Ok(_) if path.to_string_lossy().ends_with(MOVED_SUFFIX) => {
                let _ = fs::remove_file(&path);
            }
            _ => {}
        }
    }
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// A console script inside a virtual environment.
fn venv_script(env: &Path, name: &str) -> PathBuf {
    if cfg!(windows) {
        env.join("Scripts").join(exe(name))
    } else {
        env.join("bin").join(name)
    }
}

/// Path as a plain string, without the `\\?\` prefix Windows APIs sometimes add (it confuses Python tools and
/// looks odd in the Claude Desktop config).
fn plain(p: &Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

fn show(p: &Path) -> String {
    plain(p)
}

fn code(status: ExitStatus) -> String {
    status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into())
}

fn read_marker(p: &Paths) -> Option<String> {
    let text = fs::read_to_string(p.marker()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("hash")?.as_str().map(str::to_string)
}

/// SHA-256 over every file (relative path + content) of the bundled engine source, plus the extras we install.
/// Changes whenever an update ships different engine code or dependencies → setup runs again.
fn hash_dir(root: &Path) -> std::io::Result<String> {
    let mut files = Vec::new();
    collect_files(root, root, &mut files)?;
    files.sort();
    let mut h = Sha256::new();
    h.update(EXTRAS.join(",").as_bytes());
    for rel in files {
        h.update(rel.as_bytes());
        h.update([0u8]);
        let bytes = fs::read(root.join(&rel))?;
        h.update((bytes.len() as u64).to_le_bytes());
        h.update(&bytes);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<String>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            collect_files(root, &path, out)?;
        } else if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

/// Replace `dst` with a copy of `src`.
fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    if dst.exists() {
        fs::remove_dir_all(dst)?;
    }
    copy_tree(src, dst)
}

fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

/// 32 hex characters from the OS random generator.
fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| format!("getrandom: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Minimal HTTP probe of `GET /api/health` (no auth needed) — avoids pulling an HTTP client into the app.
fn health_ok(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let req = format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 32];
    let mut n = 0;
    while n < 12 {
        match s.read(&mut buf[n..]) {
            Ok(0) | Err(_) => break,
            Ok(k) => n += k,
        }
    }
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_32_hex() {
        let t = random_token().unwrap();
        assert_eq!(t.len(), 32);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn plain_strips_verbatim_prefix() {
        assert_eq!(plain(Path::new(r"\\?\C:\x\y")), r"C:\x\y");
    }

    #[test]
    fn hash_changes_with_content() {
        let dir = std::env::temp_dir().join(format!("holos-hash-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("pyproject.toml"), "a").unwrap();
        fs::write(dir.join("src").join("x.py"), "1").unwrap();
        let a = hash_dir(&dir).unwrap();
        fs::write(dir.join("src").join("x.py"), "2").unwrap();
        let b = hash_dir(&dir).unwrap();
        assert_ne!(a, b);
        let copy = dir.with_extension("copy");
        copy_dir(&dir, &copy).unwrap();
        assert_eq!(hash_dir(&copy).unwrap(), b);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&copy);
    }

    #[test]
    fn locked_file_is_found_in_uv_output() {
        let line = "error: failed to remove file `/d/env/Lib/site-packages/../../Scripts/holos.exe`: The process cannot \
                    access the file because it is being used by another process. (os error 32)";
        assert_eq!(locked_path(line), Some(PathBuf::from("/d/env/Scripts/holos.exe")));
        assert_eq!(locked_path("error: failed to fetch `https://x` (os error 10060)"), None);
        let persist = r"Caused by: Failed to persist temporary file to C:\Users\r\env\Lib\site-packages\..\..\Scripts\holos.exe: failed to persist temporary file: Access is denied. (os error 5)";
        assert_eq!(path_in(persist), Some(r"C:\Users\r\env\Lib\site-packages\..\..\Scripts\holos.exe"));
        assert!(locked_path(persist).is_some());
        #[cfg(windows)]
        assert_eq!(locked_path(persist), Some(PathBuf::from(r"C:\Users\r\env\Scripts\holos.exe")));
        assert_eq!(locked_path(r"Caused by: failed to read C:\x\y.whl: (os error 50)"), None);
        assert_eq!(locked_path("Prepared 1 package in 877ms"), None);
    }

    #[test]
    fn claude_config_entry_is_moved_to_python() {
        let holos = Path::new(r"C:\Users\o\AppData\Local\com.brainfromukraine.holos\env\Scripts\holos.exe");
        let python = Path::new(r"C:\Users\o\AppData\Local\com.brainfromukraine.holos\env\Scripts\python.exe");
        let text = r#"{"mcpServers": {"holos-studio": {"command": "C:\\Users\\o\\AppData\\Local\\com.brainfromukraine.holos\\env\\Scripts\\holos.exe", "args": ["mcp"], "env": {"HOLOS_FFMPEG": "x"}}, "kicad": {"command": "kicad-mcp", "args": []}}, "theme": "dark"}"#;
        let new = rewrite_claude_config(text, holos, python).unwrap();
        let v: serde_json::Value = serde_json::from_str(&new).unwrap();
        assert_eq!(v["mcpServers"]["holos-studio"]["command"], plain(python));
        assert_eq!(v["mcpServers"]["holos-studio"]["args"], serde_json::json!(["-m", "holos", "mcp"]));
        assert_eq!(v["mcpServers"]["holos-studio"]["env"]["HOLOS_FFMPEG"], "x");
        assert_eq!(v["mcpServers"]["kicad"]["command"], "kicad-mcp");
        assert_eq!(v["theme"], "dark");
        // other files, already updated configs and foreign holos installs are left alone
        assert!(rewrite_claude_config(&new, holos, python).is_none());
        assert!(rewrite_claude_config(r#"{"mcpServers": {"h": {"command": "D:\\other\\holos.exe", "args": ["mcp"]}}}"#, holos, python).is_none());
        assert!(rewrite_claude_config("not json", holos, python).is_none());
        assert!(rewrite_claude_config(r#"{"theme": "dark"}"#, holos, python).is_none());
    }

    #[test]
    fn moved_aside_files_are_cleaned_up() {
        let dir = std::env::temp_dir().join(format!("holos-moved-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Scripts")).unwrap();
        let exe = dir.join("Scripts").join("holos.exe");
        fs::write(&exe, "old").unwrap();
        let a = move_aside(&exe).unwrap();
        fs::write(&exe, "new").unwrap();
        let b = move_aside(&exe).unwrap();
        assert_ne!(a, b);
        assert!(!exe.exists() && a.exists() && b.exists());
        fs::write(&exe, "newest").unwrap();
        remove_moved(&dir);
        assert!(!a.exists() && !b.exists());
        assert_eq!(fs::read_to_string(&exe).unwrap(), "newest");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn health_probe_fails_on_closed_port() {
        let port = free_port().unwrap();
        assert!(!health_ok(port));
    }
}
