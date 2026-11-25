import {
  DesktopQuickComposerDraftState,
  DesktopQuickComposerOpenThreadInput,
  DesktopQuickComposerShortcutAvailability,
  DesktopQuickComposerState,
  QuickComposerShortcut,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopQuickComposer from "../../quickComposer/DesktopQuickComposer.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getQuickComposerState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.QUICK_COMPOSER_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopQuickComposerState,
  handler: Effect.fn("desktop.ipc.quickComposer.getState")(function* () {
    return yield* (yield* DesktopQuickComposer.DesktopQuickComposer).state;
  }),
});

export const checkQuickComposerShortcut = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.QUICK_COMPOSER_CHECK_SHORTCUT_CHANNEL,
  payload: QuickComposerShortcut,
  result: DesktopQuickComposerShortcutAvailability,
  handler: Effect.fn("desktop.ipc.quickComposer.checkShortcut")(function* (shortcut) {
    return yield* (yield* DesktopQuickComposer.DesktopQuickComposer).checkShortcut(shortcut);
  }),
});

export const setQuickComposerShortcutSuppressed = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.QUICK_COMPOSER_SET_SHORTCUT_SUPPRESSED_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.quickComposer.setShortcutSuppressed")(function* (suppressed) {
    yield* (yield* DesktopQuickComposer.DesktopQuickComposer).setShortcutSuppressed(suppressed);
  }),
});

export const readyQuickComposer = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.QUICK_COMPOSER_READY_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.quickComposer.ready")(function* (_input, event) {
    const senderId = event?.sender.id ?? -1;
    yield* (yield* DesktopQuickComposer.DesktopQuickComposer).markReady(senderId);
  }),
});

export const toggleQuickComposer = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.QUICK_COMPOSER_TOGGLE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.quickComposer.toggle")(function* () {
    yield* (yield* DesktopQuickComposer.DesktopQuickComposer).toggle({ allowWhenDisabled: true });
  }),
});

export const hideQuickComposer = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.QUICK_COMPOSER_HIDE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.quickComposer.hide")(function* () {
    yield* (yield* DesktopQuickComposer.DesktopQuickComposer).hide;
  }),
});

export const openQuickComposerThreadInMain = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.QUICK_COMPOSER_OPEN_THREAD_CHANNEL,
  payload: DesktopQuickComposerOpenThreadInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.quickComposer.openThreadInMain")(function* (input) {
    yield* (yield* DesktopQuickComposer.DesktopQuickComposer).openThreadInMain(input);
  }),
});

export const setQuickComposerDraftState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.QUICK_COMPOSER_SET_DRAFT_STATE_CHANNEL,
  payload: DesktopQuickComposerDraftState,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.quickComposer.setDraftState")(function* (state) {
    yield* (yield* DesktopQuickComposer.DesktopQuickComposer).setDraftState(state);
  }),
});

export const resizeQuickComposerHeight = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.QUICK_COMPOSER_RESIZE_HEIGHT_CHANNEL,
  payload: Schema.Int.check(Schema.isGreaterThan(0)),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.quickComposer.resizeHeight")(function* (height, event) {
    if (!event) return;
    yield* (yield* DesktopQuickComposer.DesktopQuickComposer).resizeHeight(event.sender.id, height);
  }),
});

export const acquireQuickComposerMic = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.QUICK_COMPOSER_ACQUIRE_MIC_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.quickComposer.acquireMic")(function* (_input, event) {
    const senderId = event?.sender.id ?? -1;
    return yield* (yield* DesktopQuickComposer.DesktopQuickComposer).acquireMic(senderId);
  }),
});

export const releaseQuickComposerMic = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.QUICK_COMPOSER_RELEASE_MIC_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.quickComposer.releaseMic")(function* (_input, event) {
    const senderId = event?.sender.id ?? -1;
    yield* (yield* DesktopQuickComposer.DesktopQuickComposer).releaseMic(senderId);
  }),
});
