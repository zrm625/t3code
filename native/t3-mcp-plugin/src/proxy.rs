use crate::bridge::offline_reply;
use crate::credentials::{Credential, Credentials, RequestId, ThreadId};
use crate::http::{self, Endpoint, EventStream};
use crate::ipc::Stream;
use hyper::Method;
use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{OnceCell, mpsc, watch};
use tokio::task::JoinSet;

/// Opening a session is quick. Tool calls get no limit: `t3_thread_wait` can take an hour.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const END_SESSION_TIMEOUT: Duration = Duration::from_secs(2);
/// Covers T3 Code sending Claude its credential just after the plugin servers start.
const CREDENTIAL_WAIT: Duration = Duration::from_secs(15);
const INITIALIZE_ID: &str = "t3-mcp-plugin:initialize";
const NO_REPLY: &str = "T3 Code MCP endpoint ended the request without a reply.";
const NO_THREAD: &str = "Codex sent a tool call without _meta.threadId, so t3-codex cannot tell which \
                         T3 Code thread is calling. This Codex version is not supported.";

/// Which T3 Code thread a tool call acts as.
#[derive(Clone, Copy, Debug)]
pub enum Identity {
    /// Codex: one app-server hosts many threads, and `_meta.threadId` names the caller.
    Thread,
    /// Claude: one process per thread; subagents share it, so every call is that thread's.
    Process,
}

#[derive(Debug)]
enum Error {
    /// T3 Code no longer accepts this credential or session (HTTP 401 or 404). Nothing was
    /// relayed, so the message can go again on a fresh session.
    Stale(u16),
    /// T3 Code gave no credential: it did not start this session.
    Offline,
    Failed(String),
}

impl Error {
    fn message(&self) -> String {
        match self {
            Self::Stale(status) => format!("T3 Code MCP endpoint responded with HTTP {status}."),
            Self::Offline => "T3 Code did not start this session.".to_owned(),
            Self::Failed(message) => message.clone(),
        }
    }
}

impl From<String> for Error {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Session {
    credential: Credential,
    endpoint: Endpoint,
    id: Mutex<Option<String>>,
    protocol_version: OnceLock<String>,
    /// T3 Code's initialize result, which Codex receives as this server's own.
    init_result: OnceLock<Box<RawValue>>,
}

struct Connection {
    credentials: Arc<Credentials>,
    identity: Identity,
    output: mpsc::UnboundedSender<String>,
    sessions: Mutex<HashMap<Credential, Arc<OnceCell<Arc<Session>>>>>,
    /// Serves everything not tied to a thread: discovery, pings, notifications.
    primary: Mutex<Option<Arc<Session>>>,
    /// Codex's initialize params, replayed to open each session.
    init_params: Mutex<Value>,
    initialized: watch::Sender<bool>,
    offline: AtomicBool,
    /// Server request -> its session, so Codex's reply goes back there.
    server_requests: Mutex<HashMap<RequestId, Arc<Session>>>,
    /// Codex request -> its session, so a cancellation reaches the right one.
    in_flight: Mutex<HashMap<RequestId, Arc<Session>>>,
}

pub async fn serve(stream: impl Stream, credentials: Arc<Credentials>, identity: Identity) {
    let (reader, mut writer) = tokio::io::split(stream);
    let (output, mut outgoing) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        // Every message is one line by construction (see `one_line`).
        while let Some(mut line) = outgoing.recv().await {
            line.push('\n');
            if writer.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });
    let connection = Arc::new(Connection {
        credentials,
        identity,
        output,
        sessions: Mutex::default(),
        primary: Mutex::default(),
        init_params: Mutex::new(json!({})),
        initialized: watch::Sender::new(false),
        offline: AtomicBool::new(false),
        server_requests: Mutex::default(),
        in_flight: Mutex::default(),
    });
    let mut handlers = JoinSet::new();
    let mut lines = BufReader::new(reader);
    let mut line = Vec::new();
    loop {
        line.clear();
        match lines.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let message = line.trim_ascii();
        if !message.is_empty() {
            handlers.spawn(Arc::clone(&connection).handle(message.to_vec()));
        }
        while handlers.try_join_next().is_some() {}
    }
    // The bridge is gone, so no one is left to read replies.
    handlers.abort_all();
    connection.end_sessions().await;
}

#[derive(Deserialize)]
struct Incoming {
    id: Option<RequestId>,
    method: Option<String>,
    #[serde(default)]
    params: Value,
}

