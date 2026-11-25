import { OrchestrationDispatchCommandError, ProjectId, WS_METHODS } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

import { QUICK_COMPOSER_DRAFT_ID, useComposerDraftStore } from "~/composerDraftStore";
import { readAttachmentUpload } from "~/lib/attachmentUploadQueue";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "~/lib/terminalContext";
// Layout assertions need the app's styles.
import "~/index.css";
import {
  answerRpc,
  installFakeEnvironment,
  PROJECT_ID,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
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
const OTHER_PROJECT_ID = ProjectId.make("project-other");
const UNREAD_PROJECT_ID = ProjectId.make("project-unread");

/** Serves a scratch session and another project; each scratch request waits for `succeed` or `fail`. */
function installScratchEnvironment() {
  const environment = installFakeEnvironment([], {
    scratchWorkspaceRoot: "/workspace/Scratch",
    projectSettingsOverrides: {
      [PROJECT_ID]: { defaultRuntimeMode: "auto" },
      [OTHER_PROJECT_ID]: { defaultRuntimeMode: "approval-required" },
    },
    extraProjects: [
      { id: SCRATCH_PROJECT_ID, title: "Scratch" },
      { id: OTHER_PROJECT_ID, title: "other" },
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

/** The window's default width. */
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

it("sends with the destination project's permissions after switching projects", async () => {
  await using _viewport = await useQuickComposerViewport();
  using _environment = installScratchEnvironment();
  using launches = answerLaunches();
  await using _app = await renderQuickComposer();
  using _bridge = stubQuickComposerBridge();

  await chooseProject("render");
  await page.getByRole("button", { name: "Permissions: Auto", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Full access", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Permissions: Full access", exact: true }))
    .toBeVisible();

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("Keep this draft after switching projects");
  await chooseProject("other");
  expect(draftPrompt()).toBe("Keep this draft after switching projects");

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await vi.waitFor(() => expect(launches.launched).toHaveLength(1));
  expect(launches.launched[0]).toMatchObject({
    projectId: OTHER_PROJECT_ID,
    runtimeMode: "approval-required",
  });
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

  await expect.element(page.getByRole("alert")).toMatchTextContent("Launch refused");
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
    const send = page.getByRole("button", { name: "Send", exact: true });
    await send.click();
    await vi.waitFor(() => expect(launches.launched).toHaveLength(1));
    launches.fail();

    const alert = page.getByRole("alert");
    await expect.element(alert).toBeVisible();
    await expect.element(send).toBeEnabled();
    await commands.resetPointer();
    expect(alert.element().textContent).toContain("QA launch refused.");
    expect(draftPrompt()).toBe("Recover this prompt");
    const box = (element: Element) => element.getBoundingClientRect();
    const alertBox = box(alert.element());
    const projectBox = box(page.getByRole("combobox", { name: /^Choose project/ }).element());
    const editorBox = box(page.getByTestId("composer-editor").element());
    const sendBox = box(send.element());
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
    // The app's scrollbar shows the overflow; its lane is reserved so it never shifts the layout.
    expect(getComputedStyle(column).scrollbarWidth).not.toBe("none");
    expect(column.offsetWidth - column.clientWidth).toBeGreaterThan(0);
    permissions.scrollIntoView({ block: "nearest" });
    expect(box(permissions).bottom).toBeLessThanOrEqual(window.innerHeight);
    // The workspace control is a picker in a wide window and a button in a narrow one.
    const workspace = [
      ...page.getByRole("combobox", { name: "Workspace" }).elements(),
      ...page.getByRole("button", { name: "Current checkout" }).elements(),
    ].find((element) => element.getBoundingClientRect().width > 0)!;
    const branch = page.getByRole("combobox", { name: /^Branch: / }).element();
    expect(box(branch).bottom).toBeLessThanOrEqual(window.innerHeight);
    for (const control of [workspace, permissions]) {
      expect(box(control).bottom).toBeLessThanOrEqual(window.innerHeight);
      await vi.waitFor(() =>
        expect(hitsAtCenter(control), control.getAttribute("aria-label") ?? control.tagName).toBe(
          true,
        ),
      );
    }
    // Scrolling to the workspace row keeps the project named above it.
    const pinnedProject = page.getByRole("combobox", { name: /^Choose project/ }).element();
    expect(box(pinnedProject).top).toBeGreaterThanOrEqual(0);
    expect(hitsAtCenter(pinnedProject)).toBe(true);
    column.scrollTop = 0;

    await alert.getByRole("button", { name: "Dismiss error" }).click();
    await expect.element(alert).not.toBeInTheDocument();
    await expect.element(page.getByTestId("composer-editor")).toHaveFocus();
    expect(draftPrompt()).toBe("Recover this prompt");
  },
);

/** Whether a pointer at the element's center reaches it, and not something drawn over it. */
function hitsAtCenter(element: Element) {
  const box = element.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return hit !== null && element.contains(hit);
}

function overlaps(a: DOMRect, b: DOMRect) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

const editorHasFocus = () =>
  page.getByTestId("composer-editor").element().contains(document.activeElement);

it.each([460, 680])(
  "keeps a failed first message recoverable beside the next draft at %ipx",
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
    using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

    await userEvent.click(page.getByTestId("composer-editor"));
    await userEvent.keyboard("First prompt that will fail");
    await page.viewport(width, 240);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await vi.waitFor(() => expect(launches.launched).toHaveLength(1));
    // The pointer send leaves the editor focused, so the next draft can start during the launch.
    expect(editorHasFocus()).toBe(true);
    await userEvent.keyboard("Second draft typed while the first launch is pending");
    launches.fail();

    const recovery = page.getByRole("alert").filter({ hasText: "Message not sent" });
    await expect.element(recovery).toBeVisible();
    expect(recovery.element().textContent).toContain("First prompt that will fail");
    expect(recovery.element().textContent).toContain("QA launch refused.");
    // The rejection is reported once, in flow, and never as a toast over the draft.
    expect(page.getByRole("alert").all()).toHaveLength(1);
    expect(
      page.getByText("Your new draft was kept. Copy the failed message to send it again.").query(),
    ).toBeNull();
    expect(draftPrompt()).toBe("Second draft typed while the first launch is pending");
    expect(editorHasFocus()).toBe(true);

    const copy = recovery.getByRole("button", { name: "Copy message" });
    const dismiss = recovery.getByRole("button", { name: "Dismiss error" });
    const send = page.getByRole("button", { name: "Send", exact: true });
    const sendAndOpen = page.getByRole("button", { name: "Send and open in T3 Code" });
    // A disabled button passes the pointer through, so hit-test once the send has settled.
    await expect.element(send).toBeEnabled();
    await expect.element(sendAndOpen).toBeEnabled();
    const recoveryBox = recovery.element().getBoundingClientRect();
    for (const control of [copy, dismiss, send, sendAndOpen]) {
      const box = control.element().getBoundingClientRect();
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(window.innerHeight);
      expect(hitsAtCenter(control.element())).toBe(true);
    }
    for (const control of [page.getByTestId("composer-editor"), send, sendAndOpen]) {
      expect(overlaps(recoveryBox, control.element().getBoundingClientRect())).toBe(false);
    }

    // A pointer copy leaves the draft focused, so typing carries on.
    await userEvent.click(copy.element());
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith("First prompt that will fail"));
    await expect.element(recovery.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(editorHasFocus()).toBe(true);
    await expect.element(page.getByTestId("composer-editor")).toBeVisible();
    expect(draftPrompt()).toBe("Second draft typed while the first launch is pending");
    // From the keyboard, Copy keeps focus, where its new name is announced.
    write.mockClear();
    const copied = recovery.getByRole("button", { name: "Copied" }).element() as HTMLElement;
    copied.focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith("First prompt that will fail"));
    expect(document.activeElement).toBe(copied);

    await userEvent.click(dismiss);
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await vi.waitFor(() => expect(editorHasFocus()).toBe(true));
    expect(draftPrompt()).toBe("Second draft typed while the first launch is pending");
  },
);

it("keeps every failed message from repeated launches until each is dismissed", async () => {
  await using _viewport = await useQuickComposerViewport(240);
  using _scratch = installScratchEnvironment();
  using launches = answerLaunches({ hold: true });
  await using _app = await renderQuickComposer();
  using quickComposer = stubQuickComposerBridge();

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("Prompt A{Enter}");
  await vi.waitFor(() => expect(launches.launched).toHaveLength(1));
  await userEvent.keyboard("Prompt B");
  launches.fail();
  const recovery = page.getByRole("alert");
  const recoveryText = () => recovery.element().textContent;
  await vi.waitFor(() => expect(recoveryText()).toContain("Prompt A"));

  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(launches.launched).toHaveLength(2));
  await userEvent.keyboard("Prompt C");
  launches.fail();
  await vi.waitFor(() => expect(recoveryText()).toContain("Prompt B"));
  expect(draftPrompt()).toBe("Prompt C");
  // The window holds the only copy of each failure, so it must not be torn down while idle.
  expect(quickComposer.bridge.setDraftState).toHaveBeenLastCalledWith(
    expect.objectContaining({ hasContent: true }),
  );

  // One notice holds both; the newest shows first.
  expect(page.getByRole("alert").all()).toHaveLength(1);
  expect(recoveryText()).toContain("2 of 2");
  await recovery.getByRole("button", { name: "Dismiss error" }).click();
  await vi.waitFor(() => expect(recoveryText()).toContain("Prompt A"));
  expect(recoveryText()).not.toContain("of 2");
  await recovery.getByRole("button", { name: "Dismiss error" }).click();
  await expect.element(recovery).not.toBeInTheDocument();
  expect(draftPrompt()).toBe("Prompt C");
});

const LONG_LAUNCH_ERROR =
  "QA launch refused. The selected branch could not be checked out. Verify that it still exists in the project, confirm that the remote branch is available, and retry the restored prompt with the same worktree. If the error recurs, check your repository connection and retry.";

/**
 * Prompt A fails while B is typed, then B is sent and fails with nothing typed after it. The
 * launches answer the project file read at mount, so callers install them before rendering.
 */
async function failKeptThenRestored(width: number, launches: ReturnType<typeof answerLaunches>) {
  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("Prompt A that fails first");
  await page.viewport(width, 240);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await vi.waitFor(() => expect(launches.launched).toHaveLength(1));
  await userEvent.keyboard("Prompt B kept in the editor");
  launches.fail();
  await vi.waitFor(() => expect(draftPrompt()).toBe("Prompt B kept in the editor"));
  await expect.element(page.getByRole("alert")).toMatchTextContent("Prompt A that fails first");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await vi.waitFor(() => expect(launches.launched).toHaveLength(2));
  launches.fail();
  await vi.waitFor(() => expect(draftPrompt()).toBe("Prompt B kept in the editor"));
  await expect.element(page.getByRole("alert")).toMatchTextContent("2 of 2");
  // Rest the pointer off Send so its tooltip stays out of the layout checks.
  await userEvent.hover(page.getByTestId("composer-editor"));
}

it.each([460, 680])(
  "shows a restored draft's failure and an older kept failure in one notice at %ipx",
  async (width) => {
    await using _viewport = await useQuickComposerViewport(240);
    using _scratch = installScratchEnvironment();
    using _layout = answerRpc(WS_METHODS.workspaceLayoutCommands, () =>
      Effect.succeed({ commands: [] }),
    );
    using launches = answerLaunches({ hold: true, failureMessage: LONG_LAUNCH_ERROR });
    await using _app = await renderQuickComposer();
    using _quickComposer = stubQuickComposerBridge();
    using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await failKeptThenRestored(width, launches);

    const recovery = page.getByRole("alert");
    expect(recovery.all()).toHaveLength(1);
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect.element(send).toBeEnabled();
    // The project, prompt, both sends and the workspace row all fit without scrolling.
    const permissions = page.getByRole("button", { name: /^Permissions: / }).element();
    const column = permissions.closest("[data-chat-composer-stack]")!.parentElement!;
    expect(column.scrollHeight).toBeLessThanOrEqual(column.clientHeight);
    const branch = page.getByRole("combobox", { name: /^Branch: / }).element();
    expect(branch.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    // The workspace control is a picker in a wide window and a button in a narrow one.
    const workspace = [
      ...page.getByRole("combobox", { name: "Workspace" }).elements(),
      ...page.getByRole("button", { name: "Current checkout" }).elements(),
    ].find((element) => element.getBoundingClientRect().width > 0)!;
    const project = page.getByRole("combobox", { name: /^Choose project/ }).element();
    const sendAndOpen = page.getByRole("button", { name: "Send and open in T3 Code" }).element();
    for (const control of [project, send.element(), sendAndOpen, workspace, permissions]) {
      const box = control.getBoundingClientRect();
      const name = control.getAttribute("aria-label") ?? control.textContent;
      expect(box.top, name).toBeGreaterThanOrEqual(0);
      expect(box.bottom, name).toBeLessThanOrEqual(window.innerHeight);
      expect(hitsAtCenter(control), name).toBe(true);
    }
    const editorBox = page.getByTestId("composer-editor").element().getBoundingClientRect();
    expect(recovery.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(editorBox.top);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    // The draft's own error shows first, without the prompt that is already in the editor.
    expect(recovery.element().textContent).toContain("QA launch refused.");
    expect(recovery.getByRole("button", { name: "Copy message" }).query()).toBeNull();

    // Browsing shows the older failure without dismissing either.
    await recovery.getByRole("button", { name: "Previous error" }).click();
    await expect.element(recovery).toMatchTextContent("1 of 2");
    await expect.element(recovery).toMatchTextContent("Prompt A that fails first");
    expect(editorHasFocus()).toBe(true);
    await recovery.getByRole("button", { name: "Copy message" }).click();
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith("Prompt A that fails first"));
    await recovery.getByRole("button", { name: "Next error" }).click();
    await expect.element(recovery).toMatchTextContent("2 of 2");
    await recovery.getByRole("button", { name: "Next error" }).click();
    await expect.element(recovery).toMatchTextContent("1 of 2");
    expect(draftPrompt()).toBe("Prompt B kept in the editor");

    // Dismissing the shown entry leaves the other.
    await recovery.getByRole("button", { name: "Dismiss error" }).click();
    await vi.waitFor(() => expect(recovery.element().textContent).not.toContain("Prompt A"));
    expect(recovery.element().textContent).toContain("QA launch refused.");
    expect(recovery.element().textContent).not.toContain("of 2");
    expect(draftPrompt()).toBe("Prompt B kept in the editor");
    await recovery.getByRole("button", { name: "Dismiss error" }).click();
    await expect.element(recovery).not.toBeInTheDocument();
    expect(draftPrompt()).toBe("Prompt B kept in the editor");
    await vi.waitFor(() => expect(editorHasFocus()).toBe(true));
  },
);

it("opens a failure's full text from the keyboard and closes it with Escape", async () => {
  await using _viewport = await useQuickComposerViewport(240);
  using _scratch = installScratchEnvironment();
  using launches = answerLaunches({ hold: true, failureMessage: LONG_LAUNCH_ERROR });
  await using _app = await renderQuickComposer();
  using quickComposer = stubQuickComposerBridge();
  await failKeptThenRestored(460, launches);
  const recovery = page.getByRole("alert");
  await recovery.getByRole("button", { name: "Previous error" }).click();

  const details = recovery.getByRole("button", { name: "Details" }).element() as HTMLElement;
  details.focus();
  await userEvent.keyboard("{Enter}");
  const dialog = page.getByRole("dialog", { name: "Message not sent" });
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog).toMatchTextContent("Prompt A that fails first");
  await expect.element(dialog).toMatchTextContent(LONG_LAUNCH_ERROR);
  // The whole error is on screen in the window, not clipped in a nested scroller.
  const dialogBox = dialog.element().getBoundingClientRect();
  expect(dialogBox.top).toBeGreaterThanOrEqual(0);
  expect(dialogBox.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(dialogBox.right).toBeLessThanOrEqual(window.innerWidth);

  // Escape closes only the details, returns to their button and keeps the window open.
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await vi.waitFor(() => expect(document.activeElement).toBe(details));
  expect(quickComposer.bridge.hide).not.toHaveBeenCalled();
  await expect.element(recovery).toMatchTextContent("1 of 2");
  expect(draftPrompt()).toBe("Prompt B kept in the editor");
});

it.each([460, 680])(
  "restores a pointer send's failed draft with the editor still focused at %ipx",
  async (width) => {
    await using _viewport = await useQuickComposerViewport(240);
    using _scratch = installScratchEnvironment();
    using launches = answerLaunches({ hold: true });
    await using _app = await renderQuickComposer();
    using _quickComposer = stubQuickComposerBridge();

    await userEvent.click(page.getByTestId("composer-editor"));
    await userEvent.keyboard("Pointer send");
    await page.viewport(width, 240);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await vi.waitFor(() => expect(launches.launched).toHaveLength(1));
    expect(editorHasFocus()).toBe(true);
    launches.fail();

    await expect.element(page.getByRole("alert")).toMatchTextContent("Launch refused");
    expect(draftPrompt()).toBe("Pointer send");
    expect(editorHasFocus()).toBe(true);
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(launches.launched).toHaveLength(2));
  },
);

it("leaves focus where the user moved it during a launch that fails", async () => {
  await using _viewport = await useQuickComposerViewport(240);
  using _scratch = installScratchEnvironment();
  using launches = answerLaunches({ hold: true });
  await using _app = await renderQuickComposer();
  using _quickComposer = stubQuickComposerBridge();

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("Pointer send");
  await page.viewport(460, 240);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await vi.waitFor(() => expect(launches.launched).toHaveLength(1));
  const close = page.getByRole("button", { name: "Close Quick Composer" }).element() as HTMLElement;
  close.focus();
  launches.fail();

  await expect.element(page.getByRole("alert")).toMatchTextContent("Launch refused");
  expect(draftPrompt()).toBe("Pointer send");
  expect(document.activeElement).toBe(close);
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
});

it("returns focus to the editor when a keyboard-activated Send disables and fails", async () => {
  await using _viewport = await useQuickComposerViewport(240);
  using _scratch = installScratchEnvironment();
  using launches = answerLaunches({ hold: true });
  await using _app = await renderQuickComposer();
  using _quickComposer = stubQuickComposerBridge();

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("Keyboard send");
  (page.getByRole("button", { name: "Send", exact: true }).element() as HTMLElement).focus();
  await userEvent.keyboard(" ");
  await vi.waitFor(() => expect(launches.launched).toHaveLength(1));
  launches.fail();

  await expect.element(page.getByRole("alert")).toMatchTextContent("Launch refused");
  expect(draftPrompt()).toBe("Keyboard send");
  await vi.waitFor(() => expect(editorHasFocus()).toBe(true));
});

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);

