import { DEFAULT_QUICK_COMPOSER_SHORTCUT, type QuickComposerShortcut } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  QUICK_COMPOSER_DEFAULT_HEIGHT,
  QUICK_COMPOSER_DEFAULT_WIDTH,
  quickComposerShortcutConflict,
  resolveQuickComposerBounds,
  resolveQuickComposerShortcutMode,
} from "./quickComposer.ts";

describe("quickComposer", () => {
  it("centers horizontally in the upper third of a secondary display workArea", () => {
    const bounds = resolveQuickComposerBounds({
      x: 1920,
      y: 40,
      width: 2560,
      height: 1400,
    });
    expect(bounds).toEqual({
      x: 1920 + Math.round((2560 - QUICK_COMPOSER_DEFAULT_WIDTH) / 2),
      y: 40 + Math.round(1400 * 0.22),
      width: QUICK_COMPOSER_DEFAULT_WIDTH,
      height: QUICK_COMPOSER_DEFAULT_HEIGHT,
    });
  });

  it("clamps bounds to fit a small display workArea", () => {
    const bounds = resolveQuickComposerBounds({
      x: -1280,
      y: 0,
      width: 500,
      height: 200,
    });
    expect(bounds.x).toBeGreaterThanOrEqual(-1280);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.width).toBe(500);
    expect(bounds.height).toBe(200);
  });

  it("rejects shortcuts that collide with enabled SnapShots key chords", () => {
    const chord: QuickComposerShortcut = {
      key: "k",
      modKey: true,
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    };
    expect(
      quickComposerShortcutConflict({
        shortcut: chord,
        snapShotEnabled: true,
        snapShotShortcut: chord,
      }),
    ).toBe("This shortcut is already used by SnapShots.");

    expect(
      quickComposerShortcutConflict({
        shortcut: chord,
        snapShotEnabled: false,
        snapShotShortcut: chord,
      }),
    ).toBeNull();

    expect(
      quickComposerShortcutConflict({
        shortcut: DEFAULT_QUICK_COMPOSER_SHORTCUT,
        snapShotEnabled: true,
        snapShotShortcut: { kind: "both-shift-keys" },
      }),
    ).toBeNull();
  });

  it("uses cli-only mode on Linux Wayland and global-shortcut elsewhere", () => {
    expect(resolveQuickComposerShortcutMode("darwin", {})).toBe("global-shortcut");
    expect(resolveQuickComposerShortcutMode("win32", {})).toBe("global-shortcut");
    expect(resolveQuickComposerShortcutMode("linux", { XDG_SESSION_TYPE: "x11" })).toBe(
      "global-shortcut",
    );
    expect(resolveQuickComposerShortcutMode("linux", { XDG_SESSION_TYPE: "wayland" })).toBe(
      "cli-only",
    );
  });
});
