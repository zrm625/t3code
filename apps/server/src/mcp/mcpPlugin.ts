import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

export const T3_MCP_PLUGIN_ID = "t3-code@t3";
export const T3_MCP_ENDPOINT_ENV = "T3_MCP_ENDPOINT";
export const T3_MCP_AUTHORIZATION_ENV = "T3_MCP_AUTHORIZATION";
export const T3_MCP_PLUGIN_MODE_ENV = "T3CODE_MCP_PLUGIN";
export const CLAUDE_PLUGIN_T3_MCP_TOOL_PREFIX = "mcp__plugin_t3-code_t3-code__";

const decodeClaudeSettings = Schema.decodeUnknownOption(
  fromLenientJson(
    Schema.Struct({
      enabledPlugins: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);

/** `T3CODE_MCP_PLUGIN=1` or `0` forces plugin mode on or off; unset leaves it to detection. */
export function mcpPluginModeOverride(environment: NodeJS.ProcessEnv): boolean | undefined {
  const value = environment[T3_MCP_PLUGIN_MODE_ENV]?.trim().toLowerCase();
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}

export const isClaudeMcpPluginEnabled = Effect.fn("mcpPlugin.isClaudeMcpPluginEnabled")(function* (
  claudeHomePath: string,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem | Path.Path> {
  const override = mcpPluginModeOverride(environment);
  if (override !== undefined) return override;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* fileSystem
    .readFileString(path.join(claudeHomePath, "settings.json"))
    .pipe(Effect.option);
  return Option.flatMap(settings, decodeClaudeSettings).pipe(
    Option.exists((value) => value.enabledPlugins?.[T3_MCP_PLUGIN_ID] === true),
  );
});

/**
 * The plugin's `t3 mcp-bridge` reads the credential from the provider's environment. The `t3`
 * shim directory goes first on `PATH` so the plugin's bare `t3` command resolves.
 */
export function withMcpPluginEnvironment(
  base: NodeJS.ProcessEnv,
  credential: { readonly endpoint: string; readonly authorizationHeader: string },
  path: Path.Path,
): NodeJS.ProcessEnv {
  const cliPath = base.T3CODE_CLI_PATH?.trim();
  const pathKey = Object.keys(base).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const delimiter = path.sep === "\\" ? ";" : ":";
  return {
    ...base,
    [T3_MCP_ENDPOINT_ENV]: credential.endpoint,
    [T3_MCP_AUTHORIZATION_ENV]: credential.authorizationHeader,
    ...(cliPath
      ? { [pathKey]: [path.dirname(cliPath), base[pathKey]].filter(Boolean).join(delimiter) }
      : {}),
  };
}
