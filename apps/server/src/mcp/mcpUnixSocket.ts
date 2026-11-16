// @effect-diagnostics nodeBuiltinImport:off - Effect cannot tell whether a Unix socket is live.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { LazyArg } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { HttpMiddleware, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

import {
  guardHttpResponseWriteErrors,
  rejectRequestsUntilServing,
} from "../httpResponseErrorGuard.ts";

// Opt-in, for hosts that forbid MCP over loopback TCP.
const MCP_SOCKET_ENV = "T3CODE_MCP_SOCKET";

class McpSocketError extends Schema.TaggedError<McpSocketError>()("McpSocketError", {
  path: Schema.String,
  reason: Schema.Literals(["not-a-socket", "in-use"]),
}) {
  override get message(): string {
    return this.reason === "in-use"
      ? `${MCP_SOCKET_ENV} names ${this.path}, which another server is listening on.`
      : `${MCP_SOCKET_ENV} names ${this.path}, which exists and is not a socket.`;
  }
}

// `/mcp`, `/mcp/...` and `/mcp?...` only. Without the boundary `/mcpx` would match, and the
// socket would expose a route other than MCP.
const isMcpUrl = (url: string) => /^\/mcp(?:[/?]|$)/.test(url);

const onlyMcp = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    isMcpUrl(request.url) ? app : Effect.succeed(HttpServerResponse.empty({ status: 404 })),
  );

// Refused means nobody is listening: the file was left by a server that died.
const isListening = (path: string) =>
  Effect.callback<boolean>((resume) => {
    const probe = NodeNet.connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resume(Effect.succeed(true));
    });
    probe.once("error", (cause: NodeJS.ErrnoException) =>
      resume(cause.code === "ECONNREFUSED" ? Effect.succeed(false) : Effect.die(cause)),
    );
    return Effect.sync(() => probe.destroy());
  });

const removeStaleSocket = Effect.fn("McpUnixSocket.removeStaleSocket")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs
    .stat(path)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
  if (!info) return;
  if (info.type !== "Socket") return yield* new McpSocketError({ path, reason: "not-a-socket" });
  if (yield* isListening(path)) return yield* new McpSocketError({ path, reason: "in-use" });
  yield* fs.remove(path);
});

// For a caller that may or may not pass middleware, as `HttpServer.make` allows.
const serveWith = <E, R>(
  server: HttpServer.HttpServer["Service"],
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  middleware: HttpMiddleware.HttpMiddleware | undefined,
): Effect.Effect<void, never, Exclude<R, HttpServerRequest.HttpServerRequest> | Scope.Scope> =>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off - HttpMiddleware's types are `any`
  middleware ? server.serve(app, middleware) : server.serve(app);

/**
 * `NodeHttpServer.layer`, plus the same app on the Unix socket `T3CODE_MCP_SOCKET` names,
 * restricted to `/mcp`. The socket is chmodded to 0600 just after it is created, so put it in an
 * owner-only directory. Node removes it on close.
 */
export const layerNodeHttpServer = (
  evaluate: LazyArg<NodeHttp.Server>,
  options: NodeHttpServer.Options,
) =>
  Layer.merge(
    Layer.effect(
      HttpServer.HttpServer,
      Effect.gen(function* () {
        const main = yield* NodeHttpServer.make(evaluate, options);
        const path = yield* Config.option(Config.String(MCP_SOCKET_ENV));
        if (Option.isNone(path)) return main;
        const fs = yield* FileSystem.FileSystem;
        yield* removeStaleSocket(path.value);
        const socket = yield* NodeHttpServer.make(
          () => rejectRequestsUntilServing(guardHttpResponseWriteErrors(NodeHttp.createServer())),
          { gracefulShutdownTimeout: options.gracefulShutdownTimeout, path: path.value },
        );
        yield* fs.chmod(path.value, 0o600);
        yield* Effect.logInfo("Serving /mcp on a Unix socket", { path: path.value });
        return HttpServer.make({
          address: main.address,
          serve: <E, R>(
            app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
            middleware?: HttpMiddleware.HttpMiddleware,
          ) =>
            Effect.andThen(
              serveWith(main, app, middleware),
              serveWith(socket, onlyMcp(app), middleware),
            ),
        });
      }),
    ),
    NodeHttpServer.layerHttpServices,
  );
