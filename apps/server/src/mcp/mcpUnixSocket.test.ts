// Exercise the raw Node socket listener that feeds the main server.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { closeMcpSocket, listenMcpSocket } from "./mcpUnixSocket.ts";

const request = (socketPath: string, path: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
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
  });

const withDir = async (run: (dir: string) => Promise<void>) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcp-socket-"));
  try {
    await run(dir);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

describe("listenMcpSocket", () => {
  it("serves only /mcp from the main server, owner-only, and removes the socket on close", () =>
    withDir(async (dir) => {
      const path = NodePath.join(dir, "mcp.sock");
      const main = NodeHttp.createServer((req, res) => res.end(`main saw ${req.url}`));
      const socket = await listenMcpSocket(path, () => main);
      try {
        expect(NodeFS.statSync(path).mode & 0o777).toBe(0o600);
        expect(await request(path, "/mcp")).toEqual({ status: 200, body: "main saw /mcp" });
        expect(await request(path, "/mcp?x=1")).toEqual({ status: 200, body: "main saw /mcp?x=1" });
        expect((await request(path, "/api/settings")).status).toBe(404);
        expect((await request(path, "/mcpx")).status).toBe(404);
      } finally {
        await closeMcpSocket(socket);
      }
      expect(NodeFS.existsSync(path)).toBe(false);
    }));

  it("answers 503 until the main server exists", () =>
    withDir(async (dir) => {
      const path = NodePath.join(dir, "mcp.sock");
      const socket = await listenMcpSocket(path, () => undefined);
      try {
        expect((await request(path, "/mcp")).status).toBe(503);
      } finally {
        await closeMcpSocket(socket);
      }
    }));

  it("replaces a stale socket, but never a live one or another file", () =>
    withDir(async (dir) => {
      const path = NodePath.join(dir, "mcp.sock");
      const main = NodeHttp.createServer((_req, res) => res.end("ok"));
      // A server killed before cleanup leaves its socket file behind.
      NodeChildProcess.spawnSync(process.execPath, [
        "-e",
        `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, "SIGKILL"))`,
      ]);
      expect(NodeFS.lstatSync(path).isSocket()).toBe(true);
      const socket = await listenMcpSocket(path, () => main);
      expect(await request(path, "/mcp")).toEqual({ status: 200, body: "ok" });
      // A second server given the same path must not take it from the first.
      await expect(listenMcpSocket(path, () => main)).rejects.toThrow(
        "another server is listening",
      );
      expect(await request(path, "/mcp")).toEqual({ status: 200, body: "ok" });
      await closeMcpSocket(socket);

      const file = NodePath.join(dir, "not-a-socket");
      NodeFS.writeFileSync(file, "data");
      await expect(listenMcpSocket(file, () => main)).rejects.toThrow("is not a socket");
      expect(NodeFS.readFileSync(file, "utf8")).toBe("data");
    }));
});
