import type { DesktopBridge } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { QUICK_COMPOSER_OPEN_THREAD_CHANNEL } from "./ipc/channels.ts";

const { exposedBridges, ipcListeners } = vi.hoisted(() => ({
  exposedBridges: new Map<string, DesktopBridge>(),
  ipcListeners: new Map<string, (...args: unknown[]) => void>(),
}));

vi.mock("@clerk/electron/preload", () => ({ exposeClerkBridge: () => {} }));
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, bridge: DesktopBridge) => exposedBridges.set(key, bridge),
  },
  ipcRenderer: {
    on: (channel: string, listener: (...args: unknown[]) => void) =>
      ipcListeners.set(channel, listener),
    sendSync: () => undefined,
    invoke: async () => undefined,
  },
}));

it("opens the submitted thread even when the main coordinator mounts after delivery", async () => {
  vi.stubGlobal("document", Object.assign(new EventTarget(), { fullscreenElement: null }));
  vi.stubGlobal("window", new EventTarget());
  try {
    await import("./preload.ts");
    const emitOpen = (threadId: string) =>
      ipcListeners.get(QUICK_COMPOSER_OPEN_THREAD_CHANNEL)?.(
        {},
        { environmentId: "local", threadId },
      );

    emitOpen("submitted-while-loading");
    const bridge = exposedBridges.get("desktopBridge")?.quickComposer;
    if (!bridge) throw new Error("Quick Composer preload bridge was not exposed");
    const openThread = vi.fn();
    const unsubscribe = bridge.onOpenThreadInMain(openThread);
    expect(openThread).toHaveBeenCalledWith({
      environmentId: "local",
      threadId: "submitted-while-loading",
    });

    emitOpen("submitted-while-mounted");
    expect(openThread).toHaveBeenCalledTimes(2);

    unsubscribe();
    const remountOpenThread = vi.fn();
    bridge.onOpenThreadInMain(remountOpenThread)();
    expect(remountOpenThread).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
