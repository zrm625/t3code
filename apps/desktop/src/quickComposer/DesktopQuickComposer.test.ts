import * as NodeEvents from "node:events";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
  type DesktopQuickComposerEvent,
  type DesktopQuickComposerOpenThreadInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { describe, expect, vi } from "vite-plus/test";

const { registeredShortcuts, liveWebContents, registerMock, unregisterMock } = vi.hoisted(() => {
  const registered = new Map<string, () => void>();
  const contents = new Map<number, ReturnType<typeof makeMicRenderer>>();
  return {
    registeredShortcuts: registered,
    liveWebContents: contents,
    registerMock: vi.fn((accelerator: string, handler: () => void) => {
      if (registered.has(accelerator)) return false;
      registered.set(accelerator, handler);
      return true;
    }),
    unregisterMock: vi.fn((accelerator: string) => {
      registered.delete(accelerator);
    }),
  };
});

vi.mock("electron", () => ({
  globalShortcut: {
    register: registerMock,
    unregister: unregisterMock,
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 500, y: 300 }),
    getDisplayNearestPoint: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
    getDisplayMatching: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
  },
  webContents: {
    fromId: (id: number) => liveWebContents.get(id),
  },
}));

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopQuickComposer from "./DesktopQuickComposer.ts";

function makeMicRenderer(id: number) {
  return Object.assign(new NodeEvents.EventEmitter(), { id, isDestroyed: () => false });
}

function makeFakeWindow(webContentsId: number) {
  let visible = false;
  let focused = false;
  let destroyed = false;
  let bounds = { x: 0, y: 0, width: 680, height: 240 };
  const windowListeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const webContentsListeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const sentEvents: Array<{ readonly channel: string; readonly payload: unknown }> = [];

  const emit = (
    map: Map<string, Array<(...args: unknown[]) => void>>,
    event: string,
    ...args: unknown[]
  ) => {
    for (const listener of (map.get(event) ?? []).slice()) {
      listener(...args);
    }
  };
  const on = (
    map: Map<string, Array<(...args: unknown[]) => void>>,
    event: string,
    listener: (...args: unknown[]) => void,
  ) => {
    const existing = map.get(event) ?? [];
    existing.push(listener);
    map.set(event, existing);
  };
  const once = (
    map: Map<string, Array<(...args: unknown[]) => void>>,
    event: string,
    listener: (...args: unknown[]) => void,
  ) => {
    const wrapped = (...args: unknown[]) => {
      const list = map.get(event);
      if (list) {
        const index = list.indexOf(wrapped);
        if (index !== -1) list.splice(index, 1);
      }
      listener(...args);
    };
    on(map, event, wrapped);
  };

  const window = {
    id: webContentsId,
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isFocused: () => focused,
    getBounds: () => bounds,
    setBounds: (next: typeof bounds) => {
      bounds = next;
    },
    setSize: (width: number, height: number) => {
      bounds = { ...bounds, width, height };
    },
    setVisibleOnAllWorkspaces: vi.fn(),
    setTitle: vi.fn(),
    show: vi.fn(() => {
      visible = true;
    }),
    focus: vi.fn(() => {
      focused = true;
    }),
    hide: vi.fn(() => {
      visible = false;
      focused = false;
    }),
    destroy: vi.fn(() => {
      if (destroyed) return;
      destroyed = true;
      visible = false;
      focused = false;
      emit(windowListeners, "closed");
    }),
    loadURL: vi.fn(() => {
      emit(webContentsListeners, "did-finish-load");
      emit(windowListeners, "ready-to-show");
      return Promise.resolve();
    }),
    on: (event: string, listener: (...args: unknown[]) => void) =>
      on(windowListeners, event, listener),
    once: (event: string, listener: (...args: unknown[]) => void) =>
      once(windowListeners, event, listener),
    webContents: {
      id: webContentsId,
      session: {
        webRequest: {
          onBeforeSendHeaders: vi.fn(),
        },
      },
      setWindowOpenHandler: vi.fn(),
      send: (channel: string, payload: unknown) => {
        sentEvents.push({ channel, payload });
      },
      on: (event: string, listener: (...args: unknown[]) => void) =>
        on(webContentsListeners, event, listener),
      once: (event: string, listener: (...args: unknown[]) => void) =>
        once(webContentsListeners, event, listener),
    },
  };

  return {
    window: window as unknown as Electron.BrowserWindow,
    raw: window,
    sentEvents,
    emitClose: () => {
      const event = { preventDefault: vi.fn() };
      emit(windowListeners, "close", event);
      return event;
    },
  };
}

