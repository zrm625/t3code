import { createFileRoute } from "@tanstack/react-router";

import { QuickComposerSettings } from "../components/settings/QuickComposerSettings";

function SettingsQuickComposerRoute() {
  return <QuickComposerSettings />;
}

export const Route = createFileRoute("/_chat/settings/quick-composer")({
  component: SettingsQuickComposerRoute,
});
