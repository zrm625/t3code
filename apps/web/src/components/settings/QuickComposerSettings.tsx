import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type {
  ClientSettingsPatch,
  DesktopQuickComposerShortcutAvailability,
  DesktopQuickComposerState,
  QuickComposerShortcut,
} from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { CheckIcon, CopyIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  updateClientSettings,
  useClientSettings,
  useClientSettingsHydrated,
} from "../../hooks/useSettings";
import { m, type MessageResolver } from "../../i18n/messages";
import {
  formatSnapShotShortcutLabel,
  snapShotKeybindingConflict,
} from "../../lib/snapShotShortcut";
import { useVoiceTranscriptionDestination } from "../../speech/useEnvironmentSpeechInput";
import { useAudioChoice } from "../../speech/voiceConsent";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { SnapShotShortcutKeys } from "../desktop/SnapShotShortcutKeys";
import { Button, InlineButton } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { commandLabel, keybindingFromKeyboardEvent } from "./KeybindingsSettings.logic";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsUnavailableGroup,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

function quickComposerUnavailableMessage(
  hasBridge: boolean,
  resolve: MessageResolver,
): string | undefined {
  if (!hasBridge) {
    return resolve(msg("Quick Composer is available in the desktop app."));
  }
  return undefined;
}

function quickComposerStatus(
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

function sameQuickComposerShortcut(
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

type ShortcutCheckState =
  | { readonly status: "idle"; readonly availability: null }
  | { readonly status: "checking"; readonly availability: null }
  | {
      readonly status: "checked";
      readonly availability: DesktopQuickComposerShortcutAvailability;
    };

export function QuickComposerSettings() {
  const gt = useGT();
  const messages = useMessages();
  const setting = useSearchableSetting();
  const settings = useClientSettings((current) => ({
    quickComposerEnabled: current.quickComposerEnabled,
    quickComposerShortcut: current.quickComposerShortcut,
    quickComposerAutoVoice: current.quickComposerAutoVoice,
  }));
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const bridge = typeof window !== "undefined" ? window.desktopBridge?.quickComposer : undefined;

  const [state, setState] = useState<DesktopQuickComposerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [candidate, setCandidate] = useState<QuickComposerShortcut>(settings.quickComposerShortcut);
  const [shortcutCheck, setShortcutCheck] = useState<ShortcutCheckState>({
    status: "idle",
    availability: null,
  });
  const [recorderError, setRecorderError] = useState<string | null>(null);
  const checkSeqRef = useRef(0);

  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: {
      target: "quick-composer-cli-command",
      unavailableMessage: msg("Clipboard API is unavailable while copying the command."),
      failureMessage: msg("Failed to copy command to the clipboard."),
    },
  });

  const refreshState = async () => {
    if (!bridge) return null;
    try {
      const next = await bridge.getState();
      setState(next);
      return next;
    } catch {
      return null;
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads desktop Quick Composer state from the Electron bridge on mount
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge
      .getState()
      .then((next) => {
        if (active) setState(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      void bridge.setShortcutSuppressed(false).catch(() => undefined);
    };
  }, [bridge]);

  const savedShortcut = settings.quickComposerShortcut;
  const shortcutChanged = !sameQuickComposerShortcut(candidate, savedShortcut);
  const appConflict = snapShotKeybindingConflict(candidate, keybindings);

  const stopRecording = () => {
    setRecording(false);
    void bridge?.setShortcutSuppressed(false).catch(() => undefined);
  };

  const startRecording = async () => {
    if (!bridge || busy) return;
    setRecorderError(null);
    try {
      await bridge.setShortcutSuppressed(true);
      setRecording(true);
    } catch (error) {
      setRecorderError(
        error instanceof Error
          ? (thrownErrorMessage(error, m) ?? error.message)
          : gt("Could not start shortcut recording."),
      );
    }
  };

  const handleShortcutKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording || event.key === "Tab" || event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stopRecording();
      return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) return;
    const input = keybindingFromKeyboardEvent(event, navigator.platform);
    if (!input) return;
    const parsed = parseKeybindingShortcut(input);
    if (!parsed) return;
    if (
      !parsed.metaKey &&
      !parsed.ctrlKey &&
      !parsed.altKey &&
      !parsed.shiftKey &&
      !parsed.modKey
    ) {
      return;
    }
    stopRecording();
    setCandidate(parsed);
    setRecorderError(null);
    if (sameQuickComposerShortcut(parsed, savedShortcut)) {
      setShortcutCheck({ status: "idle", availability: null });
      return;
    }
    if (snapShotKeybindingConflict(parsed, keybindings) !== null) {
      setShortcutCheck({ status: "idle", availability: null });
      return;
    }
    if (!bridge) return;
    const seq = ++checkSeqRef.current;
    setShortcutCheck({ status: "checking", availability: null });
    void bridge
      .checkShortcut(parsed)
      .then((availability) => {
        if (checkSeqRef.current === seq) {
          setShortcutCheck({ status: "checked", availability });
        }
      })
      .catch(() => {
        if (checkSeqRef.current === seq) {
          setShortcutCheck({ status: "idle", availability: null });
        }
      });
  };

  const save = async (patch: ClientSettingsPatch) => {
    setBusy(true);
    let saveError: unknown = null;
    try {
      await updateClientSettings(patch);
      await refreshState();
    } catch (error) {
      saveError = error;
    }
    setBusy(false);
    if (saveError !== null) {
      toastManager.add({
        type: "error",
        title: gt("Could not update Quick Composer settings"),
        description: thrownErrorMessage(saveError, m) ?? undefined,
      });
    }
  };

  const canSaveShortcut =
    shortcutChanged &&
    appConflict === null &&
    shortcutCheck.status !== "checking" &&
    (shortcutCheck.status !== "checked" || shortcutCheck.availability.available);

  const shortcutStatus =
    recorderError ??
    (appConflict !== null
      ? gt("Already used in T3 Code for {command}.", {
          command: messages(commandLabel(appConflict)),
        })
      : shortcutCheck.status === "checking"
        ? gt("Checking shortcut…")
        : shortcutCheck.status === "checked" && !shortcutCheck.availability.available
          ? (shortcutCheck.availability.message ??
            gt("This shortcut is already used by the system or another app."))
          : undefined);

  const unavailableMessage = quickComposerUnavailableMessage(Boolean(bridge), messages);
  const cliCommand = state?.cliCommand ?? "t3 quick-composer";

  return (
    <SettingsPageContainer>
      <SettingsSection id="quick-composer" title={gt("Quick Composer")}>
        <SettingsUnavailableGroup message={unavailableMessage}>
          <SettingsRow
            {...setting("quick-composer-enabled")}
            description={gt(
              "Open a floating composer from anywhere to start a new thread without raising the main window.",
            )}
            status={quickComposerStatus(
              state,
              settings.quickComposerEnabled,
              formatSnapShotShortcutLabel(savedShortcut),
              messages,
            )}
            control={
              <>
                {bridge && settings.quickComposerEnabled ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void bridge.toggle().catch(() => undefined)}
                  >
                    <T>Open now</T>
                  </Button>
                ) : null}
                <Switch
                  checked={settings.quickComposerEnabled}
                  disabled={!bridge || busy}
                  aria-label={gt("Enable Quick Composer")}
                  onCheckedChange={(checked) => void save({ quickComposerEnabled: checked })}
                />
              </>
            }
          />

          {settings.quickComposerEnabled && bridge ? (
            <>
              {state?.mode === "cli-only" ? (
                <SettingsRow
                  {...setting("quick-composer-shortcut")}
                  description={gt(
                    "Wayland compositors manage global shortcuts. Bind this command in Hyprland, Niri, KDE, or GNOME:",
                  )}
                  control={
                    <div className="flex items-center gap-2">
                      <code className="rounded-md border border-border bg-muted/50 px-2 py-1 font-mono text-xs text-foreground">
                        {cliCommand}
                      </code>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => copyToClipboard(cliCommand)}
                      >
                        {isCopied ? (
                          <CheckIcon className="size-3.5 text-success" />
                        ) : (
                          <CopyIcon className="size-3.5" />
                        )}
                        {isCopied ? gt("Copied") : gt("Copy")}
                      </Button>
                    </div>
                  }
                />
              ) : (
                <SettingsRow
                  {...setting("quick-composer-shortcut")}
                  description={gt("Toggle the floating Quick Composer window from any app.")}
                  status={shortcutStatus}
                  control={
                    <>
                      <Button
                        size="xs"
                        variant={recording ? "default" : "outline"}
                        disabled={busy}
                        aria-label={
                          recording
                            ? gt("Press your new shortcut")
                            : gt("Quick Composer shortcut: {shortcut}", {
                                shortcut: formatSnapShotShortcutLabel(candidate),
                              })
                        }
                        onClick={() => {
                          if (recording) stopRecording();
                          else void startRecording();
                        }}
                        onBlur={() => {
                          if (recording) stopRecording();
                        }}
                        onKeyDown={handleShortcutKeyDown}
                      >
                        {recording ? (
                          <T>Press shortcut…</T>
                        ) : (
                          <SnapShotShortcutKeys shortcut={candidate} />
                        )}
                      </Button>
                      {shortcutChanged ? (
                        <>
                          <Button
                            size="xs"
                            disabled={!canSaveShortcut || busy}
                            onClick={() => {
                              void save({ quickComposerShortcut: candidate }).then(() => {
                                setShortcutCheck({ status: "idle", availability: null });
                              });
                            }}
                          >
                            {busy ? gt("Saving…") : gt("Save")}
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => {
                              stopRecording();
                              checkSeqRef.current++;
                              setCandidate(savedShortcut);
                              setShortcutCheck({ status: "idle", availability: null });
                              setRecorderError(null);
                            }}
                          >
                            <T>Cancel</T>
                          </Button>
                        </>
                      ) : null}
                    </>
                  }
                />
              )}

              <SettingsRow
                {...setting("quick-composer-auto-voice")}
                description={gt(
                  "Immediately start voice dictation whenever Quick Composer opens, when voice input is configured.",
                )}
                status={<AutoVoiceStatus />}
                control={
                  <Switch
                    checked={settings.quickComposerAutoVoice}
                    disabled={busy}
                    aria-label={gt("Start with voice dictation active")}
                    onCheckedChange={(checked) => void save({ quickComposerAutoVoice: checked })}
                  />
                }
              />
            </>
          ) : null}
        </SettingsUnavailableGroup>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

/**
 * Where dictation would go, from the Voice settings choice alone. Microphone access is asked
 * for when recording starts, so it is not part of this.
 */
function AutoVoiceStatus() {
  const gt = useGT();
  const hydrated = useClientSettingsHydrated();
  const choice = useAudioChoice();
  const destination = useVoiceTranscriptionDestination();
  if (!hydrated) return null;
  const link = (label: string) => (
    <InlineButton render={<Link to="/settings/voice" />}>{label}</InlineButton>
  );
  if (choice === null) return link(gt("Set up voice input"));
  const summary =
    choice === "off"
      ? gt("Voice input is off.")
      : destination.label !== null && (destination.onDevice || destination.prepared !== null)
        ? gt("Dictation uses {destination}.", { destination: destination.label })
        : gt("Voice input unavailable");
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span>{summary}</span>
      {link(gt("Open voice settings"))}
    </span>
  );
}
