// @effect-diagnostics nodeBuiltinImport:off - Reads the plugin manifests checked in beside the server.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { claudeMcpQueryOverrides } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  CLAUDE_PLUGIN_T3_MCP_TOOL_PREFIX,
  T3_MCP_AUTHORIZATION_ENV,
  T3_MCP_ENDPOINT_ENV,
  T3_MCP_PLUGIN_MODE_ENV,
  isClaudeMcpPluginEnabled,
  withMcpPluginEnvironment,
} from "./mcpPlugin.ts";

const pluginRoot = new URL("../../../../packaging/mcp-plugin/plugin/", import.meta.url);
const readJson = (relativePath: string) =>
  JSON.parse(NodeFS.readFileSync(new URL(relativePath, pluginRoot), "utf8"));
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

describe("T3 Code MCP plugin", () => {
  it("serves the same T3 servers through `t3 mcp-bridge` that thread config would", () => {
    const { config } = codexThreadRuntimeParams({ threadId: mcpSession.threadId, mcpSession });
    const servers = Object.entries(config).filter(([key]) => key.startsWith("mcp_servers."));
    const codexPlugin = readJson("plugins/t3-code/codex.mcp.json").mcpServers;
    expect(Object.keys(codexPlugin)).toEqual(servers.map(([key]) => key.slice(12)));
    for (const [key, server] of servers) {
      const pluginServer = codexPlugin[key.slice(12)];
      expect(pluginServer.command).toBe("t3");
      expect(pluginServer.args).toEqual(["mcp-bridge"]);
      expect(pluginServer.env_vars).toEqual([T3_MCP_ENDPOINT_ENV, T3_MCP_AUTHORIZATION_ENV]);
      expect(without(pluginServer, "command", "args", "env_vars")).toEqual(
        without(server, "url", "http_headers"),
      );
    }
    expect(
      Object.keys(
        codexThreadRuntimeParams({ threadId: mcpSession.threadId, mcpSession, usePluginMcp: true })
          .config,
      ).filter((key) => key.startsWith("mcp_servers.")),
    ).toEqual([]);

    const claudeServer = claudeMcpQueryOverrides({ mcpSession, readOnlySandbox: false })
      .mcpServers?.["t3-code"];
    const claudePlugin = readJson("plugins/t3-code/.mcp.json").mcpServers["t3-code"];
    expect(claudePlugin.command).toBe("t3");
    expect(claudePlugin.args).toEqual(["mcp-bridge"]);
    expect(without(claudePlugin, "command", "args")).toEqual(
      without(claudeServer ?? {}, "type", "url", "headers"),
    );
    expect(readJson("policy/claude/managed-settings.json").allowedMcpServers).toEqual([
      { serverCommand: ["t3", "mcp-bridge"] },
    ]);
    expect(
      claudeMcpQueryOverrides({ mcpSession, readOnlySandbox: false, usePluginMcp: true }),
    ).toEqual({
      allowedTools: [`${CLAUDE_PLUGIN_T3_MCP_TOOL_PREFIX}*`],
      pluginMcp: { endpoint: mcpSession.endpoint, authorizationHeader: "Bearer token" },
    });
  });

  it.effect("detects the plugin Claude Code enables and honors T3CODE_MCP_PLUGIN", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const claudeHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-plugin-" });

      expect(yield* isClaudeMcpPluginEnabled(claudeHome, {})).toBe(false);
      expect(yield* isClaudeMcpPluginEnabled(claudeHome, { [T3_MCP_PLUGIN_MODE_ENV]: "1" })).toBe(
        true,
      );
      yield* fs.writeFileString(
        path.join(claudeHome, "settings.json"),
        JSON.stringify({ enabledPlugins: { "t3-code@t3": true } }),
      );
      expect(yield* isClaudeMcpPluginEnabled(claudeHome, {})).toBe(true);
      expect(yield* isClaudeMcpPluginEnabled(claudeHome, { [T3_MCP_PLUGIN_MODE_ENV]: "0" })).toBe(
        false,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("passes only this thread's credential to the plugin, with this install's `t3`", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const outer = {
        PATH: "/usr/bin",
        T3CODE_CLI_PATH: "/opt/t3/bin/t3",
        [T3_MCP_ENDPOINT_ENV]: "http://127.0.0.1:1/mcp",
        [T3_MCP_AUTHORIZATION_ENV]: "Bearer outer-thread",
      };
      expect(withMcpPluginEnvironment(outer, undefined, path, "linux")).toEqual({
        PATH: "/usr/bin",
        T3CODE_CLI_PATH: "/opt/t3/bin/t3",
      });
      expect(withMcpPluginEnvironment(outer, mcpSession, path, "linux")).toEqual({
        PATH: "/opt/t3/bin:/usr/bin",
        T3CODE_CLI_PATH: "/opt/t3/bin/t3",
        [T3_MCP_ENDPOINT_ENV]: mcpSession.endpoint,
        [T3_MCP_AUTHORIZATION_ENV]: "Bearer token",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