impl Connection {
    fn send(&self, line: String) {
        let _ = self.output.send(line);
    }

    fn send_error(&self, id: Option<&RequestId>, code: i64, message: &str) {
        self.send(
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
                .to_string(),
        );
    }

    async fn handle(self: Arc<Self>, line: Vec<u8>) {
        let Ok(message) = serde_json::from_slice::<Incoming>(&line) else {
            return self.send_error(None, -32700, "Parse error");
        };
        let outcome = match (message.method.as_deref(), message.id.as_ref()) {
            (Some("initialize"), Some(id)) => self.initialize(id, &message.params).await,
            // Each session sends its own while opening.
            (Some("notifications/initialized"), _) => Ok(()),
            (Some(method), id) => {
                let _ = self.initialized.subscribe().wait_for(|done| *done).await;
                if self.offline.load(Ordering::SeqCst) {
                    if let Some(id) = id {
                        self.send(offline_reply(id, method, &message.params));
                    }
                    Ok(())
                } else {
                    self.forward(&line, method, id, &message.params).await
                }
            }
            (None, Some(id)) => self.forward_reply(&line, id).await,
            (None, None) => Ok(()),
        };
        if let (Err(error), Some(id), Some(_)) = (outcome, &message.id, &message.method) {
            self.send_error(Some(id), -32603, &error.message());
        }
    }

