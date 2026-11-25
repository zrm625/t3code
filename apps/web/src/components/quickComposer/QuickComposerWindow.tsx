import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ProjectId,
  type ScopedProjectRef,
  ThreadId,
} from "@t3tools/contracts";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import { T, useGT } from "gt-react";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  MessageSquareDashedIcon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  composerDraftHasUserContent,
  flushComposerDraftStorage,
  QUICK_COMPOSER_DRAFT_ID,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { collapseExpandedComposerCursor } from "../../composer-logic";
import { formatShortcutLabel } from "../../keybindings";
import { releaseDraftAttachments } from "../../lib/attachmentUploadQueue";
import { newThreadId } from "../../lib/utils";
import { setStandaloneDraftProject } from "../../lib/draftWorkspaceDefaults";
import { seedDraftModelSelection } from "../../lib/seedDraftModelSelection";
import { useScratchProject } from "../../hooks/useScratchProject";
import {
  buildSidebarProjectPickerEntries,
  projectGroupsSpanEnvironments,
} from "../../sidebarProjectGrouping";
import { useProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import ChatView, { type DraftComposerLaneProps, type DraftLaunchState } from "../ChatView";
import type { ChatComposerHandle, ComposerFooterActionsProps } from "../chat/ChatComposer";
import { ComposerPrimaryActions } from "../chat/ComposerPrimaryActions";
import { draftSendState, restoreComposerDraft } from "../chat/chatViewSend";
import type { RetainedComposerFailure } from "../chat/useComposerSend";
import { useSortedProjectGroups } from "../CommandPaletteLookups";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button, InlineButton } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import {
  quickComposerSubmissionIntent,
  readLastQuickComposerTarget,
  resolveInitialQuickComposerTarget,
  writeLastQuickComposerTarget,
} from "./quickComposer.logic";
import {
  QuickComposerRecoveryAlert,
  type QuickComposerRecoveryEntry,
} from "./QuickComposerRecoveryAlert";

const NO_PROJECT_VALUE = "__quick-composer:no-project__";
// Builds before every new slot reserved its own thread id could save the draft id as one.
const RESERVED_SLOT_THREAD_ID = ThreadId.make(QUICK_COMPOSER_DRAFT_ID);

const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]';

// Closed selects and menus can stay mounted without a box, so only an overlay on screen owns Escape.
function hasVisibleOverlay(): boolean {
  for (const element of document.querySelectorAll(OVERLAY_SELECTOR)) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
  }
  return false;
}

interface PickerItem {
  readonly value: string;
  readonly label: string;
}

