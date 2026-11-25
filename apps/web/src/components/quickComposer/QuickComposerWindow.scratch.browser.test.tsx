import { OrchestrationDispatchCommandError, ProjectId, WS_METHODS } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { QUICK_COMPOSER_DRAFT_ID, useComposerDraftStore } from "~/composerDraftStore";
// Layout assertions need the app's styles.
import "~/index.css";
import { answerRpc, installFakeEnvironment, type FakeDriver } from "../../../test/fakeEnvironment";
import {
  answerLaunches,
  draftPrompt,
  renderQuickComposer,
  stubQuickComposerBridge,
} from "../../../test/quickComposerHarness";
import { readLastQuickComposerTarget } from "./quickComposer.logic";

// The connection keeps its first environment's projects and config for the whole file, so the
// scratch environment gets a file of its own.
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
const UNREAD_PROJECT_ID = ProjectId.make("project-unread");

/** Serves a scratch session and another project; each scratch request waits for `succeed` or `fail`. */
function installScratchEnvironment() {
  const environment = installFakeEnvironment([], {
    scratchWorkspaceRoot: "/workspace/Scratch",
    extraProjects: [
      { id: SCRATCH_PROJECT_ID, title: "Scratch" },
      { id: ProjectId.make("project-other"), title: "other" },
      // A project file is read once per connection; only one test opens this project.
      { id: UNREAD_PROJECT_ID, title: "unread" },
    ],
  });
  let settle: (outcome: "succeed" | "fail") => void = () => {};
  const outcome = new Promise<"succeed" | "fail">((resolve) => {
    settle = resolve;
  });
  const scratch = answerRpc(WS_METHODS.projectsEnsureScratch, () =>
    Effect.promise(() => outcome).pipe(
      Effect.flatMap((result) =>
        result === "succeed"
          ? Effect.succeed({ projectId: SCRATCH_PROJECT_ID })
          : Effect.fail(new OrchestrationDispatchCommandError({ message: "Scratch unavailable" })),
      ),
    ),
  );
  return {
    succeed: () => settle("succeed"),
    fail: () => settle("fail"),
    [Symbol.dispose]: () => {
      scratch[Symbol.dispose]();
      environment[Symbol.dispose]();
    },
  };
}

/** The window's width; below the phone breakpoint an unfocused composer collapses its footer. */
async function useQuickComposerViewport(height = 480) {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(680, height);
  return { [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height) };
}

const draftProjectId = () =>
  useComposerDraftStore.getState().getDraftSession(QUICK_COMPOSER_DRAFT_ID)?.projectId;

async function chooseProject(name: string) {
  await page.getByRole("combobox", { name: /^Choose project/ }).click();

  await page.getByRole("option", { name }).click();
}

it("holds sends while No project resolves and drops it for a newer choice", async () => {
  await using _viewport = await useQuickComposerViewport();
  using scratch = installScratchEnvironment();
  using _launches = answerLaunches();
  await using _app = await renderQuickComposer();
  using quickComposer = stubQuickComposerBridge();
  const startingProjectId = draftProjectId();

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("Where does this go");
  await chooseProject("No project");

  const picker = page.getByRole("combobox", { name: "Choose project, switching to: No project" });
  await expect.element(picker).toBeVisible();
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect.element(send).toBeDisabled();
  await expect.element(send).toHaveAccessibleDescription("Switching to No project");
  await expect
    .element(page.getByRole("button", { name: "Send and open in T3 Code" }))
    .toBeDisabled();
  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("{Enter}");
  expect(draftProjectId()).toBe(startingProjectId);
  expect(draftPrompt()).toBe("Where does this go");

  await chooseProject("other");
  await expect
    .element(page.getByRole("combobox", { name: "Choose project, current: other" }))
    .toBeVisible();
  scratch.succeed();
  await expect.element(send).toBeEnabled();

  await expect
    .element(page.getByRole("combobox", { name: "Choose project, current: other" }))
    .toBeVisible();
  expect(draftProjectId()).toBe(ProjectId.make("project-other"));
  expect(draftPrompt()).toBe("Where does this go");
  expect(quickComposer.bridge.hide).not.toHaveBeenCalled();
});

it("keeps the project and draft when No project fails", async () => {
  await using _viewport = await useQuickComposerViewport();
  using scratch = installScratchEnvironment();
  await using _app = await renderQuickComposer();
  using _quickComposer = stubQuickComposerBridge();
  const startingProjectId = draftProjectId();

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("Keep me");
  await chooseProject("No project");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect.element(send).toBeDisabled();
  scratch.fail();

  await expect.element(page.getByText("Could not start without a project")).toBeVisible();
  await expect.element(send).toBeEnabled();
  expect(draftProjectId()).toBe(startingProjectId);
  expect(draftPrompt()).toBe("Keep me");
});

