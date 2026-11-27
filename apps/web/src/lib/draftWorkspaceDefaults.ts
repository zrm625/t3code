import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_SERVER_SETTINGS,
  type ScopedProjectRef,
  type ServerConfig,
  type T3ProjectFile,
} from "@t3tools/contracts";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { flushSync } from "react-dom";

import {
  type DraftId,
  type DraftSessionState,
  type DraftThreadEnvMode,
  useComposerDraftStore,
} from "../composerDraftStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, readThreadShells } from "../state/entities";
import { readUnloadedThreadCount } from "../state/olderSettledShelf";
import { environmentSummaries } from "../state/presentation";
import { environmentServerConfigsAtom } from "../state/server";
import { resolveNewDraftStartFromOrigin } from "./chatThreadActions";
import { peekT3ProjectFile, readT3ProjectFile } from "./t3ProjectFileDefaults";
import { newThreadId } from "./utils";

type DraftWorkspaceDefault = Pick<DraftSessionState, "envMode" | "startFromOrigin">;

interface PendingWorkspaceDefault {
  readonly projectRef: ScopedProjectRef;
  readonly workspace: DraftWorkspaceDefault;
  readonly threadId: DraftSessionState["threadId"] | undefined;
  readonly openedManual: boolean;
  readonly settled: Promise<void>;
}

const pendingDefaults = new Map<DraftId, PendingWorkspaceDefault>();

function isInProject(
  draft: DraftSessionState | null,
  projectRef: ScopedProjectRef,
): draft is DraftSessionState {
  return (
    draft !== null &&
    draft.promotedTo == null &&
    draft.environmentId === projectRef.environmentId &&
    draft.projectId === projectRef.projectId
  );
}

function acceptsWorkspaceDefault(
  draft: DraftSessionState | null,
  pending: PendingWorkspaceDefault,
): draft is DraftSessionState {
  return (
    isInProject(draft, pending.projectRef) &&
    draft.threadId === pending.threadId &&
    draft.envMode === pending.workspace.envMode &&
    !draft.workspaceExplicit &&
    draft.worktreePath === null &&
    (pending.openedManual || draft.environmentSelection !== "manual")
  );
}

type CheckoutOutcome = boolean | "moved";

const pendingCheckouts = new Map<DraftId, Promise<CheckoutOutcome>>();

/**
 * A waiting send can resume only after the current checkout has been applied. Moving the draft
 * to another project drops the checkout, even if the draft moves back before it finishes.
 */
export function trackPendingDraftCheckout(
  draftId: DraftId,
  projectRef: ScopedProjectRef,
  checkoutReady: Promise<boolean>,
) {
  const { promise: settled, resolve } = Promise.withResolvers<CheckoutOutcome>();
  const isCurrent = () => pendingCheckouts.get(draftId) === settled;
  const release = (outcome: CheckoutOutcome) => {
    unsubscribe();
    if (isCurrent()) pendingCheckouts.delete(draftId);
    resolve(outcome);
  };
  const unsubscribe = useComposerDraftStore.subscribe((state) => {
    if (!isInProject(state.getDraftSession(draftId), projectRef)) release("moved");
  });
  pendingCheckouts.set(draftId, settled);
  checkoutReady.then(release, () => release(false));
  return isCurrent;
}

/** "moved" means the send waited on a checkout the draft left by changing projects. */
export function readPendingWorkspaceDefault(
  draftId: DraftId,
): Promise<CheckoutOutcome | void> | null {
  const checkout = pendingCheckouts.get(draftId);
  if (checkout) return checkout;
  const pending = pendingDefaults.get(draftId);
  if (!pending) return null;
  const draft = useComposerDraftStore.getState().getDraftSession(draftId);
  return acceptsWorkspaceDefault(draft, pending) ? pending.settled : null;
}

