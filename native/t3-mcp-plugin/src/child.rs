//! Runs the real CLI between T3 Code and it, and serves the plugin's bridges meanwhile.

use crate::credentials::Credentials;
use crate::ipc;
use crate::proxy::{self, Identity};
use std::borrow::Cow;
use std::ffi::OsString;
use std::io::{self, BufRead};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// T3 Code's opt-in Unix socket (or pipe) for `/mcp`; when set, sessions use it instead of TCP.
const T3_MCP_SOCKET_ENV: &str = "T3CODE_MCP_SOCKET";

/// `real_env`, else the first `name` on PATH that is not this program.
pub fn real_binary(name: &str, real_env: &str) -> crate::Result<PathBuf> {
    if let Some(path) = std::env::var_os(real_env).filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let own = std::env::current_exe().and_then(std::fs::canonicalize).ok();
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.cmd")]
    } else {
        vec![name.to_owned()]
    };
    std::env::var_os("PATH")
        .iter()
        .flat_map(std::env::split_paths)
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| {
            candidate.is_file()
                && std::fs::canonicalize(candidate)
                    .ok()
                    .is_some_and(|path| Some(path) != own)
        })
        .ok_or_else(|| format!("no {name} on PATH; set {real_env}").into())
}

pub fn t3_socket() -> Option<PathBuf> {
    std::env::var_os(T3_MCP_SOCKET_ENV)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

#[cfg(unix)]
pub fn passthrough(real: &Path, args: &[OsString]) -> crate::Result<i32> {
    use std::os::unix::process::CommandExt;
    let error = std::process::Command::new(real).args(args).exec();
    Err(format!("cannot run {}: {error}", real.display()).into())
}

#[cfg(windows)]
pub fn passthrough(real: &Path, args: &[OsString]) -> crate::Result<i32> {
    let status = std::process::Command::new(real).args(args).status();
    let status = status.map_err(|error| format!("cannot run {}: {error}", real.display()))?;
    Ok(exit_code(status))
}

pub fn runtime() -> io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
}

/// Starts the real CLI with the bridges' endpoint in its environment. The plugin runs
/// `<this program> mcp-bridge`, so this program's directory goes first on PATH.
pub fn spawn(real: &Path, args: &[OsString]) -> io::Result<(Child, ipc::Listener)> {
    let listener = ipc::Listener::bind()?;
    let own_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    let path = std::env::var_os("PATH").unwrap_or_default();
    let path = std::env::join_paths(own_dir.into_iter().chain(std::env::split_paths(&path)))
        .unwrap_or(path);
    let child = Command::new(real)
        .args(args)
        .env(ipc::ENV, &listener.name)
        .env("PATH", path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    Ok((child, listener))
}

/// The CLI's stdin, written in order from anywhere.
pub struct Stdin(Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>);

impl Stdin {
    pub fn start(mut stdin: ChildStdin) -> Self {
        let (sender, mut lines) = mpsc::unbounded_channel::<Vec<u8>>();
        tokio::spawn(async move {
            while let Some(line) = lines.recv().await {
                if stdin.write_all(&line).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
        });
        Self(Mutex::new(Some(sender)))
    }

    pub fn send(&self, line: Vec<u8>) {
        let sender = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(sender) = sender.as_ref() {
            let _ = sender.send(line);
        }
    }

    /// Closing T3 Code's side closes the CLI's stdin, which shuts it down.
    pub fn close(&self) {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
    }
}

/// Reads T3 Code's lines on a plain thread, not tokio's stdin: that reads on a blocking thread
/// the runtime cannot cancel, so it could never shut down while T3 Code keeps stdin open.
pub fn read_from_t3(
    stdin: Arc<Stdin>,
    mut rewrite: impl FnMut(Vec<u8>) -> Vec<u8> + Send + 'static,
) {
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        let mut line = Vec::new();
        loop {
            line.clear();
            match input.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => stdin.send(rewrite(line.clone())),
            }
        }
        stdin.close();
    });
}

/// `filter` returns `None` for a line that must not reach T3 Code.
pub fn relay_to_t3(
    stdout: ChildStdout,
    mut filter: impl FnMut(&[u8]) -> Option<Cow<'_, [u8]>> + Send + 'static,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout);
        let mut out = tokio::io::stdout();
        let mut line = Vec::new();
        loop {
            line.clear();
            match lines.read_until(b'\n', &mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let Some(line) = filter(&line) else {
                continue;
            };
            if out.write_all(&line).await.is_err() || out.flush().await.is_err() {
                break;
            }
        }
    })
}

/// Serves bridges until the CLI exits, and returns its exit code.
pub async fn serve(
    mut child: Child,
    mut listener: ipc::Listener,
    credentials: Arc<Credentials>,
    identity: Identity,
    to_t3: JoinHandle<()>,
) -> io::Result<i32> {
    if let Some(pid) = child.id() {
        tokio::spawn(forward_signals(pid));
    }
    let bridges = async {
        while let Ok(stream) = listener.accept().await {
            tokio::spawn(proxy::serve(stream, Arc::clone(&credentials), identity));
        }
    };
    let status = tokio::select! {
        status = child.wait() => status?,
        () = bridges => child.wait().await?,
    };
    let _ = to_t3.await;
    Ok(exit_code(status))
}

fn exit_code(status: ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    status.code().unwrap_or(1)
}

/// Passes termination on to the CLI; the wrapper exits once it does.
#[cfg(unix)]
async fn forward_signals(child: u32) {
    use rustix::process::{Pid, Signal, kill_process};
    use tokio::signal::unix::{SignalKind, signal};
    let Some(child) = i32::try_from(child).ok().and_then(Pid::from_raw) else {
        return;
    };
    let (Ok(mut term), Ok(mut int), Ok(mut hup)) = (
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
        signal(SignalKind::hangup()),
    ) else {
        return;
    };
    loop {
        let signal = tokio::select! {
            _ = term.recv() => Signal::TERM,
            _ = int.recv() => Signal::INT,
            _ = hup.recv() => Signal::HUP,
        };
        // Our own child, kept unreaped by `kill_on_drop`, so the PID cannot be reused yet.
        let _ = kill_process(child, signal);
    }
}

/// Console control events already reach the CLI, which shares the console.
#[cfg(windows)]
async fn forward_signals(_child: u32) {}
