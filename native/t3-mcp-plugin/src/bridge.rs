use crate::credentials::RequestId;
use crate::ipc;
use serde::Deserialize;
use serde_json::{Value, json};
use std::ffi::OsStr;
use std::io::{BufRead, Read, Write};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

const DEFAULT_PROTOCOL_VERSION: &str = "2025-06-18";

/// Pipes stdio to the wrapper that started this Codex. Without one, T3 Code did not start this
/// session, so it answers as an MCP server with no tools.
pub fn run() -> crate::Result<i32> {
    let Some(name) = std::env::var_os(ipc::ENV).filter(|name| !name.is_empty()) else {
        offline();
        return Ok(0);
    };
    crate::runtime()?.block_on(pipe(&name))?;
    Ok(0)
}

/// Runs until either side closes: Codex closing stdin asks the server to exit (MCP stdio).
async fn pipe(name: &OsStr) -> crate::Result<()> {
    let stream = ipc::connect(name)
        .await
        .map_err(|error| format!("cannot reach t3-codex: {error}"))?;
    let (mut from_wrapper, mut to_wrapper) = tokio::io::split(stream);
    // A plain thread, not tokio's stdin: that reads on a blocking thread the runtime cannot
    // cancel, so the runtime could never shut down while Codex keeps stdin open.
    let (stdin_chunks, mut requests) = mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut buffer = [0; 16 * 1024];
        while let Ok(read @ 1..) = stdin.read(&mut buffer) {
            if stdin_chunks.send(buffer[..read].to_vec()).is_err() {
                return;
            }
        }
    });
    let forward_requests = async {
        while let Some(chunk) = requests.recv().await {
            if to_wrapper.write_all(&chunk).await.is_err() {
                return;
            }
        }
    };
    let forward_replies = async {
        let mut stdout = tokio::io::stdout();
        let mut buffer = [0; 16 * 1024];
        while let Ok(read @ 1..) = from_wrapper.read(&mut buffer).await {
            if stdout.write_all(&buffer[..read]).await.is_err() || stdout.flush().await.is_err() {
                return;
            }
        }
    };
    tokio::select! {
        () = forward_requests => {}
        () = forward_replies => {}
    }
    Ok(())
}

fn offline() {
    #[derive(Deserialize)]
    struct Request {
        id: Option<RequestId>,
        method: Option<String>,
        #[serde(default)]
        params: Value,
    }
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout();
    let mut line = Vec::new();
    loop {
        line.clear();
        match stdin.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        // Notifications, replies and unreadable lines need no answer.
        let Ok(Request {
            id: Some(id),
            method: Some(method),
            params,
        }) = serde_json::from_slice(line.trim_ascii())
        else {
            continue;
        };
        let reply = offline_reply(&id, &method, &params);
        if writeln!(stdout, "{reply}")
            .and_then(|()| stdout.flush())
            .is_err()
        {
            return;
        }
    }
}

pub fn offline_reply(id: &RequestId, method: &str, params: &Value) -> String {
    let result = match method {
        "initialize" => json!({
            "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or(DEFAULT_PROTOCOL_VERSION),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "t3-code", "version": "offline" },
            "instructions": "T3 Code did not start this session, so T3 Code's tools are unavailable.",
        }),
        "tools/list" => json!({ "tools": [] }),
        "ping" => json!({}),
        _ => {
            return json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "T3 Code did not start this session." } })
                .to_string();
        }
    };
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}
