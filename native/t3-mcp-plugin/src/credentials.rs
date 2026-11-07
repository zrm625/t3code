use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::watch;

/// Subagents rarely nest; this only stops a cycle from looping forever.
const MAX_PARENT_DEPTH: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Credential {
    pub url: String,
    pub authorization: String,
    /// Reach `url` through this socket instead of TCP (T3 Code's `T3CODE_MCP_SOCKET`).
    pub socket: Option<PathBuf>,
}

/// A thread's credential, or why T3 Code's config for it could not be read.
pub type Binding = Result<Credential, String>;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(i64),
    String(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ThreadId(pub String);

pub type ParentLookup = Box<
    dyn Fn(ThreadId) -> Pin<Box<dyn Future<Output = Result<Option<ThreadId>, String>> + Send>>
        + Send
        + Sync,
>;

#[derive(Default)]
struct State {
    threads: HashMap<ThreadId, Binding>,
    /// Subagent -> the T3 Code thread it acts as. Its credential is read from there, so it follows
    /// the parent's rotation.
    parents: HashMap<ThreadId, ThreadId>,
    /// Thread requests awaiting Codex's reply, which names the thread.
    pending: HashMap<RequestId, Binding>,
    /// Credentials for opening a session before any thread is known, newest last.
    recent: Vec<Credential>,
}

pub struct Credentials {
    state: Mutex<State>,
    parent_of: ParentLookup,
    /// Bumped whenever a credential arrives, for callers waiting on the first one.
    arrived: watch::Sender<u64>,
}

impl Credentials {
    pub fn new(parent_of: ParentLookup) -> Self {
        Self {
            state: Mutex::default(),
            parent_of,
            arrived: watch::Sender::new(0),
        }
    }

    /// For a CLI whose subagents share its process, so no thread lineage is needed.
    pub fn without_parents() -> Self {
        Self::new(Box::new(|_| Box::pin(async { Ok(None) })))
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Called before the thread request reaches Codex, so a bridge Codex starts for it finds a
    /// credential.
    pub fn begin(&self, request: RequestId, binding: Binding) {
        if let Ok(credential) = &binding {
            self.set_newest(credential.clone());
        }
        self.state().pending.insert(request, binding);
    }

    /// A CLI process acts as one thread; T3 Code replaces its credential when it rotates it.
    pub fn set_newest(&self, credential: Credential) {
        let mut state = self.state();
        state.recent.retain(|known| known != &credential);
        state.recent.push(credential);
        drop(state);
        self.arrived.send_modify(|count| *count += 1);
    }

    /// Records Codex's reply to a thread request. `None` means the request failed; T3 Code may
    /// revoke its credential, so it is no longer offered.
    pub fn finish(&self, request: &RequestId, thread: Option<ThreadId>) {
        let mut state = self.state();
        let Some(binding) = state.pending.remove(request) else {
            return;
        };
        match thread {
            Some(thread) => {
                state.threads.insert(thread, binding);
            }
            None => {
                if let Ok(credential) = &binding {
                    state.recent.retain(|known| known != credential);
                }
            }
        }
    }

    pub fn is_waiting(&self) -> bool {
        !self.state().pending.is_empty()
    }

    /// Codex: for initialize and discovery, before any thread is known. Claude: the process's own.
    /// `None`: T3 Code gave none, so it did not start this session.
    pub fn newest(&self) -> Option<Credential> {
        self.state().recent.last().cloned()
    }

    /// Claude starts plugin servers before T3 Code sends the credential, so they wait for it.
    pub async fn wait_for_newest(&self, timeout: Duration) -> Option<Credential> {
        let mut arrived = self.arrived.subscribe();
        let wait = async {
            loop {
                if let Some(credential) = self.newest() {
                    return credential;
                }
                if arrived.changed().await.is_err() {
                    std::future::pending::<()>().await;
                }
            }
        };
        tokio::time::timeout(timeout, wait).await.ok()
    }

    /// The credential a Codex thread acts with. A subagent T3 Code never saw acts as the T3 Code
    /// thread it descends from.
    pub async fn for_thread(&self, thread: &ThreadId) -> Binding {
        let mut current = self
            .state()
            .parents
            .get(thread)
            .cloned()
            .unwrap_or_else(|| thread.clone());
        for _ in 0..MAX_PARENT_DEPTH {
            let found = self.state().threads.get(&current).cloned();
            if let Some(binding) = found {
                if &current != thread {
                    self.state().parents.insert(thread.clone(), current);
                }
                return binding;
            }
            match (self.parent_of)(current.clone()).await? {
                Some(parent) => current = parent,
                None => break,
            }
        }
        Err(format!(
            "Codex thread {} has no T3 Code credential.",
            thread.0
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credential(token: &str) -> Credential {
        Credential {
            url: "http://h/mcp".into(),
            authorization: format!("Bearer {token}"),
            socket: None,
        }
    }

    fn thread(id: &str) -> ThreadId {
        ThreadId(id.into())
    }

    fn lineage() -> Credentials {
        Credentials::new(Box::new(|id: ThreadId| {
            let parent = match id.0.as_str() {
                "grandchild" => Some(thread("child")),
                "child" => Some(thread("parent")),
                _ => None,
            };
            Box::pin(async move { Ok(parent) })
        }))
    }

    #[tokio::test]
    async fn subagents_follow_their_t3_thread_through_rotation() {
        let credentials = lineage();
        credentials.begin(RequestId::Number(1), Ok(credential("p1")));
        credentials.finish(&RequestId::Number(1), Some(thread("parent")));
        assert_eq!(
            credentials.for_thread(&thread("grandchild")).await,
            Ok(credential("p1"))
        );

        credentials.begin(RequestId::Number(2), Ok(credential("p2")));
        credentials.finish(&RequestId::Number(2), Some(thread("parent")));
        assert_eq!(
            credentials.for_thread(&thread("grandchild")).await,
            Ok(credential("p2"))
        );
        assert!(credentials.for_thread(&thread("stranger")).await.is_err());
    }

    #[tokio::test]
    async fn failed_thread_requests_leave_bootstrap() {
        let credentials = lineage();
        credentials.begin(RequestId::Number(1), Ok(credential("a")));
        credentials.begin(RequestId::String("x".into()), Ok(credential("b")));
        assert_eq!(credentials.newest(), Some(credential("b")));
        credentials.finish(&RequestId::Number(1), Some(thread("a")));
        credentials.finish(&RequestId::String("x".into()), None);
        assert_eq!(credentials.newest(), Some(credential("a")));
        assert!(!credentials.is_waiting());
    }

    #[tokio::test]
    async fn waits_for_a_credential_that_arrives_late() {
        let credentials = std::sync::Arc::new(Credentials::without_parents());
        let late = std::sync::Arc::clone(&credentials);
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            late.set_newest(credential("late"));
        });
        let waited = credentials.wait_for_newest(Duration::from_secs(5)).await;
        assert_eq!(waited, Some(credential("late")));
    }
}