/** The draft's workspace strip, or null when it is not on screen. */
const workspaceControls = () => ({
  workspace: page.getByRole("combobox", { name: "Workspace" }),
  branch: page.getByRole("combobox", { name: /^Branch: / }),
  permissions: page.getByRole("button", { name: /^Permissions: / }),
});

it("keeps a failed send's destination, checkout and permissions together through the launch", async () => {
  // The default window size.
  await using _viewport = await useQuickComposerViewport(240);
  using _scratch = installScratchEnvironment();
  using launches = answerLaunches({ hold: true });
  using _layout = answerRpc(WS_METHODS.workspaceLayoutCommands, () =>
    Effect.succeed({ commands: [] }),
  );
  await using _app = await renderQuickComposer();
  using quickComposer = stubQuickComposerBridge();
  const starting = useComposerDraftStore.getState().getDraftSession(QUICK_COMPOSER_DRAFT_ID)!;
  const startingProjectId = starting.projectId;
  useComposerDraftStore
    .getState()
    .setDraftThreadContext(QUICK_COMPOSER_DRAFT_ID, { envMode: "worktree", branch: "main" });
  const controls = workspaceControls();
  await expect.element(controls.workspace).toBeVisible();
  const controlsBefore = {
    workspace: controls.workspace.element().textContent,
    branch: controls.branch.element().getAttribute("aria-label"),
    permissions: controls.permissions.element().getAttribute("aria-label"),
  };

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("Send this to the first project");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await vi.waitFor(() => expect(launches.launched).toHaveLength(1));

  const picker = page.getByRole("combobox", { name: /^Choose project/ });
  await expect.element(picker).toBeDisabled();
  picker.element().focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(page.getByRole("listbox").query()).toBeNull();
  // The launch reports one status line; the pop-out never shows the sent message.
  await expect.element(page.getByRole("status").getByText("Preparing worktree")).toBeVisible();
  expect(page.getByText("Send this to the first project").query()).toBeNull();
  expect(page.getByRole("button", { name: "Copy message" }).query()).toBeNull();
  // The checkout and permissions the launch was sent with cannot change while it settles.
  for (const control of Object.values(controls)) {
    const element = control.element() as HTMLElement;
    expect(element.closest("[inert]")).not.toBeNull();
    element.focus();
    expect(document.activeElement).not.toBe(element);
  }
  launches.fail();

  await expect.element(page.getByRole("alert")).toHaveTextContent("Launch refused");
  await expect.element(picker).toBeEnabled();
  expect(draftPrompt()).toBe("Send this to the first project");
  expect(draftProjectId()).toBe(startingProjectId);
  for (const control of Object.values(controls)) {
    expect(control.element().closest("[inert]")).toBeNull();
  }
  expect({
    workspace: controls.workspace.element().textContent,
    branch: controls.branch.element().getAttribute("aria-label"),
    permissions: controls.permissions.element().getAttribute("aria-label"),
  }).toEqual(controlsBefore);
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect.element(send).toBeEnabled();
  expect(send.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);

  await send.click();
  await vi.waitFor(() => expect(launches.launched).toHaveLength(2));
  const [failed, retried] = launches.launched;
  expect(retried?.projectId).toBe(startingProjectId);
  expect(retried?.workspaceStrategy).toEqual(failed?.workspaceStrategy);
  expect(retried?.workspaceStrategy).toMatchObject({ type: "worktree", baseRef: "main" });
  expect(retried?.runtimeMode).toBe(failed?.runtimeMode);
  launches.release();
  await vi.waitFor(() => expect(quickComposer.bridge.hide).toHaveBeenCalledOnce());
  expect(readLastQuickComposerTarget()).toEqual(
    scopeProjectRef(starting.environmentId, startingProjectId),
  );
});

it("holds the project while a send waits for the project's workspace default", async () => {
  await using _viewport = await useQuickComposerViewport();
  using _scratch = installScratchEnvironment();
  using launches = answerLaunches();
  await using _app = await renderQuickComposer();
  using _quickComposer = stubQuickComposerBridge();
  // The next project's t3.json read stays unanswered, so a send waits before it reports busy.
  let readProjectFile = () => {};
  const projectFileRead = new Promise<void>((resolve) => {
    readProjectFile = resolve;
  });
  using _projectFile = answerRpc(WS_METHODS.projectsReadFile, () =>
    Effect.promise(() => projectFileRead).pipe(
      Effect.as({
        relativePath: "t3.json",
        contents: "",
        byteLength: 0,
        truncated: false,
        exists: false,
      }),
    ),
  );
  await chooseProject("unread");
  expect(draftProjectId()).toBe(UNREAD_PROJECT_ID);

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("Stay with unread{Enter}");
  // The send owns the window from the click, before its launch request goes out.
  await expect.element(page.getByRole("combobox", { name: /^Choose project/ })).toBeDisabled();
  expect(draftProjectId()).toBe(UNREAD_PROJECT_ID);
  expect(launches.launched).toHaveLength(0);
  readProjectFile();

  await vi.waitFor(() => expect(launches.launched).toHaveLength(1));
  expect(launches.launched[0]?.projectId).toBe(UNREAD_PROJECT_ID);
});

