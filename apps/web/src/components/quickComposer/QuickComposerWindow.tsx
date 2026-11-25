import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ScopedProjectRef,
  type ThreadId,
} from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import { T, useGT, Var } from "gt-react";
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
  useComposerDraftStore,
} from "../../composerDraftStore";
import { formatShortcutLabel } from "../../keybindings";
import { newThreadId } from "../../lib/utils";
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
import { useSortedProjectGroups } from "../CommandPaletteLookups";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button, InlineButton } from "../ui/button";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  QUICK_COMPOSER_DRAFT_ID,
  readLastQuickComposerTarget,
  resolveInitialQuickComposerTarget,
  writeLastQuickComposerTarget,
} from "./quickComposer.logic";

const NO_PROJECT_VALUE = "__quick-composer:no-project__";

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
  const pickerFilter = useComboboxFilter();

  const draftSession = useComposerDraftStore((store) =>
    store.getDraftSession(QUICK_COMPOSER_DRAFT_ID),
  );
  const hasDraftContent = useComposerDraftStore((store) =>
    composerDraftHasUserContent(store.getComposerDraft(QUICK_COMPOSER_DRAFT_ID)),
  );
  const setStandaloneDraftThread = useComposerDraftStore((store) => store.setStandaloneDraftThread);
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- initializes the standalone Quick Composer draft store slot once a target project is available
  useEffect(() => {
    if (draftSession !== null || initialTarget === null) return;
    setStandaloneDraftThread(QUICK_COMPOSER_DRAFT_ID, initialTarget, {
      threadId: newThreadId(),
    });
    seedDraftModelSelection(QUICK_COMPOSER_DRAFT_ID, initialTarget);
  }, [draftSession, initialTarget, setStandaloneDraftThread]);

  // Report draft occupancy to the desktop main process so idle teardown only runs when safe.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes draft occupancy to the Electron quick-composer service for idle teardown gating
  useEffect(() => {
    void window.desktopBridge?.quickComposer
      ?.setDraftState({
        hasContent: hasDraftContent,
        busy: composerRef.current?.isDictating() === true,
      })
      .catch(() => undefined);
  }, [hasDraftContent]);

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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to Quick Composer show/hide lifecycle events from the desktop main process
  useEffect(() => {
    const bridge = window.desktopBridge?.quickComposer;
    if (!bridge) return;
    return bridge.onEvent((event) => {
      void handleDesktopEvent(event);
    });
  }, []);

  // Hide on Escape when idle and no overlay/combobox/dialog owns Escape.
  const handleGlobalKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
    if (pickerOpen) return;
    if (composerRef.current?.isModelPickerOpen() || composerRef.current?.isDictating()) return;
    if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="listbox"]')) return;
    event.preventDefault();
    void hidePopout();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers a window-level Escape listener to dismiss the Quick Composer overlay
  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  const selectProjectRef = (projectRef: ScopedProjectRef) => {
    setStandaloneDraftThread(QUICK_COMPOSER_DRAFT_ID, projectRef);
    seedDraftModelSelection(QUICK_COMPOSER_DRAFT_ID, projectRef);
    window.requestAnimationFrame(() => composerRef.current?.focusAtEnd());
  };

  const selectNoProject = async () => {
    const targetEnvId = scratchEnvironmentId(
      activeProjectRef?.environmentId ?? primaryEnvironmentId ?? null,
    );
    if (targetEnvId === null) return;
    const scratch = await openScratchProject(targetEnvId);
    if (!scratch) return;
    selectProjectRef(scopeProjectRef(scratch.environmentId, scratch.id));
  };

  const handleSendAccepted = (result: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly openInMain: boolean;
  }) => {
    const session = useComposerDraftStore.getState().getDraftSession(QUICK_COMPOSER_DRAFT_ID);
    if (session) {
      writeLastQuickComposerTarget(scopeProjectRef(session.environmentId, session.projectId));
    }
    rotateDraftThreadId(QUICK_COMPOSER_DRAFT_ID, newThreadId());
    flushComposerDraftStorage();
    void window.desktopBridge?.quickComposer
      ?.setDraftState({ hasContent: false, busy: false })
      .catch(() => undefined);
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
              <Button size="sm" onClick={() => void selectNoProject()}>
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

  const header = (
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
          onValueChange={(item) => {
            if (!item) return;
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
            render={<InlineButton tone="picker" />}
            aria-label={gt("Choose project")}
          >
            {activeProjectIsScratch ? (
              <MessageSquareDashedIcon className="size-3.5 shrink-0 text-muted-foreground" />
            ) : activeProject ? (
              <ProjectFavicon project={activeProject} className="size-3.5 shrink-0" />
            ) : null}
            <span className="max-w-56 truncate text-xs font-medium">
              {activeProjectIsScratch
                ? gt("No project")
                : (activeProject?.title ?? gt("Choose project"))}
            </span>
            {showProjectEnvironments && activeProjectGroup ? (
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

      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={gt("Send and open in T3 Code")}
                onClick={() => composerRef.current?.submitWithIntent("foreground")}
              />
            }
          >
            <ArrowUpRightIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>
            <T>
              Send and open in T3 Code (
              <Var>
                {formatShortcutLabel({
                  key: "enter",
                  modKey: true,
                  shiftKey: true,
                  ctrlKey: false,
                  altKey: false,
                  metaKey: false,
                })}
              </Var>
              )
            </T>
          </TooltipPopup>
        </Tooltip>
        <Button
          size="icon-xs"
          variant="ghost"
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
        routeKind="draft"
        draftId={QUICK_COMPOSER_DRAFT_ID}
        environmentId={draftSession.environmentId}
        threadId={draftSession.threadId}
        reserveTitleBarControlInset={false}
        quickComposer={{
          header,
          composerRef,
          onSendAccepted: handleSendAccepted,
        }}
      />
    </main>
  );
}
