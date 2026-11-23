# T3 Code MCP Plugin

Gives Codex and Claude Code sessions started by T3 Code access to T3 Code's MCP tools on machines
where an admin policy allows MCP servers only from approved plugins.

No extra binaries or wrapper scripts are needed: the plugin runs T3 Code's own `t3 mcp-bridge`
command, which connects directly to T3 Code's loopback HTTP `/mcp` endpoint using the session's
credential from the environment.

## Pieces

```text
plugin/.agents/plugins/marketplace.json             Codex marketplace "t3"
plugin/.claude-plugin/marketplace.json              Claude Code marketplace "t3"
plugin/plugins/t3-code/codex.mcp.json               Codex servers: `t3 mcp-bridge`
plugin/plugins/t3-code/.mcp.json                    Claude Code server: `t3 mcp-bridge`
plugin/policy/codex/requirements.toml               Example Codex admin policy
plugin/policy/claude/managed-settings.json          Example Claude Code admin policy
```

## How it works

1. Install the `t3-code@t3` plugin in Codex and/or Claude Code. T3 Code reads Codex's effective
   config and Claude Code's `settings.json` to see whether the plugin is enabled. Set
   `T3CODE_MCP_PLUGIN=1` or `0` to force plugin mode on or off.
2. In plugin mode, T3 Code stops adding its MCP servers to the thread (`mcp_servers.t3-code*` on
   Codex, `mcpServers` on Claude Code). It puts a credential in `T3_MCP_ENDPOINT` and
   `T3_MCP_AUTHORIZATION` instead, and the plugin's `t3 mcp-bridge` relays stdio JSON-RPC to
   T3 Code's loopback `/mcp` endpoint.
3. Identity:
   - **Claude Code** runs one process per thread, so it gets that thread's own credential.
   - **Codex** shares one `app-server` across threads, so it gets one bridge credential for the
     app-server. Each `tools/call` names its thread in `_meta.threadId`, and T3 Code runs the call
     with that thread's credential. Subagents act as their parent thread. `T3_MCP_*` is excluded
     from agent shells.

## Setup on a managed machine

1. Ensure T3 Code's `t3` CLI is installed (Desktop installs it automatically, or run `t3 install`).
2. Add the marketplace and install the plugin:

   ```sh
   codex plugin marketplace add "$PWD/packaging/mcp-plugin/plugin"
   codex plugin add t3-code@t3
   claude plugin marketplace add "$PWD/packaging/mcp-plugin/plugin"
   claude plugin install t3-code@t3
   ```

   If your administrator hosts an approved Git marketplace, use its URL in both `marketplace add`
   commands with the contents of `packaging/mcp-plugin/plugin` at the repository root.

3. Deploy the policies: `policy/codex/requirements.toml` as `/etc/codex/requirements.toml`, and
   `policy/claude/managed-settings.json` as `/etc/claude-code/managed-settings.json` (Linux) or the
   macOS managed settings location, with `strictKnownMarketplaces` set to the approved source.

## Outside T3 Code

When Codex or Claude Code runs outside T3 Code, `T3_MCP_ENDPOINT` and `T3_MCP_AUTHORIZATION` are
unset, so `t3 mcp-bridge` answers MCP `initialize` and `tools/list` with no tools and never blocks
the session.