    async fn initialize(&self, id: &RequestId, params: &Value) -> Result<(), Error> {
        *lock(&self.init_params) = params.clone();
        let opened = self.primary().await;
        self.initialized.send_replace(true);
        match opened {
            Ok(session) => {
                let result = session
                    .init_result
                    .get()
                    .map_or("{}", |result| result.get());
                let id = serde_json::to_string(id).unwrap_or_default();
                self.send(format!(
                    r#"{{"jsonrpc":"2.0","id":{id},"result":{result}}}"#
                ));
                Ok(())
            }
            Err(Error::Offline) => {
                self.offline.store(true, Ordering::SeqCst);
                self.send(offline_reply(id, "initialize", params));
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    async fn forward(
        &self,
        line: &[u8],
        method: &str,
        id: Option<&RequestId>,
        params: &Value,
    ) -> Result<(), Error> {
        let thread = match (method, self.identity) {
            // Without it, the call would run as whichever thread a session was opened for.
            ("tools/call", Identity::Thread) => Some(
                params
                    .pointer("/_meta/threadId")
                    .and_then(Value::as_str)
                    .filter(|thread| !thread.is_empty())
                    .map(|thread| ThreadId(thread.to_owned()))
                    .ok_or_else(|| Error::Failed(NO_THREAD.to_owned()))?,
            ),
            _ => None,
        };
        for attempt in 0..2 {
            let session = match (&thread, method) {
                (Some(thread), _) => {
                    self.session(self.credentials.for_thread(thread).await?)
                        .await?
                }
                // A rotated credential takes effect on the next call.
                (None, "tools/call") => {
                    let credential = self.credentials.newest().ok_or(Error::Offline)?;
                    self.session(credential).await?
                }
                _ => match self.cancelled_request_session(method, params) {
                    Some(session) => session,
                    None => self.primary().await?,
                },
            };
            if let Some(id) = id {
                lock(&self.in_flight).insert(id.clone(), Arc::clone(&session));
            }
            let outcome = self.exchange(&session, line.to_vec(), id, false).await;
            if let Some(id) = id {
                lock(&self.in_flight).remove(id);
            }
            match outcome {
                Ok(_) => return Ok(()),
                Err(Error::Stale(_)) if attempt == 0 => self.forget(&session),
                Err(error) => return Err(error),
            }
        }
        unreachable!("the loop returns on its second attempt")
    }

    fn cancelled_request_session(&self, method: &str, params: &Value) -> Option<Arc<Session>> {
        let request = params
            .get("requestId")
            .filter(|_| method == "notifications/cancelled")?;
        let request = RequestId::deserialize(request).ok()?;
        lock(&self.in_flight).get(&request).cloned()
    }

    async fn forward_reply(&self, line: &[u8], id: &RequestId) -> Result<(), Error> {
        let session = lock(&self.server_requests).remove(id);
        let session = match session {
            Some(session) => session,
            None => self.primary().await?,
        };
        self.exchange(&session, line.to_vec(), None, false)
            .await
            .map(|_| ())
    }

    /// The session opened with any current credential. One revoked since gets a fresh lookup.
    async fn primary(&self) -> Result<Arc<Session>, Error> {
        if let Some(session) = lock(&self.primary).clone() {
            return Ok(session);
        }
        for attempt in 0..2 {
            let credential = match self.identity {
                Identity::Thread => self.credentials.newest(),
                Identity::Process => self.credentials.wait_for_newest(CREDENTIAL_WAIT).await,
            };
            let credential = credential.ok_or(Error::Offline)?;
            match self.session(credential).await {
                Ok(session) => {
                    *lock(&self.primary) = Some(Arc::clone(&session));
                    return Ok(session);
                }
                Err(Error::Stale(_)) if attempt == 0 => {}
                Err(error) => return Err(error),
            }
        }
        unreachable!("the loop returns on its second attempt")
    }

    /// Opens at most one session per credential; the map lock is never held while opening.
    async fn session(&self, credential: Credential) -> Result<Arc<Session>, Error> {
        let cell = Arc::clone(lock(&self.sessions).entry(credential.clone()).or_default());
        cell.get_or_try_init(|| self.open(credential))
            .await
            .cloned()
    }

    fn forget(&self, session: &Arc<Session>) {
        let mut sessions = lock(&self.sessions);
        let current = sessions
            .get(&session.credential)
            .and_then(|cell| cell.get());
        if current.is_some_and(|current| Arc::ptr_eq(current, session)) {
            sessions.remove(&session.credential);
        }
        let mut primary = lock(&self.primary);
        if primary
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            *primary = None;
        }
    }

    async fn open(&self, credential: Credential) -> Result<Arc<Session>, Error> {
        let session = Arc::new(Session {
            endpoint: Endpoint::new(&credential.url, credential.socket.clone())?,
            credential,
            id: Mutex::default(),
            protocol_version: OnceLock::new(),
            init_result: OnceLock::new(),
        });
        let params = lock(&self.init_params).clone();
        let initialize = json!({ "jsonrpc": "2.0", "id": INITIALIZE_ID, "method": "initialize", "params": params });
        let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        let handshake = async {
            let init_id = RequestId::String(INITIALIZE_ID.to_owned());
            let result = self
                .exchange(
                    &session,
                    initialize.to_string().into_bytes(),
                    Some(&init_id),
                    true,
                )
                .await?
                .ok_or_else(|| Error::Failed(NO_REPLY.to_owned()))?;
            if let Some(version) = protocol_version(&result) {
                let _ = session.protocol_version.set(version);
            }
            let _ = session.init_result.set(result);
            self.exchange(&session, initialized.to_string().into_bytes(), None, false)
                .await
        };
        tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake)
            .await
            .map_err(|_| {
                Error::Failed("T3 Code did not finish opening an MCP session.".to_owned())
            })??;
        Ok(session)
    }

    /// With `capture`, the result for `expect` is returned instead of relayed to Codex.
    async fn exchange(
        &self,
        session: &Arc<Session>,
        body: Vec<u8>,
        expect: Option<&RequestId>,
        capture: bool,
    ) -> Result<Option<Box<RawValue>>, Error> {
        let session_id = lock(&session.id).clone();
        let mut headers = vec![
            ("content-type", "application/json"),
            ("accept", "application/json, text/event-stream"),
            ("authorization", session.credential.authorization.as_str()),
        ];
        if let Some(session_id) = &session_id {
            headers.push(("mcp-session-id", session_id));
        }
        if let Some(version) = session.protocol_version.get() {
            headers.push(("mcp-protocol-version", version));
        }
        let mut response = http::send(&session.endpoint, Method::POST, &headers, body).await?;
        if let Some(id) = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
        {
            *lock(&session.id) = Some(id.to_owned());
        }
        let status = response.status().as_u16();
        if matches!(status, 401 | 404) {
            return Err(Error::Stale(status));
        }
        if !response.status().is_success() {
            return Err(Error::Failed(format!(
                "T3 Code MCP endpoint responded with HTTP {status}."
            )));
        }
        let mut relay = Relay {
            connection: self,
            session,
            expect,
            capture,
            answered: false,
            captured: None,
        };
        if !matches!(status, 202 | 204) {
            let is_event_stream = response
                .headers()
                .get(hyper::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.contains("text/event-stream"));
            let body = response.body_mut();
            if is_event_stream {
                let mut events = EventStream::default();
                while let Some(chunk) = http::next_chunk(body).await? {
                    for data in events.push(&chunk) {
                        relay.payload(&data)?;
                    }
                }
            } else {
                let mut whole = Vec::new();
                while let Some(chunk) = http::next_chunk(body).await? {
                    whole.extend_from_slice(&chunk);
                }
                if !whole.trim_ascii().is_empty() {
                    relay.payload(&whole)?;
                }
            }
        }
        if expect.is_some() && !relay.answered {
            return Err(Error::Failed(NO_REPLY.to_owned()));
        }
        match relay.captured {
            Some(Err(error)) => Err(Error::Failed(format!(
                "T3 Code refused the MCP session: {error}"
            ))),
            Some(Ok(result)) => Ok(Some(result)),
            None => Ok(None),
        }
    }

    /// Best effort: T3 Code keeps a session until it is deleted or T3 Code restarts.
    async fn end_sessions(&self) {
        let sessions: Vec<_> = lock(&self.sessions)
            .values()
            .filter_map(|cell| cell.get().cloned())
            .collect();
        let mut ending = JoinSet::new();
        for session in sessions {
            let Some(session_id) = lock(&session.id).clone() else {
                continue;
            };
            ending.spawn(async move {
                let mut headers = vec![
                    ("authorization", session.credential.authorization.as_str()),
                    ("mcp-session-id", session_id.as_str()),
                ];
                if let Some(version) = session.protocol_version.get() {
                    headers.push(("mcp-protocol-version", version));
                }
                let delete = http::send(&session.endpoint, Method::DELETE, &headers, Vec::new());
                let _ = tokio::time::timeout(END_SESSION_TIMEOUT, delete).await;
            });
        }
        ending.join_all().await;
    }
}

/// Everything else in a message from T3 Code passes through verbatim.
#[derive(Deserialize)]
struct ServerMessage<'a> {
    id: Option<RequestId>,
    method: Option<IgnoredAny>,
    #[serde(borrow)]
    result: Option<&'a RawValue>,
    #[serde(borrow)]
    error: Option<&'a RawValue>,
}

