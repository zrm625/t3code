import { T, useGT } from "gt-react";

import { InlineButton } from "../ui/button";
import { Spinner } from "../ui/spinner";

/**
 * One line naming what an unaccepted launch is waiting on, in place of the timeline the window
 * does not show. The live region stays mounted so the first status is announced.
 */
export function QuickComposerLaunchStatus(props: {
  readonly sending: boolean;
  readonly preparingWorktree: boolean;
  readonly onWorkLocally: (() => void) | null;
  readonly onCancelWorktreeSetup: (() => void) | null;
}) {
  const gt = useGT();
  return (
    <div className="flex min-w-0 items-center gap-2.5 px-1 text-xs text-muted-foreground">
      <span role="status" className="flex min-w-0 items-center gap-1.5">
        {props.sending ? (
          <>
            <Spinner size="xs" tone="muted" aria-hidden className="shrink-0" />
            <span className="truncate">
              {props.preparingWorktree ? gt("Preparing worktree") : gt("Sending…")}
            </span>
          </>
        ) : null}
      </span>
      {props.sending && props.onWorkLocally ? (
        <InlineButton tone="muted" touchTarget="padded" onClick={props.onWorkLocally}>
          <T>Work locally</T>
        </InlineButton>
      ) : null}
      {props.sending && props.onCancelWorktreeSetup ? (
        <InlineButton tone="muted" touchTarget="padded" onClick={props.onCancelWorktreeSetup}>
          <T>Cancel</T>
        </InlineButton>
      ) : null}
    </div>
  );
}
