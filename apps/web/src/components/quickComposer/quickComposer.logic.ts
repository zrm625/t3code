import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";

import type { ComposerSubmissionIntent } from "../../composer-logic";
import type { Project } from "../../types";

export const QUICK_COMPOSER_LAST_TARGET_STORAGE_KEY = "t3code:quick-composer-last-target:v1";

const PersistedQuickComposerTarget = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
const decodePersistedQuickComposerTarget = Schema.decodeUnknownOption(
  Schema.fromJsonString(PersistedQuickComposerTarget),
);

export function readLastQuickComposerTarget(
  storage: Pick<Storage, "getItem"> | null = typeof window !== "undefined"
    ? window.localStorage
    : null,
): ScopedProjectRef | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(QUICK_COMPOSER_LAST_TARGET_STORAGE_KEY);
    if (!raw) return null;
    const decoded = decodePersistedQuickComposerTarget(raw);
    return decoded._tag === "Some"
      ? scopeProjectRef(decoded.value.environmentId, decoded.value.projectId)
      : null;
  } catch {
    return null;
  }
}

export function writeLastQuickComposerTarget(
  target: ScopedProjectRef,
  storage: Pick<Storage, "setItem"> | null = typeof window !== "undefined"
    ? window.localStorage
    : null,
): void {
  if (!storage) return;
  try {
    storage.setItem(
      QUICK_COMPOSER_LAST_TARGET_STORAGE_KEY,
      JSON.stringify({
        environmentId: target.environmentId,
        projectId: target.projectId,
      }),
    );
  } catch {}
}

export function resolveInitialQuickComposerTarget(input: {
  readonly storedTarget: ScopedProjectRef | null;
  readonly projects: ReadonlyArray<Pick<Project, "id" | "environmentId">>;
  readonly preferredEnvironmentId: EnvironmentId | null;
}): ScopedProjectRef | null {
  const { storedTarget, projects, preferredEnvironmentId } = input;
  if (storedTarget !== null) {
    const exactMatch = projects.find(
      (project) =>
        project.environmentId === storedTarget.environmentId &&
        project.id === storedTarget.projectId,
    );
    if (exactMatch) {
      return scopeProjectRef(exactMatch.environmentId, exactMatch.id);
    }
  }
  if (preferredEnvironmentId !== null) {
    const onPreferredEnvironment = projects.find(
      (project) => project.environmentId === preferredEnvironmentId,
    );
    if (onPreferredEnvironment) {
      return scopeProjectRef(onPreferredEnvironment.environmentId, onPreferredEnvironment.id);
    }
  }
  const first = projects[0];
  return first ? scopeProjectRef(first.environmentId, first.id) : null;
}

type QuickComposerKeyEvent = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey" | "isComposing" | "repeat"
>;

/** Mod+Shift+Enter is Quick Composer's Send and open. */
function isQuickComposerOpenShortcut(event: QuickComposerKeyEvent): boolean {
  return (
    event.key === "Enter" &&
    event.shiftKey &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.isComposing &&
    !event.repeat
  );
}

/** Quick Composer sends stay in the background; only its Send and open shortcut shows the thread. */
export function quickComposerSubmissionIntent(
  event: QuickComposerKeyEvent | null,
  intent: ComposerSubmissionIntent | null,
): ComposerSubmissionIntent | null {
  if (event !== null && isQuickComposerOpenShortcut(event)) return "foreground";
  return intent === "foreground" ? "background" : intent;
}
