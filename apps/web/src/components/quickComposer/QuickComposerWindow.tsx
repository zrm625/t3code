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
import { ChevronDownIcon, MessageSquareDashedIcon, WifiOffIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";

import {
  composerDraftHasUserContent,
  flushComposerDraftStorage,
  QUICK_COMPOSER_DRAFT_ID,
  useComposerDraftStore,
} from "../../composerDraftStore";
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
import ChatView from "../ChatView";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import { draftSendState } from "../chat/chatViewSend";
import { useSortedProjectGroups } from "../CommandPaletteLookups";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button, InlineButton } from "../ui/button";
import { Spinner } from "../ui/spinner";
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
  readLastQuickComposerTarget,
  resolveInitialQuickComposerTarget,
  writeLastQuickComposerTarget,
} from "./quickComposer.logic";

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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes draft occupancy to the Electron quick-composer service for idle teardown gating
  useEffect(() => {
    void window.desktopBridge?.quickComposer
      ?.setDraftState({ hasContent: hasDraftContent, busy: composerActivity.busy })
      .catch(() => undefined);
  }, [hasDraftContent, composerActivity.busy]);

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

  const header = (launchStatus: ReactNode) => (
    <div className="drag-region mb-2 flex items-center justify-between gap-2">
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
        {launchStatus}
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
        quickComposer={{
          header,
          composerRef,
          onDismiss: () => void hidePopout(),
          sendDisabledReason: scratchPending ? gt("Switching to No project") : null,
          sending: composerActivity.sending,
          onBusyChange: setComposerActivity,
          onSendAccepted: handleSendAccepted,
        }}
      />
    </main>
  );
}
