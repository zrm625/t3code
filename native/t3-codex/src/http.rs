use crate::ipc::{self, Stream};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, Uri};
use hyper_util::rt::TokioIo;
use std::io;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Endpoint {
    authority: String,
    /// `authority` with the default port filled in, for connecting over TCP.
    address: String,
    path: String,
    socket: Option<PathBuf>,
}

impl Endpoint {
    pub fn new(url: &str, socket: Option<PathBuf>) -> Result<Self, String> {
        let invalid = || format!("T3 Code gave an MCP URL t3-codex cannot use: {url}");
        let uri: Uri = url.parse().map_err(|_| invalid())?;
        let authority = uri
            .authority()
            .filter(|_| uri.scheme_str() == Some("http"))
            .ok_or_else(invalid)?;
        Ok(Self {
            address: format!(
                "{}:{}",
                authority.host(),
                authority.port_u16().unwrap_or(80)
            ),
            authority: authority.to_string(),
            path: uri
                .path_and_query()
                .map_or_else(|| "/".to_owned(), ToString::to_string),
            socket,
        })
    }
}

pub async fn send(
    endpoint: &Endpoint,
    method: Method,
    headers: &[(&str, &str)],
    body: Vec<u8>,
) -> Result<Response<Incoming>, String> {
    let request = headers
        .iter()
        .fold(
            Request::builder()
                .method(method)
                .uri(&endpoint.path)
                .header(hyper::header::HOST, &endpoint.authority),
            |request, (name, value)| request.header(*name, *value),
        )
        .body(Full::new(Bytes::from(body)))
        .map_err(|error| format!("T3 Code MCP request is not valid: {error}"))?;
    match &endpoint.socket {
        Some(socket) => exchange(ipc::connect(socket.as_os_str()).await, request).await,
        None => {
            exchange(
                tokio::net::TcpStream::connect(&endpoint.address).await,
                request,
            )
            .await
        }
    }
}

async fn exchange(
    connection: io::Result<impl Stream>,
    request: Request<Full<Bytes>>,
) -> Result<Response<Incoming>, String> {
    let connection = connection.map_err(|error| format!("cannot reach T3 Code: {error}"))?;
    let (mut sender, driver) = hyper::client::conn::http1::handshake(TokioIo::new(connection))
        .await
        .map_err(|error| format!("cannot reach T3 Code: {error}"))?;
    tokio::spawn(driver);
    sender
        .send_request(request)
        .await
        .map_err(|error| format!("T3 Code MCP request failed: {error}"))
}

/// `None` at the end of the body. A body cut short is an error.
pub async fn next_chunk(body: &mut Incoming) -> Result<Option<Bytes>, String> {
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|error| format!("T3 Code MCP response failed: {error}"))?;
        if let Ok(data) = frame.into_data() {
            return Ok(Some(data));
        }
    }
    Ok(None)
}

#[derive(Default)]
pub struct EventStream {
    line: Vec<u8>,
    data: Option<Vec<u8>>,
    /// The last byte ended a line with CR, so an LF right after it (even in the next chunk) belongs
    /// to the same line ending.
    after_cr: bool,
}

impl EventStream {
    /// An event cut off by the end of the stream is never returned.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        let mut events = Vec::new();
        for &byte in chunk {
            let continues_crlf = self.after_cr && byte == b'\n';
            self.after_cr = byte == b'\r';
            match byte {
                _ if continues_crlf => {}
                b'\r' | b'\n' => self.end_line(&mut events),
                _ => self.line.push(byte),
            }
        }
        events
    }

    fn end_line(&mut self, events: &mut Vec<Vec<u8>>) {
        let line = std::mem::take(&mut self.line);
        if line.is_empty() {
            events.extend(self.data.take());
            return;
        }
        let (field, value) = match line.iter().position(|&byte| byte == b':') {
            Some(colon) => {
                let value = &line[colon + 1..];
                (&line[..colon], value.strip_prefix(b" ").unwrap_or(value))
            }
            None => (&line[..], &[][..]),
        };
        if field == b"data" {
            match &mut self.data {
                Some(data) => {
                    data.push(b'\n');
                    data.extend_from_slice(value);
                }
                None => self.data = Some(value.to_vec()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_endpoints() {
        let endpoint = Endpoint::new("http://127.0.0.1:4/mcp?x=1", None).unwrap();
        assert_eq!(
            (endpoint.authority.as_str(), endpoint.path.as_str()),
            ("127.0.0.1:4", "/mcp?x=1")
        );
        assert_eq!(
            Endpoint::new("http://[::1]/mcp", None).unwrap().address,
            "[::1]:80"
        );
        assert!(Endpoint::new("https://h/mcp", None).is_err());
        assert!(Endpoint::new("not a url", None).is_err());
    }

    #[test]
    fn decodes_events_as_soon_as_they_end() {
        let mut stream = EventStream::default();
        let mut push = |chunk: &str| -> Vec<String> {
            let events = stream.push(chunk.as_bytes());
            events
                .into_iter()
                .map(|data| String::from_utf8(data).unwrap())
                .collect()
        };
        assert!(push("event: message\r").is_empty());
        assert!(push("\ndata: {\"a\":").is_empty());
        assert_eq!(push("1}\r\n\r\n: comment\n"), [r#"{"a":1}"#]);
        // A lone CR ends a line at once: a stream held open must not wait for another byte.
        assert_eq!(push("data: x\rdata: y\r\r"), ["x\ny"]);
        assert!(push("data: cut off").is_empty());
    }
}
