import { ThreadId, WS_METHODS, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { recordPromptSent } from "~/components/GitHubStarPrompt";
import { QUICK_COMPOSER_DRAFT_ID, useComposerDraftStore } from "~/composerDraftStore";
import { answerRpc, installFakeEnvironment, type FakeDriver } from "../../../test/fakeEnvironment";
import {
  answerLaunches,
  draftPrompt,
  draftThreadId,
  renderQuickComposer,
  stubQuickComposerBridge,
} from "../../../test/quickComposerHarness";

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

vi.mock(import("~/components/GitHubStarPrompt"), async (original) => {
  const actual = await original();
  return { ...actual, recordPromptSent: vi.fn(actual.recordPromptSent) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("Escape in the editor hides an idle Quick Composer and keeps its draft", async () => {
  using _environment = installFakeEnvironment([]);
  await using _app = await renderQuickComposer();
  using quickComposer = stubQuickComposerBridge();

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("Keep this draft");
  await userEvent.keyboard("{Escape}");

  await vi.waitFor(() => expect(quickComposer.bridge.hide).toHaveBeenCalledOnce());
  expect(draftPrompt()).toBe("Keep this draft");
});

it("Escape off the editor hides Quick Composer past a closed popup left mounted", async () => {
  using _environment = installFakeEnvironment([]);
  await using _app = await renderQuickComposer();
  using quickComposer = stubQuickComposerBridge();
  // A closed select keeps its listbox mounted with no box, as the Workspace picker does.
  const closedListbox = document.createElement("div");
  closedListbox.setAttribute("role", "listbox");
  closedListbox.hidden = true;
  document.body.append(closedListbox);
  using _listbox = { [Symbol.dispose]: () => closedListbox.remove() };

  const close = page.getByRole("button", { name: "Close Quick Composer" });
  close.element().focus();
  await userEvent.keyboard("{Escape}");

  await vi.waitFor(() => expect(quickComposer.bridge.hide).toHaveBeenCalledOnce());
});

it("Escape closes the project picker before it hides Quick Composer", async () => {
  using _environment = installFakeEnvironment([]);
  await using _app = await renderQuickComposer();
  using quickComposer = stubQuickComposerBridge();

  await page.getByRole("combobox", { name: /^Choose project/ }).click();
  const projects = page.getByRole("listbox");
  await expect.element(projects).toBeVisible();
  await userEvent.keyboard("{Escape}");

  await expect.element(projects).not.toBeInTheDocument();
  expect(quickComposer.bridge.hide).not.toHaveBeenCalled();
});

it("Escape closes an open composer menu before it hides Quick Composer", async () => {
  using _environment = installFakeEnvironment([]);
  await using _app = await renderQuickComposer();
  using quickComposer = stubQuickComposerBridge();

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("/");
  await expect.element(page.getByRole("listbox")).toBeVisible();
  await userEvent.keyboard("{Escape}");

  await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
  expect(quickComposer.bridge.hide).not.toHaveBeenCalled();
});

it("Send and open shares Send's eligibility and opens the sent thread", async () => {
  using _environment = installFakeEnvironment([]);
  using _launches = answerLaunches();
  await using _app = await renderQuickComposer();
  using quickComposer = stubQuickComposerBridge();

  const send = page.getByRole("button", { name: "Send", exact: true });
  const sendAndOpen = page.getByRole("button", { name: "Send and open in T3 Code" });
  await expect.element(send).toBeDisabled();
  await expect.element(sendAndOpen).toBeDisabled();

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("Open this one");
  await expect.element(send).toBeEnabled();
  await expect.element(sendAndOpen).toBeEnabled();

  const sentThreadId = draftThreadId();
  await sendAndOpen.click();

  await vi.waitFor(() =>
    expect(quickComposer.bridge.openThreadInMain).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: sentThreadId }),
    ),
  );
  expect(quickComposer.bridge.hide).not.toHaveBeenCalled();
  expect(draftThreadId()).not.toBe(sentThreadId);
});

it("a send never asks for a GitHub star, even past the prompt count", async () => {
  using _environment = installFakeEnvironment([]);
  using _launches = answerLaunches();
  await using _app = await renderQuickComposer();
  using quickComposer = stubQuickComposerBridge();
  // One more counted prompt would ask; see GitHubStarPrompt.
  localStorage.setItem("t3code:github-star-prompt:sent", "5");
  using _sent = {
    [Symbol.dispose]: () => localStorage.removeItem("t3code:github-star-prompt:sent"),
  };

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("No star prompt here{Enter}");

  await vi.waitFor(() => expect(quickComposer.bridge.hide).toHaveBeenCalledOnce());
  expect(recordPromptSent).not.toHaveBeenCalled();
  expect(localStorage.getItem("t3code:github-star-prompt:sent")).toBe("5");
});

it("Enter sends in the background like Send", async () => {
  using _environment = installFakeEnvironment([]);
  using _launches = answerLaunches();
  await using _app = await renderQuickComposer();
  using quickComposer = stubQuickComposerBridge();

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("Background please{Enter}");

  await vi.waitFor(() => expect(quickComposer.bridge.hide).toHaveBeenCalledOnce());
  expect(quickComposer.bridge.openThreadInMain).not.toHaveBeenCalled();
});

it("the next draft drops the sent thread's worktree setup", async () => {
  using _environment = installFakeEnvironment([]);
  using launches = answerLaunches({ hold: true });
  using _layout = answerRpc(WS_METHODS.workspaceLayoutCommands, () =>
    Effect.succeed({ commands: [] }),
  );
  using _setup = answerRpc(WS_METHODS.subscribeWorktreeSetup, (input: { threadId: ThreadId }) =>
    Stream.make<[WorktreeSetupSnapshot]>({
      threadId: input.threadId,
      phase: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      branch: null,
      baseRef: null,
      worktreePath: null,
      setupScript: null,
      stages: [
        {
          id: "checkout",
          status: "running",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: null,
          percent: null,
          detail: null,
          tail: [],
        },
      ],
      error: null,
      sequence: 1,
    }).pipe(Stream.concat(Stream.never)),
  );
  await using _app = await renderQuickComposer();
  using quickComposer = stubQuickComposerBridge();
  useComposerDraftStore
    .getState()
    .setDraftThreadContext(QUICK_COMPOSER_DRAFT_ID, { envMode: "worktree", branch: "main" });

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("Start in a worktree");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  // A status line and the setup's way out stand in for the timeline's setup card.
  const status = page.getByRole("status").getByText("Preparing worktree");
  await expect.element(status).toBeVisible();
  const workLocally = page.getByRole("button", { name: "Work locally" });
  await expect.element(workLocally).toBeVisible();
  expect(page.getByRole("region", { name: "Worktree setup" }).query()).toBeNull();

  launches.release();
  await vi.waitFor(() => expect(quickComposer.bridge.hide).toHaveBeenCalledOnce());

  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  await expect.element(status).not.toBeInTheDocument();
  await expect.element(workLocally).not.toBeInTheDocument();
});

it("reports busy while a sent draft's launch is pending after the composer clears", async () => {
  using _environment = installFakeEnvironment([]);
  using launches = answerLaunches({ hold: true });
  await using _app = await renderQuickComposer();
  using quickComposer = stubQuickComposerBridge();
  const lastDraftState = () => quickComposer.bridge.setDraftState.mock.lastCall?.[0];

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("Hold this launch");
  await vi.waitFor(() => expect(lastDraftState()).toEqual({ hasContent: true, busy: false }));
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await vi.waitFor(() => expect(lastDraftState()).toEqual({ hasContent: false, busy: true }));
  expect(draftPrompt()).toBe("");

  launches.release();
  await vi.waitFor(() => expect(quickComposer.bridge.hide).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(lastDraftState()).toEqual({ hasContent: false, busy: false }));
});

it("moves a saved draft off the reserved slot id and keeps its text", async () => {
  using _environment = installFakeEnvironment([]);
  await using _app = await renderQuickComposer();
  using _quickComposer = stubQuickComposerBridge();
  const reservedThreadId = ThreadId.make(QUICK_COMPOSER_DRAFT_ID);

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("Saved by an older build");
  // Older builds could save the slot with its draft id as its thread id.
  useComposerDraftStore.getState().rotateDraftThreadId(QUICK_COMPOSER_DRAFT_ID, reservedThreadId);

  await vi.waitFor(() => expect(draftThreadId()).not.toBe(reservedThreadId));
  expect(draftPrompt()).toBe("Saved by an older build");
});
