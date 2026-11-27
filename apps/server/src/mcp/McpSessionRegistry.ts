import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { routineSpan } from "@t3tools/shared/observability";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  /** False omits the preview capability wherever the token is honored. Defaults to full access. */
  readonly browserToolsAvailable?: boolean;
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
  readonly subagent?: boolean;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
}

/** One credential for every thread of a Codex app-server, which runs T3's plugin bridge. */
export interface McpBridgeRequest {
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** Maps the calling provider thread to the T3 thread whose credential the call uses. */
  readonly resolveThreadId: (nativeThreadId: string) => Effect.Effect<ThreadId | undefined>;
}

export interface McpIssuedBridge {
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

/** Read from the request's `mcp-method` and `t3-native-thread-id` headers. */
export interface McpBridgeRequestContext {
  readonly method?: string | undefined;
  readonly nativeThreadId?: string | undefined;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  /** Revoked when the scope closes. */
  readonly issueBridge: (
    request: McpBridgeRequest,
  ) => Effect.Effect<McpIssuedBridge, never, Scope.Scope>;
  readonly resolve: (
    rawToken: string,
    bridgeRequest?: McpBridgeRequestContext,
  ) => Effect.Effect<McpInvocationContext.McpThreadInvocationScope | undefined>;
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface AliveMark {
  readonly wallMs: number;
  readonly monotonicMs: number;
}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpThreadInvocationScope;
  readonly lastAlive: AliveMark;
  /** Set when a request finds the token idle; only `touch` clears it, whatever the clocks do. */
  readonly expired: boolean;
}

interface BridgeRecord {
  readonly providerInstanceId: ProviderInstanceId;
  readonly resolveThreadId: McpBridgeRequest["resolveThreadId"];
  readonly discoveryScope: McpInvocationContext.McpThreadInvocationScope;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  /** Drives both the wall and monotonic readings. */
  readonly now?: () => number;
}

/**
 * `/mcp` is outside environment auth, so idle tokens stop authenticating.
 * Keep expired records until explicit revocation: a trusted provider turn can
 * refresh the token its subprocess still holds; MCP requests cannot.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

// The larger elapsed reading wins: stepping the wall clock back cannot extend a token,
// and wall time that passes while the host sleeps still counts.
const idleMs = (since: AliveMark, now: AliveMark): number =>
  Math.max(now.wallMs - since.wallMs, now.monotonicMs - since.monotonicMs);

// Codex lists tools once per thread without naming it, so a bridge lists every tool as a
// stand-in thread; each call then runs as the thread it names.
const BRIDGE_DISCOVERY_CAPABILITIES: ReadonlySet<McpInvocationContext.McpCapability> = new Set([
  "orchestration",
  "worktree",
  "pull-requests",
  "issues",
  "preview",
  "device",
]);

const getHttpMcpEndpointHost = (address: NetAddress.IpAddress): string =>
  NetAddress.isUnspecified(address)
    ? "127.0.0.1"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(address));

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  const bridges = new Map<string, BridgeRecord>();
  const { now } = options;
  const currentAliveMark: Effect.Effect<AliveMark> = now
    ? Effect.sync(() => {
        const timestamp = now();
        return { wallMs: timestamp, monotonicMs: timestamp };
      })
    : Effect.all({
        wallMs: Clock.currentTimeMillis,
        monotonicMs: Clock.monotonicTimeNanos.pipe(
          Effect.map((nanos) => Number(nanos / 1_000_000n)),
        ),
      });
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const endpoint = NetAddress.isInetAddress(httpServer.address)
    ? `http://${getHttpMcpEndpointHost(httpServer.address.address)}:${httpServer.address.port}/mcp`
    : "http://127.0.0.1/mcp";

  const hashToken = (token: string) =>
    digest
      .digest(Digest.sha256, new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAlive = yield* currentAliveMark;
      const providerSessionId = yield* random.uuidV4();
      const rawToken = yield* random.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const browserToolsAvailable = request.browserToolsAvailable ?? true;
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId,
        requestNamespace: providerSessionId,
        thread: {
          threadId: ThreadId.make(request.threadId),
          providerSessionId,
          providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
          subagent: request.subagent === true,
        },
        client: undefined,
        capabilities: new Set<McpInvocationContext.McpCapability>([
          "orchestration",
          "worktree",
          "pull-requests",
          "issues",
          ...(request.capabilities ?? (browserToolsAvailable ? (["preview"] as const) : [])),
        ]),
        issuedAt: issuedAlive.wallMs,
      };
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(records);
        next.set(tokenHash, { tokenHash, scope, lastAlive: issuedAlive, expired: false });
        return { records: next };
      });
      return {
        config: {
          environmentId,
          threadId: scope.thread.threadId,
          providerSessionId,
          providerInstanceId: scope.thread.providerInstanceId,
          endpoint,
          authorizationHeader: `Bearer ${rawToken}`,
          browserToolsAvailable: scope.capabilities.has("preview"),
          capabilities: scope.capabilities,
        },
      };
    },
  );

  const issueBridge: McpSessionRegistryShape["issueBridge"] = Effect.fn(
    "McpSessionRegistry.issueBridge",
  )(function* ({ providerSessionId, providerInstanceId, resolveThreadId }) {
    const rawToken = yield* random.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
    const tokenHash = yield* hashToken(rawToken);
    const discoveryScope: McpInvocationContext.McpThreadInvocationScope = {
      environmentId,
      requestNamespace: providerSessionId,
      thread: { threadId: ThreadId.make(providerSessionId), providerSessionId, providerInstanceId },
      client: undefined,
      capabilities: BRIDGE_DISCOVERY_CAPABILITIES,
      issuedAt: (yield* currentAliveMark).wallMs,
    };
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        bridges.set(tokenHash, { providerInstanceId, resolveThreadId, discoveryScope }),
      ),
      () => Effect.sync(() => bridges.delete(tokenHash)),
    );
    return { endpoint, authorizationHeader: `Bearer ${rawToken}` };
  });

  // Both run inside the traced `resolve`.
  const resolveRecord = Effect.fnUntraced(function* (tokenHash: string) {
    const alive = yield* currentAliveMark;
    return yield* SynchronizedRef.modify(state, ({ records }) => {
      const record = records.get(tokenHash);
      if (!record || record.expired) return [undefined, { records }] as const;
      if (idleMs(record.lastAlive, alive) > livenessWindowMs) {
        const next = new Map(records);
        next.set(tokenHash, { ...record, expired: true });
        return [undefined, { records: next }] as const;
      }
      const next = new Map(records);
      next.set(tokenHash, { ...record, lastAlive: alive });
      return [record.scope, { records: next }] as const;
    });
  });

  const resolveBridge = Effect.fnUntraced(function* (
    bridge: BridgeRecord,
    { method, nativeThreadId }: McpBridgeRequestContext = {},
  ) {
    if (nativeThreadId === undefined) {
      return method === "tools/call" ? undefined : bridge.discoveryScope;
    }
    const threadId = yield* bridge.resolveThreadId(nativeThreadId);
    const record = Array.from((yield* SynchronizedRef.get(state)).records.values()).find(
      ({ expired, scope }) =>
        !expired &&
        scope.thread.threadId === threadId &&
        scope.thread.providerInstanceId === bridge.providerInstanceId,
    );
    return record === undefined ? undefined : yield* resolveRecord(record.tokenHash);
  });

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve", {
    attributes: routineSpan,
  })(function* (rawToken, bridgeRequest) {
    if (rawToken.length === 0) return undefined;
    const tokenHash = yield* hashToken(rawToken);
    const bridge = bridges.get(tokenHash);
    return bridge === undefined
      ? yield* resolveRecord(tokenHash)
      : yield* resolveBridge(bridge, bridgeRequest);
  });

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const alive = yield* currentAliveMark;
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(records);
        for (const [tokenHash, record] of records) {
          if (record.scope.thread.threadId === threadId) {
            next.set(tokenHash, { ...record, lastAlive: alive, expired: false });
          }
        }
        return { records: next };
      });
    },
  );

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.update(state, ({ records }) => ({
      records: new Map(Array.from(records).filter(([, record]) => !predicate(record))),
    }));

  return McpSessionRegistry.of({
    issue,
    issueBridge,
    resolve,
    touch,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => record.scope.thread.providerSessionId === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.scope.thread.threadId === threadId);
    }),
    revokeAll: SynchronizedRef.set(state, { records: new Map() }).pipe(
      Effect.tap(() => Effect.sync(() => bridges.clear())),
    ),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

export const __testing = {
  make: makeWithOptions,
};
