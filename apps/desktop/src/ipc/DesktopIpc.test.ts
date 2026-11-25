import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "./DesktopIpc.ts";

it.effect("answers trusted app windows' top frames and rejects subframes and guests", () =>
  Effect.gen(function* () {
    const mainFrame = {};
    const quickComposerMainFrame = {};
    const invoke = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    const sync = new Map<string, DesktopIpc.DesktopIpcSyncListener>();
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { id: 1, mainFrame },
    } as unknown as Electron.BrowserWindow;
    const quickComposerWindow = {
      isDestroyed: () => false,
      once: vi.fn(),
      webContents: { id: 3, mainFrame: quickComposerMainFrame },
    } as unknown as Electron.BrowserWindow;
    const untrust = ElectronWindow.trustAuxiliaryAppWindow(quickComposerWindow);
    yield* Effect.addFinalizer(() => Effect.sync(untrust));
    const ipc = yield* DesktopIpc.DesktopIpc.pipe(
      Effect.provide(
        DesktopIpc.layer({
          removeHandler: (channel) => void invoke.delete(channel),
          handle: (channel, listener) => void invoke.set(channel, listener),
          removeAllListeners: (channel) => void sync.delete(channel),
          on: (channel, listener) => void sync.set(channel, listener),
        }).pipe(
          Layer.provide(
            Layer.mock(ElectronWindow.ElectronWindow, {
              main: Effect.succeedSome(mainWindow),
            }),
          ),
        ),
      ),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: "token",
        payload: Schema.Void,
        result: Schema.String,
        handler: () => Effect.succeed("secret"),
      }),
    );
    yield* ipc.handleSync({ channel: "token-sync", handler: () => Effect.succeed("secret") });

    const senders = {
      app: { sender: { id: 1 }, senderFrame: mainFrame },
      appSubframe: { sender: { id: 1 }, senderFrame: {} },
      quickComposer: { sender: { id: 3 }, senderFrame: quickComposerMainFrame },
      quickComposerSubframe: { sender: { id: 3 }, senderFrame: {} },
      previewGuest: { sender: { id: 2 }, senderFrame: {} },
    };
    const results: Record<string, unknown> = {};
    for (const [name, sender] of Object.entries(senders)) {
      const event = { ...sender, returnValue: "unset" as unknown };
      sync.get("token-sync")!(event);
      results[name] = [
        yield* Effect.promise(() =>
          Promise.resolve(invoke.get("token")!(sender, undefined)).catch(() => "rejected"),
        ),
        event.returnValue,
      ];
    }
    assert.deepEqual(results, {
      app: ["secret", "secret"],
      appSubframe: ["rejected", undefined],
      quickComposer: ["secret", "secret"],
      quickComposerSubframe: ["rejected", undefined],
      previewGuest: ["rejected", undefined],
    });
  }),
);