/** A visible draft can use a provisional workspace while its project file loads. */
export function trackPendingWorkspaceDefault(
  draftId: DraftId,
  projectRef: ScopedProjectRef,
  workspace: DraftWorkspaceDefault,
  resolution: Promise<DraftWorkspaceDefault>,
) {
  const { getDraftSession, setDraftThreadContext } = useComposerDraftStore.getState();
  const settled = resolution
    .then((resolved) => {
      const draft = getDraftSession(draftId);
      if (pendingDefaults.get(draftId) !== pending || !acceptsWorkspaceDefault(draft, pending))
        return;
      if (
        resolved.envMode === workspace.envMode &&
        resolved.startFromOrigin === workspace.startFromOrigin
      )
        return;
      // A send waiting on this promise must see the resolved workspace when it resumes.
      flushSync(() =>
        setDraftThreadContext(draftId, {
          envMode: resolved.envMode,
          ...(draft.startFromOrigin === workspace.startFromOrigin
            ? { startFromOrigin: resolved.startFromOrigin }
            : {}),
        }),
      );
    })
    .finally(() => {
      if (pendingDefaults.get(draftId) === pending) pendingDefaults.delete(draftId);
    });
  const draft = getDraftSession(draftId);
  const pending = {
    projectRef,
    threadId: draft?.threadId,
    workspace,
    openedManual: draft?.environmentSelection === "manual",
    settled,
  };
  pendingDefaults.set(draftId, pending);
}

export function resolveDraftWorkspaceDefaults(
  projectRef: ScopedProjectRef,
  project: EnvironmentProject | undefined,
  environmentConfig: ServerConfig | undefined,
) {
  const serverSettings = environmentConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const projectSettings = resolveProjectSettings(serverSettings, project?.id ?? null, project);
  const envModeFor = (projectFile: T3ProjectFile | null) =>
    resolveNewThreadEnvMode({
      projectSettings: resolveProjectSettings(
        serverSettings,
        project?.id ?? null,
        project,
        projectFile,
      ),
      workspaceRoot: project?.workspaceRoot ?? null,
      newProjectsRoot: environmentConfig?.newProjectsRoot,
      projectHasThreads:
        readThreadShells().some(
          (thread) =>
            thread.environmentId === projectRef.environmentId &&
            thread.projectId === projectRef.projectId,
        ) ||
        readUnloadedThreadCount(
          [{ environmentId: projectRef.environmentId, id: projectRef.projectId }],
          [],
        ) > 0,
    });
  const startFromOriginFor = (envMode: DraftThreadEnvMode) =>
    resolveNewDraftStartFromOrigin({
      envMode,
      newWorktreesStartFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
    });

  // Environment queries wait for a connection, so an offline machine's file is never read.
  const consultProjectFile =
    project !== undefined &&
    projectSettings.settings.defaultThreadEnvMode === null &&
    appAtomRegistry
      .get(environmentSummaries.connectedEnvironmentIdsAtom)
      .includes(project.environmentId);
  const projectFileRead = consultProjectFile
    ? readT3ProjectFile(project.environmentId, project.workspaceRoot)
    : null;
  const cachedProjectFile = consultProjectFile
    ? peekT3ProjectFile(project.environmentId, project.workspaceRoot)
    : null;
  const envMode = envModeFor(cachedProjectFile ?? null);
  const startFromOrigin = startFromOriginFor(envMode);

  const applyProjectFile = (draftId: DraftId) => {
    pendingDefaults.delete(draftId);
    if (cachedProjectFile !== undefined || projectFileRead === null) return;
    trackPendingWorkspaceDefault(
      draftId,
      projectRef,
      { envMode, startFromOrigin },
      projectFileRead.then((projectFile) => {
        const envMode = envModeFor(projectFile);
        return { envMode, startFromOrigin: startFromOriginFor(envMode) };
      }),
    );
  };
  return {
    envMode,
    startFromOrigin,
    runtimeMode: projectSettings.settings.defaultRuntimeMode,
    applyProjectFile,
  };
}

export function setStandaloneDraftProject(draftId: DraftId, projectRef: ScopedProjectRef): void {
  const { getDraftSession, setStandaloneDraftThread } = useComposerDraftStore.getState();
  const draft = getDraftSession(draftId);
  if (draft?.environmentId === projectRef.environmentId && draft.projectId === projectRef.projectId)
    return;

  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(projectRef.environmentId);
  const { envMode, startFromOrigin, runtimeMode, applyProjectFile } = resolveDraftWorkspaceDefaults(
    projectRef,
    readProject(projectRef) ?? undefined,
    config,
  );
  setStandaloneDraftThread(draftId, projectRef, {
    // The slot's draft id is not a server thread id; a new slot reserves one of its own.
    ...(draft === null ? { threadId: newThreadId() } : {}),
    envMode,
    startFromOrigin,
    runtimeMode,
    environmentSelection: "auto",
    workspaceExplicit: false,
  });
  applyProjectFile(draftId);
}
