import { DEFAULT_CLIENT_SETTINGS, type DesktopQuickComposerState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../../test/render";
import {
  __resetClientSettingsPersistenceForTests,
  updateClientSettings,
} from "../../hooks/useSettings";
import { QuickComposerSettings } from "./QuickComposerSettings";

describe("QuickComposerSettings", () => {
  it("shows desktop-only unavailable state when desktopBridge is absent", async () => {
    __resetClientSettingsPersistenceForTests();
    using _bridge = stubGlobal("desktopBridge", undefined);

    await using screen = await render(<QuickComposerSettings />);
    await expect
      .element(screen.getByText("Quick Composer is available in the desktop app."))
      .toBeVisible();
    await expect
      .element(screen.getByRole("switch", { name: "Enable Quick Composer" }))
      .toBeDisabled();
  });

  it("enables Quick Composer and shows Wayland CLI command when mode is cli-only", async () => {
    __resetClientSettingsPersistenceForTests();
    const state: DesktopQuickComposerState = {
      supported: true,
      mode: "cli-only",
      enabled: true,
      shortcutRegistered: false,
      cliCommand: "t3 quick-composer",
    };
    const toggle = vi.fn(async () => undefined);
    using _bridge = stubGlobal("desktopBridge", {
      getClientSettings: vi.fn(async () => ({
        ...DEFAULT_CLIENT_SETTINGS,
        quickComposerEnabled: true,
      })),
      setClientSettings: vi.fn(async () => undefined),
      quickComposer: {
        getState: vi.fn(async () => state),
        checkShortcut: vi.fn(async () => ({ available: true })),
        setShortcutSuppressed: vi.fn(async () => undefined),
        toggle,
        hide: vi.fn(async () => undefined),
        openThreadInMain: vi.fn(async () => undefined),
        setDraftState: vi.fn(async () => undefined),
        acquireMic: vi.fn(async () => true),
        releaseMic: vi.fn(async () => undefined),
        onEvent: vi.fn(() => () => undefined),
        onOpenThreadInMain: vi.fn(() => () => undefined),
      },
    });
    await updateClientSettings({ quickComposerEnabled: true });

    await using screen = await render(<QuickComposerSettings />);
    await expect.element(screen.getByText("t3 quick-composer")).toBeVisible();
    await expect
      .element(screen.getByRole("switch", { name: "Start with voice dictation active" }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("switch", { name: "Start with voice dictation active" }))
      .not.toBeChecked();

    await screen.getByRole("button", { name: "Open now" }).click();
    expect(toggle).toHaveBeenCalledOnce();
  });
});
