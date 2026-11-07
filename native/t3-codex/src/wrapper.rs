use crate::credentials::{Binding, Credential, Credentials, ParentLookup, RequestId, ThreadId};
use crate::{ipc, proxy};
use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use std::borrow::Cow;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot};

const REAL_CODEX_ENV: &str = "T3_CODEX_REAL";
/// T3 Code's opt-in Unix socket (or pipe) for `/mcp`; when set, sessions use it instead of TCP.
const T3_MCP_SOCKET_ENV: &str = "T3CODE_MCP_SOCKET";
const T3_SERVERS: [&str; 2] = ["t3-code", "t3-code-direct"];
const THREAD_METHODS: [&str; 3] = ["thread/start", "thread/resume", "thread/fork"];
/// Keeps the wrapper's endpoint out of agent shell commands; bridges get it through `env_vars`.
const SHELL_FILTER_KEY: &str = "shell_environment_policy.filters.T3_MCP_*";
const READ_TIMEOUT: Duration = Duration::from_secs(10);

pub fn run(args: Vec<OsString>) -> crate::Result<i32> {
    let real = real_codex()?;
    if args.first().is_none_or(|arg| arg != "app-server") {
        return passthrough(&real, &args);
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    Ok(runtime.block_on(app_server(&real, &args))?)
}

async fn app_server(real: &Path, args: &[OsString]) -> std::io::Result<i32> {
    let mut listener = ipc::Listener::bind()?;
    let mut child = Command::new(real)
        .args(args)
        .env(ipc::ENV, &listener.name)
        .env("PATH", path_with_own_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    let codex = Codex::start(child.stdin.take().expect("piped stdin"));
    let lookup = Arc::clone(&codex);
    let parent_of: ParentLookup = Box::new(move |thread| {
        let codex = Arc::clone(&lookup);
        Box::pin(async move { codex.parent_of(thread).await })
    });
    let credentials = Arc::new(Credentials::new(parent_of));
    let t3_socket = std::env::var_os(T3_MCP_SOCKET_ENV)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);

    // A plain thread: tokio reads stdin on a blocking thread it cannot cancel, so a runtime that
    // owned this read could never shut down while T3 Code keeps stdin open.
    let from_t3 = (Arc::clone(&codex), Arc::clone(&credentials));
    std::thread::spawn(move || forward_from_t3(&from_t3.0, &from_t3.1, t3_socket.as_deref()));
    let to_t3 = tokio::spawn(to_t3(
        child.stdout.take().expect("piped stdout"),
        codex,
        Arc::clone(&credentials),
    ));
    if let Some(pid) = child.id() {
        tokio::spawn(forward_signals(pid));
    }
    let bridges = async {
        while let Ok(stream) = listener.accept().await {
            tokio::spawn(proxy::serve(stream, Arc::clone(&credentials)));
        }
    };
    let status = tokio::select! {
        status = child.wait() => status?,
        () = bridges => child.wait().await?,
    };
    let _ = to_t3.await;
    Ok(exit_code(status))
}

struct Codex {
    stdin: Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    replies: Mutex<HashMap<RequestId, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Codex {
    fn start(mut stdin: ChildStdin) -> Arc<Self> {
        let (sender, mut lines) = mpsc::unbounded_channel::<Vec<u8>>();
        tokio::spawn(async move {
            while let Some(line) = lines.recv().await {
                if stdin.write_all(&line).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
        });
        Arc::new(Self {
            stdin: Mutex::new(Some(sender)),
            replies: Mutex::default(),
            next_id: AtomicU64::new(1),
        })
    }

    fn send(&self, line: Vec<u8>) {
        if let Some(stdin) = lock(&self.stdin).as_ref() {
            let _ = stdin.send(line);
        }
    }

    /// Closing T3 Code's side closes the app-server's stdin, which shuts it down.
    fn close(&self) {
        lock(&self.stdin).take();
    }

    fn is_waiting(&self) -> bool {
        !lock(&self.replies).is_empty()
    }

    /// False if the reply is T3 Code's.
    fn deliver(&self, id: &RequestId, line: &[u8]) -> bool {
        let Some(waiter) = lock(&self.replies).remove(id) else {
            return false;
        };
        if let Ok(message) = serde_json::from_slice(line) {
            let _ = waiter.send(message);
        }
        true
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = RequestId::String(format!(
            "t3-codex:{}",
            self.next_id.fetch_add(1, Ordering::SeqCst)
        ));
        let (waiter, reply) = oneshot::channel();
        lock(&self.replies).insert(id.clone(), waiter);
        let mut line = json!({ "id": id, "method": method, "params": params })
            .to_string()
            .into_bytes();
        line.push(b'\n');
        self.send(line);
        let reply = tokio::time::timeout(READ_TIMEOUT, reply).await;
        lock(&self.replies).remove(&id);
        let reply = reply
            .map_err(|_| format!("Codex did not answer {method}."))?
            .map_err(|_| format!("Codex closed before answering {method}."))?;
        match reply.get("error") {
            Some(error) => Err(format!("Codex refused {method}: {error}")),
            None => Ok(reply.get("result").cloned().unwrap_or(Value::Null)),
        }
    }

    async fn parent_of(&self, thread: ThreadId) -> Result<Option<ThreadId>, String> {
        let read = self
            .request("thread/read", json!({ "threadId": thread.0 }))
            .await?;
        Ok(read
            .pointer("/thread/source/subAgent/thread_spawn/parent_thread_id")
            .and_then(Value::as_str)
            .map(|parent| ThreadId(parent.to_owned())))
    }
}

fn forward_from_t3(codex: &Codex, credentials: &Credentials, t3_socket: Option<&Path>) {
    let mut stdin = std::io::stdin().lock();
    let mut line = Vec::new();
    loop {
        line.clear();
        match std::io::BufRead::read_until(&mut stdin, b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let rewritten = take_t3_servers_from(&line, credentials, t3_socket);
        codex.send(rewritten.unwrap_or_else(|| line.clone()));
    }
    codex.close();
}

async fn to_t3(stdout: ChildStdout, codex: Arc<Codex>, credentials: Arc<Credentials>) {
    let mut lines = BufReader::new(stdout);
    let mut stdout = tokio::io::stdout();
    let mut line = Vec::new();
    loop {
        line.clear();
        match lines.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if note_reply(&line, &codex, &credentials) {
            continue;
        }
        if stdout.write_all(&line).await.is_err() || stdout.flush().await.is_err() {
            break;
        }
    }
}

/// T3 Code puts its MCP servers, with each thread's own credential, in every thread request's
/// config. The admin policy refuses MCP servers from config, so they move into the plugin.
/// `None` leaves the line as it is.
fn take_t3_servers_from(
    line: &[u8],
    credentials: &Credentials,
    t3_socket: Option<&Path>,
) -> Option<Vec<u8>> {
    #[derive(Deserialize)]
    struct Head<'a> {
        #[serde(borrow)]
        method: Option<Cow<'a, str>>,
        id: Option<RequestId>,
    }
    let head: Head = serde_json::from_slice(line).ok()?;
    let is_thread_request = head
        .method
        .as_deref()
        .is_some_and(|method| THREAD_METHODS.contains(&method));
    let id = head.id.filter(|_| is_thread_request)?;
    let mut message: Value = serde_json::from_slice(line).ok()?;
    let config = message.pointer_mut("/params/config")?.as_object_mut()?;
    let binding = take_t3_servers(config, t3_socket)?;
    config.insert(SHELL_FILTER_KEY.to_owned(), json!("exclude"));
    if let Err(error) = &binding {
        eprintln!("t3-codex: {error}");
    }
    credentials.begin(id, binding);
    let mut rewritten = message.to_string().into_bytes();
    rewritten.push(b'\n');
    Some(rewritten)
}

/// Removes T3 Code's servers, dotted (`mcp_servers.t3-code`) or nested. `None` if there were none.
fn take_t3_servers(config: &mut Map<String, Value>, t3_socket: Option<&Path>) -> Option<Binding> {
    let mut taken: Vec<Value> = T3_SERVERS
        .iter()
        .filter_map(|name| config.remove(&format!("mcp_servers.{name}")))
        .collect();
    if let Some(Value::Object(servers)) = config.get_mut("mcp_servers") {
        taken.extend(T3_SERVERS.iter().filter_map(|name| servers.remove(*name)));
        if servers.is_empty() {
            config.remove("mcp_servers");
        }
    }
    if taken.is_empty() {
        return None;
    }
    let credential = taken.iter().find_map(|server| {
        let headers = server.get("http_headers")?.as_object()?;
        let (_, authorization) = headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))?;
        Some(Credential {
            url: server.get("url")?.as_str()?.to_owned(),
            authorization: authorization.as_str()?.to_owned(),
            socket: t3_socket.map(Path::to_path_buf),
        })
    });
    Some(credential.ok_or_else(|| {
        "T3 Code sent its MCP servers in a form t3-codex does not understand (expected `url` and an \
         `Authorization` header in `http_headers`). Update t3-codex to match this T3 Code version."
            .to_owned()
    }))
}

/// Parses only while something is waiting; the app-server's stream otherwise passes unread.
/// True for a reply to the wrapper's own request, which must not reach T3 Code.
fn note_reply(line: &[u8], codex: &Codex, credentials: &Credentials) -> bool {
    if !credentials.is_waiting() && !codex.is_waiting() {
        return false;
    }
    #[derive(Deserialize)]
    struct Reply<'a> {
        id: Option<RequestId>,
        method: Option<IgnoredAny>,
        #[serde(borrow)]
        result: Option<&'a RawValue>,
    }
    #[derive(Deserialize)]
    struct ThreadResult {
        thread: ThreadFields,
    }
    #[derive(Deserialize)]
    struct ThreadFields {
        id: String,
    }
    let Ok(Reply {
        id: Some(id),
        method: None,
        result,
    }) = serde_json::from_slice::<Reply>(line)
    else {
        return false;
    };
    if codex.deliver(&id, line) {
        return true;
    }
    let thread = result
        .and_then(|result| serde_json::from_str::<ThreadResult>(result.get()).ok())
        .map(|result| ThreadId(result.thread.id));
    credentials.finish(&id, thread);
    false
}

