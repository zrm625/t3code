import { ClientSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { applyLanguage } from "../../i18n/messages.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopQuickComposer from "../../quickComposer/DesktopQuickComposer.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CLIENT_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(ClientSettingsSchema),
  handler: Effect.fn("desktop.ipc.clientSettings.get")(function* () {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    return Option.getOrNull(yield* clientSettings.get);
  }),
});

export const setClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CLIENT_SETTINGS_CHANNEL,
  payload: ClientSettingsSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.clientSettings.set")(function* (settings, event) {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    const snapShot = yield* DesktopSnapShot.DesktopSnapShot;
    const quickComposer = yield* DesktopQuickComposer.DesktopQuickComposer;
    const electronWindow = yield* Effect.serviceOption(ElectronWindow.ElectronWindow);
    yield* clientSettings.set(settings);
    yield* snapShot.configure(settings);
    yield* quickComposer.configure(settings);
    yield* applyLanguage(settings.language);
    if (Option.isSome(electronWindow)) {
      const senderId = event?.sender.id;
      const windows = yield* electronWindow.value.trustedAppWindows;
      for (const window of windows) {
        if (!window.isDestroyed() && window.webContents.id !== senderId) {
          window.webContents.send(IpcChannels.CLIENT_SETTINGS_CHANGED_CHANNEL, settings);
        }
      }
    }
  }),
});
