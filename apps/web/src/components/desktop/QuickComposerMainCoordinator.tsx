import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { buildThreadRouteParams } from "../../threadRoutes";

export function QuickComposerMainCoordinator() {
  const navigate = useNavigate();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to Quick Composer open-in-main events from the Electron bridge
  useEffect(() => {
    const bridge = window.desktopBridge?.quickComposer;
    if (!bridge) return;
    return bridge.onOpenThreadInMain(({ environmentId, threadId }) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId, threadId }),
      });
    });
  }, [navigate]);

  return null;
}
