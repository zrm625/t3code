import { createMemoryHistory } from "@tanstack/react-router";
import {
  type CommandId,
  type DesktopQuickComposerDraftState,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ThreadLaunchError,
  type ProjectId,
  type RuntimeMode,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as Effect from "effect/Effect";
import { expect, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import { QUICK_COMPOSER_DRAFT_ID, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { answerRpc, launchResult } from "./fakeEnvironment";
import { render, stubGlobal } from "./render";

// Callers mock the connection driver with fakeDriver, as QuickComposerWindow.browser.test.tsx does.

// Installed after mount: the root route takes its desktop path for any desktopBridge, and the
// window reads the bridge only when it hides or opens a thread.
export function stubQuickComposerBridge() {
  const bridge = {
    ready: vi.fn(async () => undefined),
    hide: vi.fn(async () => undefined),
    openThreadInMain: vi.fn(async () => undefined),
    setDraftState: vi.fn(async (_state: DesktopQuickComposerDraftState) => undefined),
    onEvent: vi.fn(() => () => undefined),
  };
  // Other desktop reads see a host with nothing to report.
  const desktopBridge = new Proxy(
    {
      quickComposer: bridge,
      appleSpeech: undefined,
      getLocalEnvironmentBootstraps: () => [],
      // Read once per page, which may be after the stub when a composer mounts late.
      probeRemoteEditors: async () => [],
    },
    {
      get: (target, key) =>
        key in target
          ? target[key as keyof typeof target]
          : typeof key === "string" && key.startsWith("on")
            ? () => () => undefined
            : () => undefined,
    },
  );
  const global = stubGlobal("desktopBridge", desktopBridge);
  return { bridge, [Symbol.dispose]: () => global[Symbol.dispose]() };
}

export async function renderQuickComposer() {
  const app = await renderQuickComposerWindow();
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  return app;
}

/** Renders the window without waiting for a composer, which needs a project to exist. */
export async function renderQuickComposerWindow() {
  // The window keeps one draft slot, which outlives a test's render.
  useComposerDraftStore.getState().clearDraftThread(QUICK_COMPOSER_DRAFT_ID);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(createMemoryHistory({ initialEntries: ["/quick-composer"] }));
  await router.load();
  return render(<AppRoot router={router} isQuickComposerSurface />, {
    // AppRoot brings its own router.
    router: false,
  });
}

export const draftPrompt = () =>
  useComposerDraftStore.getState().getComposerDraft(QUICK_COMPOSER_DRAFT_ID)?.prompt ?? "";

interface LaunchInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runtimeMode: RuntimeMode;
  readonly workspaceStrategy: unknown;
}

/**
 * Accepts every new-thread launch, or holds each until `release` or `fail`, until disposed.
 * `launched` records each request. The project has no t3.json, so a send need not wait for its
 * workspace default.
 */
export function answerLaunches(options?: {
  readonly hold?: boolean;
  readonly failureMessage?: string;
}) {
  const launched: LaunchInput[] = [];
  let pending: Array<(outcome: "accept" | "fail") => void> = [];
  const settle = (outcome: "accept" | "fail") => {
    const held = pending;
    pending = [];
    for (const resolve of held) resolve(outcome);
  };
  const answer = answerRpc(ORCHESTRATION_V2_WS_METHODS.launchThread, (input: LaunchInput) => {
    launched.push(input);
    const outcome = options?.hold
      ? new Promise<"accept" | "fail">((resolve) => pending.push(resolve))
      : Promise.resolve("accept" as const);
    return Effect.promise(() => outcome).pipe(
      Effect.flatMap((result) =>
        result === "accept"
          ? Effect.succeed(launchResult(input.threadId))
          : Effect.fail(
              new OrchestrationV2ThreadLaunchError({
                commandId: input.commandId,
                projectId: input.projectId,
                message: options?.failureMessage ?? "Launch refused",
              }),
            ),
      ),
    );
  });
  const projectFile = answerRpc(WS_METHODS.projectsReadFile, () =>
    Effect.succeed({
      relativePath: "t3.json",
      contents: "",
      byteLength: 0,
      truncated: false,
      exists: false,
    }),
  );
  return {
    launched,
    release: () => settle("accept"),
    fail: () => settle("fail"),
    [Symbol.dispose]: () => {
      answer[Symbol.dispose]();
      projectFile[Symbol.dispose]();
    },
  };
}

export const draftThreadId = () =>
  useComposerDraftStore.getState().getDraftSession(QUICK_COMPOSER_DRAFT_ID)!.threadId;
