import type { DesktopQuickComposerState, QuickComposerShortcut } from "@t3tools/contracts";
import { msg } from "gt-react";

import type { MessageResolver } from "../../i18n/messages";

export function quickComposerUnavailableMessage(
  hasBridge: boolean,
  resolve: MessageResolver,
): string | undefined {
  if (!hasBridge) {
    return resolve(msg("Quick Composer is available in the desktop app."));
  }
  return undefined;
}

export function quickComposerStatus(
  state: DesktopQuickComposerState | null,
  enabled: boolean,
  formattedShortcut: string,
  resolve: MessageResolver,
): string | undefined {
  if (!state) return undefined;
  if (!enabled) return undefined;
  // The shortcut row below already explains the compositor binding.
  if (state.mode === "cli-only") return undefined;
  if (state.message) return state.message;
  if (state.shortcutRegistered) {
    return resolve(msg("Global shortcut active ({shortcut}).", { shortcut: formattedShortcut }));
  }
  return resolve(msg("Global shortcut is not registered."));
}

export function sameQuickComposerShortcut(
  left: QuickComposerShortcut,
  right: QuickComposerShortcut,
): boolean {
  return (
    left.key === right.key &&
    left.modKey === right.modKey &&
    left.metaKey === right.metaKey &&
    left.ctrlKey === right.ctrlKey &&
    left.altKey === right.altKey &&
    left.shiftKey === right.shiftKey
  );
}
