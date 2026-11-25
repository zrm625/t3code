import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type DesktopQuickComposerDraftState,
  type DesktopQuickComposerEvent,
  type DesktopQuickComposerOpenThreadInput,
  type DesktopQuickComposerShortcutAvailability,
  type DesktopQuickComposerState,
  type QuickComposerShortcut,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as Electron from "electron";

import * as DesktopClerk from "../app/DesktopClerk.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import { getDesktopOrigin, getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  activateWindowsForeground,
  loadWindowsForegroundApi,
} from "../electron/WindowsForeground.ts";
import { QUICK_COMPOSER_EVENT_CHANNEL } from "../ipc/channels.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import { toElectronAccelerator } from "../snapShot/snapShot.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { acquireTrustedAppRemoteRequestHeaderPolicy } from "../window/RemoteRequestHeaders.ts";
import {
  QUICK_COMPOSER_CLI_COMMAND,
  QUICK_COMPOSER_DEFAULT_HEIGHT,
  QUICK_COMPOSER_DEFAULT_WIDTH,
  QUICK_COMPOSER_IDLE_TEARDOWN_MS,
  QUICK_COMPOSER_MAX_HEIGHT,
  QUICK_COMPOSER_MIN_HEIGHT,
  QUICK_COMPOSER_MIN_WIDTH,
  quickComposerShortcutConflict,
  resolveQuickComposerBounds,
  resolveQuickComposerShortcutMode,
} from "./quickComposer.ts";

// @effect-diagnostics globalTimers:off -- Idle teardown and hide-handshake fallbacks own native timers cleared on hide, show, and finalization.
const HIDE_HANDSHAKE_FALLBACK_MS = 450;

