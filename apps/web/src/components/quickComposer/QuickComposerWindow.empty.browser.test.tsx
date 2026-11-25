import { ProjectId, ThreadId, WS_METHODS } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { QUICK_COMPOSER_DRAFT_ID, useComposerDraftStore } from "~/composerDraftStore";
import {
  answerRpc,
  emitProject,
  installFakeEnvironment,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import {
  answerLaunches,
  draftThreadId,
  renderQuickComposerWindow,
  stubQuickComposerBridge,
} from "../../../test/quickComposerHarness";

// The connection keeps its first environment's projects for the whole file, so an environment
// without projects gets a file of its own.
// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const SCRATCH_PROJECT_ID = ProjectId.make("project-scratch");

it("sends the first scratch draft on a thread of its own when there are no projects", async () => {
  // Test files in parallel share an origin, and drafts sync across windows through storage
  // events, so another file's Quick Composer slot would arrive here.
  const blockStorageSync = (event: StorageEvent) => event.stopImmediatePropagation();
  window.addEventListener("storage", blockStorageSync, true);
  using _storageSync = {
    [Symbol.dispose]: () => window.removeEventListener("storage", blockStorageSync, true),
  };
  using _environment = installFakeEnvironment([], {
    scratchWorkspaceRoot: "/workspace/Scratch",
    omitDefaultProject: true,
  });
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(680, 480);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  using _scratch = answerRpc(WS_METHODS.projectsEnsureScratch, () =>
    Effect.promise(() => emitProject({ id: SCRATCH_PROJECT_ID, title: "Scratch" })).pipe(
      Effect.as({ projectId: SCRATCH_PROJECT_ID }),
    ),
  );
  using launches = answerLaunches();
  await using _app = await renderQuickComposerWindow();
  const start = page.getByRole("button", { name: "Start without project" });
  await expect.element(start).toBeVisible();
  using quickComposer = stubQuickComposerBridge();
  const slotThreadIds = new Set<ThreadId>();
  const unsubscribe = useComposerDraftStore.subscribe((state) => {
    const threadId = state.draftThreadsByThreadKey[QUICK_COMPOSER_DRAFT_ID]?.threadId;
    if (threadId) slotThreadIds.add(threadId);
  });
  using _subscription = { [Symbol.dispose]: unsubscribe };

  await start.click();
  await expect
    .element(page.getByRole("combobox", { name: "Choose project, current: No project" }))
    .toBeVisible();
  const slotThreadId = draftThreadId();
  expect([...slotThreadIds]).toEqual([slotThreadId]);
  expect(slotThreadId).not.toBe(ThreadId.make(QUICK_COMPOSER_DRAFT_ID));

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("First scratch note");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await vi.waitFor(() => expect(quickComposer.bridge.hide).toHaveBeenCalledOnce());
  expect(launches.launched).toEqual([
    expect.objectContaining({ threadId: slotThreadId, projectId: SCRATCH_PROJECT_ID }),
  ]);
  expect(draftThreadId()).not.toBe(slotThreadId);
});
