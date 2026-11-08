# t3-mcp-plugin

Gives Codex and Claude Code sessions started by T3 Code access to T3 Code's MCP tools on machines
where an admin policy allows MCP servers only from approved plugins. T3 Code does not change; an
optional transport (below) is the only server addition.

## Pieces

```text
src/                                                Rust; builds `t3-codex` and `t3-claude`
plugin/.agents/plugins/marketplace.json             Codex marketplace "t3"
plugin/.claude-plugin/marketplace.json              Claude Code marketplace "t3"
plugin/plugins/t3-code/codex.mcp.json               Codex servers: `t3-codex mcp-bridge`
plugin/plugins/t3-code/.mcp.json                    Claude Code server: `t3-claude mcp-bridge`
plugin/policy/codex/requirements.toml               Example Codex admin policy
plugin/policy/claude/managed-settings.json          Example Claude Code admin policy
```

Each binary has two roles. `t3-codex app-server` and `t3-claude` (as the Agent SDK runs it) stand
in for the real CLI; `<binary> mcp-bridge` is the plugin's MCP server. Any other invocation, such
as `--version`, runs the real CLI directly.

## How it works

T3 Code hands each CLI its MCP server with that thread's own credential. A plugin-only policy
refuses servers added that way, so the wrapper moves them into the plugin:

1. T3 Code's **binary path** setting for the provider points at the wrapper, which starts the
   real CLI and relays its stdio.
2. The wrapper removes T3 Code's servers and records the credential:
   - Codex: `t3-code` and `t3-code-direct` from the config of `thread/start`, `thread/resume`,
     and `thread/fork`.
   - Claude Code: `t3-code` from the Agent SDK's `mcp_set_servers` control request, which T3
     Code also sends when it rotates the credential.
3. The CLI starts the plugin's bridge, which only pipes stdio to the wrapper over a private
   channel named by `T3_MCP_BRIDGE` (a Unix socket, or a named pipe on Windows). The wrapper
   answers as the MCP server and sends each tool call to T3 Code with the calling thread's
   credential, one MCP session per credential.
4. Identity:
   - Codex hosts many threads per app-server; `_meta.threadId` names the caller, and a subagent
     T3 Code never saw is traced to its parent with `thread/read`.
   - Claude Code runs one process per thread, and subagents share it, so every call is that
     thread's.

T3 Code sees exactly the per-thread credentials it issues today, so scopes, capabilities, idle
expiry, rotation, and revocation work unchanged.

Claude Code names plugin tools `mcp__plugin_t3-code_t3-code__<tool>`, while T3 Code expects
`mcp__t3-code__<tool>` in its allowed tools, approvals, and tool rows. `t3-claude` maps the names
in both directions: in Claude's arguments and input, and in its output.

## Plugin server settings

The MCP files are plain JSON: Codex silently loads no servers from a file with comments. Their
settings copy what T3 Code sends each thread today, in `codexThreadRuntimeParams` and
`claudeMcpQueryOverrides`. `apps/server/src/mcp/mcpPlugin.test.ts` fails when they drift apart.