function runWithService<A, E>(
  platform: NodeJS.Platform,
  hostEnv: NodeJS.ProcessEnv,
  program: (ctx: {
    readonly service: DesktopQuickComposer.DesktopQuickComposer["Service"];
    readonly createdWindows: Array<ReturnType<typeof makeFakeWindow>>;
    readonly openedThreads: Array<DesktopQuickComposerOpenThreadInput>;
    readonly triggerMainCleared: () => void;
  }) => Effect.Effect<A, E>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      registeredShortcuts.clear();
      liveWebContents.clear();
      registerMock.mockClear();
      unregisterMock.mockClear();

      const createdWindows: Array<ReturnType<typeof makeFakeWindow>> = [];
      const openedThreads: Array<DesktopQuickComposerOpenThreadInput> = [];
      const quitting = yield* Ref.make(false);

      const service = yield* DesktopQuickComposer.make.pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
          platform,
          isDevelopment: false,
          devServerUrl: Option.none(),
          displayName: "T3 Code",
          preloadPath: "/preload.js",
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
        Effect.provideService(HostProcess.Environment, hostEnv),
        Effect.provideService(DesktopState.DesktopState, {
          quitting,
        } as DesktopState.DesktopState["Service"]),
        Effect.provideService(DesktopClientSettings.DesktopClientSettings, {
          get: Effect.succeedNone,
          set: () => Effect.void,
        }),
        Effect.provideService(ElectronWindow.ElectronWindow, {
          create: () =>
            Effect.sync(() => {
              const created = makeFakeWindow(100 + createdWindows.length);
              createdWindows.push(created);
              return created.window;
            }),
          main: Effect.succeedNone,
          currentMainOrFirst: Effect.succeedNone,
          focusedMainOrFirst: Effect.succeedNone,
          setMain: () => Effect.void,
          clearMain: () => Effect.void,
          prepareReveal: () => Effect.succeed(false),
          reveal: () => Effect.void,
          sendAll: () => Effect.void,
          destroyAll: Effect.void,
          syncAllAppearance: () => Effect.void,
        }),
        Effect.provideService(ElectronTheme.ElectronTheme, {
          shouldUseDarkColors: Effect.succeed(true),
          setSource: () => Effect.void,
          onUpdated: () => Effect.void,
        }),
        Effect.provideService(ElectronShell.ElectronShell, {
          openExternal: () => Effect.succeed(true),
        } as unknown as ElectronShell.ElectronShell["Service"]),
        Effect.provideService(DesktopWindow.DesktopThreadNavigation, {
          open: (input) =>
            Effect.sync(() => {
              openedThreads.push(input);
            }),
        }),
        Effect.provideService(DesktopRendererHistory.DesktopRendererHistory, {
          register: () => Effect.void,
          recordMetrics: () => Effect.void,
          shutdown: Effect.void,
        }),
      );

      return yield* program({
        service,
        createdWindows,
        openedThreads,
        triggerMainCleared: ElectronWindow.closeAppWindowsWithMain,
      });
    }),
  );
}