/// `T3_CODEX_REAL`, else the first `codex` on PATH that is not this program.
fn real_codex() -> crate::Result<PathBuf> {
    if let Some(path) = std::env::var_os(REAL_CODEX_ENV).filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let own = std::env::current_exe().and_then(std::fs::canonicalize).ok();
    let names: &[&str] = if cfg!(windows) {
        &["codex.exe", "codex.cmd"]
    } else {
        &["codex"]
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
        .ok_or_else(|| format!("no codex on PATH; set {REAL_CODEX_ENV}").into())
}

/// The plugin runs `t3-codex mcp-bridge`; this program's directory goes first so Codex finds it.
fn path_with_own_dir() -> OsString {
    let own_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    let rest = std::env::var_os("PATH").unwrap_or_default();
    std::env::join_paths(own_dir.into_iter().chain(std::env::split_paths(&rest))).unwrap_or(rest)
}

#[cfg(unix)]
fn passthrough(real: &Path, args: &[OsString]) -> crate::Result<i32> {
    use std::os::unix::process::CommandExt;
    let error = std::process::Command::new(real).args(args).exec();
    Err(format!("cannot run {}: {error}", real.display()).into())
}

#[cfg(windows)]
fn passthrough(real: &Path, args: &[OsString]) -> crate::Result<i32> {
    let status = std::process::Command::new(real).args(args).status();
    let status = status.map_err(|error| format!("cannot run {}: {error}", real.display()))?;
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

/// Passes termination on to the app-server; the wrapper exits once it does.
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

/// Console control events already reach the app-server, which shares the console.
#[cfg(windows)]
async fn forward_signals(_child: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn credentials() -> Credentials {
        Credentials::new(Box::new(|_| Box::pin(async { Ok(None) })))
    }

    fn credential(token: &str) -> Credential {
        Credential {
            url: "http://h/mcp".into(),
            authorization: format!("Bearer {token}"),
            socket: None,
        }
    }

    #[test]
    fn takes_t3_servers_in_every_form() {
        let server =
            json!({ "url": "http://h/mcp", "http_headers": { "Authorization": "Bearer a" } });
        let mut dotted = json!({ "mcp_servers.t3-code": server, "mcp_servers.t3-code-direct": server, "mcp_servers.other": {}, "model": "m" });
        let dotted = dotted.as_object_mut().unwrap();
        assert_eq!(take_t3_servers(dotted, None), Some(Ok(credential("a"))));
        assert_eq!(
            dotted.keys().collect::<Vec<_>>(),
            ["mcp_servers.other", "model"]
        );

        let mut nested = json!({ "mcp_servers": { "t3-code": server, "other": {} } });
        assert_eq!(
            take_t3_servers(nested.as_object_mut().unwrap(), None),
            Some(Ok(credential("a")))
        );
        assert_eq!(nested, json!({ "mcp_servers": { "other": {} } }));

        assert_eq!(
            take_t3_servers(json!({ "x": 1 }).as_object_mut().unwrap(), None),
            None
        );
        // A shape T3 Code might move to: still removed, and reported.
        let mut changed = json!({ "mcp_servers.t3-code": { "url": "http://h/mcp", "bearer_token_env_var": "X" } });
        assert!(matches!(
            take_t3_servers(changed.as_object_mut().unwrap(), None),
            Some(Err(_))
        ));
    }

    #[tokio::test]
    async fn binds_threads_from_requests_and_replies() {
        let credentials = credentials();
        let codex = Codex::start_detached();
        assert_eq!(
            take_t3_servers_from(
                br#"{"id":1,"method":"turn/start","params":{"x":"thread/start"}}"#,
                &credentials,
                None
            ),
            None
        );

        let start = br#"{"id":7,"method":"thread/start","params":{"config":{"mcp_servers.t3-code":{"url":"http://h/mcp","http_headers":{"Authorization":"Bearer a"}}}}}"#;
        let rewritten: Value =
            serde_json::from_slice(&take_t3_servers_from(start, &credentials, None).unwrap())
                .unwrap();
        assert_eq!(
            rewritten["params"]["config"],
            json!({ SHELL_FILTER_KEY: "exclude" })
        );

        assert!(!note_reply(
            br#"{"id":7,"result":{"thread":{"id":"th"}}}"#,
            &codex,
            &credentials
        ));
        assert_eq!(
            credentials.for_thread(&ThreadId("th".into())).await,
            Ok(credential("a"))
        );
    }

    impl Codex {
        fn start_detached() -> Self {
            Self {
                stdin: Mutex::new(None),
                replies: Mutex::default(),
                next_id: AtomicU64::new(1),
            }
        }
    }
}