export function QuickComposerWindow() {
  const gt = useGT();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  // Remounts ChatView per accepted send so the sent thread's setup and dispatch state stay behind.
  const [acceptedSendCount, setAcceptedSendCount] = useState(0);
  // Opening the scratch project is a server round trip; a later choice supersedes its result.
  const scratchRequestRef = useRef(0);
  const [scratchPending, setScratchPending] = useState(false);
  const [composerActivity, setComposerActivity] = useState({ busy: false, sending: false });
  // Outlives the ChatView remount after an accepted send: each entry is a failed message's only copy.
  const [failedMessages, setFailedMessages] = useState<
    readonly (RetainedComposerFailure & { readonly id: number })[]
  >([]);
  const failedMessageIdRef = useRef(0);
  const pickerFilter = useComboboxFilter();

  const draftSession = useComposerDraftStore((store) =>
    store.getDraftSession(QUICK_COMPOSER_DRAFT_ID),
  );
  const hasDraftContent = useComposerDraftStore((store) =>
    composerDraftHasUserContent(store.getComposerDraft(QUICK_COMPOSER_DRAFT_ID)),
  );
  const rotateDraftThreadId = useComposerDraftStore((store) => store.rotateDraftThreadId);

  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment] as const),
  );
  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const environmentMachineById = new Map(
    environments.flatMap((environment) => {
      const kind = resolveEnvironmentMachineKind(environment.serverConfig);
      return kind === undefined ? [] : [[environment.environmentId, kind] as const];
    }),
  );
  const projectGroups = useSortedProjectGroups(environmentLabelById);
  const showProjectEnvironments = projectGroupsSpanEnvironments(projectGroups);

  const activeProjectRef: ScopedProjectRef | null = draftSession
    ? scopeProjectRef(draftSession.environmentId, draftSession.projectId)
    : null;

  const projectPickerEntries = buildSidebarProjectPickerEntries({
    groups: pickableProjectGroups(projectGroups),
    preferredProjectRef: activeProjectRef,
  });
  const projectEntryByKey = new Map(
    projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const),
  );
  const menuEntries = projectPickerEntries.filter(
    ({ targetProject }) =>
      !isScratchProject(targetProject, scratchWorkspaceRootFor(targetProject.environmentId)),
  );

  // Seed the standalone Quick Composer draft once projects arrive.
  const initialTarget =
    draftSession === null
      ? resolveInitialQuickComposerTarget({
          storedTarget: readLastQuickComposerTarget(),
          projects,
          preferredEnvironmentId: primaryEnvironmentId,
        })
      : null;

  const slotThreadReserved = draftSession?.threadId === RESERVED_SLOT_THREAD_ID;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- initializes the standalone Quick Composer draft store slot once a target project is available, and moves a saved slot off the draft id it once used as its thread id
  useEffect(() => {
    if (slotThreadReserved) {
      rotateDraftThreadId(QUICK_COMPOSER_DRAFT_ID, newThreadId());
      return;
    }
    if (draftSession !== null || initialTarget === null) return;
    setStandaloneDraftProject(QUICK_COMPOSER_DRAFT_ID, initialTarget);
    seedDraftModelSelection(QUICK_COMPOSER_DRAFT_ID, initialTarget);
  }, [draftSession, initialTarget, rotateDraftThreadId, slotThreadReserved]);

  // Report draft occupancy to the desktop main process so idle teardown only runs when safe.
  const hasUnsavedContent = hasDraftContent || failedMessages.length > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes draft occupancy to the Electron quick-composer service for idle teardown gating
  useEffect(() => {
    void window.desktopBridge?.quickComposer
      ?.setDraftState({ hasContent: hasUnsavedContent, busy: composerActivity.busy })
      .catch(() => undefined);
  }, [hasUnsavedContent, composerActivity.busy]);

  const hidePopout = useEffectEvent(async () => {
    if (composerRef.current?.isDictating()) {
      await composerRef.current.stopDictation().catch(() => undefined);
    }
    flushComposerDraftStorage();
    await window.desktopBridge?.quickComposer?.hide().catch(() => undefined);
  });

  const handleDesktopEvent = useEffectEvent(
    async (
      event:
        | { readonly type: "shown"; readonly autoVoice: boolean }
        | { readonly type: "hide-requested" },
    ) => {
      if (event.type === "shown") {
        window.requestAnimationFrame(() => {
          composerRef.current?.focusAtEnd();
          if (event.autoVoice && composerRef.current?.canStartDictation()) {
            void composerRef.current.startDictation();
          }
        });
        return;
      }
      await hidePopout();
    },
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to Quick Composer show/hide lifecycle events and signals mount readiness to the desktop main process
  useEffect(() => {
    const bridge = window.desktopBridge?.quickComposer;
    if (!bridge) return;
    const unsubscribe = bridge.onEvent((event) => {
      void handleDesktopEvent(event);
    });
    void bridge.ready().catch(() => undefined);
    return unsubscribe;
  }, []);

  // Read before any popup sees the key: one that closes on this Escape has used it.
  const overlayOwnedEscapeRef = useRef(false);
  const handleGlobalKeyDownCapture = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === "Escape") overlayOwnedEscapeRef.current = hasVisibleOverlay();
  });
  // Hide on Escape when idle and no overlay/combobox/dialog owns Escape.
  const handleGlobalKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
    if (pickerOpen || overlayOwnedEscapeRef.current) return;
    if (composerRef.current?.isModelPickerOpen() || composerRef.current?.isDictating()) return;
    event.preventDefault();
    void hidePopout();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers a window-level Escape listener to dismiss the Quick Composer overlay
  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKeyDownCapture, true);
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDownCapture, true);
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, []);

  // A send owns its destination until it is accepted or its draft is restored. The ref covers the
  // awaits before the composer reports the send; the reported state covers the renders after.
  const destinationLocked = () =>
    composerActivity.sending ||
    (draftSession !== null &&
      draftSendState(
        scopedThreadKey(scopeThreadRef(draftSession.environmentId, draftSession.threadId)),
      ).sendInFlight.current);

  const selectProjectRef = (projectRef: ScopedProjectRef) => {
    scratchRequestRef.current += 1;
    setScratchPending(false);
    setStandaloneDraftProject(QUICK_COMPOSER_DRAFT_ID, projectRef);
    seedDraftModelSelection(QUICK_COMPOSER_DRAFT_ID, projectRef);
    window.requestAnimationFrame(() => composerRef.current?.focusAtEnd());
  };

  const selectNoProject = async () => {
    if (destinationLocked()) return;
    const targetEnvId = scratchEnvironmentId(
      activeProjectRef?.environmentId ?? primaryEnvironmentId ?? null,
    );
    if (targetEnvId === null) return;
    const request = ++scratchRequestRef.current;
    setScratchPending(true);
    const scratch = await openScratchProject(targetEnvId);
    if (request !== scratchRequestRef.current) return;
    setScratchPending(false);
    // A failure was already reported; the current project and draft stay as they were.
    if (!scratch) return;
    selectProjectRef(scopeProjectRef(scratch.environmentId, scratch.id));
  };

  const handleSendAccepted = (result: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly openInMain: boolean;
  }) => {
    writeLastQuickComposerTarget(scopeProjectRef(result.environmentId, result.projectId));
    rotateDraftThreadId(QUICK_COMPOSER_DRAFT_ID, newThreadId());
    setAcceptedSendCount((count) => count + 1);
    flushComposerDraftStorage();
    if (result.openInMain) {
      void window.desktopBridge?.quickComposer
        ?.openThreadInMain({
          environmentId: result.environmentId,
          threadId: result.threadId,
        })
        .catch(() => undefined);
    } else {
      void window.desktopBridge?.quickComposer?.hide().catch(() => undefined);
    }
  };

  const keepFailedMessage = (failed: RetainedComposerFailure) => {
    failedMessageIdRef.current += 1;
    const id = failedMessageIdRef.current;
    setFailedMessages((current) => [...current, { ...failed, id }]);
  };

  // Its files and context belong to the project it was sent to, so it only returns there.
  const canRestoreTo = (failed: RetainedComposerFailure) =>
    !scratchPending &&
    activeProjectRef !== null &&
    activeProjectRef.environmentId === failed.destination.environmentId &&
    activeProjectRef.projectId === failed.destination.projectId;

  const restoreFailedMessage = (failed: RetainedComposerFailure & { readonly id: number }) => {
    if (!canRestoreTo(failed)) return;
    // Added after the current draft, which stays as typed; the images get fresh previews.
    restoreComposerDraft(QUICK_COMPOSER_DRAFT_ID, failed.snapshot);
    setFailedMessages((current) => current.filter((candidate) => candidate.id !== failed.id));
    const prompt =
      useComposerDraftStore.getState().getComposerDraft(QUICK_COMPOSER_DRAFT_ID)?.prompt ?? "";
    composerRef.current?.resetCursorState({
      prompt,
      cursor: collapseExpandedComposerCursor(prompt, prompt.length),
    });
    // After the editor renders the restored text, so the caret lands at its end.
    window.requestAnimationFrame(() => composerRef.current?.focusAtEnd());
  };

  const recoveryNotice = (
    draftError: { readonly detail: string; readonly onDismiss: () => void } | null,
  ) => {
    const entries: QuickComposerRecoveryEntry[] = failedMessages.map((failed) => ({
      kind: "kept",
      key: `kept:${failed.id}`,
      failure: failed,
      onRestore: canRestoreTo(failed) ? () => restoreFailedMessage(failed) : null,
    }));
    // Listed last: each send clears the draft's error, so it follows every failure kept before it.
    if (draftError)
      entries.push({ kind: "error", key: `error:${draftError.detail}`, ...draftError });
    return (
      <QuickComposerRecoveryAlert
        entries={entries}
        onDismiss={(entry) => {
          // Focus moves before the entry unmounts, or its focused button would drop it to the body.
          composerRef.current?.focusAtEnd();
          if (entry.kind === "error") {
            draftError?.onDismiss();
            return;
          }
          // Dismissing is the message's discard, so its uploads go with it.
          releaseDraftAttachments(entry.failure.snapshot.attachments);
          setFailedMessages((current) =>
            current.filter((failed) => `kept:${failed.id}` !== entry.key),
          );
        }}
      />
    );
  };

  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const activeProjectIsScratch =
    activeProject !== null &&
    isScratchProject(activeProject, scratchWorkspaceRootFor(activeProject.environmentId));
  const activeProjectLabel = activeProjectIsScratch
    ? gt("No project")
    : (activeProject?.title ?? null);
  const triggerLabel = scratchPending ? gt("No project") : activeProjectLabel;
  const activeEnvironment =
    activeProjectRef !== null
      ? (environmentById.get(activeProjectRef.environmentId) ?? null)
      : null;
  const activeEnvironmentOffline =
    activeEnvironment !== null && activeEnvironment.connection.phase !== "connected";

  const activeProjectGroup =
    activeProjectRef === null || activeProjectIsScratch
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activePickerValue = activeProjectIsScratch
    ? NO_PROJECT_VALUE
    : (activeProjectGroup?.projectKey ?? "");

  const scratchAvailable =
    scratchEnvironmentId(activeProjectRef?.environmentId ?? primaryEnvironmentId ?? null) !== null;

  const pickerItems: readonly PickerItem[] = [
    ...menuEntries.map(({ group }) => ({ value: group.projectKey, label: group.displayName })),
    ...(scratchAvailable ? [{ value: NO_PROJECT_VALUE, label: gt("No project") }] : []),
  ];
  const pickerSearch = pickerQuery.trim();
  const filteredPickerItems =
    pickerSearch.length === 0
      ? pickerItems
      : pickerItems.filter((item) =>
          pickerFilter.contains(item, pickerSearch, (candidate) => candidate.label),
        );
  const selectedPickerItem = pickerItems.find((item) => item.value === activePickerValue) ?? null;

  if (draftSession === null) {
    return (
      <div className="flex h-dvh w-full flex-col justify-between bg-background p-4">
        <div className="drag-region flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            <T>Quick Composer</T>
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Close Quick Composer")}
            onClick={() => void hidePopout()}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <p className="text-sm text-muted-foreground">
            {environments.length === 0 ? (
              <T>Connect an environment in T3 Code to start sending from Quick Composer.</T>
            ) : (
              <T>Add a project in T3 Code or start a scratch session to use Quick Composer.</T>
            )}
          </p>
          <div className="flex items-center gap-2">
            {scratchAvailable ? (
              <Button size="sm" disabled={scratchPending} onClick={() => void selectNoProject()}>
                {scratchPending ? <Spinner /> : null}
                <T>Start without project</T>
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void hidePopout().then(() =>
                  window.desktopBridge?.revealWindow().catch(() => undefined),
                );
              }}
            >
              <T>Open T3 Code</T>
            </Button>
          </div>
        </div>
        <div />
      </div>
    );
  }

  const header = (launchStatus: DraftLaunchState) => (
    <div className="drag-region mb-1 flex items-center justify-between gap-2 sm:mb-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <Combobox
          items={pickerItems}
          filteredItems={filteredPickerItems}
          autoHighlight
          itemToStringLabel={(item) => item.label}
          isItemEqualToValue={(a, b) => a.value === b.value}
          open={pickerOpen}
          onOpenChange={(open) => {
            setPickerOpen(open);
            setPickerQuery("");
          }}
          value={selectedPickerItem}
          disabled={composerActivity.sending}
          onValueChange={(item) => {
            if (!item || destinationLocked()) return;
            setPickerOpen(false);
            if (item.value === NO_PROJECT_VALUE) {
              void selectNoProject();
              return;
            }
            const entry = projectEntryByKey.get(item.value);
            if (!entry) return;
            selectProjectRef(
              scopeProjectRef(entry.targetProject.environmentId, entry.targetProject.id),
            );
          }}
        >
          <ComboboxTrigger
            render={<InlineButton tone="picker" className="min-h-6" />}
            aria-busy={scratchPending || undefined}
            aria-label={
              scratchPending
                ? gt("Choose project, switching to: {project}", { project: gt("No project") })
                : activeProjectLabel === null
                  ? gt("Choose project")
                  : gt("Choose project, current: {project}", { project: activeProjectLabel })
            }
          >
            {scratchPending ? (
              <Spinner size="sm" tone="muted" className="shrink-0" />
            ) : activeProjectIsScratch ? (
              <MessageSquareDashedIcon className="size-3.5 shrink-0 text-muted-foreground" />
            ) : activeProject ? (
              <ProjectFavicon project={activeProject} className="size-3.5 shrink-0" />
            ) : null}
            <span className="max-w-56 truncate text-xs font-medium">
              {triggerLabel ?? gt("Choose project")}
            </span>
            {showProjectEnvironments && activeProjectGroup && !scratchPending ? (
              <ProjectEnvironmentBadge
                group={activeProjectGroup}
                primaryEnvironmentId={primaryEnvironmentId}
                machineByEnvironmentId={environmentMachineById}
              />
            ) : null}
            <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
          </ComboboxTrigger>
          <ComboboxPopup align="start" sideOffset={6} className="w-72">
            <ComboboxSearchInput
              aria-label={gt("Search projects")}
              placeholder={gt("Search projects…")}
              value={pickerQuery}
              onChange={(event) => setPickerQuery(event.target.value)}
            />
            <ComboboxEmpty>
              <T>No matching projects</T>
            </ComboboxEmpty>
            <ComboboxList>
              {(item: PickerItem) => {
                if (item.value === NO_PROJECT_VALUE) {
                  return (
                    <ComboboxItem key={item.value} value={item}>
                      <MessageSquareDashedIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{item.label}</span>
                    </ComboboxItem>
                  );
                }
                const entry = projectEntryByKey.get(item.value);
                return (
                  <ComboboxItem key={item.value} value={item}>
                    {entry ? (
                      <ProjectFavicon project={entry.targetProject} className="size-3.5 shrink-0" />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {showProjectEnvironments && entry ? (
                      <ProjectEnvironmentBadge
                        group={entry.group}
                        primaryEnvironmentId={primaryEnvironmentId}
                        machineByEnvironmentId={environmentMachineById}
                      />
                    ) : null}
                  </ComboboxItem>
                );
              }}
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>
        {activeEnvironmentOffline ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-warning/15 px-1.5 py-0.5 text-2xs font-medium text-warning">
            <WifiOffIcon className="size-3" />
            <T>Offline</T>
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 items-center gap-1">
        <QuickComposerLaunchStatus {...launchStatus} />
        <Button
          size="icon-xs"
          variant="ghost"
          className="shrink-0"
          aria-label={gt("Close Quick Composer")}
          onClick={() => void hidePopout()}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );

  return (
    <main className="flex h-dvh w-full flex-col overflow-hidden bg-background">
      <ChatView
        key={acceptedSendCount}
        routeKind="draft"
        draftId={QUICK_COMPOSER_DRAFT_ID}
        environmentId={draftSession.environmentId}
        threadId={draftSession.threadId}
        reserveTitleBarControlInset={false}
        draftHost={{
          overlayClassName:
            "pointer-events-none absolute inset-0 z-20 flex flex-col justify-start pt-2 pb-1 sm:pt-3",
          Lane: QuickComposerLane,
          header,
          notice: recoveryNotice,
          onFailedMessageKept: keepFailedMessage,
          composerRef,
          composerSurface: {
            defaultSubmissionIntent: "background",
            keySubmissionIntent: quickComposerSubmissionIntent,
            onUnhandledEscape: () => void hidePopout(),
            onActivityChange: setComposerActivity,
            FooterActions: QuickComposerSendActions,
          },
          sendDisabledReason: scratchPending ? gt("Switching to No project") : null,
          sending: composerActivity.sending,
          onSendAccepted: handleSendAccepted,
        }}
      />
    </main>
  );
}

function QuickComposerLane({ laneRef, header, children }: DraftComposerLaneProps) {
  return (
    <>
      <div className="pointer-events-auto shrink-0 px-3">{header}</div>
      <div
        ref={laneRef}
        className="scrollbar-gutter-both pointer-events-auto min-h-0 w-full overflow-y-auto px-1.5"
      >
        {children}
      </div>
    </>
  );
}

function QuickComposerSendActions({
  submit,
  requiresSendModifier,
  ...actions
}: ComposerFooterActionsProps) {
  const gt = useGT();
  const enter = { key: "enter", ctrlKey: false, metaKey: false, altKey: false };
  const sendShortcut = formatShortcutLabel({
    ...enter,
    modKey: requiresSendModifier,
    shiftKey: false,
  });
  const openShortcut = formatShortcutLabel({ ...enter, modKey: true, shiftKey: true });

  return (
    <ComposerPrimaryActions
      {...actions}
      sendPresentation={{
        label: gt("Send", { $context: "verb, sends the message without opening T3 Code" }),
        tooltip: gt("Send in background ({shortcut})", { shortcut: sendShortcut }),
        renderSecondaryAction: ({ disabled, status, statusId, onPointerDown }) => (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Button
                type="button"
                size="compact"
                variant="outline"
                onPointerDown={onPointerDown}
                disabled={disabled}
                aria-label={gt("Send and open in T3 Code")}
                aria-describedby={statusId}
                onClick={() => submit("foreground")}
              >
                <ArrowUpRightIcon aria-hidden />
                <span className="@max-[400px]/composer-surface:hidden">{gt("Send and open")}</span>
              </Button>
            </TooltipTrigger>
            <TooltipPopup align="end">
              {status ?? gt("Send and open in T3 Code ({shortcut})", { shortcut: openShortcut })}
            </TooltipPopup>
          </Tooltip>
        ),
      }}
    />
  );
}

/**
 * One line naming what an unaccepted launch is waiting on, in place of the timeline the window
 * does not show. The live region stays mounted so the first status is announced.
 */
function QuickComposerLaunchStatus(props: DraftLaunchState) {
  const gt = useGT();
  return (
    <div className="flex min-w-0 items-center gap-2.5 px-1 text-xs text-muted-foreground">
      <span role="status" className="flex min-w-0 items-center gap-1.5">
        {props.sending ? (
          <>
            <Spinner size="xs" tone="muted" aria-hidden className="shrink-0" />
            <span className="truncate">
              {props.preparingWorktree ? gt("Preparing worktree") : gt("Sending…")}
            </span>
          </>
        ) : null}
      </span>
      {props.sending && props.onWorkLocally ? (
        <InlineButton tone="muted" touchTarget="padded" onClick={props.onWorkLocally}>
          <T>Work locally</T>
        </InlineButton>
      ) : null}
      {props.sending && props.onCancelWorktreeSetup ? (
        <InlineButton tone="muted" touchTarget="padded" onClick={props.onCancelWorktreeSetup}>
          <T>Cancel</T>
        </InlineButton>
      ) : null}
    </div>
  );
}
