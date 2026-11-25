import {
  isModifierPairShortcut,
  type QuickComposerShortcut,
  type SnapShotShortcut,
} from "@t3tools/contracts";

import {
  isWaylandSession,
  snapShotShortcutSystemConflict,
  toElectronAccelerator,
} from "../snapShot/snapShot.ts";

export interface QuickComposerRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const QUICK_COMPOSER_DEFAULT_WIDTH = 680;
export const QUICK_COMPOSER_DEFAULT_HEIGHT = 240;
export const QUICK_COMPOSER_MIN_WIDTH = 460;
export const QUICK_COMPOSER_MIN_HEIGHT = 172;
export const QUICK_COMPOSER_MAX_HEIGHT = 540;
export const QUICK_COMPOSER_IDLE_TEARDOWN_MS = 5 * 60 * 1_000;
export const QUICK_COMPOSER_CLI_COMMAND = "t3 quick-composer";

export type QuickComposerShortcutMode = "global-shortcut" | "cli-only";

export function resolveQuickComposerShortcutMode(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): QuickComposerShortcutMode {
  return isWaylandSession(platform, environment) ? "cli-only" : "global-shortcut";
}

export function resolveQuickComposerBounds(
  workArea: QuickComposerRect,
  size: { readonly width: number; readonly height: number } = {
    width: QUICK_COMPOSER_DEFAULT_WIDTH,
    height: QUICK_COMPOSER_DEFAULT_HEIGHT,
  },
): QuickComposerRect {
  const width = Math.min(Math.max(size.width, QUICK_COMPOSER_MIN_WIDTH), workArea.width);
  const height = Math.min(Math.max(size.height, QUICK_COMPOSER_MIN_HEIGHT), workArea.height);
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  // Spotlight-style upper-third placement leaves room for popovers below the composer.
  const preferredY = Math.round(workArea.y + workArea.height * 0.22);
  const maxY = workArea.y + Math.max(0, workArea.height - height);
  const y = Math.min(Math.max(preferredY, workArea.y), maxY);
  return { x, y, width: Math.round(width), height: Math.round(height) };
}

export function quickComposerShortcutConflict(input: {
  readonly shortcut: QuickComposerShortcut;
  readonly snapShotEnabled: boolean;
  readonly snapShotShortcut: SnapShotShortcut;
}): string | null {
  const systemConflict = snapShotShortcutSystemConflict(input.shortcut);
  if (systemConflict !== null) return systemConflict;

  if (input.snapShotEnabled && !isModifierPairShortcut(input.snapShotShortcut)) {
    if (toElectronAccelerator(input.shortcut) === toElectronAccelerator(input.snapShotShortcut)) {
      return "This shortcut is already used by SnapShots.";
    }
  }
  return null;
}