export class DesktopQuickComposer extends Context.Service<
  DesktopQuickComposer,
  {
    readonly initialize: Effect.Effect<void>;
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
    readonly state: Effect.Effect<DesktopQuickComposerState>;
    readonly checkShortcut: (
      shortcut: QuickComposerShortcut,
    ) => Effect.Effect<DesktopQuickComposerShortcutAvailability>;
    readonly setShortcutSuppressed: (suppressed: boolean) => Effect.Effect<void>;
    readonly toggle: (options?: {
      readonly activationToken?: string | undefined;
      readonly allowWhenDisabled?: boolean | undefined;
    }) => Effect.Effect<boolean>;
    readonly hide: Effect.Effect<void>;
    readonly openThreadInMain: (input: DesktopQuickComposerOpenThreadInput) => Effect.Effect<void>;
    readonly setDraftState: (draftState: DesktopQuickComposerDraftState) => Effect.Effect<void>;
    readonly acquireMic: (senderWebContentsId: number) => Effect.Effect<boolean>;
    readonly releaseMic: (senderWebContentsId: number) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/quickComposer/DesktopQuickComposer") {}

const { logInfo, logWarning } = makeComponentLogger("desktop-quick-composer");

function getInitialBackgroundColor(dark: boolean): string {
  return dark ? "#141416" : "#ffffff";
}

function isSameOriginQuickComposerNavigation(applicationOrigin: string, rawUrl: string): boolean {
  try {
    return new URL(rawUrl).origin === applicationOrigin;
  } catch {
    return false;
  }
}

function configureMacPanelWindow(window: Electron.BrowserWindow): void {
  try {
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  } catch {}
}

// Chromium/Electron's Ozone Wayland backend reads XDG_ACTIVATION_TOKEN from process.env on show().
function applyWaylandActivationToken(token: string | undefined): void {
  if (!token) return;
  process.env.XDG_ACTIVATION_TOKEN = token;
}

function tryRegisterGlobalShortcut(
  accelerator: string,
  handler: () => void,
): { readonly ok: true } | { readonly ok: false; readonly cause?: unknown } {
  try {
    return Electron.globalShortcut.register(accelerator, handler) ? { ok: true } : { ok: false };
  } catch (cause) {
    return { ok: false, cause };
  }
}

function tryProbeGlobalShortcut(accelerator: string): boolean {
  try {
    if (Electron.globalShortcut.register(accelerator, () => undefined)) {
      Electron.globalShortcut.unregister(accelerator);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const hostEnvironment = yield* HostProcess.Environment;
  const desktopState = yield* DesktopState.DesktopState;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronShell = yield* ElectronShell.ElectronShell;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const rendererHistory = yield* DesktopRendererHistory.DesktopRendererHistory;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const runSync = Effect.runSyncWith(context);

  const shortcutMode = resolveQuickComposerShortcutMode(environment.platform, hostEnvironment);
  const configMutex = yield* Semaphore.make(1);
  const windowMutex = yield* Semaphore.make(1);

  let currentSettings: ClientSettings = DEFAULT_CLIENT_SETTINGS;
  let shortcutSuppressed = false;
  let registeredAccelerator: string | null = null;
  let quickComposerWindow: Electron.BrowserWindow | null = null;
  let quickComposerReady = false;
  let pendingShowEvent: DesktopQuickComposerEvent | null = null;
  let draftState: DesktopQuickComposerDraftState = { hasContent: false, busy: false };
  let idleTeardownTimer: ReturnType<typeof setTimeout> | null = null;
  let hideHandshakeTimer: ReturnType<typeof setTimeout> | null = null;
  let previousWindowsHwnd: bigint | null = null;
  let micOwnerWebContentsId: number | null = null;

  const stateRef = yield* Ref.make<DesktopQuickComposerState>({
    supported: true,
    mode: shortcutMode,
    enabled: false,
    shortcutRegistered: false,
    cliCommand: QUICK_COMPOSER_CLI_COMMAND,
  });

  const clearIdleTimer = () => {
    if (idleTeardownTimer !== null) {
      clearTimeout(idleTeardownTimer);
      idleTeardownTimer = null;
    }
  };

  const scheduleHideHandshakeFallback = (onTimeout: () => void) => {
    clearHideHandshakeTimer();
    hideHandshakeTimer = setTimeout(() => {
      hideHandshakeTimer = null;
      onTimeout();
    }, HIDE_HANDSHAKE_FALLBACK_MS);
  };

  const clearHideHandshakeTimer = () => {
    if (hideHandshakeTimer !== null) {
      clearTimeout(hideHandshakeTimer);
      hideHandshakeTimer = null;
    }
  };

  const unregisterShortcut = () => {
    if (registeredAccelerator === null) return;
    try {
      Electron.globalShortcut.unregister(registeredAccelerator);
    } catch {}
    registeredAccelerator = null;
  };

  const destroyWindowNow = () => {
    clearIdleTimer();
    clearHideHandshakeTimer();
    const target = quickComposerWindow;
    quickComposerWindow = null;
    quickComposerReady = false;
    pendingShowEvent = null;
    if (target && !target.isDestroyed()) {
      if (micOwnerWebContentsId === target.webContents.id) {
        micOwnerWebContentsId = null;
      }
      target.destroy();
    }
  };

  const scheduleIdleTeardown = () => {
    clearIdleTimer();
    if (draftState.hasContent || draftState.busy) return;
    const target = quickComposerWindow;
    if (!target || target.isDestroyed() || target.isVisible()) return;
    idleTeardownTimer = setTimeout(() => {
      idleTeardownTimer = null;
      if (draftState.hasContent || draftState.busy) return;
      if (
        quickComposerWindow &&
        !quickComposerWindow.isDestroyed() &&
        !quickComposerWindow.isVisible()
      ) {
        destroyWindowNow();
      }
    }, QUICK_COMPOSER_IDLE_TEARDOWN_MS);
  };

  const releaseWindowsFocus = () => {
    const hwnd = previousWindowsHwnd;
    previousWindowsHwnd = null;
    if (environment.platform !== "win32" || hwnd === null || hwnd === 0n) return;
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(hwnd);
    void activateWindowsForeground(buf).catch(() => undefined);
  };

  const hideWindowNow = Effect.fn("desktop.quickComposer.hideNow")(() =>
    Effect.sync(() => {
      clearHideHandshakeTimer();
      const target = quickComposerWindow;
      if (!target || target.isDestroyed()) {
        previousWindowsHwnd = null;
        return;
      }
      if (target.isVisible()) {
        target.hide();
      }
      releaseWindowsFocus();
      scheduleIdleTeardown();
    }),
  );

  const sendEventToWindow = (target: Electron.BrowserWindow, event: DesktopQuickComposerEvent) => {
    if (target.isDestroyed()) return;
    target.webContents.send(QUICK_COMPOSER_EVENT_CHANNEL, event);
  };

  const positionWindowOnCursorDisplay = (target: Electron.BrowserWindow) => {
    if (shortcutMode === "cli-only") return;
    try {
      const cursorPoint = Electron.screen.getCursorScreenPoint();
      const display = Electron.screen.getDisplayNearestPoint(cursorPoint);
      const currentBounds = target.getBounds();
      const nextBounds = resolveQuickComposerBounds(display.workArea, {
        width: currentBounds.width || QUICK_COMPOSER_DEFAULT_WIDTH,
        height: currentBounds.height || QUICK_COMPOSER_DEFAULT_HEIGHT,
      });
      target.setBounds(nextBounds);
    } catch {}
  };

  const ensureWindow = Effect.fn("desktop.quickComposer.ensureWindow")(function* () {
    if (quickComposerWindow && !quickComposerWindow.isDestroyed()) {
      return Option.some(quickComposerWindow);
    }
    if (yield* Ref.get(desktopState.quitting)) {
      return Option.none<Electron.BrowserWindow>();
    }

    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    const applicationOrigin = getDesktopOrigin(environment.isDevelopment);
    const applicationUrl = `${getDesktopUrl(environment.isDevelopment)}#/quick-composer`;

    const window = yield* electronWindow
      .create(
        {
          width: QUICK_COMPOSER_DEFAULT_WIDTH,
          height: QUICK_COMPOSER_DEFAULT_HEIGHT,
          minWidth: QUICK_COMPOSER_MIN_WIDTH,
          minHeight: QUICK_COMPOSER_MIN_HEIGHT,
          maxHeight: QUICK_COMPOSER_MAX_HEIGHT,
          frame: false,
          transparent: false,
          resizable: true,
          show: false,
          alwaysOnTop: true,
          skipTaskbar: true,
          fullscreenable: false,
          maximizable: false,
          minimizable: false,
          autoHideMenuBar: true,
          backgroundColor: getInitialBackgroundColor(shouldUseDarkColors),
          title: `${environment.displayName} Quick Composer`,
          ...(environment.platform === "darwin" ? { type: "panel" as const } : {}),
          webPreferences: {
            preload: environment.preloadPath,
            backgroundThrottling: true,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
        { auxiliary: true, trustedApp: true },
      )
      .pipe(
        Effect.catch((error) =>
          logWarning("failed to create Quick Composer window", { message: error.message }).pipe(
            Effect.as(null),
          ),
        ),
      );

    if (window === null) {
      return Option.none<Electron.BrowserWindow>();
    }

    if (environment.platform === "darwin") {
      configureMacPanelWindow(window);
    }

    yield* rendererHistory.register(window.webContents, { surface: "quick-composer" });

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (Option.isSome(ElectronShell.parseWebExternalUrl(url))) {
        void runPromise(electronShell.openExternal(url));
      }
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (!isSameOriginQuickComposerNavigation(applicationOrigin, url)) {
        event.preventDefault();
      }
    });

    quickComposerWindow = window;
    quickComposerReady = false;

    const webContentsId = window.webContents.id;
    const releaseRemoteRequestHeaders = acquireTrustedAppRemoteRequestHeaderPolicy(
      window.webContents.session,
      webContentsId,
      {
        desktopOrigin: applicationOrigin,
        isAllowedWebContentsId: (id) => runSync(electronWindow.isTrustedAppWebContentsId(id)),
        clerkFrontendApiHostname: DesktopClerk.desktopClerkFrontendApiHostname,
        devServerOrigin: Option.getOrUndefined(
          Option.map(environment.devServerUrl, (url) => url.origin),
        ),
        isDevelopment: environment.isDevelopment,
      },
    );
    window.webContents.once("did-finish-load", () => {
      if (quickComposerWindow !== window || window.isDestroyed()) return;
      quickComposerReady = true;
      if (pendingShowEvent !== null) {
        const queued = pendingShowEvent;
        pendingShowEvent = null;
        sendEventToWindow(window, queued);
      }
    });
    window.on("close", (event) => {
      if (!window.isDestroyed() && quickComposerWindow === window) {
        event.preventDefault();
        void runPromise(hideWindowNow());
      }
    });
    window.once("closed", () => {
      releaseRemoteRequestHeaders();
      if (micOwnerWebContentsId === webContentsId) {
        micOwnerWebContentsId = null;
      }
      if (quickComposerWindow === window) {
        quickComposerWindow = null;
        quickComposerReady = false;
        pendingShowEvent = null;
        clearIdleTimer();
        clearHideHandshakeTimer();
      }
    });

    void window.loadURL(applicationUrl).catch((cause) => {
      void runPromise(logWarning("failed to load Quick Composer URL", { cause }));
    });

    return Option.some(window);
  });

  const showWindow = Effect.fn("desktop.quickComposer.show")(function* (activationToken?: string) {
    clearIdleTimer();
    clearHideHandshakeTimer();

    if (environment.platform === "win32") {
      previousWindowsHwnd = yield* Effect.promise(() =>
        loadWindowsForegroundApi()
          .then((api) => api.getForegroundWindow())
          .catch(() => null),
      );
    }

    if (environment.platform === "linux") {
      applyWaylandActivationToken(activationToken);
    }

    const windowOpt = yield* ensureWindow();
    if (Option.isNone(windowOpt)) return;
    const target = windowOpt.value;
    if (target.isDestroyed()) return;

    positionWindowOnCursorDisplay(target);

    const shownEvent: DesktopQuickComposerEvent = {
      type: "shown",
      autoVoice: currentSettings.quickComposerAutoVoice,
    };

    const revealTarget = () => {
      if (target.isDestroyed()) return;
      target.show();
      target.focus();
      if (quickComposerReady) {
        sendEventToWindow(target, shownEvent);
      } else {
        pendingShowEvent = shownEvent;
      }
    };

    if (quickComposerReady) {
      revealTarget();
    } else {
      pendingShowEvent = shownEvent;
      target.once("ready-to-show", () => {
        if (quickComposerWindow === target && !target.isDestroyed()) {
          positionWindowOnCursorDisplay(target);
          target.show();
          target.focus();
        }
      });
    }
  });

  const toggle = Effect.fn("desktop.quickComposer.toggle")(function* (options?: {
    readonly activationToken?: string | undefined;
    readonly allowWhenDisabled?: boolean | undefined;
  }) {
    if (yield* Ref.get(desktopState.quitting)) return false;
    if (!currentSettings.quickComposerEnabled && options?.allowWhenDisabled !== true) {
      return false;
    }

    const existing = quickComposerWindow;
    if (existing && !existing.isDestroyed() && existing.isVisible() && existing.isFocused()) {
      sendEventToWindow(existing, { type: "hide-requested" });
      scheduleHideHandshakeFallback(() => {
        void runPromise(hideWindowNow());
      });
      return true;
    }

    yield* showWindow(options?.activationToken);
    return true;
  }, windowMutex.withPermits(1));

  const applySettings = Effect.fn("desktop.quickComposer.applySettings")(function* (
    settings: ClientSettings,
  ) {
    currentSettings = settings;
    unregisterShortcut();

    if (!settings.quickComposerEnabled) {
      yield* Ref.set(stateRef, {
        supported: true,
        mode: shortcutMode,
        enabled: false,
        shortcutRegistered: false,
        cliCommand: QUICK_COMPOSER_CLI_COMMAND,
      });
      if (!draftState.hasContent && !draftState.busy) {
        destroyWindowNow();
      }
      return;
    }

    if (shortcutMode === "cli-only") {
      yield* Ref.set(stateRef, {
        supported: true,
        mode: "cli-only",
        enabled: true,
        shortcutRegistered: false,
        cliCommand: QUICK_COMPOSER_CLI_COMMAND,
      });
      return;
    }

    const accelerator = toElectronAccelerator(settings.quickComposerShortcut);
    if (shortcutSuppressed) {
      yield* Ref.set(stateRef, {
        supported: true,
        mode: "global-shortcut",
        enabled: true,
        shortcutRegistered: false,
        shortcutLabel: accelerator,
        cliCommand: QUICK_COMPOSER_CLI_COMMAND,
      });
      return;
    }

    const conflict = quickComposerShortcutConflict({
      shortcut: settings.quickComposerShortcut,
      snapShotEnabled: settings.snapShotEnabled,
      snapShotShortcut: settings.snapShotShortcut,
    });
    if (conflict !== null) {
      yield* Ref.set(stateRef, {
        supported: true,
        mode: "global-shortcut",
        enabled: true,
        shortcutRegistered: false,
        shortcutLabel: accelerator,
        message: conflict,
        cliCommand: QUICK_COMPOSER_CLI_COMMAND,
      });
      return;
    }

    const registration = tryRegisterGlobalShortcut(accelerator, () => {
      void runPromise(toggle().pipe(Effect.ignore));
    });
    if (!registration.ok && registration.cause !== undefined) {
      yield* logWarning("failed to register Quick Composer global shortcut", {
        accelerator,
        cause: registration.cause,
      });
    }

    if (registration.ok) {
      registeredAccelerator = accelerator;
      yield* logInfo("registered Quick Composer global shortcut", { accelerator });
      yield* Ref.set(stateRef, {
        supported: true,
        mode: "global-shortcut",
        enabled: true,
        shortcutRegistered: true,
        shortcutLabel: accelerator,
        cliCommand: QUICK_COMPOSER_CLI_COMMAND,
      });
    } else {
      yield* Ref.set(stateRef, {
        supported: true,
        mode: "global-shortcut",
        enabled: true,
        shortcutRegistered: false,
        shortcutLabel: accelerator,
        message: "This shortcut is already used by the system or another app.",
        cliCommand: QUICK_COMPOSER_CLI_COMMAND,
      });
    }
  });

  const configure = Effect.fn("desktop.quickComposer.configure")(function* (
    settings: ClientSettings,
  ) {
    yield* applySettings(settings);
  }, configMutex.withPermits(1));

  const checkShortcut = Effect.fn("desktop.quickComposer.checkShortcut")(
    (shortcut: QuickComposerShortcut): Effect.Effect<DesktopQuickComposerShortcutAvailability> =>
      Effect.sync(() => {
        if (shortcutMode === "cli-only") {
          return {
            available: true,
            accelerator: toElectronAccelerator(shortcut),
          };
        }

        const accelerator = toElectronAccelerator(shortcut);
        const conflict = quickComposerShortcutConflict({
          shortcut,
          snapShotEnabled: currentSettings.snapShotEnabled,
          snapShotShortcut: currentSettings.snapShotShortcut,
        });
        if (conflict !== null) {
          return { available: false, accelerator, message: conflict };
        }
        if (registeredAccelerator === accelerator) {
          return { available: true, accelerator };
        }

        const available = tryProbeGlobalShortcut(accelerator);

        return available
          ? { available: true, accelerator }
          : {
              available: false,
              accelerator,
              message: "This shortcut is already used by the system or another app.",
            };
      }),
    configMutex.withPermits(1),
  );

  const setShortcutSuppressed = Effect.fn("desktop.quickComposer.setShortcutSuppressed")(function* (
    suppressed: boolean,
  ) {
    if (shortcutSuppressed === suppressed) return;
    shortcutSuppressed = suppressed;
    yield* applySettings(currentSettings);
  }, configMutex.withPermits(1));

  // Destroy the auxiliary window when the main window closes on Linux/Windows so
  // `window-all-closed` still exits the app cleanly.
  if (environment.platform !== "darwin") {
    yield* electronWindow.onMainCleared(() => {
      destroyWindowNow();
    });
  }

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unregisterShortcut();
      destroyWindowNow();
    }),
  );

  return DesktopQuickComposer.of({
    initialize: configMutex.withPermits(1)(
      clientSettings.get.pipe(
        Effect.flatMap((stored) =>
          applySettings(Option.getOrElse(stored, () => DEFAULT_CLIENT_SETTINGS)),
        ),
        Effect.ignore,
      ),
    ),
    configure,
    state: Ref.get(stateRef),
    checkShortcut,
    setShortcutSuppressed,
    toggle,
    hide: hideWindowNow().pipe(windowMutex.withPermits(1)),
    openThreadInMain: Effect.fn("desktop.quickComposer.openThreadInMain")(function* (input) {
      yield* hideWindowNow();
      previousWindowsHwnd = null;
      yield* desktopWindow.dispatchQuickComposerOpenThread(input).pipe(Effect.ignore);
    }, windowMutex.withPermits(1)),
    setDraftState: Effect.fn("desktop.quickComposer.setDraftState")((next) =>
      Effect.sync(() => {
        draftState = next;
        if (next.hasContent || next.busy) {
          clearIdleTimer();
        } else {
          scheduleIdleTeardown();
        }
      }),
    ),
    acquireMic: Effect.fn("desktop.quickComposer.acquireMic")((senderWebContentsId) =>
      Effect.sync(() => {
        if (micOwnerWebContentsId !== null && micOwnerWebContentsId !== senderWebContentsId) {
          const ownerAlive = Electron.webContents
            .getAllWebContents()
            .some((contents) => contents.id === micOwnerWebContentsId && !contents.isDestroyed());
          if (ownerAlive) {
            return false;
          }
        }
        micOwnerWebContentsId = senderWebContentsId;
        return true;
      }),
    ),
    releaseMic: Effect.fn("desktop.quickComposer.releaseMic")((senderWebContentsId) =>
      Effect.sync(() => {
        if (micOwnerWebContentsId === senderWebContentsId) {
          micOwnerWebContentsId = null;
        }
      }),
    ),
  });
});

export const layer = Layer.effect(DesktopQuickComposer, make);