struct Relay<'a> {
    connection: &'a Connection,
    session: &'a Arc<Session>,
    expect: Option<&'a RequestId>,
    capture: bool,
    answered: bool,
    captured: Option<Result<Box<RawValue>, String>>,
}

impl Relay<'_> {
    fn payload(&mut self, payload: &[u8]) -> Result<(), Error> {
        let unreadable = |_| Error::Failed("T3 Code sent an unreadable MCP message.".to_owned());
        let entries: Vec<&RawValue> = if payload.trim_ascii_start().starts_with(b"[") {
            serde_json::from_slice(payload).map_err(unreadable)?
        } else {
            vec![serde_json::from_slice(payload).map_err(unreadable)?]
        };
        for entry in entries {
            let message: ServerMessage = serde_json::from_str(entry.get()).map_err(unreadable)?;
            match (message.id, message.method) {
                (Some(id), None) if Some(&id) == self.expect => {
                    self.answered = true;
                    if self.capture {
                        self.captured = Some(match (message.result, message.error) {
                            (Some(result), _) => Ok(result.to_owned()),
                            (None, error) => {
                                Err(error.map_or_else(String::new, |error| error.get().to_owned()))
                            }
                        });
                        continue;
                    }
                }
                (Some(id), Some(_)) => {
                    lock(&self.connection.server_requests).insert(id, Arc::clone(self.session));
                }
                _ => {}
            }
            self.connection.send(one_line(entry.get()));
        }
        Ok(())
    }
}

/// Codex reads one message per line. Raw CR and LF can appear in JSON only as whitespace between
/// tokens (inside strings they must be escaped), so removing them never changes a message.
fn one_line(json: &str) -> String {
    json.chars().filter(|c| !matches!(c, '\r' | '\n')).collect()
}

fn protocol_version(init_result: &RawValue) -> Option<String> {
    #[derive(Deserialize)]
    struct Probe {
        #[serde(rename = "protocolVersion")]
        protocol_version: Option<Value>,
    }
    match serde_json::from_str::<Probe>(init_result.get())
        .ok()?
        .protocol_version?
    {
        Value::String(version) if !version.is_empty() => Some(version),
        _ => None,
    }
}