| Setting                                                                | Why                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`, `args`                                                      | The bridge. Each policy allows the server only when these match exactly.                                                                                                                                                                              |
| `env_vars: ["T3_MCP_BRIDGE"]` (Codex)                                  | Codex starts MCP servers with a reduced environment. Without this the bridge cannot find the wrapper and serves no tools.                                                                                                                             |
| `tool_timeout_sec: 3900` (Codex), `timeout: 3900000` (Claude Code, ms) | 65 minutes. `t3_thread_wait` can block for an hour.                                                                                                                                                                                                   |
| `t3-code` and `t3-code-direct` (Codex)                                 | The same bridge registered twice. Code Mode would run the blocking `t3_thread_wait` as a nested call while the model keeps working, so `t3-code` disables it and `t3-code-direct` carries only that tool, hidden from Code Mode and deferred loading. |

## Setup on a managed machine

1. Build and install the binaries:

   ```sh
   cargo build --locked --release --manifest-path native/t3-mcp-plugin/Cargo.toml
   ```

   Each wrapper puts its own directory first on the CLI's `PATH`, so the CLI finds it when the
   plugin runs `<binary> mcp-bridge`.

2. Install the plugin from `native/t3-mcp-plugin/plugin`:

   ```sh
   codex plugin marketplace add <path-or-git-url>
   codex plugin add t3-code@t3
   claude plugin marketplace add <path-or-git-url>
   claude plugin install t3-code@t3
   ```

3. In T3 Code, set **Settings → Providers → Codex → Binary path** to `t3-codex` and
   **Settings → Providers → Claude → Binary path** to `t3-claude`. Each finds the real CLI on
   `PATH`, skipping itself; set `T3_CODEX_REAL` or `T3_CLAUDE_REAL` to choose another.

4. Deploy the policies: Codex's as `/etc/codex/requirements.toml`, Claude Code's as
   `/etc/claude-code/managed-settings.json` (Linux) or the macOS managed settings location. Set
   `strictKnownMarketplaces` to the approved source of this plugin.

## Transport: TCP or Unix socket

By default the wrappers reach T3 Code's `/mcp` over loopback TCP, at the URL T3 Code gave. For
machines where MCP over loopback TCP is not allowed, start T3 Code with `T3CODE_MCP_SOCKET=<path>`.
T3 Code then also serves `/mcp`, and nothing else, on that Unix socket (mode 0600; put it in an
owner-only directory such as `$XDG_RUNTIME_DIR`). The wrappers inherit the variable and use the
socket. See `apps/server/src/mcp/mcpUnixSocket.ts`.

## Credential handling

- The bridge channel lives in a new owner-only directory under `XDG_RUNTIME_DIR` (or the temp
  directory). The wrapper removes it on exit and forwards SIGTERM, SIGINT, and SIGHUP to the CLI.
  A directory left by SIGKILL is removed by the next wrapper start.
- Codex agent shells do not see `T3_MCP_BRIDGE`: `t3-codex` adds
  `shell_environment_policy.filters."T3_MCP_*" = "exclude"` to each thread it rewrites.
- Claude Code passes its environment to Bash and has no per-variable filter, so Bash in a Claude
  thread can see `T3_MCP_BRIDGE`. It reaches only that thread's own T3 Code access, which the
  agent already has.
- A process that finds a Codex wrapper's channel can make tool calls as any thread on that
  app-server. Its name is in the app-server's environment, which unsandboxed processes running
  as the same user can read. Those processes can already read T3 Code's own data and secrets.

## Outside T3 Code

The plugin is on for every session. A session T3 Code did not start has no channel, so the bridge,
if its binary is on `PATH`, answers as an MCP server with no tools. Otherwise the CLI reports that
the server failed to start; that does not block the session.

## Stable contract

Managed installs pin these: the marketplace name `t3`, the plugin ID `t3-code@t3`, the server
names `t3-code` and `t3-code-direct`, the commands `t3-codex mcp-bridge` and `t3-claude
mcp-bridge`, and the variable `T3_MCP_BRIDGE`.

The wrappers also depend on how T3 Code hands over its server: `codexThreadRuntimeParams` and
`claudeMcpQueryOverrides` in the provider adapters (a server named `t3-code` with `url` and an
`Authorization` header). `apps/server/src/mcp/mcpPlugin.test.ts` checks T3 Code's output against
`fixtures/`, which the Rust tests parse, so a change there fails CI. A wrapper older than the
T3 Code it runs under logs that it does not understand the fields; tool calls then fail instead
of running as another thread.

## Requirements

- Codex 0.167.0 or later; Claude Code 2.1.319 or later, through Agent SDK 0.3.316.
- Tested on Linux. macOS and Windows builds type-check but have not been run.
