// @effect-diagnostics nodeBuiltinImport:off - Reads the plugin manifests checked in beside the server.
import * as NodeFS from "node:fs";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { claudeMcpQueryOverrides } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import {
  CLAUDE_PLUGIN_T3_MCP_TOOL_PREFIX,
  T3_MCP_AUTHORIZATION_ENV,
  T3_MCP_ENDPOINT_ENV,
  T3_MCP_PLUGIN_MODE_ENV,
  isClaudeMcpPluginEnabled,
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

  it.effect("routes a Codex bridge call to the thread its `_meta.threadId` names", () =>
    Effect.gen(function* () {
      const WhoAmI = Tool.make("who_am_i", { success: Schema.Struct({ threadId: Schema.String }) });
      const WhoAmIToolkit = Toolkit.make(WhoAmI);
      const registry = yield* McpSessionRegistry.__testing.make({ livenessWindowMs: 60_000 }).pipe(
        Effect.provideService(
          HttpServer.HttpServer,
          HttpServer.HttpServer.of({
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
            serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
          }),
        ),
        Effect.provideService(
          ServerEnvironment.ServerEnvironment,
          ServerEnvironment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("env-plugin-test")),
            getDescriptor: Effect.die("unused"),
          }),
        ),
        Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
      const codex = ProviderInstanceId.make("codex");
      const threadA = ThreadId.make("thread-a");
      const nativeThreads = new Map<string, ThreadId>();
      const bridge = yield* registry.issueBridge({
        providerSessionId: "codex-session",
        providerInstanceId: codex,
        resolveThreadId: (nativeThreadId) => Effect.succeed(nativeThreads.get(nativeThreadId)),
      });
      yield* HttpRouter.serve(
        McpHttpServer.layerMcpTransport(
          McpHttpServer.toolkitRegistration(
            WhoAmIToolkit,
            McpToolAccess.toLayer(WhoAmIToolkit, {
              who_am_i: McpToolAccess.reads(() =>
                Effect.serviceOption(McpInvocationContext.McpInvocationContext).pipe(
                  Effect.map((scope) => ({
                    threadId: Option.getOrUndefined(scope)?.thread?.threadId ?? "none",
                  })),
                ),
              ),
            }),
          ),
        ).pipe(
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry)),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(Layer.build);
      const httpClient = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(bridge.authorizationHeader.slice(7))),
      );
      const post = (message: object, headers: Record<string, string> = {}) =>
        httpClient.post("/mcp", {
          headers: { accept: "application/json, text/event-stream", ...headers },
          body: HttpBody.text(JSON.stringify({ jsonrpc: "2.0", ...message }), "application/json"),
        });
      const callWhoAmI = (sessionId: string) =>
        post(
          {
            id: 2,
            method: "tools/call",
            params: { name: "who_am_i", arguments: {}, _meta: { threadId: "native-a" } },
          },
          { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
        );

      // Codex initializes before any of its threads has a live credential.
      const initialize = yield* post({
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "codex", version: "0.171.0" },
        },
      });
      expect(initialize.status).toBe(200);
      const sessionId = initialize.headers["mcp-session-id"]!;
      expect((yield* callWhoAmI(sessionId)).status).toBe(401);

      yield* registry.issue({ threadId: threadA, providerInstanceId: codex });
      nativeThreads.set("native-a", threadA);
      const mapped = yield* callWhoAmI(sessionId);
      expect(mapped.status).toBe(200);
      expect(yield* mapped.text).toContain("thread-a");
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );
});
