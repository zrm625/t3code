// @effect-diagnostics nodeBuiltinImport:off - Real Unix sockets, and a child that leaves one behind.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

import { layerNodeHttpServer } from "./mcpUnixSocket.ts";

const request = (socketPath: string, path: string) =>
  Effect.promise(
    () =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const sent = NodeHttp.request(
          { socketPath, path, method: "POST", agent: false },
          (response) => {
            let body = "";
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
          },
        );
        sent.on("error", reject);
        sent.end("{}");
      }),
  );

// Through the real layer with real listen options, as server.ts builds it.
const serve = Effect.fn("mcpUnixSocket.test.serve")(function* (path: string) {
  const context = yield* Layer.build(
    layerNodeHttpServer(() => NodeHttp.createServer(), { host: "127.0.0.1", port: 0 }).pipe(
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_MCP_SOCKET: path } })),
      ),
    ),
  );
  yield* Context.get(context, HttpServer.HttpServer).serve(
    Effect.map(HttpServerRequest.HttpServerRequest, (req) =>
      HttpServerResponse.text(`app saw ${req.url}`),
    ),
  );
});

it.live("serves only /mcp from the main app, owner-only, and removes the socket on close", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = `${yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-socket-" })}/mcp.sock`;
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* serve(path);
        expect(((yield* fs.stat(path)).mode & 0o777).toString(8)).toBe("600");
        expect(yield* request(path, "/mcp")).toEqual({ status: 200, body: "app saw /mcp" });
        expect(yield* request(path, "/mcp?x=1")).toEqual({ status: 200, body: "app saw /mcp?x=1" });
        expect((yield* request(path, "/api/settings")).status).toBe(404);
        expect((yield* request(path, "/mcpx")).status).toBe(404);
      }),
    );
    expect(yield* fs.exists(path)).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("replaces a stale socket, but never a live one or another file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-socket-" });
    const path = `${dir}/mcp.sock`;
    // A server killed before cleanup leaves its socket file behind.
    NodeChildProcess.spawnSync(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, "SIGKILL"))`,
    ]);
    expect((yield* fs.stat(path)).type).toBe("Socket");
    yield* serve(path);
    expect((yield* request(path, "/mcp")).status).toBe(200);

    expect(yield* Effect.flip(Effect.scoped(serve(path)))).toMatchObject({ reason: "in-use" });
    expect((yield* request(path, "/mcp")).status).toBe(200);

    const file = `${dir}/not-a-socket`;
    yield* fs.writeFileString(file, "data");
    expect(yield* Effect.flip(Effect.scoped(serve(file)))).toMatchObject({
      reason: "not-a-socket",
    });
    expect(yield* fs.readFileString(file)).toBe("data");
  }).pipe(Effect.provide(NodeServices.layer)),
);
