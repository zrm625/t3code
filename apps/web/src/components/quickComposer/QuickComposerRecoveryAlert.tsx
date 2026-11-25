import { msg, T, useGT } from "gt-react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CopyIcon,
  FileIcon,
  ImageIcon,
  XIcon,
} from "lucide-react";
import { type PointerEvent, type ReactElement, type Ref, useRef, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import type { RetainedComposerFailure } from "../chat/useComposerSend";
import { ComposerBanner } from "../chat/ComposerBanner";
import { showAnchoredCopyErrorToast } from "../ui/anchoredCopyToast";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * One of the window's recovery entries: a failed send kept beside a newer draft, or the current
 * draft's error (usually its own failed send, already back in the editor).
 */
export type QuickComposerRecoveryEntry =
  | {
      readonly kind: "kept";
      readonly key: string;
      readonly failure: RetainedComposerFailure;
      /** Null while another project is selected: its files and context stay with their own. */
      readonly onRestore: (() => void) | null;
    }
  | { readonly kind: "error"; readonly key: string; readonly detail: string };

// A pointer press keeps focus where it was, so a click never pulls focus out of the draft.
// Keyboard activation still lands on the button, where its feedback is announced.
const keepFocus = (event: PointerEvent) => event.preventDefault();

// Keep action icons as legible as the text on the error surface.
const ICON_CLASS = "text-error-foreground!";

function IconAction({
  ref,
  label,
  onClick,
  icon,
  keepEditorFocus,
}: {
  readonly ref?: Ref<HTMLButtonElement>;
  readonly label: string;
  readonly onClick: () => void;
  readonly icon: ReactElement;
  readonly keepEditorFocus: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={ref}
            variant="ghost"
            size="icon-micro"
            aria-label={label}
            onPointerDown={keepEditorFocus ? keepFocus : undefined}
            onClick={onClick}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Every recovery entry in one row, newest shown first, so repeated failures never stack alerts over
 * the draft and its send buttons in a 240px window. Full text, attachments and the way back to the
 * draft open in a popover.
 */
export function QuickComposerRecoveryAlert(props: {
  /** Oldest first. */
  readonly entries: readonly QuickComposerRecoveryEntry[];
  readonly onDismiss: (entry: QuickComposerRecoveryEntry) => void;
}) {
  const gt = useGT();
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  // A browsed entry stays selected until a newer failure arrives, which then takes the row.
  const [selection, setSelection] = useState<{ key: string; newestKey: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const restoringRef = useRef(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard<string>({
    target: {
      target: "failed message",
      unavailableMessage: msg("Clipboard API is unavailable while copying failed message."),
      failureMessage: msg("Failed to copy failed message to the clipboard."),
    },
    onCopy: setCopiedKey,
    onError: (error) => showAnchoredCopyErrorToast(copyButtonRef, error),
  });

  const { entries } = props;
  const newest = entries.at(-1);
  // A retry clears the draft's error before its result, so a repeated identical error is a new
  // newest entry; forgetting the old selection here lets it take the row.
  if (selection !== null && selection.newestKey !== newest?.key) setSelection(null);
  if (newest === undefined) return null;
  const selectedIndex =
    selection?.newestKey === newest.key
      ? entries.findIndex((entry) => entry.key === selection.key)
      : -1;
  const index = selectedIndex === -1 ? entries.length - 1 : selectedIndex;
  const entry = entries[index] ?? newest;
  const select = (next: number) => {
    const target = entries[(next + entries.length) % entries.length];
    if (target) setSelection({ key: target.key, newestKey: newest.key });
  };
  const nextSelectionWithout = () => {
    // The next newer entry takes the removed one's place, or the next older at the end.
    const neighbor = entries[index + 1] ?? entries[index - 1];
    const remainingNewest = entries.filter((candidate) => candidate.key !== entry.key).at(-1);
    setSelection(
      neighbor && remainingNewest ? { key: neighbor.key, newestKey: remainingNewest.key } : null,
    );
  };
  const dismiss = () => {
    nextSelectionWithout();
    props.onDismiss(entry);
  };

  const failure = entry.kind === "kept" ? entry.failure : null;
  const title =
    failure === null
      ? null
      : failure.interrupted
        ? gt("Message may not have been sent")
        : gt("Message not sent");
  const message = failure?.snapshot.draftText ?? "";
  const excerpt = message.replace(/\s+/g, " ").trim();
  const attachments = failure?.snapshot.attachments ?? [];
  // An image-only message is named by its attachments.
  const summary = excerpt.length > 0 ? excerpt : attachments.map((file) => file.name).join(", ");
  const detail =
    entry.kind === "kept" ? (entry.failure.detail ?? gt("Your new draft was kept.")) : entry.detail;
  const copied = isCopied && copiedKey === entry.key;
  const destination = failure?.destination ?? null;
  const destinationProject = destination?.projectTitle ?? gt("No project");
  const restore = entry.kind === "kept" ? entry.onRestore : null;

  return (
    <ComposerBanner.Root
      variant="error"
      detached
      role="alert"
      className="pointer-events-auto mb-1 text-error-foreground [--composer-banner-icon-column:--spacing(5)] sm:[--composer-banner-icon-column:--spacing(5)]"
      data-quick-composer-recovery=""
    >
      <ComposerBanner.Row>
        <ComposerBanner.Icon className="text-error">
          <CircleAlertIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="items-baseline gap-1.5">
          {title === null ? null : <span className="shrink-0">{title}</span>}
          {/* One line in the default window; Details holds the rest. */}
          <span className="min-w-0 flex-1 truncate font-normal">
            {summary.length > 0 ? <span className="me-2">{`${summary} `}</span> : null}
            {detail}
          </span>
          <Popover
            open={detailsOpen}
            onOpenChange={(open) => {
              if (open) restoringRef.current = false;
              setDetailsOpen(open);
            }}
          >
            <PopoverTrigger render={<InlineButton />}>
              <T>Details</T>
            </PopoverTrigger>
            <PopoverPopup
              side="bottom"
              align="end"
              width="md"
              padding="compact"
              // A restore sends focus to the draft it changed, not back to Details.
              finalFocus={() => !restoringRef.current}
            >
              <div className="flex flex-col gap-2 text-xs">
                <PopoverTitle>{title ?? gt("Details")}</PopoverTitle>
                {excerpt.length > 0 ? (
                  <p className="whitespace-pre-wrap wrap-anywhere">{message}</p>
                ) : null}
                {attachments.length > 0 ? (
                  <ul className="flex flex-col gap-1">
                    {attachments.map((attachment) => (
                      <li key={attachment.id} className="flex min-w-0 items-center gap-1.5">
                        {attachment.type === "image" ? (
                          <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="truncate">{attachment.name}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {destination === null ? null : (
                  <p className="text-muted-foreground">
                    {gt("Sent to {project}", { project: destinationProject })}
                    {" · "}
                    {destination.envMode === "worktree"
                      ? gt("New worktree")
                      : gt("Current checkout")}
                    {destination.branch === null ? null : ` · ${destination.branch}`}
                  </p>
                )}
                <p className="whitespace-pre-wrap wrap-anywhere text-muted-foreground">{detail}</p>
                {entry.kind === "kept" ? (
                  <div className="flex flex-col items-start gap-1.5">
                    {restore === null ? (
                      <p>
                        {gt("Switch back to {project} to restore it to the draft.", {
                          project: destinationProject,
                        })}
                      </p>
                    ) : null}
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={restore === null}
                      onClick={() => {
                        if (restore === null) return;
                        restoringRef.current = true;
                        setDetailsOpen(false);
                        nextSelectionWithout();
                        restore();
                      }}
                    >
                      <T>Restore to draft</T>
                    </Button>
                  </div>
                ) : null}
              </div>
            </PopoverPopup>
          </Popover>
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          {/* Copy comes and goes per entry, so it sits before the pager, which keeps its place. */}
          {excerpt.length > 0 ? (
            <IconAction
              ref={copyButtonRef}
              label={copied ? gt("Copied") : gt("Copy message")}
              keepEditorFocus
              onClick={() => copyToClipboard(message, entry.key)}
              icon={
                copied ? <CheckIcon className={ICON_CLASS} /> : <CopyIcon className={ICON_CLASS} />
              }
            />
          ) : null}
          {entries.length > 1 ? (
            <>
              <IconAction
                label={gt("Previous error")}
                keepEditorFocus
                onClick={() => select(index - 1)}
                icon={<ChevronLeftIcon className={ICON_CLASS} />}
              />
              <span className="self-center text-xs tabular-nums">
                {gt("{step} of {total}", { step: index + 1, total: entries.length })}
              </span>
              <IconAction
                label={gt("Next error")}
                keepEditorFocus
                onClick={() => select(index + 1)}
                icon={<ChevronRightIcon className={ICON_CLASS} />}
              />
            </>
          ) : null}
          <IconAction
            label={gt("Dismiss error")}
            keepEditorFocus={false}
            onClick={dismiss}
            icon={<XIcon className={ICON_CLASS} />}
          />
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
    </ComposerBanner.Root>
  );
}
