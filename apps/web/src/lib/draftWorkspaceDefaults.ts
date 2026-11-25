import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_SERVER_SETTINGS,
  type ScopedProjectRef,
  type ServerConfig,
  type T3ProjectFile,
  type ThreadId,
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

// Drafts that opened before their project's t3.json was read. A send waits for the file's
// workspace default unless the user has already chosen a workspace.
interface ProvisionalWorkspace {
  readonly envMode: DraftThreadEnvMode;
  readonly projectRef: ScopedProjectRef;
  readonly threadId: ThreadId;
  // A reused draft keeps an earlier "manual" marker; only a switch to manual after opening is a choice.
  readonly openedManual: boolean;
}

const pendingWorkspaceDefaults = new Map<
  DraftId,
  ProvisionalWorkspace & { readonly settled: Promise<void> }
>();

function keepsProvisionalWorkspace(
  draft: DraftSessionState | null,
  provisional: ProvisionalWorkspace,
): draft is DraftSessionState {
  return (
    draft !== null &&
    draft.promotedTo == null &&
    draft.environmentId === provisional.projectRef.environmentId &&
    draft.projectId === provisional.projectRef.projectId &&
    draft.threadId === provisional.threadId &&
    draft.envMode === provisional.envMode &&
    draft.worktreePath === null &&
    (provisional.openedManual || draft.environmentSelection !== "manual")
  );
}

export function readPendingWorkspaceDefault(draftId: DraftId): Promise<void> | null {
  const pending = pendingWorkspaceDefaults.get(draftId);
  if (pending === undefined) return null;
  const draft = useComposerDraftStore.getState().getDraftSession(draftId);
  return keepsProvisionalWorkspace(draft, pending)
    ? pending.settled.then(() => readPendingWorkspaceDefault(draftId) ?? undefined)
    : null;
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
    pendingWorkspaceDefaults.delete(draftId);
    if (cachedProjectFile !== undefined || projectFileRead === null) return;
    const { getDraftSession, setDraftThreadContext } = useComposerDraftStore.getState();
    const initialDraft = getDraftSession(draftId);
    if (!initialDraft) return;
    const provisional: ProvisionalWorkspace = {
      envMode,
      projectRef,
      threadId: initialDraft.threadId,
      openedManual: initialDraft.environmentSelection === "manual",
    };
    const settled = projectFileRead
      .then((projectFile) => {
        if (pendingWorkspaceDefaults.get(draftId)?.settled !== settled) return;
        const fileEnvMode = envModeFor(projectFile);
        const draft = getDraftSession(draftId);
        if (fileEnvMode === envMode || !keepsProvisionalWorkspace(draft, provisional)) return;
        // Commit before a waiting send re-reads the composer's workspace.
        flushSync(() =>
          setDraftThreadContext(draftId, {
            envMode: fileEnvMode,
            ...(draft.startFromOrigin === startFromOrigin
              ? { startFromOrigin: startFromOriginFor(fileEnvMode) }
              : {}),
          }),
        );
      })
      .finally(() => {
        if (pendingWorkspaceDefaults.get(draftId)?.settled === settled) {
          pendingWorkspaceDefaults.delete(draftId);
        }
      });
    pendingWorkspaceDefaults.set(draftId, { ...provisional, settled });
  };
  return { envMode, startFromOrigin, applyProjectFile };
}

export function setStandaloneDraftProject(draftId: DraftId, projectRef: ScopedProjectRef): void {
  const { getDraftSession, setStandaloneDraftThread } = useComposerDraftStore.getState();
  const draft = getDraftSession(draftId);
  if (draft?.environmentId === projectRef.environmentId && draft.projectId === projectRef.projectId)
    return;

  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(projectRef.environmentId);
  const { envMode, startFromOrigin, applyProjectFile } = resolveDraftWorkspaceDefaults(
    projectRef,
    readProject(projectRef) ?? undefined,
    config,
  );
  setStandaloneDraftThread(draftId, projectRef, {
    // The slot's draft id is not a server thread id; a new slot reserves one of its own.
    ...(draft === null ? { threadId: newThreadId() } : {}),
    envMode,
    startFromOrigin,
    environmentSelection: "auto",
  });
  applyProjectFile(draftId);
}
