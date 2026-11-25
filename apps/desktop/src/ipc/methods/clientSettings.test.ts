import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vite-plus/test";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopQuickComposer from "../../quickComposer/DesktopQuickComposer.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import * as IpcChannels from "../channels.ts";
import { setClientSettings } from "./clientSettings.ts";

describe("clientSettings IPC", () => {
  it.effect("broadcasts updated settings to other trusted app windows only", () =>
    Effect.gen(function* () {
      const mainSend = vi.fn();
      const popoutSend = vi.fn();
      const mainWindow = {
        isDestroyed: () => false,
        webContents: { id: 1, send: mainSend },
      } as unknown as Electron.BrowserWindow;
      const popoutWindow = {
        isDestroyed: () => false,
        webContents: { id: 2, send: popoutSend },
      } as unknown as Electron.BrowserWindow;

      const updated = { ...DEFAULT_CLIENT_SETTINGS, quickComposerEnabled: true };
      yield* setClientSettings
        .handler(updated, { sender: { id: 1 } } as Electron.IpcMainInvokeEvent)
        .pipe(
          Effect.provideService(DesktopClientSettings.DesktopClientSettings, {
            get: Effect.succeedNone,
            set: () => Effect.void,
          }),
          Effect.provideService(DesktopSnapShot.DesktopSnapShot, {
            configure: () => Effect.void,
          } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
          Effect.provideService(DesktopQuickComposer.DesktopQuickComposer, {
            configure: () => Effect.void,
          } as unknown as DesktopQuickComposer.DesktopQuickComposer["Service"]),
          Effect.provideService(ElectronWindow.ElectronWindow, {
            trustedAppWindows: Effect.succeed([mainWindow, popoutWindow]),
          } as unknown as ElectronWindow.ElectronWindow["Service"]),
          Effect.provideService(ElectronApp.ElectronApp, {
            preferredSystemLanguages: Effect.succeed(["en-US"]),
          } as unknown as ElectronApp.ElectronApp["Service"]),
        );

      expect(mainSend).not.toHaveBeenCalled();
      expect(popoutSend).toHaveBeenCalledExactlyOnceWith(
        IpcChannels.CLIENT_SETTINGS_CHANGED_CHANNEL,
        updated,
      );
    }),
  );
});
