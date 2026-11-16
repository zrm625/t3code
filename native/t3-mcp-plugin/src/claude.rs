use crate::child::{self, Stdin};
use crate::credentials::{Credential, Credentials};
use crate::proxy::Identity;
use serde_json::Value;
use std::borrow::Cow;
use std::ffi::OsString;
use std::path::Path;
use std::sync::Arc;

const REAL_CLAUDE_ENV: &str = "T3_CLAUDE_REAL";
const T3_SERVER: &str = "t3-code";
// Claude names a plugin's server `plugin:<plugin>:<server>` and its tools
// `mcp__plugin_<plugin>_<server>__<tool>`; T3 Code knows them as `t3-code` and `mcp__t3-code__*`.
const T3_TOOLS: &[u8] = b"mcp__t3-code__";
const PLUGIN_TOOLS: &[u8] = b"mcp__plugin_t3-code_t3-code__";
const T3_SERVER_NAME: &[u8] = b"\"t3-code\"";
const PLUGIN_SERVER_NAME: &[u8] = b"\"plugin:t3-code:t3-code\"";

pub fn run(args: Vec<OsString>) -> crate::Result<i32> {
    let real = child::real_binary("claude", REAL_CLAUDE_ENV)?;
    if !is_sdk_session(&args) {
        return child::passthrough(&real, &args);
    }
    Ok(crate::runtime()?.block_on(session(&real, &args))?)
}

/// The Agent SDK runs Claude with stream-json input; anything else (`--version`) is not a session.
fn is_sdk_session(args: &[OsString]) -> bool {
    args.windows(2)
        .any(|pair| pair[0] == "--input-format" && pair[1] == "stream-json")
}

async fn session(real: &Path, args: &[OsString]) -> std::io::Result<i32> {
    // T3 Code pre-approves its tools by name (`--allowedTools`), so the names follow the plugin.
    let args: Vec<OsString> = args.iter().map(to_plugin_names_arg).collect();
    let (mut process, listener) = child::spawn(real, &args)?;
    let stdin = Arc::new(Stdin::start(process.stdin.take().expect("piped stdin")));
    let credentials = Arc::new(Credentials::without_parents());

    let t3_socket = child::t3_socket();
    let from_t3 = Arc::clone(&credentials);
    child::read_from_t3(stdin, move |line| {
        let line = take_t3_server_from(&line, &from_t3, t3_socket.as_deref()).unwrap_or(line);
        replace(&line, T3_TOOLS, PLUGIN_TOOLS).into_owned()
    });
    let stdout = process.stdout.take().expect("piped stdout");
    let to_t3 = child::relay_to_t3(stdout, |line| Some(to_t3_names(line)));
    child::serve(process, listener, credentials, Identity::Process, to_t3).await
}

/// T3 Code sends its MCP server, with this thread's credential, in an `mcp_set_servers` control
/// request (the Agent SDK's `setMcpServers`), again whenever it rotates the credential. The admin
/// policy refuses servers added that way, so it moves into the plugin. `None` leaves the line.
fn take_t3_server_from(
    line: &[u8],
    credentials: &Credentials,
    t3_socket: Option<&Path>,
) -> Option<Vec<u8>> {
    if !contains(line, b"mcp_set_servers") {
        return None;
    }
    let mut message: Value = serde_json::from_slice(line).ok()?;
    let is_set_servers =
        message["type"] == "control_request" && message["request"]["subtype"] == "mcp_set_servers";
    let servers = message
        .pointer_mut("/request/servers")
        .filter(|_| is_set_servers)?
        .as_object_mut()?;
    let server = servers.get(T3_SERVER)?;
    let authorization = server["headers"].as_object().and_then(|headers| {
        headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
            .and_then(|(_, value)| value.as_str())
    });
    let (Some(url), Some(authorization)) = (server["url"].as_str(), authorization) else {
        // Passed on unchanged, so the policy's refusal reaches T3 Code as it would without this.
        eprintln!(
            "t3-claude: T3 Code sent its MCP server in a form t3-claude does not understand \
             (expected `url` and an `Authorization` header). Update t3-claude to match this \
             T3 Code version."
        );
        return None;
    };
    credentials.set_newest(Credential {
        url: url.to_owned(),
        authorization: authorization.to_owned(),
        socket: t3_socket.map(Path::to_path_buf),
    });
    servers.remove(T3_SERVER);
    let mut rewritten = message.to_string().into_bytes();
    rewritten.push(b'\n');
    Some(rewritten)
}

