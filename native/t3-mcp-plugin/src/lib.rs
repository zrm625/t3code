//! Lets T3 Code's MCP tools reach Codex and Claude Code through T3 Code plugins where an admin
//! policy allows MCP servers only from plugins. `t3-codex` and `t3-claude` stand in for each CLI;
//! `<binary> mcp-bridge` is the plugin's server.

mod bridge;
mod child;
pub mod claude;
pub mod codex;
mod credentials;
mod http;
mod ipc;
mod proxy;

use std::ffi::OsString;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub fn main(wrapper: fn(Vec<OsString>) -> Result<i32>) -> ! {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let outcome = match args.first() {
        Some(mode) if mode == "mcp-bridge" => bridge::run(),
        _ => wrapper(args),
    };
    match outcome {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
