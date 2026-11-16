// @effect-diagnostics nodeBuiltinImport:off - Reads the plugin's files from native/.
import * as NodeFS from "node:fs";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { claudeMcpQueryOverrides } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";

// The wrappers in native/t3-mcp-plugin parse these servers, and its plugin copies their settings.
// A failure here means T3 Code's handoff changed: update the wrappers, plugin, and fixtures.
const native = new URL("../../../../native/t3-mcp-plugin/", import.meta.url);
const read = (path: string) => JSON.parse(NodeFS.readFileSync(new URL(path, native), "utf8"));
const without = (value: {} | null, ...keys: ReadonlyArray<string>) =>
  Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !keys.includes(key)));

const mcpSession = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  providerSessionId: "session",
  providerInstanceId: ProviderInstanceId.make("provider"),
  endpoint: "http://127.0.0.1:3773/mcp",
  authorizationHeader: "Bearer token",
  browserToolsAvailable: true,
};

describe("T3 Code's handoff to the MCP plugin", () => {
  it("gives Codex the servers t3-codex parses, with the settings the plugin copies", () => {
    const { config } = codexThreadRuntimeParams({ threadId: mcpSession.threadId, mcpSession });
    const servers = Object.entries(config).filter(([key]) => key.startsWith("mcp_servers"));
    expect(Object.fromEntries(servers)).toEqual(read("fixtures/codex-mcp-servers.json"));
    const plugin = read("plugin/plugins/t3-code/codex.mcp.json").mcpServers;
    for (const [key, server] of servers) {
      expect(
        without(plugin[key.replace("mcp_servers.", "")], "command", "args", "env_vars"),
      ).toEqual(without(server, "url", "http_headers"));
    }
  });

  it("gives Claude the server t3-claude parses, with the settings the plugin copies", () => {
    const servers = claudeMcpQueryOverrides({ mcpSession, readOnlySandbox: false }).mcpServers;
    expect(servers).toEqual(read("fixtures/claude-mcp-servers.json"));
    const plugin = read("plugin/plugins/t3-code/.mcp.json").mcpServers;
    expect(without(plugin["t3-code"], "command", "args")).toEqual(
      without(servers?.["t3-code"] ?? {}, "type", "url", "headers"),
    );
  });
});