fn to_plugin_names_arg(arg: &OsString) -> OsString {
    let Some(text) = arg.to_str() else {
        return arg.clone();
    };
    match replace(text.as_bytes(), T3_TOOLS, PLUGIN_TOOLS) {
        Cow::Borrowed(_) => arg.clone(),
        Cow::Owned(bytes) => String::from_utf8(bytes).map_or_else(|_| arg.clone(), OsString::from),
    }
}

/// T3 Code recognizes its own tools and server by name in Claude's stream.
fn to_t3_names(line: &[u8]) -> Cow<'_, [u8]> {
    match replace(line, PLUGIN_TOOLS, T3_TOOLS) {
        Cow::Borrowed(line) => replace(line, PLUGIN_SERVER_NAME, T3_SERVER_NAME),
        Cow::Owned(line) => {
            Cow::Owned(replace(&line, PLUGIN_SERVER_NAME, T3_SERVER_NAME).into_owned())
        }
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// The names are plain ASCII, which JSON never escapes, so a byte replace is exact.
fn replace<'a>(line: &'a [u8], from: &[u8], to: &[u8]) -> Cow<'a, [u8]> {
    if !contains(line, from) {
        return Cow::Borrowed(line);
    }
    let mut out = Vec::with_capacity(line.len() + 32);
    let mut rest = line;
    while let Some(at) = rest.windows(from.len()).position(|window| window == from) {
        out.extend_from_slice(&rest[..at]);
        out.extend_from_slice(to);
        rest = &rest[at + from.len()..];
    }
    out.extend_from_slice(rest);
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn moves_t3_code_out_of_set_servers() {
        let credentials = Credentials::without_parents();
        let mut servers: Value =
            serde_json::from_str(include_str!("../fixtures/claude-mcp-servers.json")).unwrap();
        servers["other"] = json!({ "type": "stdio", "command": "x" });
        let set = json!({ "type": "control_request", "request_id": "r1",
            "request": { "subtype": "mcp_set_servers", "servers": servers } });
        let rewritten = take_t3_server_from(set.to_string().as_bytes(), &credentials, None);
        let rewritten: Value = serde_json::from_slice(&rewritten.unwrap()).unwrap();
        assert_eq!(
            rewritten["request"]["servers"],
            json!({ "other": { "type": "stdio", "command": "x" } })
        );
        assert_eq!(
            credentials.newest(),
            Some(Credential {
                url: "http://127.0.0.1:3773/mcp".into(),
                authorization: "Bearer token".into(),
                socket: None,
            })
        );
        let prompt = br#"{"type":"user","message":"mcp_set_servers"}"#;
        assert_eq!(take_t3_server_from(prompt, &credentials, None), None);
    }

    #[test]
    fn maps_tool_and_server_names_both_ways() {
        let from_claude = br#"{"tool":"mcp__plugin_t3-code_t3-code__t3_thread_wait","server":"plugin:t3-code:t3-code","other":"mcp__x__y"}"#;
        assert_eq!(
            to_t3_names(from_claude).as_ref(),
            br#"{"tool":"mcp__t3-code__t3_thread_wait","server":"t3-code","other":"mcp__x__y"}"#
        );
        assert_eq!(
            to_plugin_names_arg(&OsString::from("Read,mcp__t3-code__*")),
            OsString::from("Read,mcp__plugin_t3-code_t3-code__*")
        );
    }
}