/** Accepts every attachment upload without sending its bytes, until disposed. */
function acceptAttachmentUploads(): Disposable {
  const mint = answerRpc(WS_METHODS.attachmentsCreateUploadUrl, () =>
    Effect.succeed({ attachmentId: "upload-1", relativeUrl: "/upload", expiresAt: 0 }),
  );
  // Sending verifies each ready upload still exists on the server.
  const verify = answerRpc(WS_METHODS.assetsCreateUrl, () =>
    Effect.succeed({ relativeUrl: "/upload-1", expiresAt: 0 }),
  );
  const status = vi.spyOn(XMLHttpRequest.prototype, "status", "get").mockReturnValue(200);
  const send = vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(function (
    this: XMLHttpRequest,
  ) {
    queueMicrotask(() => this.dispatchEvent(new ProgressEvent("load")));
  });
  return {
    [Symbol.dispose]: () => {
      send.mockRestore();
      status.mockRestore();
      mint[Symbol.dispose]();
      verify[Symbol.dispose]();
    },
  };
}

const quickDraft = () => useComposerDraftStore.getState().getComposerDraft(QUICK_COMPOSER_DRAFT_ID);

it("restores a kept failure's image and context only in its own project, beside the newer draft", async () => {
  await using _viewport = await useQuickComposerViewport(240);
  using _scratch = installScratchEnvironment();
  using launches = answerLaunches({ hold: true });
  using _uploads = acceptAttachmentUploads();
  await using _app = await renderQuickComposer();
  using _quickComposer = stubQuickComposerBridge();
  const editor = page.getByTestId("composer-editor");
  // An earlier send in this file may have made another project the window's last choice.
  await chooseProject("render");
  await expect
    .element(page.getByRole("combobox", { name: "Choose project, current: render" }))
    .toBeVisible();

  await userEvent.click(editor);
  const clipboardData = new DataTransfer();
  clipboardData.items.add(new File([PNG], "recovery-fixture.png", { type: "image/png" }));
  editor
    .element()
    .dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  await expect.element(page.getByRole("img", { name: "recovery-fixture.png" })).toBeVisible();
  await userEvent.keyboard("Prompt A with an image");
  const draftThread = useComposerDraftStore.getState().getDraftSession(QUICK_COMPOSER_DRAFT_ID)!;
  const prompt = quickDraft()!.prompt;
  expect(
    useComposerDraftStore.getState().insertTerminalContext(
      QUICK_COMPOSER_DRAFT_ID,
      `${prompt}${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}`,
      {
        id: "terminal-context-recovery",
        threadId: draftThread.threadId,
        createdAt: "2026-01-01T00:00:00.000Z",
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 3,
        lineEnd: 3,
        text: "terminal line kept with A",
      },
      prompt.length,
    ),
  ).toBe(true);
  const sentImage = quickDraft()!.images[0]!;

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await vi.waitFor(() => expect(launches.launched).toHaveLength(1));
  expect(JSON.stringify(launches.launched[0])).toContain("terminal line kept with A");
  await userEvent.keyboard("Prompt B typed while A launched");
  launches.fail();

  const recovery = page.getByRole("alert").filter({ hasText: "Message not sent" });
  await expect.element(recovery).toBeVisible();
  expect(draftPrompt()).toBe("Prompt B typed while A launched");
  expect(quickDraft()!.images).toHaveLength(0);
  expect(quickDraft()!.terminalContexts).toHaveLength(0);

  // In another project, Details names where A was going and keeps it there.
  await chooseProject("other");
  await expect
    .element(page.getByRole("combobox", { name: "Choose project, current: other" }))
    .toBeVisible();
  await recovery.getByRole("button", { name: "Details" }).click();
  const details = page.getByRole("dialog", { name: "Message not sent" });
  await expect.element(details).toMatchTextContent("recovery-fixture.png");
  await expect.element(details).toMatchTextContent("Sent to render");
  await expect
    .element(details)
    .toMatchTextContent("Switch back to render to restore it to the draft.");
  const restore = details.getByRole("button", { name: "Restore to draft" });
  await expect.element(restore).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await expect.element(details).not.toBeInTheDocument();
  expect(draftPrompt()).toBe("Prompt B typed while A launched");
  expect(quickDraft()!.images).toHaveLength(0);

  await chooseProject("render");
  await recovery.getByRole("button", { name: "Details" }).click();
  await expect.element(restore).toBeEnabled();
  await restore.click();

  // A joins B in the draft: its text after B's, its image with a fresh preview, its context.
  await expect.element(recovery).not.toBeInTheDocument();
  await vi.waitFor(() =>
    expect(draftPrompt()).toMatch(/^Prompt B typed while A launched\n\nPrompt A with an image/),
  );
  // The editor keeps the context as a reference in A's text, as a failed send restores it.
  expect(draftPrompt()).toContain("t3-context://v1/terminal/terminal_terminal-context-recovery");
  const restoredImage = quickDraft()!.images[0]!;
  expect(quickDraft()!.images).toHaveLength(1);
  expect(restoredImage.id).toBe(sentImage.id);
  expect(restoredImage.file).toBe(sentImage.file);
  expect(restoredImage.previewUrl).toMatch(/^blob:/);
  expect(restoredImage.previewUrl).not.toBe(sentImage.previewUrl);
  expect(quickDraft()!.terminalContexts.map((context) => context.text)).toEqual([
    "terminal line kept with A",
  ]);
  await expect.element(page.getByRole("img", { name: "recovery-fixture.png" })).toBeVisible();
  await vi.waitFor(() => expect(editorHasFocus()).toBe(true));
  // Nothing was resent; the restored message goes out only when the user sends it.
  expect(launches.launched).toHaveLength(1);

  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(launches.launched).toHaveLength(2));
  const resent = JSON.stringify(launches.launched[1]);
  expect(resent).toContain("Prompt B typed while A launched");
  expect(resent).toContain("Prompt A with an image");
  expect(resent).toContain("terminal line kept with A");
  expect(resent).toContain("recovery-fixture.png");
  launches.release();
});