it("keeps the Send and open label in the narrowest window", async () => {
  await using _viewport = await useQuickComposerViewport(240);
  using _scratch = installScratchEnvironment();
  await using _app = await renderQuickComposer();
  using _quickComposer = stubQuickComposerBridge();

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("Narrow window");
  // The window opens focused; an unfocused phone-width composer collapses its footer.
  await page.viewport(460, 240);
  const sendAndOpen = page.getByRole("button", { name: "Send and open in T3 Code" });
  const send = page.getByRole("button", { name: "Send", exact: true });
  const label = sendAndOpen.getByText("Send and open", { exact: true });
  await expect.element(label).toBeVisible();
  expect(label.element().getClientRects()).toHaveLength(1);
  const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]')!;
  expect(footer.scrollWidth).toBeLessThanOrEqual(footer.clientWidth);
  const footerBox = footer.getBoundingClientRect();
  const sendAndOpenBox = sendAndOpen.element().getBoundingClientRect();
  const sendBox = send.element().getBoundingClientRect();
  // One row, inside the footer, Send and open before Send.
  expect(sendAndOpenBox.left).toBeGreaterThanOrEqual(footerBox.left);
  expect(sendAndOpenBox.right).toBeLessThanOrEqual(sendBox.left);
  expect(sendBox.right).toBeLessThanOrEqual(footerBox.right);
  expect(sendBox.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(sendAndOpenBox.top).toBeLessThan(sendBox.bottom);
  expect(sendAndOpenBox.bottom).toBeGreaterThan(sendBox.top);
});

it.each([460, 680])(
  "keeps the project, prompt and both sends clear of a long launch error at %ipx",
  async (width) => {
    await using _viewport = await useQuickComposerViewport(240);
    using _scratch = installScratchEnvironment();
    using launches = answerLaunches({
      hold: true,
      failureMessage:
        "QA launch refused. The selected branch could not be checked out. Verify that it still exists in the project and then retry the same prompt.",
    });
    await using _app = await renderQuickComposer();
    using _quickComposer = stubQuickComposerBridge();

    await userEvent.click(page.getByTestId("composer-editor"));
    await userEvent.keyboard("Recover this prompt");
    await page.viewport(width, 240);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await vi.waitFor(() => expect(launches.launched).toHaveLength(1));
    launches.fail();

    const alert = page.getByRole("alert");
    await expect.element(alert).toBeVisible();
    expect(alert.element().textContent).toContain("QA launch refused.");
    expect(draftPrompt()).toBe("Recover this prompt");
    const box = (element: Element) => element.getBoundingClientRect();
    const alertBox = box(alert.element());
    const projectBox = box(page.getByRole("combobox", { name: /^Choose project/ }).element());
    const editorBox = box(page.getByTestId("composer-editor").element());
    const sendBox = box(page.getByRole("button", { name: "Send", exact: true }).element());
    const sendAndOpenBox = box(
      page.getByRole("button", { name: "Send and open in T3 Code" }).element(),
    );
    // The alert takes its own row between the project and the prompt.
    expect(projectBox.bottom).toBeLessThanOrEqual(alertBox.top);
    expect(alertBox.bottom).toBeLessThanOrEqual(editorBox.top);
    expect(alertBox.right).toBeLessThanOrEqual(width);
    for (const control of [projectBox, editorBox, sendBox, sendAndOpenBox]) {
      expect(control.top).toBeGreaterThanOrEqual(0);
      expect(control.bottom).toBeLessThanOrEqual(window.innerHeight);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    // Below the send row, the workspace strip scrolls into the window rather than off its edge.
    const permissions = page.getByRole("button", { name: /^Permissions: / }).element();
    const column = permissions.closest("[data-chat-composer-stack]")!.parentElement!;
    expect(getComputedStyle(column).overflowY).toBe("auto");
    permissions.scrollIntoView({ block: "nearest" });
    expect(box(permissions).bottom).toBeLessThanOrEqual(window.innerHeight);
    column.scrollTop = 0;

    await alert.getByRole("button", { name: "Dismiss error" }).click();
    await expect.element(alert).not.toBeInTheDocument();
    await expect.element(page.getByTestId("composer-editor")).toHaveFocus();
    expect(draftPrompt()).toBe("Recover this prompt");
  },
);
