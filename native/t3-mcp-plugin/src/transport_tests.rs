use crate::credentials::{Credential, Credentials, RequestId};
use crate::proxy::{Identity, serve};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::Notify;

/// One POST from the proxy: (raw head, JSON body).
async fn read_request(stream: &mut tokio::net::TcpStream) -> (String, Value) {
    let mut reader = BufReader::new(stream);
    let mut head = String::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        if line == "\r\n" {
            break;
        }
        head.push_str(&line);
    }
    let length = head
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|n| n.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await.unwrap();
    (head, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

/// T3 Code asks the client something mid-handshake and holds the initialize reply until the
/// answer arrives. The answer must reach the session still being opened.
#[tokio::test]
async fn relays_a_server_request_during_the_handshake() {
    let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", upstream.local_addr().unwrap());
    let answered = Arc::new(Notify::new());
    let server_answered = Arc::clone(&answered);
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = upstream.accept().await.unwrap();
            let answered = Arc::clone(&server_answered);
            tokio::spawn(async move {
                let (_, body) = read_request(&mut stream).await;
                match body["method"].as_str() {
                    Some("initialize") => {
                        let ping = json!({ "jsonrpc": "2.0", "id": "s1", "method": "ping" });
                        stream.write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nmcp-session-id: s\r\n\r\ndata: {ping}\n\n").as_bytes()).await.unwrap();
                        answered.notified().await;
                        let result = json!({ "jsonrpc": "2.0", "id": body["id"], "result": { "protocolVersion": "2025-06-18", "serverInfo": { "name": "t3" } } });
                        let _ = stream
                            .write_all(format!("data: {result}\n\n").as_bytes())
                            .await;
                    }
                    _ => {
                        if body["id"] == "s1" {
                            answered.notify_one();
                        }
                        let _ = stream
                            .write_all(b"HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\n\r\n")
                            .await;
                    }
                }
            });
        }
    });

    let credentials = Arc::new(Credentials::new(Box::new(|_| Box::pin(async { Ok(None) }))));
    let credential = Credential {
        url,
        authorization: "Bearer t".into(),
        socket: None,
    };
    credentials.begin(RequestId::Number(0), Ok(credential));
    let (codex, bridge) = tokio::io::duplex(64 * 1024);
    tokio::spawn(serve(bridge, credentials, Identity::Thread));
    let (reader, mut writer) = tokio::io::split(codex);
    let mut lines = BufReader::new(reader).lines();
    writer
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n")
        .await
        .unwrap();

    let ping: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    assert_eq!(ping["method"], "ping");
    writer
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"s1\",\"result\":{}}\n")
        .await
        .unwrap();
    let reply: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    assert_eq!(
        (
            reply["id"].clone(),
            reply["result"]["serverInfo"]["name"].clone()
        ),
        (json!(1), json!("t3"))
    );
}
