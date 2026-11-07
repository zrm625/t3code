use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Mutex;

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
}

impl Credentials {
    pub fn new(parent_of: ParentLookup) -> Self {
        Self {
            state: Mutex::default(),
            parent_of,
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Called before the thread request reaches Codex, so a bridge Codex starts for it finds a
    /// credential.
    pub fn begin(&self, request: RequestId, binding: Binding) {
        let mut state = self.state();
        if let Ok(credential) = &binding {
            state.recent.retain(|known| known != credential);
            state.recent.push(credential.clone());
        }
        state.pending.insert(request, binding);
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

    /// For initialize and discovery, before any thread is known. `None`: T3 Code did not start
    /// this session.
    pub fn bootstrap(&self) -> Option<Credential> {
        self.state().recent.last().cloned()
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
        assert_eq!(credentials.bootstrap(), Some(credential("b")));
        credentials.finish(&RequestId::Number(1), Some(thread("a")));
        credentials.finish(&RequestId::String("x".into()), None);
        assert_eq!(credentials.bootstrap(), Some(credential("a")));
        assert!(!credentials.is_waiting());
    }
}