describe("DesktopQuickComposer", () => {
  it.effect("registers and suppresses its global shortcut and detects SnapShot conflicts", () =>
    runWithService("darwin", {}, ({ service }) =>
      Effect.gen(function* () {
        yield* service.configure({
          ...DEFAULT_CLIENT_SETTINGS,
          quickComposerEnabled: true,
        });
        expect((yield* service.state).shortcutRegistered).toBe(true);
        expect(registeredShortcuts.size).toBe(1);

        yield* service.setShortcutSuppressed(true);
        expect((yield* service.state).shortcutRegistered).toBe(false);
        expect(registeredShortcuts.size).toBe(0);

        yield* service.setShortcutSuppressed(false);
        expect((yield* service.state).shortcutRegistered).toBe(true);

        const conflict = yield* service.checkShortcut(
          DEFAULT_CLIENT_SETTINGS.quickComposerShortcut,
        );
        expect(conflict.available).toBe(true);
      }),
    ),
  );

  it.effect(
    "creates window lazily, toggles hide-requested when focused, opens thread in main, and cleans up on main close on Linux",
    () =>
      runWithService(
        "linux",
        { XDG_SESSION_TYPE: "x11" },
        ({ service, createdWindows, openedThreads, triggerMainCleared }) =>
          Effect.gen(function* () {
            yield* service.configure({
              ...DEFAULT_CLIENT_SETTINGS,
              quickComposerEnabled: true,
              quickComposerAutoVoice: true,
            });
            expect(createdWindows).toHaveLength(0);

            const opened = yield* service.toggle();
            expect(opened).toBe(true);
            expect(createdWindows).toHaveLength(1);
            const popout = createdWindows[0]!;
            expect(popout.raw.show).toHaveBeenCalledTimes(1);
            expect(popout.raw.focus).toHaveBeenCalledTimes(1);
            // Queued shown event waits for renderer mount readiness instead of did-finish-load.
            expect(popout.sentEvents).toHaveLength(0);

            yield* service.markReady(popout.raw.id);
            expect(popout.sentEvents.at(-1)?.payload).toEqual({
              type: "shown",
              autoVoice: true,
            } satisfies DesktopQuickComposerEvent);

            yield* service.resizeHeight(popout.raw.id + 1, 440);
            expect(popout.raw.getBounds().height).toBe(240);
            yield* service.resizeHeight(popout.raw.id, 440);
            expect(popout.raw.getBounds()).toMatchObject({ width: 680, height: 440 });
            yield* service.resizeHeight(popout.raw.id, 1000);
            expect(popout.raw.getBounds().height).toBe(540);
            yield* service.resizeHeight(popout.raw.id, 180);
            expect(popout.raw.getBounds().height).toBe(240);

            // Native OS close routes through the renderer hide handshake so active dictation stops first.
            const closeEvent = popout.emitClose();
            expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
            expect(popout.raw.hide).not.toHaveBeenCalled();
            expect(popout.sentEvents.at(-1)?.payload).toEqual({
              type: "hide-requested",
            } satisfies DesktopQuickComposerEvent);

            yield* service.toggle();
            expect(popout.sentEvents.at(-1)?.payload).toEqual({
              type: "hide-requested",
            } satisfies DesktopQuickComposerEvent);

            const openInput = {
              environmentId: EnvironmentId.make("env-1"),
              threadId: ThreadId.make("thread-1"),
            };
            yield* service.openThreadInMain(openInput);
            expect(popout.raw.hide).toHaveBeenCalledTimes(1);
            expect(openedThreads).toEqual([openInput]);

            triggerMainCleared();
            expect(popout.raw.destroy).toHaveBeenCalledTimes(1);
          }),
      ),
  );

  it.effect("arbitrates microphone ownership across windows", () =>
    runWithService("darwin", {}, ({ service }) =>
      Effect.gen(function* () {
        const mainRenderer = makeMicRenderer(10);
        liveWebContents.set(10, mainRenderer);
        liveWebContents.set(20, makeMicRenderer(20));

        expect(yield* service.acquireMic(10)).toBe(true);
        expect(yield* service.acquireMic(20)).toBe(false);
        expect(yield* service.acquireMic(10)).toBe(true);

        yield* service.releaseMic(20);
        expect(yield* service.acquireMic(20)).toBe(false);

        mainRenderer.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
        mainRenderer.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
        expect(yield* service.acquireMic(20)).toBe(false);

        mainRenderer.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
        expect(yield* service.acquireMic(20)).toBe(true);

        yield* service.releaseMic(20);
        expect(yield* service.acquireMic(10)).toBe(true);
        mainRenderer.emit("render-process-gone");
        expect(yield* service.acquireMic(20)).toBe(true);

        yield* service.releaseMic(20);
        expect(yield* service.acquireMic(10)).toBe(true);
        mainRenderer.emit("destroyed");
        expect(yield* service.acquireMic(20)).toBe(true);
      }),
    ),
  );
});
