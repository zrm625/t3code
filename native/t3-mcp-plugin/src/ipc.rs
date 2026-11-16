use std::collections::hash_map::RandomState;
use std::ffi::{OsStr, OsString};
use std::hash::{BuildHasher, Hasher};
use std::io;
use tokio::io::{AsyncRead, AsyncWrite};

/// Names the wrapper's endpoint for the bridges Codex starts. Plugin `env_vars` pass it through.
pub const ENV: &str = "T3_MCP_BRIDGE";

pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send + 'static {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + 'static> Stream for T {}

/// Unguessable without extra dependencies: `RandomState` is seeded from the OS.
fn random_suffix() -> String {
    format!("{:016x}", RandomState::new().build_hasher().finish())
}

#[cfg(unix)]
pub use unix::{Listener, connect};
#[cfg(windows)]
pub use windows::{Listener, connect};

#[cfg(unix)]
mod unix {
    use super::*;
    use std::fs::{self, DirBuilder};
    use std::os::unix::fs::DirBuilderExt;
    use std::path::{Path, PathBuf};
    use tokio::net::{UnixListener, UnixStream};

    pub struct Listener {
        listener: UnixListener,
        dir: PathBuf,
        pub name: OsString,
    }

    impl Listener {
        /// Binds in a fresh owner-only directory, so no other user can connect.
        pub fn bind() -> io::Result<Self> {
            let base = std::env::var_os("XDG_RUNTIME_DIR")
                .filter(|dir| !dir.is_empty())
                .map_or_else(std::env::temp_dir, PathBuf::from);
            remove_stale_dirs(&base);
            let dir = base.join(format!(
                "t3-codex-{}-{}",
                std::process::id(),
                random_suffix()
            ));
            DirBuilder::new().mode(0o700).create(&dir)?;
            let path = dir.join("bridge.sock");
            let listener = UnixListener::bind(&path).inspect_err(|_| {
                let _ = fs::remove_dir_all(&dir);
            })?;
            Ok(Self {
                listener,
                dir,
                name: path.into_os_string(),
            })
        }

        pub async fn accept(&mut self) -> io::Result<impl Stream> {
            Ok(self.listener.accept().await?.0)
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    pub async fn connect(name: &OsStr) -> io::Result<impl Stream> {
        UnixStream::connect(name).await
    }

    /// Removes directories whose wrapper is gone, as after SIGKILL.
    fn remove_stale_dirs(base: &Path) {
        let Ok(entries) = fs::read_dir(base) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(pid) = name
                .to_str()
                .and_then(|name| name.strip_prefix("t3-codex-"))
                .and_then(|rest| rest.split('-').next())
                .and_then(|pid| pid.parse().ok())
                .and_then(rustix::process::Pid::from_raw)
            else {
                continue;
            };
            let gone = rustix::process::test_kill_process(pid) == Err(rustix::io::Errno::SRCH);
            if gone {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::time::Duration;
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};

    const ERROR_PIPE_BUSY: i32 = 231;

    /// Named pipes need no cleanup: they vanish with their last handle.
    pub struct Listener {
        next: NamedPipeServer,
        pub name: OsString,
    }

    impl Listener {
        pub fn bind() -> io::Result<Self> {
            let name = OsString::from(format!(
                r"\\.\pipe\t3-codex-{}-{}",
                std::process::id(),
                random_suffix()
            ));
            let next = ServerOptions::new()
                .first_pipe_instance(true)
                .reject_remote_clients(true)
                .create(&name)?;
            Ok(Self { next, name })
        }

        pub async fn accept(&mut self) -> io::Result<impl Stream> {
            self.next.connect().await?;
            let following = ServerOptions::new()
                .reject_remote_clients(true)
                .create(&self.name)?;
            Ok(std::mem::replace(&mut self.next, following))
        }
    }

    pub async fn connect(name: &OsStr) -> io::Result<impl Stream> {
        loop {
            match ClientOptions::new().open(name) {
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                result => return result,
            }
        }
    }
}
