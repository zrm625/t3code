import {
  DEFAULT_CLIENT_SETTINGS,
  type DesktopQuickComposerState,
  EnvironmentId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../../test/render";
import {
  __resetClientSettingsPersistenceForTests,
  updateClientSettings,
} from "../../hooks/useSettings";
import { chooseAudioDestination } from "../../speech/voiceConsent";
import { QuickComposerSettings } from "./QuickComposerSettings";

const AUDIO_CHOICE_KEY = "t3code:voice-audio-grant:v1";

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
        ready: vi.fn(async () => undefined),
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

  it("says where auto voice would send dictation, with a way to Voice settings", async () => {
    __resetClientSettingsPersistenceForTests();
    window.localStorage.removeItem(AUDIO_CHOICE_KEY);
    using _audioChoice = { [Symbol.dispose]: () => localStorage.removeItem(AUDIO_CHOICE_KEY) };
    const state: DesktopQuickComposerState = {
      supported: true,
      mode: "global-shortcut",
      enabled: true,
      shortcutRegistered: true,
      cliCommand: "t3 quick-composer",
    };
    using _bridge = stubGlobal("desktopBridge", {
      getClientSettings: vi.fn(async () => ({
        ...DEFAULT_CLIENT_SETTINGS,
        quickComposerEnabled: true,
      })),
      setClientSettings: vi.fn(async () => undefined),
      quickComposer: {
        getState: vi.fn(async () => state),
        setShortcutSuppressed: vi.fn(async () => undefined),
      },
    });
    await updateClientSettings({ quickComposerEnabled: true });

    await using screen = await render(<QuickComposerSettings />);
    const setUp = screen.getByRole("link", { name: "Set up voice input" });
    await expect.element(setUp).toHaveAttribute("href", "/settings/voice");

    chooseAudioDestination(null);
    await expect.element(screen.getByText("Voice input is off.")).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Open voice settings" }))
      .toHaveAttribute("href", "/settings/voice");

    // A chosen machine that is not connected cannot take dictation yet.
    chooseAudioDestination({ kind: "environment", environmentId: EnvironmentId.make("missing") });
    await expect.element(screen.getByText("Voice input unavailable")).toBeVisible();
    expect(screen.getByText(/^Dictation uses/).query()).toBeNull();
  });
});
