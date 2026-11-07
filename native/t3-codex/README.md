# t3-codex

Gives Codex sessions started by T3 Code access to T3 Code's MCP tools on machines where an admin
policy allows MCP servers only from approved plugins. T3 Code does not change; an optional
transport (below) is the only server addition.

Claude Code is not affected. T3 Code keeps connecting Claude Code to its tools the way it does
today.

## Pieces

```text
src/                                                Rust program, built as `t3-codex`
plugin/.agents/plugins/marketplace.json             Codex marketplace "t3" listing one plugin
plugin/plugins/t3-code/.codex-plugin/plugin.json    Plugin manifest
plugin/plugins/t3-code/.mcp.json                    The two MCP servers, both `t3-codex mcp-bridge`
plugin/policy/requirements.toml                     Example admin policy
```

`t3-codex` has two roles:

- `t3-codex app-server`: T3 Code runs it in place of `codex`.
- `t3-codex mcp-bridge`: Codex runs it from the plugin.

## How it works

T3 Code puts its MCP server in each thread's config, with that thread's own credential. The admin
policy refuses MCP servers from config, so on a managed machine those servers never load.
`t3-codex` moves them into the plugin:

1. T3 Code's Codex **binary path** setting points at `t3-codex`. T3 Code starts
   `t3-codex app-server` and talks to it exactly as it talks to Codex.
2. `t3-codex` starts the real `codex app-server` and relays every message. In `thread/start`,
   `thread/resume`, and `thread/fork` it removes the `t3-code` and `t3-code-direct` servers from
   the config and remembers each Codex thread's endpoint and credential. Other commands
   (`--version`, `exec`, `login`) run the real Codex directly.
3. Codex starts the plugin's `t3-codex mcp-bridge` for each thread. The bridge only pipes stdio to
   the wrapper over a private channel named by `T3_MCP_SOCKET` (a Unix socket, or a named pipe on
   Windows). The wrapper answers as the MCP server: each tool call goes to T3 Code with the
   calling thread's own credential (`_meta.threadId`), one MCP session per credential.
4. A subagent thread T3 Code never saw is resolved to its parent with `thread/read`, so it acts
   as its parent thread, the same as with today's injected config.

T3 Code sees exactly the per-thread credentials it issues today, so scopes, capabilities, idle
expiry, rotation on resume, and revocation all work unchanged.

`t3-code-direct` registers the same server a second time for `t3_thread_wait` only, so Codex
calls that blocking tool directly instead of from Code Mode, as T3 Code does today.

## Setup on a managed machine

1. Build and install `t3-codex`:

   ```sh
   cargo build --locked --release --manifest-path native/t3-codex/Cargo.toml
   ```

   It puts its own directory first on the app-server's `PATH`, so Codex finds it when the plugin
   runs `t3-codex mcp-bridge`.

2. Install the plugin:

   ```sh
   codex plugin marketplace add <path-or-git-url-of-native/t3-codex/plugin>
   codex plugin add t3-code@t3
   ```

3. In T3 Code, set **Settings → Providers → Codex → Binary path** to `t3-codex`. It finds the
   real `codex` on `PATH`, skipping itself; set `T3_CODEX_REAL` in the provider's environment to
   choose another.

`codex plugin remove t3-code@t3` and clearing the binary path undo it.

## Transport: TCP or Unix socket

By default `t3-codex` reaches T3 Code's `/mcp` over loopback TCP, at the URL T3 Code put in the
thread config. For machines where MCP over loopback TCP is not allowed, start T3 Code with
`T3CODE_MCP_SOCKET=<path>`. T3 Code then also serves `/mcp`, and nothing else, on that Unix
socket (mode 0600; put it in an owner-only directory such as `$XDG_RUNTIME_DIR`). `t3-codex`
inherits the variable and uses the socket. Requests and credentials are the same either way; only
the connection changes. See `apps/server/src/mcp/mcpUnixSocket.ts`.

## Credential handling

- The bridge channel lives in a new owner-only directory under `XDG_RUNTIME_DIR` (or the temp
  directory). `t3-codex` removes it on exit and forwards SIGTERM, SIGINT, and SIGHUP to Codex. A
  directory left by SIGKILL is removed by the next `t3-codex` start.
- Agent shell commands do not see `T3_MCP_SOCKET`. `t3-codex` adds
  `shell_environment_policy.filters."T3_MCP_*" = "exclude"` to each thread it rewrites.
- A process that finds the channel can make tool calls as any thread on that app-server. Its
  name is in the app-server's environment, which unsandboxed processes running as the same user
  can read. Those processes can already read T3 Code's own data and secrets.

## Outside T3 Code

The plugin is on for every Codex session. A session T3 Code did not start has no channel, so
`t3-codex mcp-bridge`, if `t3-codex` is on `PATH`, answers as an MCP server with no tools.
Otherwise Codex reports that both servers failed to start. The failure does not block the
session.

## Stable contract

Managed installs pin these: the marketplace name `t3`, the plugin ID `t3-code@t3`, the server
names `t3-code` and `t3-code-direct`, the command `t3-codex mcp-bridge`, and the variable
`T3_MCP_SOCKET`.

`t3-codex` also depends on T3 Code's private config shape: servers named `t3-code` and
`t3-code-direct` under `mcp_servers` with `url` and an `Authorization` header in `http_headers`,
sent in `thread/start`, `thread/resume`, and `thread/fork` (`codexThreadRuntimeParams` in
`CodexAdapterV2.ts`). If T3 Code renames the servers, the policy refuses them as before. If it
changes their credential fields, `t3-codex` logs it and each tool call fails with "T3 Code sent
its MCP servers in a form t3-codex does not understand". A tool call without `_meta.threadId`
fails rather than run as another thread.

## Requirements

- Codex 0.167.0 or later.
- Tested on Linux. macOS and Windows builds type-check but have not been run.
