import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import {
  QUICK_COMPOSER_LAST_TARGET_STORAGE_KEY,
  quickComposerSubmissionIntent,
  readLastQuickComposerTarget,
  resolveInitialQuickComposerTarget,
  writeLastQuickComposerTarget,
} from "./quickComposer.logic";

function createMemoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("quickComposer.logic", () => {
  const envLocal = EnvironmentId.make("env-local");
  const envRemote = EnvironmentId.make("env-remote");
  const projectA = ProjectId.make("project-a");
  const projectB = ProjectId.make("project-b");

  it("round-trips the last Quick Composer target and ignores malformed values", () => {
    const storage = createMemoryStorage();
    expect(readLastQuickComposerTarget(storage)).toBeNull();

    const target = scopeProjectRef(envRemote, projectB);
    writeLastQuickComposerTarget(target, storage);
    expect(readLastQuickComposerTarget(storage)).toEqual(target);

    storage.setItem(QUICK_COMPOSER_LAST_TARGET_STORAGE_KEY, "{not-json");
    expect(readLastQuickComposerTarget(storage)).toBeNull();
  });

  it("resolves stored target, then preferred environment, then first available project", () => {
    const projects = [
      { environmentId: envRemote, id: projectB },
      { environmentId: envLocal, id: projectA },
    ];

    expect(
      resolveInitialQuickComposerTarget({
        storedTarget: scopeProjectRef(envRemote, projectB),
        projects,
        preferredEnvironmentId: envLocal,
      }),
    ).toEqual(scopeProjectRef(envRemote, projectB));

    expect(
      resolveInitialQuickComposerTarget({
        storedTarget: scopeProjectRef(envLocal, ProjectId.make("deleted")),
        projects,
        preferredEnvironmentId: envLocal,
      }),
    ).toEqual(scopeProjectRef(envLocal, projectA));

    expect(
      resolveInitialQuickComposerTarget({
        storedTarget: null,
        projects,
        preferredEnvironmentId: EnvironmentId.make("missing"),
      }),
    ).toEqual(scopeProjectRef(envRemote, projectB));

    expect(
      resolveInitialQuickComposerTarget({
        storedTarget: null,
        projects: [],
        preferredEnvironmentId: envLocal,
      }),
    ).toBeNull();
  });
});

describe("quickComposerSubmissionIntent", () => {
  const enter = {
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    repeat: false,
  };

  it("keeps plain sends in the background and opens only on Mod+Shift+Enter", () => {
    expect(quickComposerSubmissionIntent(enter, "foreground")).toBe("background");
    expect(quickComposerSubmissionIntent(null, "foreground")).toBe("background");
    expect(quickComposerSubmissionIntent(enter, null)).toBeNull();
    expect(
      quickComposerSubmissionIntent({ ...enter, ctrlKey: true, shiftKey: true }, "background"),
    ).toBe("foreground");
    expect(quickComposerSubmissionIntent({ ...enter, metaKey: true, shiftKey: true }, null)).toBe(
      "foreground",
    );
  });

  it("leaves IME composition and key repeat to the resolved intent", () => {
    const open = { ...enter, ctrlKey: true, shiftKey: true };
    expect(quickComposerSubmissionIntent({ ...open, isComposing: true }, null)).toBeNull();
    expect(quickComposerSubmissionIntent({ ...open, repeat: true }, null)).toBeNull();
  });
});
