// Hands raw Node requests to the main server, below Effect's HTTP layer.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

/** Opt-in path where `/mcp` is also served, for hosts that forbid MCP over loopback TCP. */
export const MCP_SOCKET_ENV = "T3CODE_MCP_SOCKET";

const isMcpPath = (url: string | undefined) => url !== undefined && /^\/mcp(?:[/?]|$)/.test(url);

const errorCode = (cause: unknown) => (cause as NodeJS.ErrnoException).code;

/** Removes a socket left by a server that died; refuses one another server still answers on. */
const removeStaleSocket = async (path: string) => {
  let isSocket: boolean;
  try {
    isSocket = NodeFS.lstatSync(path).isSocket();
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return;
    throw cause;
  }
  if (!isSocket) {
    throw new Error(`${MCP_SOCKET_ENV} names ${path}, which exists and is not a socket.`);
  }
  const live = await new Promise<boolean>((resolve, reject) => {
    const probe = NodeNet.connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", (cause) =>
      errorCode(cause) === "ECONNREFUSED" ? resolve(false) : reject(cause),
    );
  });
  if (live) {
    throw new Error(`${MCP_SOCKET_ENV} names ${path}, which another server is listening on.`);
  }
  NodeFS.unlinkSync(path);
};

/**
 * Serves `/mcp` on a Unix socket only this user can open, by passing each request to the main
 * server's handler. Every other path gets 404. Put the socket in an owner-only directory: its
 * mode is set just after it is created.
 */
export interface McpSocket {
  readonly server: NodeHttp.Server;
  readonly path: string;
  /** Identifies our socket file, so cleanup never removes one a later server created. */
  readonly inode: number;
}

export const listenMcpSocket = async (
  path: string,
  main: () => NodeHttp.Server | undefined,
): Promise<McpSocket> => {
  await removeStaleSocket(path);
  return new Promise((resolve, reject) => {
    const server = NodeHttp.createServer((request, response) => {
      const target = main();
      if (target === undefined || !isMcpPath(request.url)) {
        response.writeHead(target === undefined ? 503 : 404, { connection: "close" }).end();
        return;
      }
      target.emit("request", request, response);
    });
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      NodeFS.chmodSync(path, 0o600);
      resolve({ server, path, inode: NodeFS.lstatSync(path).ino });
    });
  });
};

/** Drops open connections first: a `t3_thread_wait` response can stay open for an hour. */
export const closeMcpSocket = ({ server, path, inode }: McpSocket): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      try {
        if (NodeFS.lstatSync(path).ino === inode) NodeFS.unlinkSync(path);
      } catch {
        // Already gone.
      }
      resolve();
    });
  });
