import type { FeedbackRecord } from "@siteping/core";
import type { ReactElement } from "react";
import type { FlowGroup } from "../flows.js";
import { formatAbsolute, formatRelativeTime, pathFromUrl, safeScreenshotUrl, toDateTimeAttr } from "../format.js";
import { getStatusLabel, getTypeLabel, tWithParams } from "../i18n/index.js";
import { STATUS_ICONS, useInboxUi } from "./context.js";
import { CameraIcon, ChevronDownIcon } from "./icons.js";

interface RowProps {
  record: FeedbackRecord;
  /** Its step number, when the row sits under an expanded flow. */
  step?: number | undefined;
  /** DOM id targeted by the listbox `aria-activedescendant`. */
  domId: string;
  /** Keyboard-focused row — drives the focus ring + `aria-activedescendant`, never selection. */
  focused: boolean;
  /** The opened record — drives `aria-selected` (the real listbox selection). */
  selected: boolean;
  /** Ghost row kept briefly in the DOM while its status-leave animation runs. */
  leaving: boolean;
  onSelect: () => void;
  refCallback: (el: HTMLDivElement | null) => void;
}

/** One feedback line in the listbox — density-aware, ellipsized, keyboard-driven from the root. */
export function Row({
  record,
  step,
  domId,
  focused,
  selected,
  leaving,
  onSelect,
  refCallback,
}: RowProps): ReactElement {
  const { t, locale } = useInboxUi();
  const StatusIcon = STATUS_ICONS[record.status];
  const typeLabel = getTypeLabel(record.type, t);
  const path = pathFromUrl(record.url);
  const inFlow = step !== undefined;
  const className = `spd-row${inFlow ? " spd-row-step" : ""}${focused ? " spd-row-focused" : ""}${leaving ? " spd-row-leaving" : ""}`;

  const handleClick = (): void => {
    // Dragging to select message text must not open the drawer.
    if (window.getSelection()?.toString()) return;
    onSelect();
  };

  return (
    <div
      id={domId}
      ref={refCallback}
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      aria-hidden={leaving || undefined}
      data-status={record.status}
      className={className}
      onClick={leaving ? undefined : handleClick}
    >
      <span className="spd-row-status" role="img" aria-label={getStatusLabel(record.status, t)}>
        <StatusIcon />
      </span>
      {inFlow ? <span className="spd-row-step-label">{tWithParams(t, "flow.stepLabel", { step })}</span> : null}
      <span className="spd-row-type" title={typeLabel}>
        <i className="spd-type-square" data-type={record.type} aria-hidden="true" />
        {/* Type label is display:none below 720cq; keep it in the a11y tree always. */}
        <span className="spd-sr-only">{typeLabel}</span>
        <span className="spd-type-label" aria-hidden="true">
          {typeLabel}
        </span>
      </span>
      <span className="spd-row-message" title={record.message}>
        {record.message}
      </span>
      <span className="spd-row-path" title={path}>
        {path}
      </span>
      <span className="spd-row-author" title={record.authorName}>
        {record.authorName}
      </span>
      {safeScreenshotUrl(record) ? (
        <span className="spd-row-camera" role="img" aria-label={t("drawer.screenshotAlt")}>
          <CameraIcon />
        </span>
      ) : null}
      <time
        className="spd-row-time"
        dateTime={toDateTimeAttr(record.createdAt)}
        title={formatAbsolute(record.createdAt, locale)}
      >
        {formatRelativeTime(record.createdAt, t)}
      </time>
    </div>
  );
}

interface FlowRowProps {
  group: FlowGroup;
  expanded: boolean;
  /** DOM id targeted by the listbox `aria-activedescendant`. */
  domId: string;
  focused: boolean;
  onToggle: () => void;
  refCallback: (el: HTMLDivElement | null) => void;
}

/**
 * A multi-page flow's row — "Sign-up · 3 steps" — which expands to its
 * steps. Its state is read out as text: `aria-expanded` is not an option's.
 */
export function FlowRow({ group, expanded, domId, focused, onToggle, refCallback }: FlowRowProps): ReactElement {
  const { t, locale } = useInboxUi();
  const count = group.steps.length;
  const title = group.title ?? t("flow.untitled");
  const latest = group.steps.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  const authors = [...new Set(group.steps.map((step) => step.authorName))].join(", ");
  const className = `spd-row spd-row-flow${focused ? " spd-row-focused" : ""}`;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard folding is handled on the listbox itself (Enter, → / ←)
    <div
      id={domId}
      ref={refCallback}
      role="option"
      tabIndex={-1}
      aria-selected={false}
      data-expanded={expanded}
      className={className}
      onClick={onToggle}
    >
      <span className="spd-row-status spd-flow-chevron">
        <ChevronDownIcon />
      </span>
      <span className="spd-sr-only">{t("flow.kind")}</span>
      <span className="spd-row-message" title={title}>
        {title}
        <span className="spd-flow-count"> · {tWithParams(t, count === 1 ? "flow.step" : "flow.steps", { count })}</span>
      </span>
      <span className="spd-sr-only">{t(expanded ? "flow.expanded" : "flow.collapsed")}</span>
      <span className="spd-row-author" title={authors}>
        {authors}
      </span>
      <time
        className="spd-row-time"
        dateTime={toDateTimeAttr(latest.createdAt)}
        title={formatAbsolute(latest.createdAt, locale)}
      >
        {formatRelativeTime(latest.createdAt, t)}
      </time>
    </div>
  );
}
