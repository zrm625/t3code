use crate::child::{self, Stdin};
use crate::credentials::{Binding, Credential, Credentials, ParentLookup, RequestId, ThreadId};
use crate::proxy::Identity;
use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use std::borrow::Cow;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::oneshot;

const REAL_CODEX_ENV: &str = "T3_CODEX_REAL";
const T3_SERVERS: [&str; 2] = ["t3-code", "t3-code-direct"];
const THREAD_METHODS: [&str; 3] = ["thread/start", "thread/resume", "thread/fork"];
/// Keeps the wrapper's endpoint out of agent shell commands; bridges get it through `env_vars`.
const SHELL_FILTER_KEY: &str = "shell_environment_policy.filters.T3_MCP_*";
const READ_TIMEOUT: Duration = Duration::from_secs(10);

pub fn run(args: Vec<OsString>) -> crate::Result<i32> {
    let real = child::real_binary("codex", REAL_CODEX_ENV)?;
    if args.first().is_none_or(|arg| arg != "app-server") {
        return child::passthrough(&real, &args);
    }
    Ok(child::runtime()?.block_on(app_server(&real, &args))?)
}

async fn app_server(real: &Path, args: &[OsString]) -> std::io::Result<i32> {
    let (mut process, listener) = child::spawn(real, args)?;
    let codex = Arc::new(Codex {
        stdin: Arc::new(Stdin::start(process.stdin.take().expect("piped stdin"))),
        replies: Mutex::default(),
        next_id: AtomicU64::new(1),
    });
    let lookup = Arc::clone(&codex);
    let parent_of: ParentLookup = Box::new(move |thread| {
        let codex = Arc::clone(&lookup);
        Box::pin(async move { codex.parent_of(thread).await })
    });
    let credentials = Arc::new(Credentials::new(parent_of));

    let t3_socket = child::t3_socket();
    let from_t3 = Arc::clone(&credentials);
    child::read_from_t3(Arc::clone(&codex.stdin), move |line| {
        take_t3_servers_from(&line, &from_t3, t3_socket.as_deref()).unwrap_or(line)
    });
    let (to_t3, replies) = (Arc::clone(&credentials), Arc::clone(&codex));
    let stdout = process.stdout.take().expect("piped stdout");
    let to_t3 = child::relay_to_t3(stdout, move |line| {
        (!note_reply(line, &replies, &to_t3)).then_some(Cow::Borrowed(line))
    });
    child::serve(process, listener, credentials, Identity::Thread, to_t3).await
}

struct Codex {
    stdin: Arc<Stdin>,
    replies: Mutex<HashMap<RequestId, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Codex {
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
        self.stdin.send(line);
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
        let codex = Codex {
            stdin: Arc::new(Stdin::detached()),
            replies: Mutex::default(),
            next_id: AtomicU64::new(1),
        };
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
}
