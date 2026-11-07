//! Lets T3 Code's MCP tools reach Codex through the T3 Code plugin where an admin policy allows MCP
//! servers only from plugins. `t3-codex app-server` replaces Codex for T3 Code; `t3-codex
//! mcp-bridge` is the plugin's server; anything else runs the real Codex.

mod bridge;
mod credentials;
mod http;
mod ipc;
mod proxy;
#[cfg(test)]
mod transport_tests;
mod wrapper;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn run() -> Result<i32> {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    match args.first() {
        Some(mode) if mode == "mcp-bridge" => bridge::run(),
        _ => wrapper::run(args),
    }
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