/** Sends only an image, types the next draft during the launch, then rejects the image. */
async function failImageOnlyBehindDraft(launches: ReturnType<typeof answerLaunches>) {
  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  const clipboardData = new DataTransfer();
  clipboardData.items.add(new File([PNG], "only-image.png", { type: "image/png" }));
  editor
    .element()
    .dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  await expect.element(page.getByRole("img", { name: "only-image.png" })).toBeVisible();
  const image = quickDraft()!.images[0]!;
  await vi.waitFor(() => expect(readAttachmentUpload(image.id)?.status).toBe("ready"));
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await vi.waitFor(() => expect(launches.launched).toHaveLength(1));
  await userEvent.keyboard("Next draft");
  launches.fail();
  const recovery = page.getByRole("alert").filter({ hasText: "Message not sent" });
  await expect.element(recovery).toMatchTextContent("only-image.png");
  return { recovery, image };
}

it("releases a kept failure's uploads when it is dismissed", async () => {
  await using _viewport = await useQuickComposerViewport(240);
  using _scratch = installScratchEnvironment();
  using launches = answerLaunches({ hold: true });
  using _uploads = acceptAttachmentUploads();
  await using _app = await renderQuickComposer();
  using _quickComposer = stubQuickComposerBridge();
  const { recovery, image } = await failImageOnlyBehindDraft(launches);
  // Kept for a restore until the user lets the message go.
  expect(readAttachmentUpload(image.id)?.status).toBe("ready");

  await recovery.getByRole("button", { name: "Dismiss error" }).click();
  await expect.element(recovery).not.toBeInTheDocument();
  expect(readAttachmentUpload(image.id)).toBeUndefined();
  expect(draftPrompt()).toBe("Next draft");
});

