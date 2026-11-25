import { createFileRoute } from "@tanstack/react-router";

import { QuickComposerWindow } from "../components/quickComposer/QuickComposerWindow";

function QuickComposerRoute() {
  return <QuickComposerWindow />;
}

export const Route = createFileRoute("/quick-composer")({
  component: QuickComposerRoute,
});