it("restores an image-only kept failure named by its attachment", async () => {
  await using _viewport = await useQuickComposerViewport(240);
  using _scratch = installScratchEnvironment();
  using launches = answerLaunches({ hold: true });
  using _uploads = acceptAttachmentUploads();
  await using _app = await renderQuickComposer();
  using _quickComposer = stubQuickComposerBridge();
  const { recovery, image } = await failImageOnlyBehindDraft(launches);
  // An image has no text to copy.
  expect(recovery.getByRole("button", { name: "Copy message" }).query()).toBeNull();
  await recovery.getByRole("button", { name: "Details" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Restore to draft" }).click();
  await expect.element(recovery).not.toBeInTheDocument();
  expect(draftPrompt()).toBe("Next draft");
  expect(quickDraft()!.images.map((restored) => restored.name)).toEqual(["only-image.png"]);
  await expect.element(page.getByRole("img", { name: "only-image.png" })).toBeVisible();
  // The draft owns the upload again, so the send can reuse it.
  expect(readAttachmentUpload(image.id)?.status).toBe("ready");
  expect(launches.launched).toHaveLength(1);
});

it("shows a retry's identical rejection as the newest entry while an older one is browsed", async () => {
  await using _viewport = await useQuickComposerViewport(240);
  using _scratch = installScratchEnvironment();
  using launches = answerLaunches({ hold: true, failureMessage: LONG_LAUNCH_ERROR });
  await using _app = await renderQuickComposer();
  using _quickComposer = stubQuickComposerBridge();
  await failKeptThenRestored(460, launches);
  const recovery = page.getByRole("alert");
  await recovery.getByRole("button", { name: "Previous error" }).click();
  await expect.element(recovery).toMatchTextContent("1 of 2");
  await expect.element(recovery).toMatchTextContent("Prompt A that fails first");

  // The retry of B is rejected with exactly the error it had before.
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await vi.waitFor(() => expect(launches.launched).toHaveLength(3));
  launches.fail();
  await vi.waitFor(() => expect(draftPrompt()).toBe("Prompt B kept in the editor"));

  // The new occurrence takes the row; A is still one step back.
  await expect.element(recovery).toMatchTextContent("2 of 2");
  expect(recovery.element().textContent).toContain("QA launch refused.");
  expect(recovery.element().textContent).not.toContain("Prompt A that fails first");
  await recovery.getByRole("button", { name: "Previous error" }).click();
  await expect.element(recovery).toMatchTextContent("Prompt A that fails first");
  await recovery.getByRole("button", { name: "Next error" }).click();
  await recovery.getByRole("button", { name: "Dismiss error" }).click();
  await vi.waitFor(() => expect(recovery.element().textContent).toContain("Prompt A"));
  expect(recovery.element().textContent).not.toContain("of 2");
  expect(draftPrompt()).toBe("Prompt B kept in the editor");
});

type Rgb = readonly [number, number, number];

/** A CSS color as drawn over `under`, so translucent surfaces read as they appear. */
function drawnColor(color: string, under: Rgb = [255, 255, 255]): Rgb {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.fillStyle = `rgb(${under.join(" ")})`;
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

function contrast(a: Rgb, b: Rgb) {
  const luminance = (rgb: Rgb) => {
    const [r = 0, g = 0, b = 0] = rgb.map((channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

it.each(["light", "dark"] as const)(
  "keeps the recovery actions legible, named and in place in a %s window",
  async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    using _theme = {
      [Symbol.dispose]: () => document.documentElement.classList.remove("dark"),
    };
    await using _viewport = await useQuickComposerViewport(240);
    using _scratch = installScratchEnvironment();
    using _layout = answerRpc(WS_METHODS.workspaceLayoutCommands, () =>
      Effect.succeed({ commands: [] }),
    );
    using launches = answerLaunches({ hold: true, failureMessage: LONG_LAUNCH_ERROR });
    await using _app = await renderQuickComposer();
    using _quickComposer = stubQuickComposerBridge();
    await failKeptThenRestored(460, launches);
    const recovery = page.getByRole("alert");
    const previous = recovery.getByRole("button", { name: "Previous error" });
    const next = recovery.getByRole("button", { name: "Next error" });
    const dismiss = recovery.getByRole("button", { name: "Dismiss error" });

    // Every glyph reads at 3:1 against the alert as drawn over the window.
    const page_ = drawnColor(getComputedStyle(document.querySelector("main")!).backgroundColor);
    const banner = getComputedStyle(recovery.element(), "::before");
    const fill = drawnColor(banner.backgroundColor, page_);
    const surface = drawnColor(banner.getPropertyValue("--chat-composer-attached-tint"), fill);
    const glyphs = [...recovery.element().querySelectorAll("svg")];
    expect(glyphs.length).toBeGreaterThanOrEqual(4);
    for (const glyph of glyphs) {
      const ratio = contrast(drawnColor(getComputedStyle(glyph).color, surface), surface);
      expect(ratio, glyph.getAttribute("class") ?? "").toBeGreaterThanOrEqual(3);
    }
    // Action glyphs take the alert's text color, so a theme's lighter muted color cannot fade them.
    for (const glyph of recovery.element().querySelectorAll("button svg")) {
      expect(getComputedStyle(glyph).color).toBe(getComputedStyle(recovery.element()).color);
    }

    // Browsing to an entry with Copy leaves the pager and Dismiss where they were.
    const xs = () =>
      [previous, next, dismiss].map((button) => button.element().getBoundingClientRect().x);
    const before = xs();
    expect(recovery.getByRole("button", { name: "Copy message" }).query()).toBeNull();
    await previous.click();
    await expect.element(recovery.getByRole("button", { name: "Copy message" })).toBeVisible();
    expect(xs()).toEqual(before);
    expect(editorHasFocus()).toBe(true);

    // A tooltip names the icon, and closes once it is used so the next press lands.
    await userEvent.hover(next);
    const tooltip = () => document.querySelector('[data-slot="tooltip-popup"]');
    await vi.waitFor(() => expect(tooltip()?.textContent).toBe("Next error"));
    await next.click();
    await vi.waitFor(() => expect(tooltip()).toBeNull());
    await expect.element(recovery).toMatchTextContent("2 of 2");
    expect(editorHasFocus()).toBe(true);
    for (const button of [previous, next, dismiss]) {
      expect(hitsAtCenter(button.element())).toBe(true);
    }

    // The default window keeps spare height below the workspace row, so it needs no scroll.
    await userEvent.hover(page.getByTestId("composer-editor"));
    const stack = document.querySelector("[data-chat-composer-stack]")!;
    const overlay = stack.closest("[data-chat-composer-overlay]")!;
    const spare =
      overlay.getBoundingClientRect().bottom -
      Number.parseFloat(getComputedStyle(overlay).paddingBottom) -
      stack.getBoundingClientRect().bottom;
    expect(spare).toBeGreaterThanOrEqual(8);
    expect(stack.parentElement!.scrollHeight).toBeLessThanOrEqual(
      stack.parentElement!.clientHeight,
    );
  },
);
